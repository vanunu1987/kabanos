import type { ConnectionConfig } from '@shared/types'
import { api } from '../../api'
import type { Hit } from './DocumentCards'

/**
 * Point-in-time + search_after paging. Elasticsearch and OpenSearch differ in endpoint,
 * response key and tiebreaker sort, so both shapes live here.
 */
export interface PitPage {
  hits: Hit[]
  total: number
  pitId: string
  /** search_after cursor for the next page (sort values of the last hit). */
  next?: unknown[]
}

const KEEP_ALIVE = '5m'

function isOpenSearch(conn: ConnectionConfig): boolean {
  return (conn.detected?.engine ?? conn.engine) === 'opensearch'
}

export async function openPit(conn: ConnectionConfig, target: string): Promise<string> {
  const path = isOpenSearch(conn) ? `${encodeURIComponent(target)}/_search/point_in_time?keep_alive=${KEEP_ALIVE}` : `${encodeURIComponent(target)}/_pit?keep_alive=${KEEP_ALIVE}`
  const res = await api.cluster.request({ connectionId: conn.id, method: 'POST', path })
  if (res.status >= 400) throw new Error(`Could not open a point in time (HTTP ${res.status})`)
  const j = JSON.parse(res.body) as { id?: string; pit_id?: string }
  const id = j.id ?? j.pit_id
  if (!id) throw new Error('Point in time response had no id')
  return id
}

export async function pitPage(conn: ConnectionConfig, pitId: string, size: number, searchAfter?: unknown[], query?: unknown): Promise<PitPage> {
  const body = {
    size,
    pit: { id: pitId, keep_alive: KEEP_ALIVE },
    sort: [isOpenSearch(conn) ? { _doc: 'asc' } : { _shard_doc: 'asc' }],
    track_total_hits: true,
    seq_no_primary_term: true,
    ...(query ? { query } : {}),
    ...(searchAfter ? { search_after: searchAfter } : {})
  }
  const res = await api.cluster.request({ connectionId: conn.id, method: 'POST', path: '_search', body: JSON.stringify(body) })
  if (res.status >= 400) throw new Error(`HTTP ${res.status}: ${res.body.slice(0, 200)}`)
  const j = JSON.parse(res.body) as { pit_id?: string; hits: { total: { value: number } | number; hits: Hit[] } }
  const hits = j.hits.hits
  return {
    hits,
    total: typeof j.hits.total === 'number' ? j.hits.total : j.hits.total.value,
    pitId: j.pit_id ?? pitId,
    next: hits.length === size ? hits.at(-1)?.sort : undefined
  }
}

export async function closePit(conn: ConnectionConfig, pitId: string): Promise<void> {
  const req = isOpenSearch(conn)
    ? { method: 'DELETE' as const, path: '_search/point_in_time', body: JSON.stringify({ pit_id: [pitId] }) }
    : { method: 'DELETE' as const, path: '_pit', body: JSON.stringify({ id: pitId }) }
  await api.cluster.request({ connectionId: conn.id, ...req }).catch(() => undefined)
}
