/**
 * Aggregation pipeline model (AGGREGATIONS.md §3). The UI edits a flat list of stages; `compile()` turns it into the
 * Elasticsearch aggregation tree. Everything here is plain data so pipelines can be saved, diffed and sent over IPC.
 */

export type Scalar = string | number | boolean

export type FilterOp = 'is' | 'isNot' | 'oneOf' | 'exists' | 'missing' | 'lt' | 'lte' | 'gt' | 'gte' | 'between' | 'contains'

export interface Condition {
  field: string
  op: FilterOp
  /** is / isNot / comparisons / contains; the lower bound for between. */
  value?: Scalar
  /** Upper bound for between. */
  value2?: Scalar
  /** oneOf */
  values?: Scalar[]
}

export type MetricOp = 'count' | 'sum' | 'avg' | 'min' | 'max' | 'stats' | 'median' | 'percentiles' | 'cardinality' | 'value_count'

export interface MetricDef {
  name: string
  op: MetricOp
  field?: string
  /** percentiles only (median is always [50]). */
  percents?: number[]
}

export type Dir = 'asc' | 'desc'

export interface CompositeSource {
  field: string
  type: 'terms' | 'histogram' | 'date_histogram'
  /** histogram interval or date_histogram calendar interval. */
  interval?: number | string
}

export type GroupSpec =
  | { type: 'terms'; field: string; size: number; order?: { by: string; dir: Dir }; missing?: 'skip' | 'bucket'; minDocCount?: number }
  | { type: 'histogram'; field: string; interval: number; minDocCount?: number }
  | { type: 'date_histogram'; field: string; calendarInterval?: string; fixedInterval?: string; minDocCount?: number; format?: string; timeZone?: string }
  | { type: 'range'; field: string; ranges: Array<{ from?: number; to?: number; key?: string }> }
  | { type: 'date_range'; field: string; ranges: Array<{ from?: string; to?: string; key?: string }>; format?: string }
  | { type: 'filters'; filters: Array<{ name: string; condition: Condition }> }
  | { type: 'composite'; sources: CompositeSource[]; size: number }

export type GroupType = GroupSpec['type']

export type KeepCmp = '>' | '>=' | '<' | '<=' | '==' | '!='

interface Base {
  id: string
  enabled: boolean
  /** Collapsed cards show a one-line summary. */
  collapsed?: boolean
  /** Optional user label shown on the card (does not affect the request). */
  label?: string
}

export type Stage =
  | (Base & { kind: 'filter'; match: 'all' | 'any'; conditions: Condition[]; /** Raw query DSL when the decompiler can't map it to conditions. */ raw?: Record<string, unknown>; name?: string })
  | (Base & { kind: 'groupBy'; name: string; group: GroupSpec })
  | (Base & { kind: 'metrics'; metrics: MetricDef[] })
  | (Base & { kind: 'keepOnly'; name?: string; rules: Array<{ metric: string; cmp: KeepCmp; value: number }> })
  | (Base & { kind: 'sortLimit'; name?: string; by: string; dir: Dir; size: number; from?: number })
  | (Base & { kind: 'runningTotal'; name?: string; metric: string })
  | (Base & { kind: 'changeOverTime'; name?: string; metric: string; mode: 'diff' | 'pct' })
  | (Base & { kind: 'topDocs'; name?: string; size: number; sort?: { field: string; dir: Dir }; fields?: string[] })
  | (Base & { kind: 'custom'; name: string; json: Record<string, unknown>; /** 'request' merges `json` into the request root instead of adding an agg. */ place?: 'agg' | 'request' })

export type StageKind = Stage['kind']
export type StageOf<K extends StageKind> = Extract<Stage, { kind: K }>

export interface Pipeline {
  id: string
  name: string
  connectionId?: string
  /** Index, alias, data stream or pattern. */
  target: string
  stages: Stage[]
  preview: { live: boolean; sampled: boolean; probability?: number }
  tags: string[]
  createdAt?: string
  updatedAt?: string
}

export const STAGE_LABEL: Record<StageKind, string> = {
  filter: 'Filter',
  groupBy: 'Group by',
  metrics: 'Metrics',
  keepOnly: 'Keep only',
  sortLimit: 'Sort & limit',
  runningTotal: 'Running total',
  changeOverTime: 'Change over time',
  topDocs: 'Top documents',
  custom: 'Custom JSON'
}

export const STAGE_HINT: Record<StageKind, string> = {
  filter: 'which documents go in',
  groupBy: 'split into buckets',
  metrics: 'calculate per bucket',
  keepOnly: 'drop buckets (having)',
  sortLimit: 'order and keep N',
  runningTotal: 'cumulative sum',
  changeOverTime: 'difference to the previous bucket',
  topDocs: 'sample documents per bucket',
  custom: 'raw aggregation JSON'
}

export const GROUP_LABEL: Record<GroupType, string> = {
  terms: 'Values',
  range: 'Number ranges',
  date_range: 'Date ranges',
  histogram: 'Histogram',
  date_histogram: 'Date histogram',
  filters: 'Named filters',
  composite: 'Multi-field'
}

export const METRIC_LABEL: Record<MetricOp, string> = {
  count: 'Count',
  sum: 'Sum',
  avg: 'Average',
  min: 'Min',
  max: 'Max',
  stats: 'Stats',
  median: 'Median',
  percentiles: 'Percentiles',
  cardinality: 'Unique count',
  value_count: 'Value count'
}

/** Ops that need a numeric field. */
export const NUMERIC_OPS: ReadonlySet<MetricOp> = new Set(['sum', 'avg', 'min', 'max', 'stats', 'median', 'percentiles'])

export const FILTER_OP_LABEL: Record<FilterOp, string> = {
  is: 'is',
  isNot: 'is not',
  oneOf: 'one of',
  exists: 'exists',
  missing: 'missing',
  lt: '<',
  lte: '≤',
  gt: '>',
  gte: '≥',
  between: 'between',
  contains: 'contains text'
}

export const CALENDAR_INTERVALS = ['minute', 'hour', 'day', 'week', 'month', 'quarter', 'year'] as const

const NUMERIC_TYPES = new Set(['long', 'integer', 'short', 'byte', 'double', 'float', 'half_float', 'scaled_float', 'unsigned_long'])
const DATE_TYPES = new Set(['date', 'date_nanos'])
const AGGREGATABLE = new Set([...NUMERIC_TYPES, ...DATE_TYPES, 'keyword', 'constant_keyword', 'wildcard', 'boolean', 'ip', 'version', 'geo_point'])

export const isNumericType = (t: string): boolean => NUMERIC_TYPES.has(t)
export const isDateType = (t: string): boolean => DATE_TYPES.has(t)
export const isAggregatableType = (t: string): boolean => AGGREGATABLE.has(t)

export const newId = (): string => Math.random().toString(36).slice(2, 10)

/** Agg names: `[a-z0-9_]+`. */
export function sanitizeName(name: string): string {
  const s = name
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, '_')
    .replace(/^_+|_+$/g, '')
  return s || 'agg'
}

/** A user-chosen agg name, kept as typed except for characters that break buckets_path (`[`, `]`, `>`, `.`, spaces). */
export function safeName(name: string | undefined): string {
  return (name ?? '').trim().replace(/[[\]>.\s]+/g, '_')
}

/** `city.name` → `city_name`, `title.keyword` → `title` (the sub-field suffix adds nothing to a name). */
export function fieldSlug(field: string): string {
  return sanitizeName(field.replace(/\.(keyword|raw)$/, ''))
}

/** Friendly name for a field in prose: `city.name` → city, `title.keyword` → title, `seller_id` → seller_id. */
export function fieldLabel(field: string): string {
  const parts = field.replace(/\.(keyword|raw)$/, '').split('.')
  const last = parts[parts.length - 1] ?? field
  return parts.length > 1 && (last === 'name' || last === 'id') ? parts[parts.length - 2]! : last
}

export function newStage(kind: StageKind, fields: { numeric?: string; date?: string; keyword?: string } = {}): Stage {
  const id = newId()
  switch (kind) {
    case 'filter':
      return { id, kind, enabled: true, match: 'all', conditions: [{ field: fields.keyword ?? '', op: 'is', value: '' }] }
    case 'groupBy':
      return { id, kind, enabled: true, name: '', group: { type: 'terms', field: fields.keyword ?? '', size: 10 } }
    case 'metrics':
      return { id, kind, enabled: true, metrics: [{ name: '', op: 'avg', field: fields.numeric ?? '' }] }
    case 'keepOnly':
      return { id, kind, enabled: true, rules: [{ metric: '', cmp: '>', value: 0 }] }
    case 'sortLimit':
      return { id, kind, enabled: true, by: '_count', dir: 'desc', size: 10 }
    case 'runningTotal':
      return { id, kind, enabled: true, metric: '' }
    case 'changeOverTime':
      return { id, kind, enabled: true, metric: '', mode: 'diff' }
    case 'topDocs':
      return { id, kind, enabled: true, size: 3 }
    case 'custom':
      return { id, kind, enabled: true, name: 'custom', json: { terms: { field: fields.keyword ?? 'FIELD' } } }
  }
}

export function newPipeline(target: string, connectionId?: string): Pipeline {
  return { id: newId(), name: 'Untitled pipeline', connectionId, target, stages: [], preview: { live: true, sampled: false }, tags: [] }
}

/** Loose structural check for pipelines coming from storage or IPC. */
export function isPipeline(v: unknown): v is Pipeline {
  if (!v || typeof v !== 'object') return false
  const p = v as Partial<Pipeline>
  return typeof p.target === 'string' && Array.isArray(p.stages) && p.stages.every((s) => !!s && typeof s === 'object' && typeof (s as Stage).kind === 'string' && typeof (s as Stage).id === 'string')
}

/** Deep JSON equality: object key order is ignored, array order is not. */
export function jsonEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (typeof a !== typeof b || a === null || b === null || typeof a !== 'object') return false
  if (Array.isArray(a) !== Array.isArray(b)) return false
  if (Array.isArray(a)) {
    const bb = b as unknown[]
    return a.length === bb.length && a.every((x, i) => jsonEqual(x, bb[i]))
  }
  const ka = Object.keys(a as object).filter((k) => (a as Record<string, unknown>)[k] !== undefined)
  const kb = Object.keys(b as object).filter((k) => (b as Record<string, unknown>)[k] !== undefined)
  return ka.length === kb.length && ka.every((k) => jsonEqual((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]))
}

export const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T
