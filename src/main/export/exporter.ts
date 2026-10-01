import { createWriteStream, type WriteStream } from 'node:fs'
import { once } from 'node:events'
import { writeFile } from 'node:fs/promises'
import type { ExportFormat } from '@shared/export'
import type { ClusterRequest, ClusterResponse } from '@shared/types'
import { KabanosError } from '../errors'
import { errorReason } from '../metadata/MetadataService'

type Requester = (req: ClusterRequest) => Promise<ClusterResponse>

export interface ExportOptions {
  connectionId: string
  target: string
  /** A search body; only `query`, `sort`, `_source` and `runtime_mappings` are kept. Empty = whole index. */
  body?: string
  format: ExportFormat
  file: string
  /** Include `_id` and `_index` with each document. */
  includeMeta?: boolean
  /** Upper bound on documents written. */
  limit?: number
  signal?: AbortSignal
  onProgress?(p: { count: number; total?: number }): void
}

interface Hit {
  _id: string
  _index: string
  _source?: Record<string, unknown>
}
interface ScrollPage {
  _scroll_id?: string
  hits: { total?: { value: number } | number; hits: Hit[] }
}

const BATCH = 1000

/**
 * Stream every matching document to disk with the scroll API (works on ES and OpenSearch alike).
 * Runs entirely in main — large exports never cross IPC. Writes JSON (array), NDJSON or CSV.
 */
export async function exportDocuments(request: Requester, opts: ExportOptions): Promise<{ count: number; total?: number; cancelled: boolean }> {
  const base: Record<string, unknown> = {}
  if (opts.body?.trim()) {
    let parsed: Record<string, unknown>
    try {
      parsed = JSON.parse(opts.body) as Record<string, unknown>
    } catch {
      throw new KabanosError('VALIDATION', 'The query body is not valid JSON')
    }
    for (const k of ['query', 'sort', '_source', 'runtime_mappings']) if (parsed[k] !== undefined) base[k] = parsed[k]
  }
  // Without an explicit sort, _doc order is the fastest way to scroll.
  base.sort ??= ['_doc']
  const limit = opts.limit ?? Number.POSITIVE_INFINITY
  const writer = new DocWriter(opts.file, opts.format, !!opts.includeMeta)

  let scrollId: string | undefined
  let count = 0
  let total: number | undefined
  let cancelled = false
  try {
    let page = await json<ScrollPage>(
      await request({ connectionId: opts.connectionId, method: 'POST', path: `${encodeURIComponent(opts.target)}/_search?scroll=2m`, body: JSON.stringify({ ...base, size: BATCH, track_total_hits: true }) })
    )
    total = typeof page.hits.total === 'number' ? page.hits.total : page.hits.total?.value
    if (total !== undefined && Number.isFinite(limit)) total = Math.min(total, limit)
    opts.onProgress?.({ count, total })
    while (page.hits.hits.length > 0 && count < limit) {
      if (opts.signal?.aborted) {
        cancelled = true
        break
      }
      scrollId = page._scroll_id
      const hits = page.hits.hits.slice(0, limit - count)
      await writer.write(hits)
      count += hits.length
      opts.onProgress?.({ count, total })
      if (!scrollId || count >= limit) break
      page = await json<ScrollPage>(await request({ connectionId: opts.connectionId, method: 'POST', path: '_search/scroll', body: JSON.stringify({ scroll: '2m', scroll_id: scrollId }) }))
    }
  } finally {
    await writer.close()
    if (scrollId) void request({ connectionId: opts.connectionId, method: 'DELETE', path: '_search/scroll', body: JSON.stringify({ scroll_id: scrollId }) }).catch(() => undefined)
  }
  return { count, total, cancelled }
}

/** Write already-fetched hits (the current results page) in the same formats. */
export async function writeHits(file: string, hits: Hit[], format: ExportFormat, includeMeta: boolean): Promise<number> {
  const writer = new DocWriter(file, format, includeMeta)
  await writer.write(hits)
  await writer.close()
  return hits.length
}

/** Mapping, portable settings and aliases next to a data export, so the index can be recreated. */
export async function writeDefinition(request: Requester, connectionId: string, index: string, file: string): Promise<void> {
  const enc = encodeURIComponent(index)
  const [mapping, settings, aliases] = await Promise.all([
    request({ connectionId, method: 'GET', path: `${enc}/_mapping` }),
    request({ connectionId, method: 'GET', path: `${enc}/_settings?flat_settings=true` }),
    request({ connectionId, method: 'GET', path: `${enc}/_alias` })
  ])
  const pick = <T>(r: ClusterResponse): Record<string, T> => (r.status < 400 ? (JSON.parse(r.body) as Record<string, T>) : {})
  const out: Record<string, unknown> = {}
  const settingsByIndex = pick<{ settings: Record<string, string> }>(settings)
  const aliasesByIndex = pick<{ aliases: Record<string, unknown> }>(aliases)
  for (const [name, m] of Object.entries(pick<{ mappings: unknown }>(mapping))) {
    const flat = settingsByIndex[name]?.settings ?? {}
    out[name] = {
      mappings: m.mappings,
      settings: Object.fromEntries(Object.entries(flat).filter(([k]) => /^index\.(number_of_shards|number_of_replicas|refresh_interval|analysis\.|max_result_window|mapping\.total_fields\.limit|codec|sort\.|similarity\.)/.test(k))),
      aliases: aliasesByIndex[name]?.aliases ?? {}
    }
  }
  await writeFile(file, JSON.stringify(out, null, 2))
}

class DocWriter {
  private readonly out: WriteStream
  private columns?: string[]
  private first = true

  constructor(
    file: string,
    private readonly format: ExportFormat,
    private readonly includeMeta: boolean
  ) {
    this.out = createWriteStream(file, { encoding: 'utf8' })
    if (format === 'json') this.out.write('[\n')
  }

  private async put(chunk: string): Promise<void> {
    if (!this.out.write(chunk)) await once(this.out, 'drain')
  }

  private doc(h: Hit): Record<string, unknown> {
    return this.includeMeta ? { _id: h._id, _index: h._index, ...h._source } : { ...h._source }
  }

  async write(hits: Hit[]): Promise<void> {
    if (!hits.length) return
    if (this.format === 'ndjson') return this.put(hits.map((h) => JSON.stringify(this.doc(h))).join('\n') + '\n')
    if (this.format === 'json') {
      const body = hits.map((h) => `  ${JSON.stringify(this.doc(h))}`).join(',\n')
      await this.put((this.first ? '' : ',\n') + body)
      this.first = false
      return
    }
    const rows = hits.map((h) => flatten(this.doc(h)))
    if (!this.columns) {
      // Columns come from the first batch; fields that only appear later are dropped.
      const set = new Set<string>()
      for (const r of rows) for (const k of Object.keys(r)) set.add(k)
      this.columns = [...set]
      await this.put(this.columns.map(csvCell).join(',') + '\n')
    }
    await this.put(rows.map((r) => this.columns!.map((c) => csvCell(r[c])).join(',')).join('\n') + '\n')
  }

  async close(): Promise<void> {
    if (this.format === 'json') this.out.write(this.first ? ']\n' : '\n]\n')
    this.out.end()
    await once(this.out, 'finish').catch(() => undefined)
  }
}

async function json<T>(res: ClusterResponse): Promise<T> {
  if (res.status >= 400) throw new KabanosError('NETWORK', `Export failed: HTTP ${res.status} ${errorReason(res.body)}`)
  return JSON.parse(res.body) as T
}

export function flatten(obj: Record<string, unknown>, prefix = '', out: Record<string, unknown> = {}): Record<string, unknown> {
  for (const [k, v] of Object.entries(obj)) {
    const key = prefix ? `${prefix}.${k}` : k
    if (v && typeof v === 'object' && !Array.isArray(v)) flatten(v as Record<string, unknown>, key, out)
    else out[key] = v
  }
  return out
}

export function csvCell(v: unknown): string {
  if (v === undefined || v === null) return ''
  const s = typeof v === 'string' ? v : JSON.stringify(v)
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}
