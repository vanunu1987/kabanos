import { compile, conditionClause, conditionQuery, filterQuery, PCT_SCRIPT, MISSING_KEY } from './compiler'
import { jsonEqual, newId, type Condition, type GroupSpec, type MetricDef, type Pipeline, type Scalar, type Stage, type StageOf, clone } from './model'

type Json = Record<string, unknown>

export interface Decompiled {
  stages: Stage[]
  /** Parts that didn't map to a form and were kept verbatim as Custom JSON stages (never dropped). */
  unsupported: string[]
  /** compile(stages) reproduces the input exactly. */
  exact: boolean
}

interface Strategy {
  pipelinesAsCustom?: boolean
  aggsAsCustom?: boolean
  queryRaw?: boolean
}

const STRATEGIES: Strategy[] = [{}, { pipelinesAsCustom: true }, { aggsAsCustom: true }, { aggsAsCustom: true, queryRaw: true }]

/** `_search` body → stages (AGGREGATIONS.md §5). Tries the richest mapping first and keeps the first that round-trips. */
export function decompile(body: Json): Decompiled {
  let last: Decompiled | undefined
  for (const strategy of STRATEGIES) {
    const unsupported: string[] = []
    const stages = build(body, strategy, unsupported)
    const exact = jsonEqual(compile({ stages }).request, body)
    last = { stages, unsupported, exact }
    if (exact) return last
  }
  return last!
}

const isObj = (v: unknown): v is Json => !!v && typeof v === 'object' && !Array.isArray(v)
const isScalar = (v: unknown): v is Scalar => typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean'
const only = (o: Json, ...keys: string[]) => Object.keys(o).every((k) => keys.includes(k))
const base = { enabled: true } as const

function build(body: Json, strategy: Strategy, unsupported: string[]): Stage[] {
  const stages: Stage[] = []
  const rest: Json = {}
  // Agg entries must be objects; anything else is kept verbatim as a request option.
  const aggs = isObj(body.aggs) && Object.values(body.aggs).every(isObj) ? body.aggs : undefined
  for (const [k, v] of Object.entries(body)) if (!['query', 'aggs', 'size', 'from', 'sort', '_source'].includes(k) || (k === 'aggs' && !aggs)) rest[k] = v

  if (body.query !== undefined) {
    if (isObj(body.query)) stages.push(...(strategy.queryRaw ? [rawFilter(body.query)] : queryStages(body.query)))
    else rest.query = body.query
  }

  // Root sort / size / from / _source: a document search (Sort & limit or Top documents at the root).
  const sort = parseSort(body.sort)
  const extraRoot: Json = {}
  if (body.sort !== undefined && sort === null) extraRoot.sort = body.sort
  const source = isObj(body._source) && only(body._source, 'includes') && Array.isArray(body._source.includes) && body._source.includes.every((f) => typeof f === 'string') ? (body._source.includes as string[]) : undefined
  if (body._source !== undefined && !source) extraRoot._source = body._source
  const size = typeof body.size === 'number' && Number.isInteger(body.size) && body.size >= 0 ? body.size : undefined
  if (body.size !== undefined && size === undefined) extraRoot.size = body.size
  const from = typeof body.from === 'number' && Number.isInteger(body.from) && body.from > 0 ? body.from : undefined
  if (body.from !== undefined && from === undefined) extraRoot.from = body.from

  const rootDocs: Stage[] = []
  if (aggs) {
    // With aggs, `size: 0` is implied; anything else is kept as a request option.
    if (size !== undefined && size !== 0) extraRoot.size = size
    if (sort) extraRoot.sort = body.sort
    if (source) extraRoot._source = body._source
    if (from !== undefined) extraRoot.from = from
  } else if (source && size !== undefined && size >= 1 && from === undefined) {
    rootDocs.push({ id: newId(), ...base, kind: 'topDocs', size, ...(sort ? { sort: { field: sort.field, dir: sort.dir } } : {}), fields: source })
  } else {
    if (source) extraRoot._source = body._source
    if (size !== undefined || sort || from !== undefined) {
      if (size === undefined) {
        // Sort & limit always sets a size; keep a bare sort/from as a request option instead.
        if (sort) extraRoot.sort = body.sort
        if (from !== undefined) extraRoot.from = from
      } else rootDocs.push({ id: newId(), ...base, kind: 'sortLimit', by: sort?.field ?? '_count', dir: sort?.dir ?? 'desc', size, ...(from !== undefined ? { from } : {}) })
    }
  }

  if (aggs) {
    if (strategy.aggsAsCustom) {
      for (const [name, agg] of Object.entries(aggs)) {
        stages.push(custom(name, agg))
        unsupported.push(`aggs.${name}`)
      }
    } else levelStages(aggs, 0, strategy, unsupported, 'aggs', stages)
  }
  stages.push(...rootDocs)
  const extras = { ...extraRoot, ...rest }
  if (Object.keys(extras).length) stages.push({ id: newId(), ...base, kind: 'custom', name: 'request options', place: 'request', json: extras })
  return stages
}

function custom(name: string, json: unknown): StageOf<'custom'> {
  return { id: newId(), ...base, kind: 'custom', name, json: isObj(json) ? clone(json) : { value: json } }
}

function rawFilter(q: Json): StageOf<'filter'> {
  return { id: newId(), ...base, kind: 'filter', match: 'all', conditions: [], raw: clone(q) }
}

function parseSort(sort: unknown): { field: string; dir: 'asc' | 'desc' } | null {
  if (!Array.isArray(sort) || sort.length !== 1 || !isObj(sort[0])) return null
  const entries = Object.entries(sort[0])
  if (entries.length !== 1) return null
  const [field, spec] = entries[0]!
  if (!isObj(spec) || !only(spec, 'order') || (spec.order !== 'asc' && spec.order !== 'desc')) return null
  return { field, dir: spec.order }
}

// ---------- query → filter stages ----------

export function parseCondition(clause: unknown): Condition | null {
  if (!isObj(clause)) return null
  const keys = Object.keys(clause)
  if (keys.length !== 1) return null
  const kind = keys[0]!
  const inner = clause[kind]
  if (!isObj(inner)) return null
  const entries = Object.entries(inner)
  let c: Condition | null = null
  if (kind === 'exists' && only(inner, 'field') && typeof inner.field === 'string') c = { field: inner.field, op: 'exists' }
  else if (entries.length === 1) {
    const [field, v] = entries[0]!
    if (kind === 'term' && isScalar(v)) c = { field, op: 'is', value: v }
    else if (kind === 'terms' && Array.isArray(v) && v.length && v.every(isScalar)) c = { field, op: 'oneOf', values: v as Scalar[] }
    else if (kind === 'match' && isScalar(v)) c = { field, op: 'contains', value: v }
    else if (kind === 'range' && isObj(v)) {
      const ops = Object.keys(v)
      if (ops.length === 1 && ['lt', 'lte', 'gt', 'gte'].includes(ops[0]!) && isScalar(v[ops[0]!])) c = { field, op: ops[0] as 'lt', value: v[ops[0]!] as Scalar }
      else if (ops.length === 2 && 'gte' in v && 'lte' in v && isScalar(v.gte) && isScalar(v.lte)) c = { field, op: 'between', value: v.gte, value2: v.lte }
    }
  }
  return c && jsonEqual(conditionClause(c), clause) ? c : null
}

/** The exclude twin of a condition: is → is not, exists → does not exist, anything else → negate. */
function negateCondition(c: Condition): Condition {
  if (c.op === 'is') return { ...c, op: 'isNot' }
  if (c.op === 'exists') return { ...c, op: 'missing' }
  return { ...c, negate: true }
}

/** A clause that may be negated (`bool.must_not: [x]`). */
export function parseConditionQuery(q: unknown): Condition | null {
  if (isObj(q) && isObj(q.bool) && only(q, 'bool') && only(q.bool, 'must_not') && Array.isArray(q.bool.must_not) && q.bool.must_not.length === 1) {
    const c = parseCondition(q.bool.must_not[0])
    const neg = c ? negateCondition(c) : null
    return neg && jsonEqual(conditionQuery(neg), q) ? neg : null
  }
  return parseCondition(q)
}

function parseAny(q: unknown): StageOf<'filter'> | null {
  if (!isObj(q) || !only(q, 'bool') || !isObj(q.bool) || !only(q.bool, 'should', 'minimum_should_match') || q.bool.minimum_should_match !== 1 || !Array.isArray(q.bool.should) || !q.bool.should.length) return null
  const conds = q.bool.should.map(parseConditionQuery)
  if (conds.some((c) => !c)) return null
  return { id: newId(), ...base, kind: 'filter', match: 'any', conditions: conds as Condition[] }
}

function queryStages(q: Json): Array<StageOf<'filter'>> {
  const any = parseAny(q)
  if (any) return [any]
  const out = boolStages(q)
  if (out && jsonEqual(filterQuery(out), q)) return out
  return [rawFilter(q)]
}

function boolStages(q: Json): Array<StageOf<'filter'>> | null {
  if (!only(q, 'bool') || !isObj(q.bool) || !only(q.bool, 'filter', 'must_not')) return null
  const filter = q.bool.filter ?? []
  const mustNot = q.bool.must_not ?? []
  if (!Array.isArray(filter) || !Array.isArray(mustNot) || (!filter.length && !mustNot.length)) return null
  const stages: Array<StageOf<'filter'>> = []
  let open: StageOf<'filter'> | null = null
  for (const clause of filter) {
    const c = parseCondition(clause)
    if (c) {
      if (!open) stages.push((open = { id: newId(), ...base, kind: 'filter', match: 'all', conditions: [] }))
      open.conditions.push(c)
      continue
    }
    open = null
    const any = parseAny(clause)
    stages.push(any ?? rawFilter(clause as Json))
  }
  if (mustNot.length) {
    const negs: Condition[] = []
    for (const clause of mustNot) {
      const c = parseCondition(clause)
      if (!c) return null
      negs.push(negateCondition(c))
    }
    const lastAll = [...stages].reverse().find((s) => !s.raw && s.match === 'all')
    if (lastAll) lastAll.conditions.push(...negs)
    else stages.push({ id: newId(), ...base, kind: 'filter', match: 'all', conditions: negs })
  }
  // A lone match-any / raw stage would compile without the bool wrapper.
  if (stages.length === 1 && (stages[0]!.raw || stages[0]!.match === 'any')) return null
  return stages
}

// ---------- aggs → stages ----------

const BUCKET_TYPES = ['terms', 'histogram', 'date_histogram', 'range', 'date_range', 'filters', 'composite'] as const
const METRIC_TYPES = ['avg', 'sum', 'min', 'max', 'stats', 'cardinality', 'value_count', 'percentiles'] as const

function aggType(agg: Json): string | undefined {
  return Object.keys(agg).find((k) => k !== 'aggs' && k !== 'aggregations' && k !== 'meta')
}

export function parseMetric(name: string, agg: unknown): MetricDef | null {
  if (!isObj(agg) || Object.keys(agg).length !== 1) return null
  const type = Object.keys(agg)[0]!
  const inner = agg[type]
  if (!isObj(inner) || typeof inner.field !== 'string' || !(METRIC_TYPES as readonly string[]).includes(type)) return null
  if (type === 'percentiles') {
    if (!only(inner, 'field', 'percents') || !Array.isArray(inner.percents) || !inner.percents.length || !inner.percents.every((p) => typeof p === 'number')) return null
    const percents = inner.percents as number[]
    return percents.length === 1 && percents[0] === 50 ? { name, op: 'median', field: inner.field } : { name, op: 'percentiles', field: inner.field, percents }
  }
  if (!only(inner, 'field')) return null
  return { name, op: type as MetricDef['op'], field: inner.field }
}

export function parseGroup(agg: Json): GroupSpec | null {
  const type = aggType(agg)
  if (!type || !(BUCKET_TYPES as readonly string[]).includes(type) || !only(agg, type, 'aggs')) return null
  const t = agg[type]
  if (!isObj(t)) return null
  const num = (v: unknown) => (typeof v === 'number' && Number.isInteger(v) && v >= 0 ? v : undefined)
  let g: GroupSpec | null = null
  switch (type) {
    case 'terms': {
      if (typeof t.field !== 'string' || !only(t, 'field', 'size', 'order', 'missing', 'min_doc_count') || num(t.size) === undefined) return null
      g = { type: 'terms', field: t.field, size: t.size as number }
      if (t.order !== undefined) {
        if (!isObj(t.order) || Object.keys(t.order).length !== 1) return null
        const [by, dir] = Object.entries(t.order)[0]!
        if (dir !== 'asc' && dir !== 'desc') return null
        g.order = { by, dir }
      }
      if (t.missing !== undefined) {
        if (t.missing !== MISSING_KEY) return null
        g.missing = 'bucket'
      }
      if (t.min_doc_count !== undefined) g.minDocCount = num(t.min_doc_count)
      break
    }
    case 'histogram':
      if (typeof t.field !== 'string' || typeof t.interval !== 'number' || !only(t, 'field', 'interval', 'min_doc_count')) return null
      g = { type: 'histogram', field: t.field, interval: t.interval, ...(t.min_doc_count !== undefined ? { minDocCount: num(t.min_doc_count) } : {}) }
      break
    case 'date_histogram':
      if (typeof t.field !== 'string' || !only(t, 'field', 'calendar_interval', 'fixed_interval', 'min_doc_count', 'format', 'time_zone')) return null
      g = { type: 'date_histogram', field: t.field }
      if (typeof t.calendar_interval === 'string') g.calendarInterval = t.calendar_interval
      if (typeof t.fixed_interval === 'string') g.fixedInterval = t.fixed_interval
      if (t.min_doc_count !== undefined) g.minDocCount = num(t.min_doc_count)
      if (typeof t.format === 'string') g.format = t.format
      if (typeof t.time_zone === 'string') g.timeZone = t.time_zone
      break
    case 'range':
    case 'date_range': {
      if (typeof t.field !== 'string' || !Array.isArray(t.ranges) || !only(t, 'field', 'ranges', 'format') || (type === 'range' && t.format !== undefined)) return null
      const ranges = t.ranges.filter(isObj).map((r) => ({ ...(typeof r.key === 'string' ? { key: r.key } : {}), ...(r.from !== undefined ? { from: r.from } : {}), ...(r.to !== undefined ? { to: r.to } : {}) }))
      g = type === 'range' ? { type, field: t.field, ranges: ranges as Array<{ from?: number; to?: number; key?: string }> } : { type, field: t.field, ranges: ranges as Array<{ from?: string; to?: string; key?: string }>, ...(typeof t.format === 'string' ? { format: t.format } : {}) }
      break
    }
    case 'filters': {
      if (!only(t, 'filters') || !isObj(t.filters)) return null
      const filters: Array<{ name: string; condition: Condition }> = []
      for (const [name, q] of Object.entries(t.filters)) {
        const c = parseConditionQuery(q)
        if (!c) return null
        filters.push({ name, condition: c })
      }
      g = { type: 'filters', filters }
      break
    }
    case 'composite': {
      if (!only(t, 'size', 'sources') || num(t.size) === undefined || !Array.isArray(t.sources)) return null
      const sources: Array<{ field: string; type: 'terms' | 'histogram' | 'date_histogram'; interval?: number | string }> = []
      for (const s of t.sources) {
        if (!isObj(s) || Object.keys(s).length !== 1) return null
        const spec = Object.values(s)[0]
        if (!isObj(spec) || Object.keys(spec).length !== 1) return null
        const st = Object.keys(spec)[0] as 'terms'
        const inner = spec[st]
        if (!['terms', 'histogram', 'date_histogram'].includes(st) || !isObj(inner) || typeof inner.field !== 'string') return null
        sources.push({ field: inner.field, type: st, ...(inner.interval !== undefined ? { interval: inner.interval as number } : inner.calendar_interval !== undefined ? { interval: inner.calendar_interval as string } : {}) })
      }
      g = { type: 'composite', sources, size: t.size as number }
      break
    }
  }
  return g
}

const isPctScript = (agg: unknown) => isObj(agg) && isObj(agg.bucket_script) && agg.bucket_script.script === PCT_SCRIPT

/** buckets_path → the metric reference the form uses (`a>b` resolves through single-bucket children, so keep `b`). */
const refOf = (path: string) => path.slice(path.lastIndexOf('>') + 1)

interface PipelineParse {
  stage: Stage
  /** Metric names it reads (to decide whether it may be placed after the nested group). */
  refs: string[]
  consumed: string[]
}

function parsePipelineAgg(name: string, agg: Json, siblings: Json): PipelineParse | null {
  const type = aggType(agg)
  if (!type || Object.keys(agg).length !== 1) return null
  const t = agg[type]
  if (!isObj(t)) return null
  if (type === 'bucket_selector') {
    if (!only(t, 'buckets_path', 'script') || !isObj(t.buckets_path) || typeof t.script !== 'string') return null
    const vars = t.buckets_path as Record<string, unknown>
    if (!Object.values(vars).every((v) => typeof v === 'string')) return null
    const rules: Array<{ metric: string; cmp: '>'; value: number }> = []
    for (const part of t.script.split(' && ')) {
      const m = /^params\.(\w+) (>=|<=|==|!=|>|<) (-?\d+(?:\.\d+)?(?:e[+-]?\d+)?)$/.exec(part)
      if (!m || typeof vars[m[1]!] !== 'string') return null
      rules.push({ metric: refOf(vars[m[1]!] as string), cmp: m[2] as '>', value: Number(m[3]) })
    }
    return { stage: { id: newId(), ...base, kind: 'keepOnly', name, rules }, refs: rules.map((r) => r.metric), consumed: [name] }
  }
  if (type === 'bucket_sort') {
    if (!only(t, 'sort', 'size', 'from') || typeof t.size !== 'number') return null
    const s = parseSort(t.sort)
    if (!s) return null
    if (t.from !== undefined && (typeof t.from !== 'number' || t.from <= 0)) return null
    const by = refOf(s.field)
    return { stage: { id: newId(), ...base, kind: 'sortLimit', name, by, dir: s.dir, size: t.size, ...(t.from !== undefined ? { from: t.from as number } : {}) }, refs: [by], consumed: [name] }
  }
  if (type === 'cumulative_sum' && only(t, 'buckets_path') && typeof t.buckets_path === 'string') {
    const metric = refOf(t.buckets_path)
    return { stage: { id: newId(), ...base, kind: 'runningTotal', name, metric }, refs: [metric], consumed: [name] }
  }
  if (type === 'derivative' && only(t, 'buckets_path') && typeof t.buckets_path === 'string') {
    const metric = refOf(t.buckets_path)
    return { stage: { id: newId(), ...base, kind: 'changeOverTime', name, metric, mode: 'diff' }, refs: [metric], consumed: [name] }
  }
  if (type === 'bucket_script' && t.script === PCT_SCRIPT && isObj(t.buckets_path) && only(t, 'buckets_path', 'script')) {
    const { d, v } = t.buckets_path as Record<string, unknown>
    const diff = typeof d === 'string' ? siblings[d] : undefined
    if (typeof v !== 'string' || !isObj(diff) || !isObj(diff.derivative) || diff.derivative.buckets_path !== v) return null
    const metric = refOf(v)
    return { stage: { id: newId(), ...base, kind: 'changeOverTime', name, metric, mode: 'pct' }, refs: [metric], consumed: [d as string, name] }
  }
  return null
}

function parseTopHits(name: string, agg: Json): StageOf<'topDocs'> | null {
  if (!only(agg, 'top_hits') || !isObj(agg.top_hits)) return null
  const t = agg.top_hits
  if (!only(t, 'size', 'sort', '_source') || typeof t.size !== 'number' || !Number.isInteger(t.size) || t.size < 1 || t.size > 100) return null
  const sort = t.sort === undefined ? undefined : parseSort(t.sort)
  if (sort === null) return null
  let fields: string[] | undefined
  if (t._source !== undefined) {
    if (!isObj(t._source) || !only(t._source, 'includes') || !Array.isArray(t._source.includes)) return null
    fields = t._source.includes as string[]
  }
  return { id: newId(), ...base, kind: 'topDocs', name, size: t.size, ...(sort ? { sort } : {}), ...(fields ? { fields } : {}) }
}

/**
 * One aggs container → stages, following a single bucket chain depth-first.
 * Stages before the chain run at this level; pipeline aggs that read this level's metrics go after the nested
 * stages (the compiler climbs back to the level that defines their metrics).
 */
function levelStages(container: Json, depth: number, strategy: Strategy, unsupported: string[], path: string, out: Stage[]): void {
  const entries = Object.entries(container)
  const consumed = new Set<string>()
  // A “% change” is a derivative + bucket_script pair; the derivative is parsed with its bucket_script.
  if (!strategy.pipelinesAsCustom && depth > 0)
    for (const [, agg] of entries) {
      const bs = isObj(agg) && isObj(agg.bucket_script) ? agg.bucket_script : undefined
      const d = bs && bs.script === PCT_SCRIPT && isObj(bs.buckets_path) ? bs.buckets_path.d : undefined
      if (typeof d === 'string') consumed.add(d)
    }
  let chain: { name: string; agg: Json; stage: Stage } | undefined
  for (const [name, agg] of entries) {
    if (!isObj(agg)) continue
    const g = parseGroup(agg)
    if (g) {
      chain = { name, agg, stage: { id: newId(), ...base, kind: 'groupBy', name, group: g } }
      break
    }
    if (depth > 0 && only(agg, 'filter', 'aggs') && isObj(agg.filter)) {
      const f = queryStages(agg.filter)
      if (f.length === 1) {
        chain = { name, agg, stage: { ...f[0]!, name } }
        break
      }
    }
  }
  const pre: Stage[] = []
  const post: Stage[] = []
  let metrics: StageOf<'metrics'> | null = null
  for (const [name, agg] of entries) {
    if ((consumed.has(name) && !isPctScript(agg)) || (chain && name === chain.name)) continue
    const m = parseMetric(name, agg)
    if (m) {
      if (!metrics) pre.push((metrics = { id: newId(), ...base, kind: 'metrics', metrics: [] }))
      metrics.metrics.push(m)
      continue
    }
    metrics = null
    if (isObj(agg) && depth > 0 && !strategy.pipelinesAsCustom) {
      const p = parsePipelineAgg(name, agg, container)
      if (p) {
        const afterChain = chain && entries.findIndex(([n]) => n === name) > entries.findIndex(([n]) => n === chain!.name)
        // After the chain only when it reads metrics: the compiler climbs back to the level that defines them.
        const readsMetrics = p.refs.every((r) => r !== '_count' && r !== '_key')
        ;(afterChain && readsMetrics ? post : pre).push(p.stage)
        continue
      }
    }
    const top = isObj(agg) ? parseTopHits(name, agg) : null
    if (top && depth > 0) {
      pre.push(top)
      continue
    }
    unsupported.push(`${path}.${name}`)
    pre.push(custom(name, agg))
  }
  out.push(...pre)
  if (chain) {
    out.push(chain.stage)
    const childAggs = chain.agg.aggs
    if (isObj(childAggs)) levelStages(childAggs, depth + 1, strategy, unsupported, `${path}.${chain.name}.aggs`, out)
  }
  out.push(...post)
}

/** The compiled JSON of one stage, for its "</> JSON" editor. Group by fragments leave out their nested aggs. */
export function stageFragment(pipeline: Pick<Pipeline, 'stages'>, index: number): Json {
  const stage = pipeline.stages[index]!
  if (stage.kind === 'custom') return stage.place === 'request' ? clone(stage.json) : { [stage.name]: clone(stage.json) }
  const c = compile({ stages: pipeline.stages.map((s, i) => (i === index ? { ...s, enabled: true } : s)) })
  const info = c.stages[index]!
  if (stage.kind === 'filter' && info.level === 0) return { query: filterQuery([stage]) }
  const out: Json = {}
  for (const p of info.paths) {
    let v: unknown = c.request
    for (const k of p) v = (v as Json | undefined)?.[k as string]
    const key = String(p[p.length - 1])
    if (isObj(v) && p.length > 1) {
      const { aggs: _children, ...rest } = v
      out[key] = rest
    } else out[key] = v
  }
  return out
}

/** Parse an edited stage fragment back into stage(s); unknown shapes become Custom JSON. */
export function stagesFromFragment(fragment: Json, atRoot: boolean): Stage[] {
  if (atRoot && isObj(fragment.query) && only(fragment, 'query')) return queryStages(fragment.query)
  if (atRoot && only(fragment, 'sort', 'size', 'from', '_source')) return build(fragment, {}, [])
  const out: Stage[] = []
  levelStages(fragment, atRoot ? 0 : 1, {}, [], 'aggs', out)
  return out
}
