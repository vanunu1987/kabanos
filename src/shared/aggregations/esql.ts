import type { FieldInfo } from '../meta'
import { compile, defaultMetricName } from './compiler'
import { fieldLabel, safeName, STAGE_LABEL, type Condition, type GroupSpec, type Pipeline, type Scalar, type Stage, type StageOf } from './model'

export interface EsqlLine {
  text: string
  /** 1-based stage number for the gutter. */
  stage?: number
}

export interface EsqlResult {
  query: string
  lines: EsqlLine[]
  warnings: Array<{ stage: number; message: string }>
}

const IDENT = /^[A-Za-z_@][A-Za-z0-9_]*(\.[A-Za-z_@][A-Za-z0-9_]*)*$/
export const esqlId = (name: string): string => (IDENT.test(name) ? name : `\`${name.replace(/`/g, '``')}\``)

export function esqlValue(v: Scalar | undefined): string {
  if (typeof v === 'number' || typeof v === 'boolean') return String(v)
  return `"${String(v ?? '').replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
}

function conditionExpr(c: Condition, warn: (m: string) => void): string {
  const f = esqlId(c.field)
  switch (c.op) {
    case 'is':
      return `${f} == ${esqlValue(c.value)}`
    case 'isNot':
      // must_not term keeps documents without the field; `!=` alone would drop them.
      return `(${f} != ${esqlValue(c.value)} OR ${f} IS NULL)`
    case 'oneOf':
      return `${f} IN (${(c.values ?? []).map(esqlValue).join(', ')})`
    case 'exists':
      return `${f} IS NOT NULL`
    case 'missing':
      return `${f} IS NULL`
    case 'lt':
      return `${f} < ${esqlValue(c.value)}`
    case 'lte':
      return `${f} <= ${esqlValue(c.value)}`
    case 'gt':
      return `${f} > ${esqlValue(c.value)}`
    case 'gte':
      return `${f} >= ${esqlValue(c.value)}`
    case 'between':
      return `${f} >= ${esqlValue(c.value)} AND ${f} <= ${esqlValue(c.value2)}`
    case 'contains':
      warn(`“contains text” on ${c.field} becomes a case-sensitive LIKE "*…*" — full-text matching differs.`)
      return `${f} LIKE ${esqlValue(`*${String(c.value ?? '')}*`)}`
  }
}

function filterExpr(s: StageOf<'filter'>, warn: (m: string) => void): string | null {
  if (s.raw) {
    warn('A raw query DSL filter can’t be translated to ES|QL, so it is left out here.')
    return null
  }
  const parts = s.conditions.map((c) => conditionExpr(c, warn))
  if (!parts.length) return null
  return s.match === 'any' ? parts.map((p) => (parts.length > 1 ? `(${p})` : p)).join(' OR ') : parts.join(' AND ')
}

const FIXED_UNITS: Record<string, string> = { ms: 'milliseconds', s: 'seconds', m: 'minutes', h: 'hours', d: 'days' }

/** The BY expression for a group, or null when ES|QL has no faithful equivalent. */
function groupBy(g: GroupSpec, name: string): { by: string[]; keys: string[] } | null {
  switch (g.type) {
    case 'terms':
      return { by: [esqlId(g.field)], keys: [esqlId(g.field)] }
    case 'histogram':
      return { by: [`${esqlId(name)} = BUCKET(${esqlId(g.field)}, ${g.interval})`], keys: [esqlId(name)] }
    case 'date_histogram': {
      let span: string | null = null
      if (g.calendarInterval) span = `1 ${g.calendarInterval.replace(/^1/, '')}`
      else if (g.fixedInterval) {
        const m = /^(\d+)(ms|s|m|h|d)$/.exec(g.fixedInterval)
        if (m) span = `${m[1]} ${FIXED_UNITS[m[2]!]}`
      }
      if (!span) return null
      return { by: [`${esqlId(name)} = BUCKET(${esqlId(g.field)}, ${span})`], keys: [esqlId(name)] }
    }
    case 'composite': {
      if (g.sources.some((s) => s.type !== 'terms')) return null
      const cols = g.sources.map((s) => esqlId(s.field))
      return { by: cols, keys: cols }
    }
    default:
      return null
  }
}

/** ES|QL translation (AGGREGATIONS.md §8): FROM → WHERE → STATS … BY → WHERE → SORT / LIMIT, with a warning per stage it can't keep. */
export function toEsql(pipeline: Pick<Pipeline, 'stages' | 'target'>, fields?: FieldInfo[]): EsqlResult {
  const compiled = compile(pipeline, { fields })
  const lines: EsqlLine[] = [{ text: `FROM ${pipeline.target}` }]
  const warnings: EsqlResult['warnings'] = []
  const stageNo = (s: Stage) => pipeline.stages.indexOf(s) + 1
  const warnFor = (s: Stage) => (m: string) => warnings.push({ stage: stageNo(s), message: m })
  const live = pipeline.stages.filter((s, i) => s.enabled && compiled.stages[i]!.emitted)
  const levelOf = (s: Stage) => compiled.stages[pipeline.stages.indexOf(s)]!.level
  const firstGroup = live.find((s): s is StageOf<'groupBy'> => s.kind === 'groupBy')
  const nested = new Set<Stage>()

  // Root filters (before the first Group by).
  for (const s of live) {
    if (s === firstGroup) break
    if (s.kind !== 'filter') continue
    const expr = filterExpr(s, warnFor(s))
    if (expr) lines.push({ text: `| WHERE ${expr}`, stage: stageNo(s) })
  }

  const rootMetrics = live.filter((s): s is StageOf<'metrics'> => s.kind === 'metrics' && levelOf(s) === 0)
  if (!firstGroup) {
    // A plain search, or metrics over every document.
    if (rootMetrics.length) {
      const stats = rootMetrics.flatMap((s) => metricExprs(s))
      lines.push({ text: `| STATS ${stats.join(', ')}`, stage: stageNo(rootMetrics[0]!) })
    }
    const docs = live.find((s) => (s.kind === 'topDocs' || s.kind === 'sortLimit') && levelOf(s) === 0) as StageOf<'topDocs'> | StageOf<'sortLimit'> | undefined
    if (docs?.kind === 'topDocs') {
      if (docs.fields?.length) lines.push({ text: `| KEEP ${docs.fields.map(esqlId).join(', ')}`, stage: stageNo(docs) })
      if (docs.sort?.field) lines.push({ text: `| SORT ${esqlId(docs.sort.field)} ${docs.sort.dir.toUpperCase()}`, stage: stageNo(docs) })
      lines.push({ text: `| LIMIT ${docs.size}`, stage: stageNo(docs) })
    } else if (docs?.kind === 'sortLimit') {
      if (docs.by && docs.by !== '_count' && docs.by !== '_key') lines.push({ text: `| SORT ${esqlId(docs.by)} ${docs.dir.toUpperCase()}`, stage: stageNo(docs) })
      if (docs.from) warnFor(docs)('ES|QL has no OFFSET, so “skip” is left out here.')
      lines.push({ text: `| LIMIT ${docs.size}`, stage: stageNo(docs) })
    } else if (!rootMetrics.length) lines.push({ text: '| LIMIT 10' })
    for (const s of live) if (s.kind === 'custom') warnFor(s)('Custom JSON has no ES|QL equivalent, so it is left out here.')
    return finish(lines, warnings)
  }

  for (const s of rootMetrics) warnFor(s)('Metrics over all documents and per-group metrics can’t share one ES|QL STATS, so this stage is left out here.')

  const gStage = stageNo(firstGroup)
  const g = groupBy(firstGroup.group, firstGroup.name || 'bucket')
  if (!g) {
    warnFor(firstGroup)(`${firstGroup.group.type.replace('_', ' ')} grouping has no faithful ES|QL equivalent; keep using the JSON view.`)
    lines.push({ text: '| LIMIT 0' })
    return finish(lines, warnings)
  }
  const level1 = live.filter((s) => levelOf(s) === 1 || (s === firstGroup))
  for (const s of live) {
    if (s === firstGroup || levelOf(s) === 0) continue
    if (levelOf(s) !== 1 || (s.kind === 'groupBy' && s !== firstGroup) || s.kind === 'filter') nested.add(s)
  }
  // Stages under a nested group or filter are per-parent and can't be flattened into one STATS.
  for (const s of live) if (levelOf(s) > 1) nested.add(s)
  const parentLabel = compiled.levels[1]?.label ?? 'bucket'
  for (const s of [...nested].sort((a, b) => stageNo(a) - stageNo(b))) {
    const n = stageNo(s)
    const what = s.kind === 'groupBy' ? `group by ${s.group.type === 'date_histogram' ? (s.group.calendarInterval ?? 'interval') : 'field' in s.group ? fieldLabel(s.group.field) : 'filter'} inside each ${parentLabel}` : `${STAGE_LABEL[s.kind].toLowerCase()} inside each ${parentLabel}`
    warnFor(s)(`Stage ${n} (${what}) can't be expressed in a single ES|QL STATS, so it is left out here. Turn stage ${n} off, or keep using the JSON view.`)
  }

  if (firstGroup.group.type === 'terms' && firstGroup.group.missing !== 'bucket') lines.push({ text: `| WHERE ${esqlId(firstGroup.group.field)} IS NOT NULL`, stage: gStage })
  if (firstGroup.group.type === 'date_histogram' && !firstGroup.group.minDocCount) warnFor(firstGroup)('ES|QL leaves out empty date buckets that a date histogram returns with doc_count 0.')

  const metricStages = level1.filter((s): s is StageOf<'metrics'> => s.kind === 'metrics' && !nested.has(s))
  const stats = metricStages.flatMap((s) => metricExprs(s))
  const hasDocCount = metricStages.some((s) => s.metrics.some((m) => (m.name || '') === 'doc_count'))
  if (!hasDocCount) stats.push('doc_count = COUNT(*)')
  const firstMetric = metricStages[0]
  if (firstMetric) {
    lines.push({ text: `| STATS ${stats.join(', ')}`, stage: stageNo(firstMetric) })
    lines.push({ text: `        BY ${g.by.join(', ')}`, stage: gStage })
  } else lines.push({ text: `| STATS ${stats.join(', ')} BY ${g.by.join(', ')}`, stage: gStage })

  // terms keeps only the top N buckets before any later stage sees them.
  const gs = firstGroup.group
  if (gs.type === 'terms') {
    const o = gs.order ?? { by: '_count', dir: 'desc' as const }
    const col = o.by === '_count' ? 'doc_count' : o.by === '_key' ? g.keys[0]! : esqlId(o.by)
    lines.push({ text: `| SORT ${col} ${o.dir.toUpperCase()}`, stage: gStage }, { text: `| LIMIT ${gs.size}`, stage: gStage })
    if (gs.minDocCount && gs.minDocCount > 1) lines.push({ text: `| WHERE doc_count >= ${gs.minDocCount}`, stage: gStage })
  } else if (gs.type === 'composite') {
    lines.push({ text: `| SORT ${g.keys.join(', ')}`, stage: gStage }, { text: `| LIMIT ${gs.size}`, stage: gStage })
  }

  const colOf = (ref: string) => (ref === '_count' ? 'doc_count' : ref === '_key' ? g.keys[0]! : esqlId(ref))
  for (const s of level1) {
    if (nested.has(s)) continue
    if (s.kind === 'keepOnly') {
      lines.push({ text: `| WHERE ${s.rules.filter((r) => r.metric).map((r) => `${colOf(r.metric)} ${r.cmp} ${r.value}`).join(' AND ')}`, stage: stageNo(s) })
    } else if (s.kind === 'sortLimit') {
      lines.push({ text: `| SORT ${colOf(s.by || '_count')} ${s.dir.toUpperCase()}`, stage: stageNo(s) })
      if (s.from) warnFor(s)('ES|QL has no OFFSET, so “skip” is left out here.')
      lines.push({ text: `| LIMIT ${s.size}`, stage: stageNo(s) })
    } else if (s.kind === 'runningTotal' || s.kind === 'changeOverTime' || s.kind === 'topDocs' || s.kind === 'custom') {
      warnFor(s)(`${STAGE_LABEL[s.kind]} has no direct ES|QL equivalent, so it is left out here.`)
    }
  }
  return finish(lines, warnings)
}

function metricExprs(s: StageOf<'metrics'>): string[] {
  const out: string[] = []
  s.metrics.forEach((m) => {
    if (m.op !== 'count' && !m.field) return
    const name = safeName(m.name) || defaultMetricName(m)
    const f = esqlId(m.field ?? '')
    switch (m.op) {
      case 'count':
        return out.push(`${esqlId(name)} = COUNT(*)`)
      case 'sum':
      case 'avg':
      case 'min':
      case 'max':
        return out.push(`${esqlId(name)} = ${m.op.toUpperCase()}(${f})`)
      case 'median':
        return out.push(`${esqlId(name)} = MEDIAN(${f})`)
      case 'percentiles':
        for (const p of m.percents?.length ? m.percents : [50, 95, 99]) out.push(`${esqlId(`${name}.${p}`)} = PERCENTILE(${f}, ${p})`)
        return
      case 'cardinality':
        return out.push(`${esqlId(name)} = COUNT_DISTINCT(${f})`)
      case 'value_count':
        return out.push(`${esqlId(name)} = COUNT(${f})`)
      case 'stats':
        for (const [k, fn] of [['count', 'COUNT'], ['min', 'MIN'], ['max', 'MAX'], ['avg', 'AVG'], ['sum', 'SUM']] as const) out.push(`${esqlId(`${name}.${k}`)} = ${fn}(${f})`)
        return
    }
  })
  return out
}

function finish(lines: EsqlLine[], warnings: EsqlResult['warnings']): EsqlResult {
  warnings.sort((a, b) => a.stage - b.stage)
  return { query: lines.map((l) => l.text).join('\n'), lines, warnings }
}
