// Compiles elastic/elasticsearch-specification (Apache-2.0) into a compact autocomplete index.
//   pnpm spec:build [branch]          (default: main) → src/renderer/autocomplete/spec/es.json
//
// Output shape:
//   endpoints: [{ n: name, u: [[methods, path]], q: [query params], b: bodyRef?, d: docUrl }]
//   types:     { "ns:Name": { p: { prop: ref }, e?: [enum members] } }
// Refs: "string" | "number" | "boolean" | "field" | "fields" | "any" | "ns:Name"
//       | ["a", ref] (array) | ["d", ref, keyIsField?] (dictionary) | ["u", ...refs] (union)
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const branch = process.argv[2] ?? 'main'
const url = `https://raw.githubusercontent.com/elastic/elasticsearch-specification/${branch}/output/schema/schema.json`
const out = join(dirname(fileURLToPath(import.meta.url)), '../src/renderer/autocomplete/spec/es.json')

console.log(`fetching ${url}`)
const res = await fetch(url)
if (!res.ok) throw new Error(`HTTP ${res.status}`)
const schema = await res.json()

const key = (n) => `${n.namespace}:${n.name}`
const byName = new Map(schema.types.map((t) => [key(t.name), t]))

const PRIMITIVE = {
  '_builtins:string': 'string',
  '_builtins:boolean': 'boolean',
  '_builtins:number': 'number',
  '_builtins:integer': 'number',
  '_builtins:long': 'number',
  '_builtins:float': 'number',
  '_builtins:double': 'number',
  '_builtins:null': 'any',
  '_builtins:void': 'any',
  '_builtins:binary': 'any',
  '_types:Field': 'field',
  '_types:Fields': 'fields',
  '_types:UserDefinedValue': 'any'
}

const out_types = {}
const pending = []

function ref(v) {
  if (!v) return 'any'
  switch (v.kind) {
    case 'instance_of': {
      const k = key(v.type)
      if (PRIMITIVE[k]) return PRIMITIVE[k]
      const t = byName.get(k)
      if (!t) return 'any'
      if (t.kind === 'type_alias') return ref(t.type)
      if (!(k in out_types)) {
        out_types[k] = null
        pending.push(k)
      }
      return k
    }
    case 'array_of':
      return ['a', ref(v.value)]
    case 'dictionary_of': {
      const kk = v.key?.kind === 'instance_of' ? key(v.key.type) : ''
      return ['d', ref(v.value), kk === '_types:Field' ? 1 : 0]
    }
    case 'union_of': {
      const items = v.items.map(ref)
      const flat = [...new Set(items.map((i) => JSON.stringify(i)))].map((s) => JSON.parse(s))
      return flat.length === 1 ? flat[0] : ['u', ...flat]
    }
    case 'literal_value':
      return typeof v.value === 'boolean' ? 'boolean' : typeof v.value === 'number' ? 'number' : 'string'
    default:
      return 'any'
  }
}

function props(t, acc = {}) {
  if (t.inherits) {
    const parent = byName.get(key(t.inherits.type))
    if (parent) props(parent, acc)
  }
  for (const p of t.properties ?? []) {
    if (p.deprecated && p.deprecated.version && p.availability?.stack?.visibility === 'private') continue
    acc[p.name] = ref(p.type)
    for (const alias of p.aliases ?? []) acc[alias] = acc[p.name]
  }
  // `AdditionalProperty` behaviours (e.g. TermQuery keyed by field name) become field-keyed dictionaries.
  for (const b of t.behaviors ?? []) {
    if (b.type?.name === 'AdditionalProperty' || b.type?.name === 'AdditionalProperties') {
      const [k, v] = b.generics ?? []
      if (k?.kind === 'instance_of' && key(k.type) === '_types:Field') acc['*field'] = ref(v)
    }
  }
  return acc
}

function compile(k) {
  const t = byName.get(k)
  if (!t) return
  if (t.kind === 'enum') out_types[k] = { e: t.members.flatMap((m) => [m.name, ...(m.aliases ?? [])]) }
  else if (t.kind === 'interface') out_types[k] = { p: props(t) }
  else out_types[k] = { p: {} }
}

const endpoints = []
for (const e of schema.endpoints) {
  if (e.availability?.stack?.visibility === 'private') continue
  const req = e.request ? byName.get(key(e.request)) : undefined
  let b
  if (req?.body?.kind === 'properties') {
    const k = `req:${e.name}`
    out_types[k] = { p: Object.fromEntries(req.body.properties.flatMap((p) => [p.name, ...(p.aliases ?? [])].map((n) => [n, ref(p.type)]))) }
    b = k
  } else if (req?.body?.kind === 'value') b = ref(req.body.value)
  endpoints.push({
    n: e.name,
    u: e.urls.map((u) => [u.methods, u.path.replace(/^\//, '')]),
    q: (req?.query ?? []).map((p) => p.name),
    ...(b ? { b } : {}),
    ...(e.docUrl ? { d: e.docUrl } : {})
  })
}
while (pending.length) compile(pending.pop())

mkdirSync(dirname(out), { recursive: true })
const json = JSON.stringify({ source: `elasticsearch-specification@${branch}`, endpoints, types: out_types })
writeFileSync(out, json)
console.log(`wrote ${out}: ${endpoints.length} endpoints, ${Object.keys(out_types).length} types, ${(json.length / 1024).toFixed(0)} KB`)
