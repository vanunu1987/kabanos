import { beforeEach, describe, expect, it } from 'vitest'
import type { Cipher } from '../connections/secrets'
import { openDb, type Db } from '../store/db'
import { LibraryStore } from '../store/LibraryStore'

const cipher: Cipher = {
  isAvailable: () => true,
  encrypt: (s) => Buffer.from(`enc:${Buffer.from(s).toString('base64')}`),
  decrypt: (b) => Buffer.from(b.toString().slice(4), 'base64').toString()
}

describe('LibraryStore', () => {
  let db: Db
  let lib: LibraryStore

  beforeEach(() => {
    db = openDb(':memory:')
    lib = new LibraryStore(db, cipher)
  })

  it('searches title, body, path (index), dotted field names and #tags', () => {
    const f = lib.createFolder('Listings relevance')
    lib.createQuery({ folderId: f.id, title: 'Boost by freshness in a city', method: 'POST', path: 'listings/_search', body: '{"query":{"term":{"city.name":"TLV"}}}', tags: ['relevance'] })
    lib.createQuery({ title: 'Cluster health', method: 'GET', path: '_cluster/health', tags: ['#ops'] })
    lib.createQuery({ title: 'Zero results', method: 'POST', path: 'search-logs/_search', body: '{"query":{"term":{"results":0}}}' })

    const titles = (s: string) => lib.queries({ kind: 'all' }, s).map((q) => q.title)
    expect(titles('fresh')).toEqual(['Boost by freshness in a city'])
    expect(titles('city.name')).toEqual(['Boost by freshness in a city'])
    expect(titles('search-logs')).toEqual(['Zero results'])
    expect(titles('listings')).toEqual(['Boost by freshness in a city'])
    expect(titles('#ops')).toEqual(['Cluster health'])
    expect(titles('term #relevance')).toEqual(['Boost by freshness in a city'])
    expect(titles('"')).toEqual(expect.any(Array)) // half-typed input never throws
    expect(lib.tags()).toEqual([
      { tag: 'ops', count: 1 },
      { tag: 'relevance', count: 1 }
    ])
  })

  it('updates the search index on edit and delete', () => {
    const q = lib.createQuery({ title: 'old name', method: 'GET', path: '_search' })
    lib.updateQuery(q.id, { title: 'renamed thing' })
    expect(lib.queries({ kind: 'all' }, 'old')).toHaveLength(0)
    expect(lib.queries({ kind: 'all' }, 'renamed')).toHaveLength(1)
    lib.removeQuery(q.id)
    expect(lib.queries({ kind: 'all' }, 'renamed')).toHaveLength(0)
  })

  it('pinned and recent filters', () => {
    const a = lib.createQuery({ title: 'a', method: 'GET', path: '_search', pinned: true })
    const b = lib.createQuery({ title: 'b', method: 'GET', path: '_search' })
    lib.recordRun({ connectionId: 'c', queryId: b.id, method: 'GET', path: '_search', body: '', status: 200, ms: 5 })
    expect(lib.queries({ kind: 'pinned' }).map((q) => q.id)).toEqual([a.id])
    expect(lib.queries({ kind: 'recent' }).map((q) => q.id)).toEqual([b.id])
    expect(lib.query(b.id)).toMatchObject({ lastStatus: 200, lastMs: 5 })
  })

  it('deleting a folder moves its contents up a level', () => {
    const parent = lib.createFolder('parent')
    const child = lib.createFolder('child', parent.id)
    const grand = lib.createFolder('grand', child.id)
    const q = lib.createQuery({ folderId: child.id, title: 'q', method: 'GET', path: '_search' })
    lib.removeFolder(child.id)
    expect(lib.query(q.id).folderId).toBe(parent.id)
    expect(lib.folders().find((f) => f.id === grand.id)?.parentId).toBe(parent.id)
    expect(() => lib.updateFolder(parent.id, { parentId: grand.id })).toThrow(/itself/)
  })

  it('workspace blocks: order, collapse, and unfiled scratch cleanup', () => {
    const [tab] = lib.ensureTab()
    const saved = lib.createQuery({ folderId: lib.createFolder('f').id, title: 'saved', method: 'GET', path: '_search' })
    const scratch = lib.createQuery({ title: 'scratch', method: 'GET', path: '_count' })
    lib.addBlock(tab!.id, saved.id)
    lib.addBlock(tab!.id, scratch.id)
    lib.reorder(tab!.id, [scratch.id, saved.id])
    lib.setCollapsed(tab!.id, [saved.id], true)
    expect(lib.blocks(tab!.id).map((b) => [b.query.title, b.collapsed])).toEqual([
      ['scratch', false],
      ['saved', true]
    ])
    lib.removeBlock(tab!.id, scratch.id)
    expect(() => lib.query(scratch.id)).toThrow() // unfiled + only open here → gone
    lib.removeTab(tab!.id)
    expect(lib.query(saved.id).title).toBe('saved') // filed queries survive their tab
  })

  it('keeps only the last 5 responses per query and searches history', () => {
    const q = lib.createQuery({ title: 'q', method: 'GET', path: 'listings/_search' })
    for (let i = 0; i < 8; i++) lib.recordRun({ connectionId: 'c', queryId: q.id, method: 'GET', path: 'listings/_search', body: `{"i":${i}}`, status: 200, response: `{"run":${i}}` })
    const r = lib.responses(q.id)
    expect(r).toHaveLength(5)
    expect(r[0]!.response).toBe('{"run":7}')
    expect(lib.history('listings')).toHaveLength(8)
    expect(lib.history('nomatch')).toHaveLength(0)
  })

  it('environments keep secret variables encrypted and out of listings', () => {
    const env = lib.saveEnvironment({ name: 'prod', vars: [{ key: 'index', value: 'listings', secret: false }, { key: 'token', value: 's3cret', secret: true }] })
    expect(env.vars).toEqual([
      { key: 'index', value: 'listings', secret: false },
      { key: 'token', value: '', secret: true }
    ])
    expect(JSON.stringify(db.prepare('SELECT * FROM env_vars').all())).not.toContain('s3cret')
    expect(lib.resolveVars(env.id)).toEqual({ index: 'listings', token: 's3cret' })
    // Saving again without re-typing the secret keeps it.
    lib.saveEnvironment({ id: env.id, name: 'prod', vars: [{ key: 'index', value: 'listings-v8', secret: false }, { key: 'token', value: '', secret: true }] })
    expect(lib.resolveVars(env.id)).toEqual({ index: 'listings-v8', token: 's3cret' })
  })
})
