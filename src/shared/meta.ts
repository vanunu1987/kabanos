/** Cluster metadata shapes shared by the Explorer, Index view and autocomplete. */

export type Health = 'green' | 'yellow' | 'red' | 'unknown'

export interface IndexSummary {
  name: string
  health: Health
  status: 'open' | 'close'
  docs: number
  storeBytes: number
  primaries: number
  replicas: number
  createdAt?: string
  hidden: boolean
  /** Backing index of a data stream. */
  dataStream?: string
}

export interface AliasSummary {
  name: string
  indices: Array<{ index: string; isWriteIndex: boolean; filter: boolean }>
}

export interface DataStreamSummary {
  name: string
  indices: string[]
  template?: string
  health: Health
  /** Hidden or system data stream (e.g. ilm-history-*). */
  hidden: boolean
}

export interface TemplateSummary {
  name: string
  kind: 'index' | 'component'
  patterns: string[]
  priority?: number
  composedOf: string[]
  dataStream: boolean
  /** Built-in template managed by the stack (`_meta.managed: true`). */
  managed: boolean
  body: unknown
}

export interface ClusterTree {
  clusterName?: string
  health: Health
  nodes: number
  indices: IndexSummary[]
  aliases: AliasSummary[]
  dataStreams: DataStreamSummary[]
  templates: TemplateSummary[]
  fetchedAt: number
}

export interface FieldInfo {
  /** Dotted path, e.g. `city.name` or `title.raw` for multi-fields. */
  path: string
  name: string
  type: string
  depth: number
  details: string
  /** True for sub-fields declared under `fields` (multi-fields). */
  multiField: boolean
}

export interface ShardInfo {
  shard: number
  primary: boolean
  state: string
  docs?: number
  storeBytes?: number
  node?: string
  unassignedReason?: string
}

export interface IndexDetail {
  name: string
  summary?: IndexSummary
  aliases: Array<{ name: string; isWriteIndex: boolean; filter?: unknown; routing?: string }>
  settings: Record<string, string>
  mapping: unknown
  fields: FieldInfo[]
  matchedTemplate?: TemplateSummary
  shards: ShardInfo[]
}

export interface AliasDetail {
  name: string
  targets: AliasSummary['indices']
  /** Union of the targets' fields (first definition wins). */
  fields: FieldInfo[]
  filters: Record<string, unknown>
}

/**
 * Flatten `mappings.properties` into rows, depth-first, including object children and multi-fields.
 */
export function flattenMapping(mapping: unknown): FieldInfo[] {
  const root = (mapping as { properties?: Record<string, unknown>; mappings?: { properties?: Record<string, unknown> } }) ?? {}
  const props = root.properties ?? root.mappings?.properties ?? {}
  const out: FieldInfo[] = []
  walk(props, '', 0, out)
  return out
}

interface FieldDef {
  type?: string
  properties?: Record<string, unknown>
  fields?: Record<string, FieldDef>
  analyzer?: string
  format?: string
  doc_values?: boolean
  index?: boolean
  path?: string
  dims?: number
  scaling_factor?: number
}

function walk(props: Record<string, unknown>, prefix: string, depth: number, out: FieldInfo[]): void {
  for (const [name, raw] of Object.entries(props)) {
    const def = (raw ?? {}) as FieldDef
    const path = prefix ? `${prefix}.${name}` : name
    const type = def.type ?? (def.properties ? 'object' : 'unknown')
    const details: string[] = []
    if (def.analyzer) details.push(`analyzer: ${def.analyzer}`)
    if (def.format) details.push(`format: ${def.format}`)
    if (def.index === false) details.push('not indexed')
    if (def.doc_values === false) details.push('no doc_values')
    if (def.path) details.push(`→ ${def.path}`)
    if (def.dims) details.push(`dims: ${def.dims}`)
    if (def.scaling_factor) details.push(`scaling_factor: ${def.scaling_factor}`)
    if (def.properties) details.push(`${Object.keys(def.properties).length} properties`)
    if (def.fields) details.push(...Object.entries(def.fields).map(([sub, f]) => `+ ${path}.${sub} (${f.type ?? '?'})`))
    out.push({ path, name, type, depth, details: details.join(' · '), multiField: false })

    if (def.fields) {
      for (const [sub, f] of Object.entries(def.fields)) {
        out.push({ path: `${path}.${sub}`, name: sub, type: f.type ?? 'unknown', depth: depth + 1, details: 'multi-field', multiField: true })
      }
    }
    if (def.properties) walk(def.properties, path, depth + 1, out)
  }
}

/** Glob match for index patterns (`listings-*`, `*-logs`, `a*b*`). */
export function matchesPattern(name: string, pattern: string): boolean {
  const re = new RegExp(`^${pattern.split('*').map(escapeRe).join('.*')}$`)
  return re.test(name)
}

function escapeRe(s: string): string {
  return s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')
}

/** The composable template ES would apply to a new index of that name: highest priority match. */
export function matchTemplate(name: string, templates: TemplateSummary[]): TemplateSummary | undefined {
  return templates
    .filter((t) => t.kind === 'index' && t.patterns.some((p) => matchesPattern(name, p)))
    .sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0))[0]
}

export function formatBytes(n: number | undefined): string {
  if (n === undefined || Number.isNaN(n)) return '—'
  const units = ['b', 'kb', 'mb', 'gb', 'tb']
  let v = n
  let i = 0
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024
    i++
  }
  return `${v >= 100 || i === 0 ? Math.round(v) : v.toFixed(1)}${units[i]}`
}

/**
 * What "Hide system" hides — shared by the Explorer tree and the cluster summary so their counts agree.
 * System = dot-prefixed or hidden indices, data-stream backing indices, hidden data streams,
 * dot-prefixed aliases, and the managed/built-in templates every cluster ships with.
 */
export const isSystemIndex = (i: IndexSummary): boolean => i.hidden || !!i.dataStream
export const isSystemDataStream = (d: DataStreamSummary): boolean => d.hidden
export const isSystemAlias = (a: AliasSummary): boolean => a.name.startsWith('.')
export const isSystemTemplate = (t: TemplateSummary): boolean => t.managed || t.name.startsWith('.') || isBuiltinTemplateName(t.name)

/** Templates shipped by Elastic (logs, metrics, ILM history, APM…) even when not flagged as managed. */
export function isBuiltinTemplateName(name: string): boolean {
  return /^(logs|metrics|synthetics|traces|profiling|ecs|apm|elastic-connectors|behavioral_analytics|ilm-history|slm-history|watch-history|monitoring|data-streams|search-acl|security|entities)([-@_.].*)?$/.test(name) || name.includes('@')
}

export interface VisibleCounts {
  indices: number
  dataStreams: number
  aliases: number
  indexTemplates: number
  componentTemplates: number
}

/** Counts of user objects (shown) and system objects (hidden by default). */
export function treeCounts(t: ClusterTree): { shown: VisibleCounts; system: VisibleCounts } {
  const split = <T>(list: T[], isSys: (x: T) => boolean) => [list.filter((x) => !isSys(x)).length, list.filter(isSys).length] as const
  const [i, si] = split(t.indices, isSystemIndex)
  const [d, sd] = split(t.dataStreams, isSystemDataStream)
  const [a, sa] = split(t.aliases, isSystemAlias)
  const [it, sit] = split(t.templates.filter((x) => x.kind === 'index'), isSystemTemplate)
  const [ct, sct] = split(t.templates.filter((x) => x.kind === 'component'), isSystemTemplate)
  return {
    shown: { indices: i, dataStreams: d, aliases: a, indexTemplates: it, componentTemplates: ct },
    system: { indices: si, dataStreams: sd, aliases: sa, indexTemplates: sit, componentTemplates: sct }
  }
}
