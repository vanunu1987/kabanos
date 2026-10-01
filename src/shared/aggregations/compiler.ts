import type { FieldInfo } from '../meta'
import {
  fieldLabel,
  fieldSlug,
  isAggregatableType,
  isDateType,
  isNumericType,
  NUMERIC_OPS,
  safeName,
  sanitizeName,
  type Condition,
  type GroupSpec,
  type GroupType,
  type MetricDef,
  type Pipeline,
  type Stage,
  type StageOf
} from './model'

type Json = Record<string, unknown>

export interface CompileOptions {
  /** Compile only stages 0..upto (inclusive) — what each stage's preview runs. */
  upto?: number
  /** Preview caps: terms ≤ 10 buckets, top_hits ≤ 3, 3 sample docs with exact totals, 10 s timeout. */
  preview?: boolean
  /** Wrap the root aggs in a sampler (ES ≥ 8.2 random_sampler, else sampler). */
  sample?: { kind: 'random'; probability: number } | { kind: 'sampler'; shardSize?: number }
  /** Mapping fields of the target, for validation (aggregatable / numeric checks). */
  fields?: FieldInfo[]
  /** `_source` filter for sample documents (fields used later in the pipeline). */
  sourceFields?: string[]
  profile?: boolean
}

/** One nesting level of the agg tree. Level 0 is the request root; each Group by / post-group Filter opens the next. */
export interface LevelMeta {
  index: number
  parent: number | null
  kind: 'root' | 'multi' | 'single'
  /** Agg name that owns this level (undefined for the root). */
  name?: string
  stageIndex?: number
  groupType?: GroupType | 'filter'
  /** Key column(s) this level adds to flattened rows. */
  keys: string[]
  /** Short human label: "city", "month"… */
  label: string
}

export type ValueKind = 'single' | 'stats' | 'percentiles' | 'count' | 'hits' | 'raw'

export interface OutputMeta {
  level: number
  name: string
  stageIndex: number
  kind: ValueKind
  percents?: number[]
  /** The agg is under a single-bucket child of `level` (path from the level's bucket). */
  via?: string[]
}

export interface StageInfo {
  index: number
  /** JSON paths this stage produced in the request (for the JSON view gutter and highlighting). */
  paths: Array<Array<string | number>>
  /** Level the stage attaches to (-1 when not compiled). */
  level: number
  /** Agg names this stage created. */
  names: string[]
  errors: string[]
  warnings: string[]
  /** Whether the stage made it into the request. */
  emitted: boolean
}

export interface Compiled {
  request: Json
  stages: StageInfo[]
  levels: LevelMeta[]
  outputs: OutputMeta[]
  errors: Array<{ stageIndex: number; message: string }>
  /** Name of the root sampler agg wrapping everything, when sampling. */
  sampleWrapper?: string
  /** No Group by and no aggs: a plain search that returns documents. */
  documents: boolean
}

export const SAMPLE_AGG = 'kabanos_sample'
const PREVIEW_TERMS = 10
const PREVIEW_HITS = 3
const MAX_TOP_HITS = 100

interface Entry {
  kind: 'metric' | 'count' | 'bucket' | 'single' | 'pipeline' | 'hits' | 'custom'
  output?: OutputMeta
  /** For single-bucket children: the level they open. */
  child?: number
}

interface Level {
  meta: LevelMeta
  /** The object that owns `aggs` (request root parts or the agg body). */
  owner: Json
  path: Array<string | number>
  names: Map<string, Entry>
}

/** Pipeline → `_search` body, per-stage JSON paths, the level tree and validation errors (AGGREGATIONS.md §4). */
export function compile(pipeline: Pick<Pipeline, 'stages'>, opts: CompileOptions = {}): Compiled {
  const fieldTypes = new Map<string, string>()
  for (const f of opts.fields ?? []) if (!fieldTypes.has(f.path)) fieldTypes.set(f.path, f.type)
  const typeOf = (field: string) => fieldTypes.get(field)

  const all = pipeline.stages
  const upto = opts.upto ?? all.length - 1
  const infos: StageInfo[] = all.map((_, index) => ({ index, paths: [], level: -1, names: [], errors: [], warnings: [], emitted: false }))

  const rootAggs: Json = {}
  const rootOwner: Json = { aggs: rootAggs }
  const levels: Level[] = [{ meta: { index: 0, parent: null, kind: 'root', keys: [], label: 'all documents' }, owner: rootOwner, path: ['aggs'], names: new Map() }]
  const outputs: OutputMeta[] = []
  const rootClauses: Array<{ stageIndex: number; stage: StageOf<'filter'> }> = []
  const root: { sort?: unknown[]; size?: number; from?: number; source?: unknown; extras: Json[] } = { extras: [] }
  const fixups: Array<() => void> = []
  let current = 0
  let sawAgg = false

  const levelPath = (l: number) => levels[l]!.path
  const containerOf = (l: number): Json => {
    const lv = levels[l]!
    lv.owner.aggs ??= {}
    return lv.owner.aggs as Json
  }
  const uniq = (l: number, base: string): string => {
    const taken = levels[l]!.names
    if (!taken.has(base)) return base
    for (let i = 2; ; i++) if (!taken.has(`${base}_${i}`)) return `${base}_${i}`
  }
  const put = (l: number, name: string, body: Json, entry: Entry, si: number) => {
    containerOf(l)[name] = body
    levels[l]!.names.set(name, entry)
    infos[si]!.paths.push([...levelPath(l), name])
    infos[si]!.names.push(name)
    if (entry.output) outputs.push(entry.output)
    sawAgg = true
  }
  const multiChain = (from: number): number[] => {
    const out: number[] = []
    for (let l: number | null = from; l !== null; l = levels[l]!.meta.parent) if (levels[l]!.meta.kind === 'multi') out.push(l)
    return out
  }

  /** Resolve a metric reference at level `l` to a buckets_path (siblings, or through single-bucket children with `>`). */
  const resolveRef = (l: number, ref: string): string | null => {
    if (ref === '_count' || ref === '_key') return ref
    const dot = ref.indexOf('.')
    const base = dot >= 0 ? ref.slice(0, dot) : ref
    const sub = dot >= 0 ? ref.slice(dot + 1) : undefined
    const lookup = (lv: number, prefix: string[]): string | null => {
      const e = levels[lv]!.names.get(base)
      if (e) {
        const p = [...prefix, base].join('>')
        if (e.kind === 'count') return prefix.length ? `${prefix.join('>')}>_count` : '_count'
        if (e.kind === 'pipeline' || (e.kind === 'metric' && e.output?.kind === 'single')) return sub ? null : p
        if (e.kind === 'metric' && e.output?.kind === 'stats') return sub && ['min', 'max', 'avg', 'sum', 'count'].includes(sub) ? `${p}.${sub}` : null
        if (e.kind === 'metric' && e.output?.kind === 'percentiles') {
          const pcts = e.output.percents ?? []
          if (sub) return pcts.some((x) => String(x) === sub || x === Number(sub)) ? `${p}.${sub}` : null
          return pcts.length === 1 ? `${p}.${pcts[0]}` : null
        }
        return null
      }
      for (const [name, entry] of levels[lv]!.names) {
        if (entry.kind === 'single' && entry.child !== undefined) {
          const found = lookup(entry.child, [...prefix, name])
          if (found) return found
        }
      }
      return null
    }
    return lookup(l, [])
  }

  /** Pick the innermost multi-bucket level where every reference resolves (stages that read metrics climb to them). */
  const placeReading = (refs: string[], si: number): { level: number; paths: Map<string, string> } | null => {
    const chain = multiChain(current)
    if (!chain.length) {
      infos[si]!.errors.push('Needs a Group by above it.')
      return null
    }
    const metricRefs = refs.filter((r) => r !== '_count' && r !== '_key')
    for (const l of chain) {
      const paths = new Map<string, string>()
      let ok = true
      for (const r of refs) {
        const p = resolveRef(l, r)
        if (p === null) ok = false
        else paths.set(r, p)
      }
      if (ok && (metricRefs.length || l === chain[0])) return { level: l, paths }
    }
    const missing = metricRefs.filter((r) => !chain.some((l) => resolveRef(l, r) !== null))
    const shown = missing.length ? missing : metricRefs
    infos[si]!.errors.push(shown.length ? `No metric named ${shown.map((m) => `“${m}”`).join(', ')} at this level.` : 'Pick a metric.')
    return null
  }

  for (let si = 0; si <= upto && si < all.length; si++) {
    const stage = all[si]!
    const info = infos[si]!
    if (!stage.enabled) continue
    const hasGroup = levels.length > 1

    switch (stage.kind) {
      case 'filter': {
        const errs = filterErrors(stage)
        if (errs.length) {
          info.errors.push(...errs)
          break
        }
        if (!stage.raw && stage.conditions.length === 0) break
        if (!hasGroup) {
          rootClauses.push({ stageIndex: si, stage })
          info.level = 0
          info.emitted = true
          break
        }
        const name = uniq(current, safeName(stage.name) || `filter_${si + 1}`)
        const lvl = levels.length
        put(current, name, { filter: filterQuery([stage]) }, { kind: 'single', child: lvl }, si)
        levels.push({ meta: { index: lvl, parent: current, kind: 'single', name, stageIndex: si, groupType: 'filter', keys: [], label: 'filtered' }, owner: containerOf(current)[name] as Json, path: [...levelPath(current), name, 'aggs'], names: new Map() })
        info.level = current
        current = lvl
        info.emitted = true
        break
      }
      case 'groupBy': {
        const g = stage.group
        const errs = groupErrors(g, typeOf)
        if (errs.length) {
          info.errors.push(...errs)
          break
        }
        const name = uniq(current, safeName(stage.name) || defaultGroupName(g))
        const body = groupBody(g, opts.preview)
        const lvl = levels.length
        put(current, name, body, { kind: 'bucket', child: lvl }, si)
        const keys = groupKeys(g)
        levels.push({ meta: { index: lvl, parent: current, kind: 'multi', name, stageIndex: si, groupType: g.type, keys, label: groupLabel(g) }, owner: body, path: [...levelPath(current), name, 'aggs'], names: new Map() })
        if (g.type === 'terms' && g.order && g.order.by !== '_count' && g.order.by !== '_key') {
          const by = g.order.by
          const dir = g.order.dir
          const inner = body.terms as Json
          fixups.push(() => {
            const p = resolveRef(lvl, by)
            if (p === null) info.errors.push(`Order by: no metric named “${by}” inside this group.`)
            else inner.order = { [p]: dir }
          })
        }
        info.level = current
        current = lvl
        info.emitted = true
        break
      }
      case 'metrics': {
        let n = 0
        stage.metrics.forEach((m, mi) => {
          const err = metricError(m, typeOf)
          if (err) return info.errors.push(`Metric ${mi + 1}: ${err}`)
          const name = uniq(current, safeName(m.name) || defaultMetricName(m))
          if (m.op === 'count') {
            levels[current]!.names.set(name, { kind: 'count', output: { level: current, name, stageIndex: si, kind: 'count' } })
            outputs.push({ level: current, name, stageIndex: si, kind: 'count' })
            info.names.push(name)
            n++
            return
          }
          const out: OutputMeta = { level: current, name, stageIndex: si, kind: m.op === 'stats' ? 'stats' : m.op === 'median' || m.op === 'percentiles' ? 'percentiles' : 'single' }
          if (out.kind === 'percentiles') out.percents = m.op === 'median' ? [50] : m.percents?.length ? m.percents : [50, 95, 99]
          put(current, name, metricBody(m), { kind: 'metric', output: out }, si)
          n++
        })
        if (n) (info.level = current), (info.emitted = true)
        break
      }
      case 'keepOnly': {
        const rules = stage.rules.filter((r) => r.metric)
        if (!rules.length) {
          info.errors.push('Add a rule: metric · comparator · number.')
          break
        }
        const bad = rules.find((r) => !Number.isFinite(r.value) || !['>', '>=', '<', '<=', '==', '!='].includes(r.cmp))
        if (bad) {
          info.errors.push(`“${bad.metric}”: the value must be a number.`)
          break
        }
        const placed = placeReading(rules.map((r) => r.metric), si)
        if (!placed) break
        const distinct = [...new Set(rules.map((r) => placed.paths.get(r.metric)!))]
        const varOf = (p: string) => (distinct.length === 1 ? 'p' : `p${distinct.indexOf(p)}`)
        const bucketsPath = Object.fromEntries(distinct.map((p) => [varOf(p), p]))
        const script = rules.map((r) => `params.${varOf(placed.paths.get(r.metric)!)} ${r.cmp} ${numLiteral(r.value)}`).join(' && ')
        const name = uniq(placed.level, safeName(stage.name) || `keep_${si + 1}`)
        put(placed.level, name, { bucket_selector: { buckets_path: bucketsPath, script } }, { kind: 'pipeline' }, si)
        info.level = placed.level
        info.emitted = true
        break
      }
      case 'sortLimit': {
        if (!Number.isInteger(stage.size) || stage.size < 0) {
          info.errors.push('Keep must be a whole number.')
          break
        }
        if (!hasGroup) {
          if (stage.by && stage.by !== '_count' && stage.by !== '_key') root.sort = [{ [stage.by]: { order: stage.dir } }]
          root.size = stage.size
          if (stage.from) root.from = stage.from
          info.level = 0
          info.emitted = true
          info.paths.push(['sort'], ['size'])
          break
        }
        const placed = placeReading([stage.by || '_count'], si)
        if (!placed) break
        const body: Json = { sort: [{ [placed.paths.get(stage.by || '_count')!]: { order: stage.dir } }], size: stage.size }
        if (stage.from) body.from = stage.from
        const name = uniq(placed.level, safeName(stage.name) || `top_${stage.size}`)
        put(placed.level, name, { bucket_sort: body }, { kind: 'pipeline' }, si)
        info.level = placed.level
        info.emitted = true
        break
      }
      case 'runningTotal':
      case 'changeOverTime': {
        if (!stage.metric) {
          info.errors.push('Pick a metric.')
          break
        }
        const placed = placeReading([stage.metric], si)
        if (!placed) break
        const gt = levels[placed.level]!.meta.groupType
        if (gt !== 'histogram' && gt !== 'date_histogram') {
          info.errors.push(`${stage.kind === 'runningTotal' ? 'Running total' : 'Change over time'} works only inside a Histogram or Date histogram group.`)
          break
        }
        const path = placed.paths.get(stage.metric)!
        const slug = sanitizeName(stage.metric.replace(/^_/, ''))
        if (stage.kind === 'runningTotal') {
          const name = uniq(placed.level, safeName(stage.name) || `running_${slug}`)
          put(placed.level, name, { cumulative_sum: { buckets_path: path } }, { kind: 'pipeline', output: { level: placed.level, name, stageIndex: si, kind: 'single' } }, si)
        } else {
          const name = uniq(placed.level, safeName(stage.name) || `${slug}_change`)
          if (stage.mode === 'diff') {
            put(placed.level, name, { derivative: { buckets_path: path } }, { kind: 'pipeline', output: { level: placed.level, name, stageIndex: si, kind: 'single' } }, si)
          } else {
            const diff = uniq(placed.level, `${name}_diff`)
            put(placed.level, diff, { derivative: { buckets_path: path } }, { kind: 'pipeline' }, si)
            put(placed.level, name, { bucket_script: { buckets_path: { d: diff, v: path }, script: PCT_SCRIPT } }, { kind: 'pipeline', output: { level: placed.level, name, stageIndex: si, kind: 'single' } }, si)
          }
        }
        info.level = placed.level
        info.emitted = true
        break
      }
      case 'topDocs': {
        if (!Number.isInteger(stage.size) || stage.size < 1) {
          info.errors.push('Show at least 1 document.')
          break
        }
        let size = stage.size
        if (size > MAX_TOP_HITS) {
          info.warnings.push(`Capped at ${MAX_TOP_HITS} documents per bucket.`)
          size = MAX_TOP_HITS
        }
        if (opts.preview) size = Math.min(size, PREVIEW_HITS)
        if (!hasGroup) {
          root.size = size
          if (stage.sort?.field) root.sort = [{ [stage.sort.field]: { order: stage.sort.dir } }]
          if (stage.fields?.length) root.source = { includes: stage.fields }
          info.level = 0
          info.emitted = true
          info.paths.push(['size'])
          break
        }
        const body: Json = { size }
        if (stage.sort?.field) body.sort = [{ [stage.sort.field]: { order: stage.sort.dir } }]
        if (stage.fields?.length) body._source = { includes: stage.fields }
        const name = uniq(current, safeName(stage.name) || 'top_docs')
        put(current, name, { top_hits: body }, { kind: 'hits', output: { level: current, name, stageIndex: si, kind: 'hits' } }, si)
        info.level = current
        info.emitted = true
        break
      }
      case 'custom': {
        if (!stage.json || typeof stage.json !== 'object' || Array.isArray(stage.json)) {
          info.errors.push('The JSON must be an object.')
          break
        }
        if (stage.place === 'request') {
          root.extras.push(stage.json)
          info.level = 0
          info.emitted = true
          info.paths.push(...Object.keys(stage.json).map((k) => [k]))
          break
        }
        const name = uniq(current, safeName(stage.name) || 'custom')
        put(current, name, stage.json, { kind: 'custom', output: { level: current, name, stageIndex: si, kind: 'raw' } }, si)
        info.level = current
        info.emitted = true
        break
      }
    }
  }
  for (const f of fixups) f()

  // ---- assemble the request (key order mirrors the mockup: size, query, aggs) ----
  const request: Json = {}
  const hasAggs = Object.keys(rootAggs).length > 0
  const documents = !hasAggs && levels.length === 1
  if (opts.preview) {
    request.size = hasAggs ? 0 : Math.min(root.size ?? PREVIEW_HITS, PREVIEW_HITS)
  } else if (root.size !== undefined) request.size = root.size
  else if (hasAggs) request.size = 0
  if (root.from !== undefined) request.from = root.from
  if (rootClauses.length) {
    const q = filterQuery(rootClauses.map((c) => c.stage))
    request.query = q
    // Per-stage paths into the root query.
    if (rootClauses.length === 1 && (rootClauses[0]!.stage.raw || rootClauses[0]!.stage.match === 'any')) infos[rootClauses[0]!.stageIndex]!.paths.push(['query'])
    else {
      let fi = 0
      let ni = 0
      for (const { stageIndex, stage } of rootClauses) {
        const p = infos[stageIndex]!.paths
        if (stage.raw || stage.match === 'any') p.push(['query', 'bool', 'filter', fi++])
        else
          for (const c of stage.conditions) {
            if (c.op === 'isNot' || c.op === 'missing') p.push(['query', 'bool', 'must_not', ni++])
            else p.push(['query', 'bool', 'filter', fi++])
          }
      }
    }
  }
  if (root.sort) request.sort = root.sort
  if (root.source) request._source = root.source
  else if (opts.preview && !hasAggs && opts.sourceFields?.length) request._source = { includes: opts.sourceFields }
  if (opts.preview) {
    request.track_total_hits = true
    request.timeout = '10s'
  }
  let sampleWrapper: string | undefined
  if (hasAggs) {
    if (opts.sample) {
      sampleWrapper = SAMPLE_AGG
      const sampler = opts.sample.kind === 'random' ? { random_sampler: { probability: opts.sample.probability } } : { sampler: { shard_size: opts.sample.shardSize ?? 10_000 } }
      request.aggs = { [SAMPLE_AGG]: { ...sampler, aggs: rootAggs } }
      for (const info of infos) info.paths = info.paths.map((p) => (p[0] === 'aggs' ? ['aggs', SAMPLE_AGG, ...p] : p))
    } else request.aggs = rootAggs
  }
  for (const extra of root.extras) Object.assign(request, extra)
  if (opts.profile) request.profile = true

  const errors = infos.flatMap((i) => i.errors.map((message) => ({ stageIndex: i.index, message })))
  return { request, stages: infos, levels: levels.map((l) => l.meta), outputs, errors, sampleWrapper, documents }
}

export const PCT_SCRIPT = 'params.d / (params.v - params.d) * 100'

const numLiteral = (n: number): string => String(n)

// ---------- filters ----------

function filterErrors(s: StageOf<'filter'>): string[] {
  if (s.raw) return []
  const out: string[] = []
  s.conditions.forEach((c, i) => {
    const n = s.conditions.length > 1 ? `Condition ${i + 1}: ` : ''
    if (!c.field) out.push(`${n}pick a field.`)
    else if (c.op === 'oneOf' && !c.values?.length) out.push(`${n}add at least one value.`)
    else if (c.op === 'between' && (isBlank(c.value) || isBlank(c.value2))) out.push(`${n}between needs two values.`)
    else if (!['exists', 'missing', 'oneOf', 'between'].includes(c.op) && isBlank(c.value)) out.push(`${n}enter a value.`)
  })
  return out
}

const isBlank = (v: unknown) => v === undefined || v === null || v === ''

/** One condition → a query clause (negated conditions return the positive clause; see `isNegated`). */
export function conditionClause(c: Condition): Json {
  switch (c.op) {
    case 'is':
    case 'isNot':
      return { term: { [c.field]: c.value } }
    case 'oneOf':
      return { terms: { [c.field]: c.values ?? [] } }
    case 'exists':
    case 'missing':
      return { exists: { field: c.field } }
    case 'lt':
    case 'lte':
    case 'gt':
    case 'gte':
      return { range: { [c.field]: { [c.op]: c.value } } }
    case 'between':
      return { range: { [c.field]: { gte: c.value, lte: c.value2 } } }
    case 'contains':
      return { match: { [c.field]: c.value } }
  }
}

export const isNegated = (c: Condition) => c.op === 'isNot' || c.op === 'missing'

/** A clause that is true for the condition, negations included. */
export function conditionQuery(c: Condition): Json {
  return isNegated(c) ? { bool: { must_not: [conditionClause(c)] } } : conditionClause(c)
}

function anyQuery(s: StageOf<'filter'>): Json {
  return { bool: { should: s.conditions.map(conditionQuery), minimum_should_match: 1 } }
}

/** Filter stages → one query. A single raw / match-any stage is used as is; otherwise everything goes in one bool. */
export function filterQuery(stages: Array<StageOf<'filter'>>): Json {
  if (stages.length === 1 && stages[0]!.raw) return stages[0]!.raw
  if (stages.length === 1 && stages[0]!.match === 'any') return anyQuery(stages[0]!)
  const filter: Json[] = []
  const mustNot: Json[] = []
  for (const s of stages) {
    if (s.raw) filter.push(s.raw)
    else if (s.match === 'any') filter.push(anyQuery(s))
    else for (const c of s.conditions) (isNegated(c) ? mustNot : filter).push(conditionClause(c))
  }
  const bool: Json = {}
  if (filter.length) bool.filter = filter
  if (mustNot.length) bool.must_not = mustNot
  return { bool }
}

// ---------- group by ----------

function groupErrors(g: GroupSpec, typeOf: (f: string) => string | undefined): string[] {
  const fields = g.type === 'filters' ? [] : g.type === 'composite' ? g.sources.map((s) => s.field) : [g.field]
  if (g.type === 'composite' && g.sources.length === 0) return ['Add at least one field.']
  if (g.type === 'filters') {
    if (!g.filters.length) return ['Add at least one named filter.']
    const bad = g.filters.find((f) => !f.name || !f.condition.field)
    return bad ? ['Every named filter needs a name and a field.'] : []
  }
  for (const f of fields) {
    if (!f) return ['Pick a field.']
    const t = typeOf(f)
    if (t === 'text') return [`“${f}” is a text field and can't be grouped — use ${f}.keyword.`]
    if (t && !isAggregatableType(t)) return [`“${f}” (${t}) can't be aggregated.`]
    if (t && (g.type === 'histogram' || g.type === 'range') && !isNumericType(t)) return [`${g.type === 'range' ? 'Number ranges' : 'Histogram'} needs a numeric field; “${f}” is ${t}.`]
    if (t && (g.type === 'date_histogram' || g.type === 'date_range') && !isDateType(t)) return [`Date grouping needs a date field; “${f}” is ${t}.`]
  }
  if (g.type === 'terms') {
    if (!Number.isInteger(g.size) || g.size < 1) return ['Buckets must be at least 1.']
    const t = typeOf(g.field)
    if (g.missing === 'bucket' && t && (isNumericType(t) || isDateType(t))) return ['A “(missing)” bucket needs a keyword field.']
  }
  if (g.type === 'histogram' && !(g.interval > 0)) return ['The interval must be above 0.']
  if (g.type === 'date_histogram' && !g.calendarInterval && !g.fixedInterval) return ['Pick an interval.']
  if ((g.type === 'range' || g.type === 'date_range') && !g.ranges.length) return ['Add at least one range.']
  return []
}

export function defaultGroupName(g: GroupSpec): string {
  if (g.type === 'filters') return 'by_filter'
  if (g.type === 'composite') return `by_${g.sources.map((s) => fieldSlug(s.field)).join('_and_') || 'fields'}`
  if (g.type === 'date_histogram') return `by_${g.calendarInterval ?? fieldSlug(g.field)}`
  return `by_${fieldSlug(g.field)}`
}

function groupLabel(g: GroupSpec): string {
  if (g.type === 'filters') return 'filter'
  if (g.type === 'composite') return g.sources.map((s) => s.field).join(' + ')
  if (g.type === 'date_histogram' && g.calendarInterval) return g.calendarInterval
  return fieldLabel(g.field)
}

function groupKeys(g: GroupSpec): string[] {
  if (g.type === 'filters') return ['filter']
  if (g.type === 'composite') return compositeNames(g.sources)
  return [g.field]
}

function compositeNames(sources: Array<{ field: string }>): string[] {
  const seen = new Set<string>()
  return sources.map((s) => {
    let n = fieldSlug(s.field)
    for (let i = 2; seen.has(n); i++) n = `${fieldSlug(s.field)}_${i}`
    seen.add(n)
    return n
  })
}

function groupBody(g: GroupSpec, preview?: boolean): Json {
  switch (g.type) {
    case 'terms': {
      const t: Json = { field: g.field, size: preview ? Math.min(g.size, PREVIEW_TERMS) : g.size }
      if (g.order && !(g.order.by === '_count' && g.order.dir === 'desc')) {
        if (g.order.by === '_count' || g.order.by === '_key') t.order = { [g.order.by]: g.order.dir }
      }
      if (g.missing === 'bucket') t.missing = MISSING_KEY
      if (g.minDocCount !== undefined) t.min_doc_count = g.minDocCount
      return { terms: t }
    }
    case 'histogram': {
      const h: Json = { field: g.field, interval: g.interval }
      if (g.minDocCount !== undefined) h.min_doc_count = g.minDocCount
      return { histogram: h }
    }
    case 'date_histogram': {
      const h: Json = { field: g.field }
      if (g.calendarInterval) h.calendar_interval = g.calendarInterval
      else if (g.fixedInterval) h.fixed_interval = g.fixedInterval
      if (g.minDocCount !== undefined) h.min_doc_count = g.minDocCount
      if (g.format) h.format = g.format
      if (g.timeZone) h.time_zone = g.timeZone
      return { date_histogram: h }
    }
    case 'range':
      return { range: { field: g.field, ranges: g.ranges.map(rangeEntry) } }
    case 'date_range': {
      const r: Json = { field: g.field }
      if (g.format) r.format = g.format
      r.ranges = g.ranges.map(rangeEntry)
      return { date_range: r }
    }
    case 'filters':
      return { filters: { filters: Object.fromEntries(g.filters.map((f) => [f.name, conditionQuery(f.condition)])) } }
    case 'composite': {
      const names = compositeNames(g.sources)
      const sources = g.sources.map((s, i) => {
        const inner: Json = { field: s.field }
        if (s.type === 'histogram') inner.interval = s.interval
        if (s.type === 'date_histogram') inner.calendar_interval = s.interval
        return { [names[i]!]: { [s.type]: inner } }
      })
      return { composite: { size: preview ? Math.min(g.size, PREVIEW_TERMS) : g.size, sources } }
    }
  }
}

export const MISSING_KEY = '(missing)'

function rangeEntry(r: { from?: number | string; to?: number | string; key?: string }): Json {
  const o: Json = {}
  if (r.key) o.key = r.key
  if (r.from !== undefined && r.from !== '') o.from = r.from
  if (r.to !== undefined && r.to !== '') o.to = r.to
  return o
}

// ---------- metrics ----------

function metricError(m: MetricDef, typeOf: (f: string) => string | undefined): string | null {
  if (m.op === 'count') return null
  if (!m.field) return 'pick a field.'
  const t = typeOf(m.field)
  if (t && NUMERIC_OPS.has(m.op) && !isNumericType(t)) return `${m.op === 'avg' ? 'average' : m.op} needs a numeric field; “${m.field}” is ${t}.`
  if (t === 'text') return `“${m.field}” is a text field — use ${m.field}.keyword.`
  if (m.op === 'percentiles' && m.percents?.some((p) => !(p >= 0 && p <= 100))) return 'percentiles must be between 0 and 100.'
  return null
}

export function defaultMetricName(m: MetricDef): string {
  if (m.op === 'count') return 'count'
  const slug = fieldSlug(m.field ?? '')
  const op = m.op === 'cardinality' ? 'unique' : m.op === 'value_count' ? 'count' : m.op
  return `${op}_${slug}`
}

function metricBody(m: MetricDef): Json {
  switch (m.op) {
    case 'median':
      return { percentiles: { field: m.field, percents: [50] } }
    case 'percentiles':
      return { percentiles: { field: m.field, percents: m.percents?.length ? m.percents : [50, 95, 99] } }
    case 'count':
      return {}
    default:
      return { [m.op]: { field: m.field } }
  }
}

/** Every field a pipeline reads — the preview's sample documents show only these. */
export function fieldsUsed(stages: Stage[]): string[] {
  const out = new Set<string>()
  for (const s of stages) {
    if (!s.enabled) continue
    if (s.kind === 'filter') s.conditions.forEach((c) => c.field && out.add(c.field))
    if (s.kind === 'groupBy') {
      const g = s.group
      if (g.type === 'composite') g.sources.forEach((x) => out.add(x.field))
      else if (g.type === 'filters') g.filters.forEach((f) => f.condition.field && out.add(f.condition.field))
      else if (g.field) out.add(g.field)
    }
    if (s.kind === 'metrics') s.metrics.forEach((m) => m.field && out.add(m.field))
    if (s.kind === 'topDocs') s.fields?.forEach((f) => out.add(f))
  }
  // Sample docs come from _source: `.keyword` sub-fields live under their parent.
  return [...out].map((f) => f.replace(/\.(keyword|raw)$/, ''))
}
