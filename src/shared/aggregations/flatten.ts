import type { Compiled, OutputMeta } from './compiler'

type Json = Record<string, unknown>
export type Row = Record<string, unknown>

export interface FlatTable {
  columns: string[]
  /** Key columns (one per Group by level, composite adds one per source). */
  keyColumns: string[]
  rows: Row[]
}

export interface BucketVisit {
  row: Row
  node: Json
  /** Keys of the enclosing buckets, outermost first (empty for the first level). */
  parentKeys: string[]
  key?: string
  docCount: number
  /** The multi-bucket agg that holds this bucket. */
  holder?: Json
}

const isObj = (v: unknown): v is Json => !!v && typeof v === 'object' && !Array.isArray(v)

export function hitsTotal(response: Json): number | undefined {
  const hits = response.hits as { total?: number | { value: number } } | undefined
  const t = hits?.total
  return typeof t === 'number' ? t : t?.value
}

function rootNode(response: Json, compiled: Pick<Compiled, 'sampleWrapper'>): Json {
  const aggs = (isObj(response.aggregations) ? response.aggregations : {}) as Json
  if (compiled.sampleWrapper && isObj(aggs[compiled.sampleWrapper])) return aggs[compiled.sampleWrapper] as Json
  return aggs
}

export function bucketsOf(agg: unknown): Array<{ key: string; keyObj?: Json; node: Json }> {
  if (!isObj(agg)) return []
  const b = agg.buckets
  if (Array.isArray(b))
    return b.filter(isObj).map((x) => {
      if (isObj(x.key)) return { key: Object.values(x.key).map(String).join(' · '), keyObj: x.key, node: x }
      return { key: String(x.key_as_string ?? x.key), node: x }
    })
  if (isObj(b)) return Object.entries(b).map(([key, node]) => ({ key, node: (isObj(node) ? node : {}) as Json }))
  return []
}

/** Column names an output contributes. */
export function outputColumns(o: OutputMeta): string[] {
  if (o.kind === 'stats') return ['count', 'min', 'max', 'avg', 'sum'].map((s) => `${o.name}.${s}`)
  if (o.kind === 'percentiles') return (o.percents?.length ?? 0) === 1 ? [o.name] : (o.percents ?? []).map((p) => `${o.name}.${p}`)
  return [o.name]
}

function readOutput(o: OutputMeta, node: Json, docCount: number, row: Row): void {
  const v = node[o.name]
  switch (o.kind) {
    case 'count':
      row[o.name] = docCount
      return
    case 'single':
      row[o.name] = isObj(v) ? (v.value ?? null) : undefined
      return
    case 'stats':
      for (const s of ['count', 'min', 'max', 'avg', 'sum']) row[`${o.name}.${s}`] = isObj(v) ? (v[s] ?? null) : undefined
      return
    case 'percentiles': {
      const values = isObj(v) && isObj(v.values) ? v.values : {}
      const one = (o.percents?.length ?? 0) === 1
      for (const p of o.percents ?? []) {
        const k = Object.keys(values).find((x) => Number(x) === p)
        row[one ? o.name : `${o.name}.${p}`] = k !== undefined ? values[k] : undefined
      }
      return
    }
    case 'hits':
      row[o.name] = isObj(v) && isObj(v.hits) ? v.hits.hits : undefined
      return
    case 'raw':
      row[o.name] = v
      return
  }
}

/** Visit every bucket at `target` level (default: the deepest), carrying keys and metrics from the enclosing levels. */
export function walk(response: Json, compiled: Pick<Compiled, 'levels' | 'outputs' | 'sampleWrapper'>, target = compiled.levels.length - 1, visit: (v: BucketVisit) => void): void {
  const { levels, outputs } = compiled
  const keyNames = keyColumnNames(compiled)
  const rec = (li: number, node: Json, docCount: number, row: Row, parentKeys: string[], key: string | undefined, holder: Json | undefined) => {
    for (const o of outputs) if (o.level === li) readOutput(o, node, docCount, row)
    if (li === target) return visit({ row, node, parentKeys, key, docCount, holder })
    const next = levels[li + 1]
    if (!next?.name) return
    const agg = node[next.name]
    if (!isObj(agg)) return
    if (next.kind === 'single') return rec(li + 1, agg, Number(agg.doc_count ?? 0), row, parentKeys, key, holder)
    const cols = keyNames[li + 1] ?? []
    for (const b of bucketsOf(agg)) {
      const r: Row = { ...row }
      if (b.keyObj && cols.length > 1) cols.forEach((c, i) => (r[c] = Object.values(b.keyObj!)[i]))
      else if (cols[0]) r[cols[0]] = b.keyObj ? b.key : (b.node.key_as_string ?? b.node.key ?? b.key)
      rec(li + 1, b.node, Number(b.node.doc_count ?? 0), r, key === undefined ? parentKeys : [...parentKeys, key], b.key, agg)
    }
  }
  rec(0, rootNode(response, compiled), Number(rootNode(response, compiled).doc_count ?? hitsTotal(response) ?? 0), {}, [], undefined, undefined)
}

/** Unique column names for each level's keys (`city.name`, `created_at`…). */
function keyColumnNames(compiled: Pick<Compiled, 'levels'>): string[][] {
  const seen = new Set<string>()
  return compiled.levels.map((l) =>
    l.kind === 'multi'
      ? l.keys.map((k) => {
          let n = k
          for (let i = 2; seen.has(n); i++) n = `${k} (${i})`
          seen.add(n)
          return n
        })
      : []
  )
}

/** Response → one row per leaf bucket combination (AGGREGATIONS.md §6 “Response flattening”). */
export function flatten(response: Json, compiled: Pick<Compiled, 'levels' | 'outputs' | 'sampleWrapper'>, target = compiled.levels.length - 1): FlatTable {
  const keyNames = keyColumnNames(compiled)
  const keyColumns = keyNames.slice(1, target + 1).flat()
  const metricColumns = compiled.outputs.filter((o) => o.level <= target).flatMap(outputColumns)
  const columns = [...keyColumns, 'doc_count', ...metricColumns.filter((c) => c !== 'doc_count')]
  const rows: Row[] = []
  walk(response, compiled, target, (v) => rows.push({ ...v.row, doc_count: v.docCount }))
  return { columns, keyColumns, rows }
}

export interface LevelGroups {
  /** One entry per parent bucket (a single entry for the first level). */
  parents: Array<{ keys: string[]; buckets: Array<{ key: string; docCount: number }>; otherDocs: number }>
  total: number
}

/** Buckets of one multi-bucket level, grouped by their parent bucket — what a Group by card previews. */
export function levelGroups(response: Json, compiled: Pick<Compiled, 'levels' | 'outputs' | 'sampleWrapper'>, level: number): LevelGroups {
  const byParent = new Map<string, LevelGroups['parents'][number]>()
  const holders = new Set<Json>()
  walk(response, compiled, level, (v) => {
    const id = v.parentKeys.join('\u0000')
    let p = byParent.get(id)
    if (!p) byParent.set(id, (p = { keys: v.parentKeys, buckets: [], otherDocs: 0 }))
    p.buckets.push({ key: v.key ?? '', docCount: v.docCount })
    if (v.holder && !holders.has(v.holder)) {
      holders.add(v.holder)
      p.otherDocs += Number(v.holder.sum_other_doc_count ?? 0)
    }
  })
  const parents = [...byParent.values()]
  return { parents, total: parents.reduce((n, p) => n + p.buckets.length, 0) }
}
