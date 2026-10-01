import type { RoutineStep } from './routines'

type Props = Record<string, FieldDef>
export interface FieldDef {
  type?: string
  properties?: Props
  fields?: Props
  [param: string]: unknown
}
export interface Mapping {
  properties?: Props
  [param: string]: unknown
}

/** Field definition without its children: what can (or can't) change in place. */
function own(def: FieldDef): Record<string, unknown> {
  const { properties: _p, fields: _f, ...rest } = def
  return rest
}

/** path → own definition, including multi-fields (`title.raw`) and object/nested containers. */
export function flattenDefs(mapping: Mapping): Map<string, Record<string, unknown>> {
  const out = new Map<string, Record<string, unknown>>()
  const walk = (props: Props | undefined, prefix: string) => {
    for (const [name, def] of Object.entries(props ?? {})) {
      const path = prefix ? `${prefix}.${name}` : name
      out.set(path, { ...own(def), ...(def.properties && !def.type ? { type: 'object' } : {}) })
      for (const [sub, sdef] of Object.entries(def.fields ?? {})) out.set(`${path}.${sub}`, { ...own(sdef), multiField: true })
      walk(def.properties, path)
    }
  }
  walk(mapping.properties, '')
  return out
}

export interface MappingDiff {
  added: string[]
  changed: string[]
  removed: string[]
}

export function diffMappings(before: Mapping, after: Mapping): MappingDiff {
  const a = flattenDefs(before)
  const b = flattenDefs(after)
  const added = [...b.keys()].filter((k) => !a.has(k))
  const removed = [...a.keys()].filter((k) => !b.has(k))
  const changed = [...b.keys()].filter((k) => a.has(k) && stable(a.get(k)) !== stable(b.get(k)))
  return { added, changed, removed }
}

function stable(v: unknown): string {
  return JSON.stringify(v, (_k, x: unknown) => (x && typeof x === 'object' && !Array.isArray(x) ? Object.fromEntries(Object.entries(x as object).sort(([p], [q]) => p.localeCompare(q))) : x))
}

/**
 * Add a field at a dotted path. Missing parents become objects. With `asMultiField`, the last
 * segment is added under the parent field's `fields` (e.g. title + raw → title.raw).
 */
export function addField(mapping: Mapping, path: string, def: FieldDef, asMultiField = false): Mapping {
  const next = structuredClone(mapping)
  const parts = path.split('.').filter(Boolean)
  if (!parts.length) throw new Error('Field name is empty')
  next.properties ??= {}
  if (asMultiField) {
    const parentPath = parts.slice(0, -1)
    const parent = getField(next, parentPath.join('.'))
    if (!parent || parent.properties) throw new Error(`“${parentPath.join('.')}” is not a leaf field — multi-fields attach to fields like text or keyword`)
    parent.fields ??= {}
    if (parent.fields[parts.at(-1)!]) throw new Error(`${path} already exists`)
    parent.fields[parts.at(-1)!] = def
    return next
  }
  let props = next.properties
  for (const p of parts.slice(0, -1)) {
    const existing = props[p]
    if (existing && existing.type && existing.type !== 'object' && existing.type !== 'nested') throw new Error(`“${p}” is a ${existing.type} field, not an object`)
    props[p] ??= { properties: {} }
    props[p]!.properties ??= {}
    props = props[p]!.properties!
  }
  if (props[parts.at(-1)!]) throw new Error(`${path} already exists`)
  props[parts.at(-1)!] = def
  return next
}

/** Replace a field's own definition (children are kept). */
export function replaceField(mapping: Mapping, path: string, def: FieldDef): Mapping {
  const next = structuredClone(mapping)
  const parts = path.split('.')
  // Multi-field?
  const parent = getField(next, parts.slice(0, -1).join('.'))
  if (parent?.fields?.[parts.at(-1)!]) {
    parent.fields[parts.at(-1)!] = def
    return next
  }
  const f = getField(next, path)
  if (!f) throw new Error(`${path} not found`)
  for (const k of Object.keys(f)) if (k !== 'properties' && k !== 'fields') delete f[k]
  Object.assign(f, def)
  return next
}

/** Remove a field (with its children / multi-fields), or a multi-field like `title.raw`. */
export function removeField(mapping: Mapping, path: string): Mapping {
  const next = structuredClone(mapping)
  const parts = path.split('.').filter(Boolean)
  const name = parts.at(-1)
  const parent = getField(next, parts.slice(0, -1).join('.'))
  if (name && parent?.fields?.[name]) {
    delete parent.fields[name]
    if (!Object.keys(parent.fields).length) delete parent.fields
    return next
  }
  const props = parts.length === 1 ? next.properties : parent?.properties
  if (!name || !props?.[name]) throw new Error(`${path} not found`)
  delete props[name]
  // Drop object parents the removal left empty (seller.phone was seller's only field).
  for (let i = parts.length - 1; i > 0; i--) {
    const p = getField(next, parts.slice(0, i).join('.'))
    if (!p || p.type || Object.keys(p.properties ?? {}).length) break
    const holder = i === 1 ? next.properties : getField(next, parts.slice(0, i - 1).join('.'))?.properties
    delete holder?.[parts[i - 1]!]
  }
  return next
}

export function getField(mapping: Mapping, path: string): FieldDef | undefined {
  if (!path) return undefined
  let props = mapping.properties
  let f: FieldDef | undefined
  for (const p of path.split('.')) {
    f = props?.[p]
    if (!f) return undefined
    props = f.properties
  }
  return f
}

/** Next free index name for a reindex: listings-v7 → listings-v8 (skipping taken names), logs → logs-v2. */
export function nextIndexName(name: string, taken: Iterable<string> = []): string {
  const used = new Set(taken)
  const m = /^(.*?)([-_]v)(\d+)$/.exec(name)
  const [base, sep, n] = m ? [m[1]!, m[2]!, Number(m[3])] : [name, '-v', 1]
  let i = n + 1
  while (used.has(`${base}${sep}${i}`)) i++
  return `${base}${sep}${i}`
}

/** Index settings worth carrying over to the new index (flat keys from ?flat_settings=true). */
const COPY_SETTINGS = [/^index\.number_of_shards$/, /^index\.number_of_replicas$/, /^index\.refresh_interval$/, /^index\.analysis\./, /^index\.max_result_window$/, /^index\.mapping\.total_fields\.limit$/, /^index\.codec$/, /^index\.sort\./, /^index\.lifecycle\.name$/, /^index\.similarity\./]

export function copyableSettings(flat: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(flat).filter(([k]) => COPY_SETTINGS.some((re) => re.test(k))))
}

export interface AliasRef {
  name: string
  isWriteIndex?: boolean
  filter?: unknown
  routing?: string
}

/** Steps for "new index with the new mapping → reindex → verify → swap aliases". */
export function reindexRoutine(opts: { source: string; target: string; mapping: Mapping; settings: Record<string, unknown>; aliases: AliasRef[] }): { name: string; variables: Record<string, string>; steps: RoutineStep[] } {
  const steps: RoutineStep[] = [
    { id: 'health', name: 'Cluster is healthy', method: 'GET', path: '_cluster/health', assert: "status != 'red'", onFail: 'stop' },
    { id: 'count_source', name: 'Count source documents', method: 'POST', path: '{{source}}/_count', capture: { value: 'count' }, onFail: 'stop' },
    {
      id: 'create_target',
      name: 'Create the new index with the new mapping',
      method: 'PUT',
      path: '{{target}}',
      body: JSON.stringify({ settings: opts.settings, mappings: opts.mapping }, null, 2),
      onFail: 'stop'
    },
    {
      id: 'start_reindex',
      name: 'Start reindex',
      method: 'POST',
      path: '_reindex?wait_for_completion=false&refresh=true',
      body: JSON.stringify({ source: { index: '{{source}}' }, dest: { index: '{{target}}' } }, null, 2),
      capture: { task: 'task' },
      onFail: 'stop'
    },
    { id: 'wait', name: 'Wait for the reindex task', method: 'GET', path: '_tasks/{{steps.start_reindex.task}}', repeat: { until: 'completed == true', everySec: 5, timeoutMin: 240 }, assert: '$not($exists(error))', onFail: 'stop' },
    { id: 'verify', name: 'Verify document count', method: 'POST', path: '{{target}}/_count', assert: 'count == steps.count_source.value', onFail: 'stop' }
  ]
  if (opts.aliases.length) {
    const actions = opts.aliases.flatMap((a) => [
      { remove: { index: '{{source}}', alias: a.name } },
      { add: { index: '{{target}}', alias: a.name, ...(a.isWriteIndex ? { is_write_index: true } : {}), ...(a.filter ? { filter: a.filter } : {}), ...(a.routing ? { routing: a.routing } : {}) } }
    ])
    steps.push({ id: 'swap_aliases', name: `Move aliases (${opts.aliases.map((a) => a.name).join(', ')}) to the new index`, method: 'POST', path: '_aliases', body: JSON.stringify({ actions }, null, 2), confirm: true, onFail: 'stop' })
  }
  return { name: `Reindex ${opts.source} → ${opts.target} (mapping change)`, variables: { source: opts.source, target: opts.target }, steps }
}

/** Field types offered when adding a field, with the parameters the form asks for. */
export const FIELD_TYPES = [
  'keyword',
  'text',
  'long',
  'integer',
  'short',
  'double',
  'float',
  'scaled_float',
  'boolean',
  'date',
  'date_nanos',
  'ip',
  'geo_point',
  'geo_shape',
  'object',
  'nested',
  'flattened',
  'dense_vector',
  'wildcard',
  'constant_keyword',
  'search_as_you_type',
  'match_only_text',
  'version',
  'binary'
] as const
