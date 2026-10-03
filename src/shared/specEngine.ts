import type { JsonCursorContext } from './jsonContext'
import type { KeyShape } from './snippets'
import type { HttpMethod } from './types'

/** Compact index produced by scripts/build-spec.mjs from elasticsearch-specification. */
export type Ref = string | ['a', Ref] | ['d', Ref, 0 | 1] | ['u', ...Ref[]]
export interface SpecType {
  p?: Record<string, Ref>
  e?: string[]
}
export interface SpecEndpoint {
  n: string
  u: Array<[string[], string]>
  q: string[]
  b?: Ref
  d?: string
}
export interface Spec {
  endpoints: SpecEndpoint[]
  types: Record<string, SpecType>
}

export interface Names {
  indices: string[]
  aliases: string[]
  dataStreams: string[]
}

export interface PathSuggestion {
  label: string
  insert: string
  kind: 'endpoint' | 'index' | 'alias' | 'datastream' | 'param' | 'segment'
  detail?: string
}

/** Placeholders that name indices — matched by any non-underscore segment. */
const INDEX_PARAMS = new Set(['{index}', '{target}', '{name}', '{alias}', '{data_stream}'])

function segmentMatches(template: string, actual: string): boolean {
  if (template.startsWith('{')) return !actual.startsWith('_') || !INDEX_PARAMS.has(template)
  return template === actual
}

/** Best endpoint for a concrete method + path (path without leading slash, query string allowed). */
export function matchEndpoint(spec: Spec, method: HttpMethod, rawPath: string): { endpoint: SpecEndpoint; template: string } | undefined {
  const path = rawPath.replace(/^\/+/, '').split('?')[0]!.replace(/\/+$/, '')
  const segs = path === '' ? [] : path.split('/')
  let best: { endpoint: SpecEndpoint; template: string; score: number } | undefined
  for (const e of spec.endpoints) {
    for (const [methods, template] of e.u) {
      if (!methods.includes(method)) continue
      const t = template === '' ? [] : template.split('/')
      if (t.length !== segs.length) continue
      if (!t.every((ts, i) => segmentMatches(ts, segs[i]!))) continue
      // Prefer templates with more literal segments (`_doc/{id}` over `{id}`).
      const score = t.filter((x) => !x.startsWith('{')).length
      if (!best || score > best.score) best = { endpoint: e, template, score }
    }
  }
  return best && { endpoint: best.endpoint, template: best.template }
}

/**
 * Suggestions for the request line after the method: next path segment
 * (endpoints, index/alias names), or query parameters after `?`.
 */
export function pathSuggestions(spec: Spec, method: HttpMethod, typed: string, names: Names): PathSuggestion[] {
  const clean = typed.replace(/^\/+/, '')
  const q = clean.indexOf('?')
  if (q !== -1) {
    const m = matchEndpoint(spec, method, clean.slice(0, q))
    if (!m) return []
    const used = new Set(clean.slice(q + 1).split('&').map((kv) => kv.split('=')[0]))
    return m.endpoint.q.filter((p) => !used.has(p)).map((p) => ({ label: p, insert: p, kind: 'param' as const, detail: m.endpoint.n }))
  }

  const segs = clean.split('/')
  const done = segs.slice(0, -1)
  const out = new Map<string, PathSuggestion>()
  for (const e of spec.endpoints) {
    for (const [methods, template] of e.u) {
      if (!methods.includes(method)) continue
      const t = template === '' ? [] : template.split('/')
      if (t.length <= done.length) continue
      if (!done.every((d, i) => segmentMatches(t[i]!, d))) continue
      const next = t[done.length]!
      if (next.startsWith('{')) {
        if (INDEX_PARAMS.has(next) && !out.has('#names')) {
          out.set('#names', { label: '', insert: '', kind: 'segment' })
        }
        continue
      }
      // Offer the whole remaining literal tail when it has no placeholders (`_cluster/health`).
      const rest = t.slice(done.length)
      const firstPlaceholder = rest.findIndex((x) => x.startsWith('{'))
      const literal = (firstPlaceholder === -1 ? rest : rest.slice(0, firstPlaceholder)).join('/')
      if (!out.has(literal)) out.set(literal, { label: literal, insert: literal, kind: 'endpoint', detail: e.n })
    }
  }
  const names_ = out.delete('#names')
  const result = [...out.values()]
  if (names_) {
    for (const n of names.indices) if (!n.startsWith('.')) result.push({ label: n, insert: n, kind: 'index' })
    for (const n of names.aliases) result.push({ label: n, insert: n, kind: 'alias' })
    for (const n of names.dataStreams) result.push({ label: n, insert: n, kind: 'datastream' })
  }
  return result
}

export type BodyWant =
  | {
      kind: 'keys'
      keys: string[]
      /** Value shape per key (from the spec), for inserting `{}`, `[]`, enums… after the key. */
      shapes?: Record<string, { shape: KeyShape; values?: string[] }>
      /** What the container is — drives Kibana-style templates (query clauses, aggregations, top level). */
      container?: 'query' | 'agg' | 'root' | 'other'
      /** The cursor starts a new array element: insert the whole object, `{ "key": … }`. */
      element?: true
    }
  | { kind: 'fields' }
  | { kind: 'values'; values: string[] }
  | null

/** Resolve a ref through unions and arrays to the set of concrete refs it may be. */
function expand(spec: Spec, r: Ref, depth = 0): Ref[] {
  if (depth > 6) return []
  if (Array.isArray(r)) {
    if (r[0] === 'a') return expand(spec, r[1], depth + 1)
    if (r[0] === 'u') return (r.slice(1) as Ref[]).flatMap((x) => expand(spec, x, depth + 1))
  }
  return [r]
}

function step(spec: Spec, refs: Ref[], key: string): Ref[] {
  const next: Ref[] = []
  for (const r of refs) {
    if (Array.isArray(r) && r[0] === 'd') {
      next.push(r[1])
      continue
    }
    if (typeof r !== 'string') continue
    const t = spec.types[r]
    const p = t?.p?.[key] ?? t?.p?.['*field']
    if (p) next.push(p)
  }
  return next.flatMap((x) => expand(spec, x))
}

/** The value shape of a ref: object, array, enum, scalar… (arrays win in unions: `filter` → `[ ]`). */
export function shapeOf(spec: Spec, r: Ref): { shape: KeyShape; values?: string[] } {
  const raw = Array.isArray(r) && r[0] === 'u' ? (r.slice(1) as Ref[]) : [r]
  if (raw.some((x) => Array.isArray(x) && x[0] === 'a')) return { shape: 'array' }
  const flat = raw.flatMap((x) => expand(spec, x))
  if (flat.some((x) => Array.isArray(x) && x[0] === 'd')) return { shape: 'object' }
  for (const x of flat) {
    if (typeof x !== 'string') continue
    if (x === 'field' || x === 'fields') return { shape: 'field' }
    const t = spec.types[x]
    if (t?.e) return { shape: 'enum', values: t.e }
    if (t?.p) return { shape: 'object' }
  }
  if (flat.includes('boolean')) return { shape: 'boolean' }
  if (flat.includes('number')) return { shape: 'number' }
  if (flat.includes('string')) return { shape: 'string' }
  return { shape: 'any' }
}

/** What to suggest at a cursor inside a request body whose root type is `bodyRef`. */
export function bodySuggestions(spec: Spec, bodyRef: Ref, ctx: JsonCursorContext): BodyWant {
  let refs = expand(spec, bodyRef)
  for (const k of ctx.path) {
    refs = step(spec, refs, k)
    if (refs.length === 0) return null
  }
  const objectKeys = (types: Ref[], element: boolean): BodyWant => {
    if (types.some((r) => Array.isArray(r) && r[0] === 'd' && r[2] === 1)) return element ? null : { kind: 'fields' }
    if (types.some((r) => Array.isArray(r) && r[0] === 'd')) return null // free-form names (aggs, runtime fields)
    const keys = new Set<string>()
    const shapes: Record<string, { shape: KeyShape; values?: string[] }> = {}
    for (const r of types) {
      if (typeof r !== 'string') continue
      for (const [k, v] of Object.entries(spec.types[r]?.p ?? {})) {
        if (k === '*field') continue
        keys.add(k)
        shapes[k] ??= shapeOf(spec, v)
      }
    }
    const container = types.includes('_types.query_dsl:QueryContainer') ? 'query' : types.includes('_types.aggregations:AggregationContainer') ? 'agg' : ctx.path.length === 0 ? 'root' : 'other'
    const extra = element ? { element: true as const } : {}
    if (types.some((r) => typeof r === 'string' && spec.types[r]?.p?.['*field'])) return keys.size ? { kind: 'keys', keys: [...keys], shapes, container, ...extra } : element ? null : { kind: 'fields' }
    return keys.size ? { kind: 'keys', keys: [...keys], shapes, container, ...extra } : null
  }
  if (ctx.position === 'key') return objectKeys(refs, false)
  // A new element of an array of objects (`"must_not": [ |`): offer the object's keys, wrapped in { }.
  if (ctx.container === 'array' && !ctx.inString && !refs.some((r) => r === 'field' || r === 'fields')) {
    const asObject = objectKeys(refs, true)
    if (asObject) return asObject
  }
  // Value position: the type of `key` inside the current container (or the array's items).
  const target = ctx.container === 'array' ? refs : ctx.key ? step(spec, refs, ctx.key) : refs
  if (target.some((r) => r === 'field' || r === 'fields')) return { kind: 'fields' }
  const values = new Set<string>()
  for (const r of target) {
    if (r === 'boolean') ['true', 'false'].forEach((v) => values.add(v))
    if (typeof r === 'string') for (const e of spec.types[r]?.e ?? []) values.add(e)
  }
  return values.size ? { kind: 'values', values: [...values] } : null
}
