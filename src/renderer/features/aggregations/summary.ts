import type { Compiled } from '@shared/aggregations/compiler'
import { flatten, hitsTotal, levelGroups } from '@shared/aggregations/flatten'
import { conditionLabel, GROUP_LABEL, METRIC_LABEL, type Condition, type Stage } from '@shared/aggregations/model'
import type { Preview } from './preview'
import { fmt, short } from './OutputPanel'

const cond = (c: Condition) => `${c.field || '?'} ${conditionLabel(c)}${c.op === 'exists' || c.op === 'missing' ? '' : ` ${c.op === 'oneOf' ? (c.values ?? []).join(', ') : c.op === 'between' ? `${fmt(c.value)} and ${fmt(c.value2)}` : fmt(c.value)}`}`

/** One-line description of a stage (collapsed cards, the “How stages map” panel). */
export function describe(stage: Stage, compiled?: Compiled, index?: number): string {
  const lvl = compiled && index !== undefined ? compiled.stages[index]?.level : undefined
  const inside = lvl !== undefined && lvl > 0 ? ` (inside each ${compiled!.levels[lvl]!.label})` : ''
  switch (stage.kind) {
    case 'filter':
      return stage.raw ? 'raw query DSL' : stage.conditions.map(cond).join(stage.match === 'all' ? ' and ' : ' or ') || 'no conditions'
    case 'groupBy': {
      const g = stage.group
      if (g.type === 'date_histogram') return `date_histogram · ${g.field} · every ${g.calendarInterval ?? g.fixedInterval}${inside}`
      if (g.type === 'filters') return `filters · ${g.filters.map((f) => f.name).join(', ')}${inside}`
      if (g.type === 'composite') return `composite · ${g.sources.map((s) => s.field).join(' + ')}${inside}`
      if (g.type === 'terms') return `terms · ${g.field} · top ${g.size}${inside}`
      return `${g.type} · ${g.field}${inside}`
    }
    case 'metrics':
      return stage.metrics.map((m) => `${m.name || '…'} = ${METRIC_LABEL[m.op].toLowerCase()}${m.field ? `(${m.field})` : ''}`).join(', ')
    case 'keepOnly':
      return `buckets where ${stage.rules.map((r) => `${r.metric || '?'} ${r.cmp} ${fmt(r.value)}`).join(' and ')}   (bucket_selector)`
    case 'sortLimit':
      return `by ${stage.by === '_count' ? 'document count' : stage.by === '_key' ? 'key' : stage.by} ${stage.dir === 'desc' ? 'descending' : 'ascending'}, keep ${stage.size}${stage.from ? `, skip ${stage.from}` : ''}${lvl ? '   (bucket_sort)' : ''}`
    case 'runningTotal':
      return `running total of ${stage.metric || '?'}   (cumulative_sum)`
    case 'changeOverTime':
      return `${stage.mode === 'pct' ? '% change' : 'change'} of ${stage.metric || '?'}   (${stage.mode === 'pct' ? 'derivative + bucket_script' : 'derivative'})`
    case 'topDocs':
      return `${stage.size} documents${stage.sort ? ` by ${stage.sort.field} ${stage.sort.dir}` : ''}   (top_hits)`
    case 'custom':
      return stage.place === 'request' ? `request options · ${Object.keys(stage.json).join(', ')}` : `${stage.name} · ${Object.keys(stage.json)[0] ?? ''}`
  }
}

/** Title for chips: “Group by city”, “By month”. */
export function chipTitle(stage: Stage, n: number, nested: boolean): string {
  if (stage.kind === 'groupBy') {
    const g = stage.group
    const what = g.type === 'date_histogram' ? (g.calendarInterval ?? 'interval') : g.type === 'filters' ? 'filter' : g.type === 'composite' ? g.sources.map((s) => s.field.split('.')[0]).join('+') : g.field.replace(/\.(keyword|raw)$/, '').split('.')[0]
    return `${n} ${nested ? 'By' : 'Group by'} ${what}`
  }
  const label: Record<Stage['kind'], string> = { filter: 'Filter', groupBy: '', metrics: 'Metrics', keepOnly: 'Keep', sortLimit: 'Top', runningTotal: 'Running', changeOverTime: 'Change', topDocs: 'Docs', custom: 'Custom' }
  return `${n} ${label[stage.kind]}`
}

/** The value a flow chip / collapsed card shows for a stage's preview. */
export function outcome(stage: Stage, index: number, p: Preview | undefined, prev: Preview | undefined): string {
  if (!stage.enabled) return 'off'
  if (!p) return '…'
  if (p.status === 'error' && !p.response) return '⚠'
  if (!p.response) return '…'
  const c = p.compiled
  const info = c.stages[index]!
  const approx = !!p.sampled
  const res = p.response
  switch (stage.kind) {
    case 'filter': {
      if (info.level === 0) return short(hitsTotal(res))
      return 'filtered'
    }
    case 'groupBy': {
      const lvl = c.levels.findIndex((l) => l.stageIndex === index)
      if (lvl < 0) return '⚠'
      const g = levelGroups(res, c, lvl)
      if (c.levels[lvl]!.parent === 0) return `${g.total} buckets`
      const counts = g.parents.map((x) => x.buckets.length)
      const parent = c.levels[c.levels[lvl]!.parent ?? 0]!.label
      return `${counts.length ? Math.max(...counts) : 0} / ${parent}`
    }
    case 'metrics':
      return `×${info.names.length}`
    case 'keepOnly': {
      const kept = flatten(res, c, Math.max(0, info.level)).rows.length
      const before = prev?.response ? flatten(prev.response, prev.compiled, Math.max(0, info.level)).rows.length : undefined
      return before !== undefined ? `${kept} of ${before}` : `${kept} kept`
    }
    case 'sortLimit':
      if (info.level === 0) return `${((res.hits as { hits?: unknown[] } | undefined)?.hits ?? []).length} docs`
      return `${flatten(res, c, info.level).rows.length} rows`
    case 'runningTotal':
    case 'changeOverTime':
      return '+1 column'
    case 'topDocs':
      return `×${stage.size} docs`
    case 'custom':
      return approx ? 'custom ≈' : 'custom'
  }
}

export const groupKindLabel = (s: Stage) => (s.kind === 'groupBy' ? GROUP_LABEL[s.group.type] : '')
