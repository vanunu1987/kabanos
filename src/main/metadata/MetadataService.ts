import {
  flattenMapping,
  matchTemplate,
  type AliasDetail,
  type AliasSummary,
  type ClusterTree,
  type DataStreamSummary,
  type FieldInfo,
  type Health,
  type IndexDetail,
  type IndexSummary,
  type ShardInfo,
  type TemplateSummary
} from '@shared/meta'
import type { ClusterRequest, ClusterResponse } from '@shared/types'
import { KabanosError } from '../errors'

type Requester = (req: ClusterRequest) => Promise<ClusterResponse>

const TREE_TTL_MS = 30_000

/**
 * Reads and normalises cluster metadata for the Explorer and autocomplete.
 * The tree is cached per connection; `force` bypasses the cache (manual refresh, after writes).
 */
export class MetadataService {
  private readonly trees = new Map<string, Promise<ClusterTree>>()

  constructor(private readonly request: Requester) {}

  tree(connectionId: string, force = false): Promise<ClusterTree> {
    const cached = this.trees.get(connectionId)
    if (cached && !force) {
      return cached.then((t) => (Date.now() - t.fetchedAt < TREE_TTL_MS ? t : this.tree(connectionId, true)))
    }
    const p = this.loadTree(connectionId)
    this.trees.set(connectionId, p)
    p.catch(() => this.trees.delete(connectionId))
    return p
  }

  invalidate(connectionId: string): void {
    this.trees.delete(connectionId)
  }

  async index(connectionId: string, name: string): Promise<IndexDetail> {
    const enc = encodeURIComponent(name)
    const [settings, mapping, aliases, shards, tree] = await Promise.all([
      this.json<Record<string, { settings: Record<string, string> }>>(connectionId, `${enc}/_settings?flat_settings=true`),
      this.json<Record<string, { mappings: unknown }>>(connectionId, `${enc}/_mapping`),
      this.json<Record<string, { aliases: Record<string, { is_write_index?: boolean; filter?: unknown; index_routing?: string }> }>>(connectionId, `${enc}/_alias`, {}),
      this.json<CatShard[]>(connectionId, `_cat/shards/${enc}?format=json&bytes=b&h=shard,prirep,state,docs,store,node,unassigned.reason`, []),
      this.tree(connectionId)
    ])
    const mappings = mapping[name]?.mappings ?? Object.values(mapping)[0]?.mappings ?? {}
    const aliasMap = aliases[name]?.aliases ?? {}
    return {
      name,
      summary: tree.indices.find((i) => i.name === name),
      settings: settings[name]?.settings ?? Object.values(settings)[0]?.settings ?? {},
      mapping: mappings,
      fields: flattenMapping(mappings),
      aliases: Object.entries(aliasMap).map(([alias, a]) => ({ name: alias, isWriteIndex: !!a.is_write_index, filter: a.filter, routing: a.index_routing })),
      matchedTemplate: matchTemplate(name, tree.templates),
      shards: shards
        .map(
          (s): ShardInfo => ({
            shard: Number(s.shard),
            primary: s.prirep === 'p',
            state: s.state,
            docs: num(s.docs),
            storeBytes: num(s.store),
            node: s.node ?? undefined,
            unassignedReason: s['unassigned.reason'] ?? undefined
          })
        )
        .sort((a, b) => a.shard - b.shard || Number(b.primary) - Number(a.primary))
    }
  }

  async alias(connectionId: string, name: string): Promise<AliasDetail> {
    const enc = encodeURIComponent(name)
    const [aliasRes, mapping] = await Promise.all([
      this.json<Record<string, { aliases: Record<string, { is_write_index?: boolean; filter?: unknown }> }>>(connectionId, `_alias/${enc}`),
      this.json<Record<string, { mappings: unknown }>>(connectionId, `${enc}/_mapping`, {})
    ])
    const targets: AliasDetail['targets'] = []
    const filters: Record<string, unknown> = {}
    for (const [index, v] of Object.entries(aliasRes)) {
      const a = v.aliases[name]
      if (!a) continue
      targets.push({ index, isWriteIndex: !!a.is_write_index, filter: !!a.filter })
      if (a.filter) filters[index] = a.filter
    }
    targets.sort((a, b) => a.index.localeCompare(b.index))
    return { name, targets, filters, fields: unionFields(Object.values(mapping).map((m) => flattenMapping(m.mappings))) }
  }

  /** Fields for an index, alias, data stream or wildcard pattern — used by autocomplete and the Index view. */
  async fields(connectionId: string, target: string): Promise<FieldInfo[]> {
    const mapping = await this.json<Record<string, { mappings: unknown }>>(connectionId, `${encodeURIComponent(target)}/_mapping`, {})
    return unionFields(Object.values(mapping).map((m) => flattenMapping(m.mappings)))
  }

  private async loadTree(connectionId: string): Promise<ClusterTree> {
    const [health, cat, aliases, dataStreams, indexTemplates, componentTemplates] = await Promise.all([
      this.json<{ cluster_name?: string; status?: Health; number_of_nodes?: number }>(connectionId, '_cluster/health', {}),
      this.json<CatIndex[]>(
        connectionId,
        '_cat/indices?format=json&bytes=b&expand_wildcards=all&h=index,health,status,docs.count,store.size,pri,rep,creation.date.string'
      ),
      this.json<CatAlias[]>(connectionId, '_cat/aliases?format=json&h=alias,index,filter,is.write.index', []),
      this.json<{ data_streams?: RawDataStream[] }>(connectionId, '_data_stream?expand_wildcards=all', {}),
      this.json<{ index_templates?: RawIndexTemplate[] }>(connectionId, '_index_template', {}),
      this.json<{ component_templates?: RawComponentTemplate[] }>(connectionId, '_component_template', {})
    ])

    const streams: DataStreamSummary[] = (dataStreams.data_streams ?? []).map((d) => ({
      name: d.name,
      indices: (d.indices ?? []).map((i) => i.index_name),
      template: d.template,
      health: normHealth(d.status),
      hidden: !!d.hidden || !!d.system || d.name.startsWith('.')
    }))
    const backing = new Map(streams.flatMap((s) => s.indices.map((i) => [i, s.name] as const)))

    const indices: IndexSummary[] = cat
      .map((r) => ({
        name: r.index,
        health: r.status === 'close' ? 'unknown' : normHealth(r.health),
        status: r.status === 'close' ? ('close' as const) : ('open' as const),
        docs: num(r['docs.count']) ?? 0,
        storeBytes: num(r['store.size']) ?? 0,
        primaries: num(r.pri) ?? 0,
        replicas: num(r.rep) ?? 0,
        createdAt: r['creation.date.string'] ?? undefined,
        hidden: r.index.startsWith('.'),
        dataStream: backing.get(r.index)
      }))
      .sort((a, b) => a.name.localeCompare(b.name))

    const aliasMap = new Map<string, AliasSummary>()
    for (const a of aliases) {
      const entry = aliasMap.get(a.alias) ?? { name: a.alias, indices: [] }
      entry.indices.push({ index: a.index, isWriteIndex: a['is.write.index'] === 'true', filter: !!a.filter && a.filter !== '-' })
      aliasMap.set(a.alias, entry)
    }

    const templates: TemplateSummary[] = [
      ...(indexTemplates.index_templates ?? []).map(
        (t): TemplateSummary => ({
          name: t.name,
          kind: 'index',
          patterns: toArray(t.index_template.index_patterns),
          priority: t.index_template.priority,
          composedOf: t.index_template.composed_of ?? [],
          dataStream: !!t.index_template.data_stream,
          managed: !!t.index_template._meta?.managed,
          body: t.index_template
        })
      ),
      ...(componentTemplates.component_templates ?? []).map(
        (t): TemplateSummary => ({
          name: t.name,
          kind: 'component',
          patterns: [],
          composedOf: [],
          dataStream: false,
          managed: !!(t.component_template as { _meta?: { managed?: boolean } })._meta?.managed,
          body: t.component_template
        })
      )
    ].sort((a, b) => a.kind.localeCompare(b.kind) || a.name.localeCompare(b.name))

    return {
      clusterName: health.cluster_name,
      health: normHealth(health.status),
      nodes: health.number_of_nodes ?? 0,
      indices,
      aliases: [...aliasMap.values()].sort((a, b) => a.name.localeCompare(b.name)),
      dataStreams: streams.sort((a, b) => a.name.localeCompare(b.name)),
      templates,
      fetchedAt: Date.now()
    }
  }

  /** GET + JSON parse. With a fallback, any error (404, missing plugin, 403) yields the fallback. */
  private async json<T>(connectionId: string, path: string, fallback?: T): Promise<T> {
    try {
      const res = await this.request({ connectionId, method: 'GET', path })
      if (res.status >= 400) {
        if (fallback !== undefined) return fallback
        throw new KabanosError('NETWORK', `GET ${path} → HTTP ${res.status}: ${errorReason(res.body)}`)
      }
      return JSON.parse(res.body) as T
    } catch (err) {
      if (fallback !== undefined && !(err instanceof KabanosError && err.code === 'CANCELLED')) return fallback
      throw err
    }
  }
}

interface CatIndex {
  index: string
  health: string
  status: string
  'docs.count': string | null
  'store.size': string | null
  pri: string
  rep: string
  'creation.date.string'?: string
}
interface CatAlias {
  alias: string
  index: string
  filter: string
  'is.write.index': string
}
interface CatShard {
  shard: string
  prirep: string
  state: string
  docs: string | null
  store: string | null
  node: string | null
  'unassigned.reason': string | null
}
interface RawDataStream {
  name: string
  indices?: Array<{ index_name: string }>
  template?: string
  status?: string
  hidden?: boolean
  system?: boolean
}
interface RawIndexTemplate {
  name: string
  index_template: { index_patterns: string | string[]; priority?: number; composed_of?: string[]; data_stream?: unknown; _meta?: { managed?: boolean } }
}
interface RawComponentTemplate {
  name: string
  component_template: unknown
}

function num(v: string | null | undefined): number | undefined {
  if (v === null || v === undefined || v === '') return undefined
  const n = Number(v)
  return Number.isFinite(n) ? n : undefined
}

function normHealth(h: string | undefined): Health {
  const v = h?.toLowerCase()
  return v === 'green' || v === 'yellow' || v === 'red' ? v : 'unknown'
}

function toArray(v: string | string[] | undefined): string[] {
  return v === undefined ? [] : Array.isArray(v) ? v : [v]
}

export function unionFields(lists: FieldInfo[][]): FieldInfo[] {
  const seen = new Map<string, FieldInfo>()
  const out: FieldInfo[] = []
  for (const list of lists) {
    for (const f of list) {
      const first = seen.get(f.path)
      if (!first) {
        const copy = { ...f }
        seen.set(f.path, copy)
        out.push(copy)
      } else if (first.type !== f.type && !(first.conflicts ?? []).includes(f.type)) first.conflicts = [...(first.conflicts ?? [first.type]), f.type]
    }
  }
  return out
}

export function errorReason(body: string): string {
  try {
    const j = JSON.parse(body) as { error?: { reason?: string; type?: string } | string }
    if (typeof j.error === 'string') return j.error
    return j.error?.reason ?? j.error?.type ?? body.slice(0, 200)
  } catch {
    return body.slice(0, 200)
  }
}
