import { scopeToClusters as scopeToClustersForTest } from '../store/db'
import { beforeEach, describe, expect, it } from 'vitest'
import type { Cipher } from '../connections/secrets'
import { migrate, openDb, type Db } from '../store/db'
import Database from 'better-sqlite3'
import { LibraryStore } from '../store/LibraryStore'

const cipher: Cipher = {
  isAvailable: () => true,
  encrypt: (s) => Buffer.from(`enc:${Buffer.from(s).toString('base64')}`),
  decrypt: (b) => Buffer.from(b.toString().slice(4), 'base64').toString()
}

const addConn = (db: Db, id: string, created = '2026-01-01T00:00:00Z') =>
  db.prepare("INSERT INTO connections (id, name, url, auth_kind, tls_json, created_at) VALUES (?, ?, 'http://x', 'none', '{}', ?)").run(id, id, created)

describe('LibraryStore', () => {
  let db: Db
  let lib: LibraryStore
  const C = 'dev'

  beforeEach(() => {
    db = openDb(':memory:')
    addConn(db, 'dev')
    addConn(db, 'prod', '2026-02-01T00:00:00Z')
    lib = new LibraryStore(db, cipher)
  })

  it('searches title, body, path (index), dotted field names and #tags', () => {
    const f = lib.createFolder(C, 'Listings relevance')
    lib.createQuery({ connectionId: C, folderId: f.id, title: 'Boost by freshness in a city', method: 'POST', path: 'listings/_search', body: '{"query":{"term":{"city.name":"TLV"}}}', tags: ['relevance'] })
    lib.createQuery({ connectionId: C, title: 'Cluster health', method: 'GET', path: '_cluster/health', tags: ['#ops'] })
    lib.createQuery({ connectionId: C, title: 'Zero results', method: 'POST', path: 'search-logs/_search', body: '{"query":{"term":{"results":0}}}' })

    const titles = (s: string) => lib.queries(C, { kind: 'all' }, s).map((q) => q.title)
    expect(titles('fresh')).toEqual(['Boost by freshness in a city'])
    expect(titles('city.name')).toEqual(['Boost by freshness in a city'])
    expect(titles('search-logs')).toEqual(['Zero results'])
    expect(titles('listings')).toEqual(['Boost by freshness in a city'])
    expect(titles('#ops')).toEqual(['Cluster health'])
    expect(titles('term #relevance')).toEqual(['Boost by freshness in a city'])
    expect(titles('"')).toEqual(expect.any(Array)) // half-typed input never throws
    expect(lib.tags(C)).toEqual([
      { tag: 'ops', count: 1 },
      { tag: 'relevance', count: 1 }
    ])
  })

  it('updates the search index on edit and delete', () => {
    const q = lib.createQuery({ connectionId: C, title: 'old name', method: 'GET', path: '_search' })
    lib.updateQuery(q.id, { title: 'renamed thing' })
    expect(lib.queries(C, { kind: 'all' }, 'old')).toHaveLength(0)
    expect(lib.queries(C, { kind: 'all' }, 'renamed')).toHaveLength(1)
    lib.removeQuery(q.id)
    expect(lib.queries(C, { kind: 'all' }, 'renamed')).toHaveLength(0)
  })

  it('pinned and recent filters', () => {
    const a = lib.createQuery({ connectionId: C, title: 'a', method: 'GET', path: '_search', pinned: true })
    const b = lib.createQuery({ connectionId: C, title: 'b', method: 'GET', path: '_search' })
    lib.recordRun({ connectionId: 'c', queryId: b.id, method: 'GET', path: '_search', body: '', status: 200, ms: 5 })
    expect(lib.queries(C, { kind: 'pinned' }).map((q) => q.id)).toEqual([a.id])
    expect(lib.queries(C, { kind: 'recent' }).map((q) => q.id)).toEqual([b.id])
    expect(lib.query(b.id)).toMatchObject({ lastStatus: 200, lastMs: 5 })
  })

  it('deleting a folder moves its contents up a level', () => {
    const parent = lib.createFolder(C, 'parent')
    const child = lib.createFolder(C, 'child', parent.id)
    const grand = lib.createFolder(C, 'grand', child.id)
    const q = lib.createQuery({ connectionId: C, folderId: child.id, title: 'q', method: 'GET', path: '_search' })
    lib.removeFolder(child.id)
    expect(lib.query(q.id).folderId).toBe(parent.id)
    expect(lib.folders(C).find((f) => f.id === grand.id)?.parentId).toBe(parent.id)
    expect(() => lib.updateFolder(parent.id, { parentId: grand.id })).toThrow(/itself/)
  })

  it('workspace blocks: order, collapse, and unfiled scratch cleanup', () => {
    const [tab] = lib.ensureTab(C)
    const saved = lib.createQuery({ connectionId: C, folderId: lib.createFolder(C, 'f').id, title: 'saved', method: 'GET', path: '_search' })
    const scratch = lib.createQuery({ connectionId: C, title: 'scratch', method: 'GET', path: '_count' })
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
    const q = lib.createQuery({ connectionId: C, title: 'q', method: 'GET', path: 'listings/_search' })
    for (let i = 0; i < 8; i++) lib.recordRun({ connectionId: 'c', queryId: q.id, method: 'GET', path: 'listings/_search', body: `{"i":${i}}`, status: 200, response: `{"run":${i}}` })
    const r = lib.responses(q.id)
    expect(r).toHaveLength(5)
    expect(r[0]!.response).toBe('{"run":7}')
    expect(lib.history('c', 'listings')).toHaveLength(8)
    expect(lib.history('c', 'nomatch')).toHaveLength(0)
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

  it('keeps every cluster to itself: queries, folders, tags, tabs and history', () => {
    const devF = lib.createFolder('dev', 'Ops')
    lib.createQuery({ connectionId: 'dev', folderId: devF.id, title: 'dev query', method: 'GET', path: '_search', tags: ['ops'] })
    lib.createQuery({ connectionId: 'prod', title: 'prod query', method: 'GET', path: '_search' })
    expect(lib.queries('dev').map((q) => q.title)).toEqual(['dev query'])
    expect(lib.queries('prod').map((q) => q.title)).toEqual(['prod query'])
    expect(lib.queries('*').map((q) => q.title).sort()).toEqual(['dev query', 'prod query'])
    expect(lib.folders('prod')).toEqual([])
    expect(lib.tags('prod')).toEqual([])
    expect(lib.ensureTab('dev')[0]!.id).not.toBe(lib.ensureTab('prod')[0]!.id)
    lib.recordRun({ connectionId: 'prod', method: 'GET', path: '_search', body: '' })
    expect(lib.history('dev')).toHaveLength(0)
    expect(lib.history('prod')).toHaveLength(1)
  })

  it("won't mix clusters: folders and tabs of another cluster are refused", () => {
    const prodFolder = lib.createFolder('prod', 'Prod only')
    expect(() => lib.createQuery({ connectionId: 'dev', folderId: prodFolder.id, title: 'x', method: 'GET', path: '_search' })).toThrow(/another cluster/)
    const q = lib.createQuery({ connectionId: 'dev', title: 'x', method: 'GET', path: '_search' })
    expect(() => lib.updateQuery(q.id, { folderId: prodFolder.id })).toThrow(/another cluster/)
    expect(() => lib.addBlock(lib.ensureTab('prod')[0]!.id, q.id)).toThrow(/another cluster/)
    expect(() => lib.createFolder('dev', 'child', prodFolder.id)).toThrow(/another cluster/)
  })

  it('imports copies from another cluster on purpose, keeping folder paths', () => {
    const ops = lib.createFolder('dev', 'Ops')
    const deep = lib.createFolder('dev', 'Health', ops.id)
    const a = lib.createQuery({ connectionId: 'dev', folderId: deep.id, title: 'health', method: 'GET', path: '_cluster/health', tags: ['ops'] })
    const b = lib.createQuery({ connectionId: 'dev', title: 'agg', method: 'POST', path: 'x/_search', body: '{}', pipeline: JSON.stringify({ id: 'p', target: 'x', stages: [], connectionId: 'dev' }) })
    lib.createFolder('prod', 'Ops') // an existing folder with the same name is reused
    expect(lib.importQueries('prod', [a.id, b.id])).toEqual({ imported: 2 })
    const copies = lib.queries('prod')
    expect(copies.map((q) => q.title).sort()).toEqual(['agg', 'health'])
    const health = copies.find((q) => q.title === 'health')!
    const folders = lib.folders('prod')
    expect(folders.filter((f) => f.name === 'Ops')).toHaveLength(1)
    expect(folders.find((f) => f.id === health.folderId)).toMatchObject({ name: 'Health', parentId: folders.find((f) => f.name === 'Ops')!.id })
    expect(health.tags).toEqual(['ops'])
    expect(JSON.parse(copies.find((q) => q.title === 'agg')!.pipeline!).connectionId).toBe('prod')
    expect(lib.queries('dev')).toHaveLength(2) // originals untouched
    expect(lib.importQueries('dev', [a.id])).toEqual({ imported: 0 }) // already in that cluster
  })
})

describe('migration to per-cluster libraries', () => {
  it('assigns queries by last run, splits mixed folders and tabs per cluster', () => {
    // A fully migrated database whose rows are then reset to the legacy state (no cluster yet).
    const raw = new Database(':memory:')
    raw.pragma('foreign_keys = ON')
    migrate(raw)
    addConn(raw, 'dev')
    addConn(raw, 'prod', '2026-02-01T00:00:00Z')
    const ins = raw.prepare("INSERT INTO queries (id, folder_id, title, method, path) VALUES (?, ?, ?, 'GET', '_search')")
    raw.prepare("INSERT INTO folders (id, parent_id, name, sort) VALUES ('root', NULL, 'Shared', 0), ('empty', NULL, 'Empty', 1)").run()
    ins.run('q-dev', 'root', 'ran on dev')
    ins.run('q-prod', 'root', 'ran on prod last')
    ins.run('q-never', null, 'never ran')
    raw.prepare("INSERT INTO history (connection_id, query_id, method, path) VALUES ('prod', 'q-prod', 'GET', '_search'), ('dev', 'q-prod', 'GET', '_search'), ('prod', 'q-prod', 'GET', '_search'), ('dev', 'q-dev', 'GET', '_search')").run()
    raw.prepare("INSERT INTO workspace_tabs (id, name, sort) VALUES ('t1', 'Scratch', 0)").run()
    raw.prepare("INSERT INTO workspace_blocks (tab_id, query_id, sort) VALUES ('t1', 'q-dev', 0), ('t1', 'q-never', 1), ('t1', 'q-prod', 2)").run()
    raw.prepare('UPDATE queries SET connection_id = NULL').run()

    // Re-run the assignment step on the legacy rows.
    raw.transaction(() => scopeToClustersForTest(raw))()
    const lib = new LibraryStore(raw, cipher)
    expect(lib.queries('dev').map((q) => q.id).sort()).toEqual(['q-dev', 'q-never'])
    expect(lib.queries('prod').map((q) => q.id)).toEqual(['q-prod'])
    // "Shared" stays with dev and gets a copy for prod holding prod's query.
    const devShared = lib.folders('dev').find((f) => f.name === 'Shared')!
    const prodShared = lib.folders('prod').find((f) => f.name === 'Shared')!
    expect(devShared.id).toBe('root')
    expect(lib.query('q-prod').folderId).toBe(prodShared.id)
    expect(lib.folders('dev').map((f) => f.name).sort()).toEqual(['Empty', 'Shared'])
    // The tab stays with dev (2 of 3 blocks); prod gets its own "Scratch" with its block.
    expect(lib.tabs('dev').map((t) => t.id)).toEqual(['t1'])
    expect(lib.blocks('t1').map((b) => b.queryId).sort()).toEqual(['q-dev', 'q-never'])
    const prodTab = lib.tabs('prod')[0]!
    expect(prodTab.name).toBe('Scratch')
    expect(lib.blocks(prodTab.id).map((b) => b.queryId)).toEqual(['q-prod'])
  })
})
