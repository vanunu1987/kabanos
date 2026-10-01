import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { ClusterRequest, ClusterResponse } from '@shared/types'
import { csvCell, exportDocuments, writeDefinition, writeHits } from '../export/exporter'

const reply = (body: unknown): ClusterResponse => ({ status: 200, headers: {}, body: JSON.stringify(body), ms: 1, bytes: 1, opaqueId: 'x' })

function fakeCluster(total: number) {
  const calls: ClusterRequest[] = []
  let served = 0
  const request = async (req: ClusterRequest): Promise<ClusterResponse> => {
    calls.push(req)
    if (req.method === 'DELETE') return reply({ succeeded: true })
    const n = Math.min(1000, total - served)
    const hits = Array.from({ length: n }, (_, i) => ({ _id: String(served + i), _index: 'idx', _source: { title: `t,${served + i}`, city: { name: 'TLV' } } }))
    served += n
    return reply({ _scroll_id: 'sid', hits: { total: { value: total }, hits } })
  }
  return { request, calls }
}

describe('exportDocuments', () => {
  const dir = mkdtempSync(join(tmpdir(), 'kabanos-export-'))

  it('streams all scroll pages to NDJSON, reports progress and clears the scroll', async () => {
    const { request, calls } = fakeCluster(2500)
    const file = join(dir, 'a.ndjson')
    const progress: number[] = []
    const res = await exportDocuments(request, { connectionId: 'c', target: 'idx', body: '{"query":{"term":{"a":1}},"size":5,"aggs":{}}', format: 'ndjson', includeMeta: true, file, onProgress: (p) => progress.push(p.count) })
    expect(res).toEqual({ count: 2500, total: 2500, cancelled: false })
    const lines = readFileSync(file, 'utf8').trim().split('\n')
    expect(lines).toHaveLength(2500)
    expect(JSON.parse(lines[0]!)).toMatchObject({ _id: '0', _index: 'idx', title: 't,0' })
    expect(JSON.parse(calls[0]!.body!)).toEqual({ query: { term: { a: 1 } }, sort: ['_doc'], size: 1000, track_total_hits: true })
    expect(calls.at(-1)).toMatchObject({ method: 'DELETE', path: '_search/scroll' })
    expect(progress).toEqual([0, 1000, 2000, 2500])
  })

  it('writes a valid JSON array, with or without metadata', async () => {
    const { request } = fakeCluster(1500)
    const file = join(dir, 'a.json')
    await exportDocuments(request, { connectionId: 'c', target: 'idx', format: 'json', includeMeta: false, file })
    const docs = JSON.parse(readFileSync(file, 'utf8')) as Array<Record<string, unknown>>
    expect(docs).toHaveLength(1500)
    expect(docs[0]).toEqual({ title: 't,0', city: { name: 'TLV' } })
  })

  it('writes CSV with flattened columns, escaping and a limit', async () => {
    const { request } = fakeCluster(50)
    const file = join(dir, 'a.csv')
    const res = await exportDocuments(request, { connectionId: 'c', target: 'idx', format: 'csv', includeMeta: true, file, limit: 10 })
    expect(res.count).toBe(10)
    const lines = readFileSync(file, 'utf8').trim().split('\n')
    expect(lines[0]).toBe('_id,_index,title,city.name')
    expect(lines[1]).toBe('0,idx,"t,0",TLV')
    expect(lines).toHaveLength(11)
  })

  it('stops on cancel and keeps what was written', async () => {
    const { request } = fakeCluster(5000)
    const abort = new AbortController()
    const file = join(dir, 'c.ndjson')
    const res = await exportDocuments(request, { connectionId: 'c', target: 'idx', format: 'ndjson', file, signal: abort.signal, onProgress: (p) => p.count >= 2000 && abort.abort() })
    expect(res.cancelled).toBe(true)
    expect(res.count).toBe(2000)
    expect(readFileSync(file, 'utf8').trim().split('\n')).toHaveLength(2000)
  })

  it('an empty JSON export is still valid JSON', async () => {
    const { request } = fakeCluster(0)
    const file = join(dir, 'e.json')
    await exportDocuments(request, { connectionId: 'c', target: 'idx', format: 'json', file })
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual([])
  })

  it('escapes CSV cells', () => {
    expect(csvCell('a"b')).toBe('"a""b"')
    expect(csvCell(['x', 1])).toBe('"[""x"",1]"')
    expect(csvCell(null)).toBe('')
  })
})

describe('writeHits / writeDefinition', () => {
  const dir = mkdtempSync(join(tmpdir(), 'kabanos-export2-'))

  it('writes the current page without touching the cluster', async () => {
    const file = join(dir, 'page.json')
    const n = await writeHits(file, [{ _id: '1', _index: 'i', _source: { a: 1 } }], 'json', true)
    expect(n).toBe(1)
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual([{ _id: '1', _index: 'i', a: 1 }])
  })

  it('saves mapping, portable settings and aliases', async () => {
    const request = async (req: ClusterRequest): Promise<ClusterResponse> =>
      reply(
        req.path.endsWith('_mapping')
          ? { idx: { mappings: { properties: { a: { type: 'keyword' } } } } }
          : req.path.includes('_settings')
            ? { idx: { settings: { 'index.number_of_shards': '2', 'index.uuid': 'u', 'index.creation_date': '1' } } }
            : { idx: { aliases: { listings: { is_write_index: true } } } }
      )
    const file = join(dir, 'def.json')
    await writeDefinition(request, 'c', 'idx', file)
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({
      idx: { mappings: { properties: { a: { type: 'keyword' } } }, settings: { 'index.number_of_shards': '2' }, aliases: { listings: { is_write_index: true } } }
    })
  })
})
