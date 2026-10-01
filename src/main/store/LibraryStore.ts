import { randomUUID } from 'node:crypto'
import {
  parseSearch,
  type Block,
  type Environment,
  type Folder,
  type HistoryEntry,
  type LibraryFilter,
  type Query,
  type QueryPatch,
  type WorkspaceTab
} from '@shared/library'
import type { HttpMethod } from '@shared/types'
import type { Cipher } from '../connections/secrets'
import { KabanosError } from '../errors'
import type { Db } from './db'

interface QueryRow {
  id: string
  folder_id: string | null
  title: string
  method: string
  path: string
  body: string
  tags: string
  pinned: number
  last_status: number | null
  last_run_at: string | null
  last_ms: number | null
  created_at: string
  updated_at: string
}

/** Responses kept per saved query for the "previous responses" list. */
const RESPONSES_PER_QUERY = 5
const MAX_STORED_RESPONSE = 512 * 1024
const HISTORY_LIMIT = 20_000

/** Query library, workspace tabs/blocks, request history and environments — all in SQLite. */
export class LibraryStore {
  constructor(
    private readonly db: Db,
    private readonly cipher: Cipher
  ) {}

  // ---------- folders ----------

  folders(): Folder[] {
    return (this.db.prepare('SELECT id, parent_id, name, sort FROM folders ORDER BY sort, name').all() as Array<{ id: string; parent_id: string | null; name: string; sort: number }>).map(
      (r) => ({ id: r.id, parentId: r.parent_id, name: r.name, sort: r.sort })
    )
  }

  createFolder(name: string, parentId: string | null = null): Folder {
    const id = randomUUID()
    const sort = (this.db.prepare('SELECT COALESCE(MAX(sort), 0) + 1 AS s FROM folders WHERE parent_id IS ?').get(parentId) as { s: number }).s
    this.db.prepare('INSERT INTO folders (id, parent_id, name, sort) VALUES (?, ?, ?, ?)').run(id, parentId, name.trim() || 'New folder', sort)
    return { id, parentId, name: name.trim() || 'New folder', sort }
  }

  updateFolder(id: string, patch: { name?: string; parentId?: string | null }): void {
    if (patch.parentId !== undefined && patch.parentId !== null && this.isDescendant(patch.parentId, id)) {
      throw new KabanosError('VALIDATION', "A folder can't be moved into itself")
    }
    if (patch.name !== undefined) this.db.prepare('UPDATE folders SET name = ? WHERE id = ?').run(patch.name.trim() || 'Untitled', id)
    if (patch.parentId !== undefined) this.db.prepare('UPDATE folders SET parent_id = ? WHERE id = ?').run(patch.parentId, id)
  }

  /** Deleting a folder moves its queries and subfolders up one level. */
  removeFolder(id: string): void {
    const row = this.db.prepare('SELECT parent_id FROM folders WHERE id = ?').get(id) as { parent_id: string | null } | undefined
    if (!row) return
    this.db.transaction(() => {
      this.db.prepare('UPDATE queries SET folder_id = ? WHERE folder_id = ?').run(row.parent_id, id)
      this.db.prepare('UPDATE folders SET parent_id = ? WHERE parent_id = ?').run(row.parent_id, id)
      this.db.prepare('DELETE FROM folders WHERE id = ?').run(id)
    })()
  }

  private isDescendant(candidate: string, ancestor: string): boolean {
    let cur: string | null = candidate
    for (let i = 0; cur && i < 100; i++) {
      if (cur === ancestor) return true
      cur = (this.db.prepare('SELECT parent_id FROM folders WHERE id = ?').get(cur) as { parent_id: string | null } | undefined)?.parent_id ?? null
    }
    return false
  }

  // ---------- queries ----------

  queries(filter: LibraryFilter = { kind: 'all' }, search = ''): Query[] {
    const { fts, tags } = parseSearch(search)
    const where: string[] = []
    const params: unknown[] = []
    if (fts) {
      where.push('q.id IN (SELECT query_id FROM queries_fts WHERE queries_fts MATCH ?)')
      params.push(fts)
    }
    for (const t of filter.kind === 'tag' ? [...tags, filter.tag] : tags) {
      where.push("EXISTS (SELECT 1 FROM json_each(q.tags) WHERE lower(json_each.value) = ?)")
      params.push(t.toLowerCase())
    }
    if (filter.kind === 'pinned') where.push('q.pinned = 1')
    if (filter.kind === 'recent') where.push('q.last_run_at IS NOT NULL')
    const order = filter.kind === 'recent' ? 'q.last_run_at DESC' : 'q.title COLLATE NOCASE, q.created_at'
    const sql = `SELECT q.* FROM queries q ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY ${order} ${filter.kind === 'recent' ? 'LIMIT 50' : ''}`
    try {
      return (this.db.prepare(sql).all(...params) as QueryRow[]).map(toQuery)
    } catch (err) {
      // A half-typed search (e.g. a lone quote) is not an error worth surfacing.
      if (fts && /fts5|syntax/i.test((err as Error).message)) return []
      throw err
    }
  }

  query(id: string): Query {
    const row = this.db.prepare('SELECT * FROM queries WHERE id = ?').get(id) as QueryRow | undefined
    if (!row) throw new KabanosError('NOT_FOUND', `Query ${id} not found`)
    return toQuery(row)
  }

  createQuery(q: Partial<QueryPatch> & { method: HttpMethod; path: string }): Query {
    const id = randomUUID()
    this.db
      .prepare('INSERT INTO queries (id, folder_id, title, method, path, body, tags, pinned) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(id, q.folderId ?? null, q.title ?? '', q.method, q.path, q.body ?? '', JSON.stringify(normTags(q.tags)), q.pinned ? 1 : 0)
    this.reindex(id)
    return this.query(id)
  }

  updateQuery(id: string, patch: QueryPatch): Query {
    const sets: string[] = []
    const params: unknown[] = []
    const col: Record<keyof QueryPatch, string> = { folderId: 'folder_id', title: 'title', method: 'method', path: 'path', body: 'body', tags: 'tags', pinned: 'pinned' }
    for (const [k, v] of Object.entries(patch) as Array<[keyof QueryPatch, unknown]>) {
      if (v === undefined) continue
      sets.push(`${col[k]} = ?`)
      params.push(k === 'tags' ? JSON.stringify(normTags(v as string[])) : k === 'pinned' ? (v ? 1 : 0) : v)
    }
    if (sets.length) {
      this.db.prepare(`UPDATE queries SET ${sets.join(', ')}, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?`).run(...params, id)
      this.reindex(id)
    }
    return this.query(id)
  }

  removeQuery(id: string): void {
    this.db.transaction(() => {
      this.db.prepare('DELETE FROM queries_fts WHERE query_id = ?').run(id)
      this.db.prepare('DELETE FROM queries WHERE id = ?').run(id)
    })()
  }

  tags(): Array<{ tag: string; count: number }> {
    return this.db
      .prepare('SELECT lower(j.value) AS tag, COUNT(*) AS count FROM queries q, json_each(q.tags) j GROUP BY lower(j.value) ORDER BY count DESC, tag')
      .all() as Array<{ tag: string; count: number }>
  }

  private reindex(id: string): void {
    const q = this.db.prepare('SELECT title, body, path, tags FROM queries WHERE id = ?').get(id) as { title: string; body: string; path: string; tags: string } | undefined
    this.db.prepare('DELETE FROM queries_fts WHERE query_id = ?').run(id)
    if (q) this.db.prepare('INSERT INTO queries_fts (query_id, title, body, path, tags) VALUES (?, ?, ?, ?, ?)').run(id, q.title, q.body, q.path.replace(/[/?&=]/g, ' '), (JSON.parse(q.tags) as string[]).join(' '))
  }

  // ---------- workspace ----------

  tabs(): WorkspaceTab[] {
    const rows = this.db.prepare('SELECT * FROM workspace_tabs ORDER BY sort').all() as Array<{ id: string; name: string; sort: number; default_target: string | null; env_id: string | null }>
    return rows.map((r) => ({ id: r.id, name: r.name, sort: r.sort, defaultTarget: r.default_target ?? undefined, envId: r.env_id ?? undefined }))
  }

  /** The first launch gets a "Scratch" tab so the workspace is never empty. */
  ensureTab(): WorkspaceTab[] {
    if (this.tabs().length === 0) this.createTab('Scratch')
    return this.tabs()
  }

  createTab(name: string): WorkspaceTab {
    const id = randomUUID()
    const sort = (this.db.prepare('SELECT COALESCE(MAX(sort), 0) + 1 AS s FROM workspace_tabs').get() as { s: number }).s
    this.db.prepare('INSERT INTO workspace_tabs (id, name, sort) VALUES (?, ?, ?)').run(id, name.trim() || 'Untitled', sort)
    return this.tabs().find((t) => t.id === id)!
  }

  updateTab(id: string, patch: { name?: string; defaultTarget?: string | null; envId?: string | null }): void {
    if (patch.name !== undefined) this.db.prepare('UPDATE workspace_tabs SET name = ? WHERE id = ?').run(patch.name.trim() || 'Untitled', id)
    if (patch.defaultTarget !== undefined) this.db.prepare('UPDATE workspace_tabs SET default_target = ? WHERE id = ?').run(patch.defaultTarget || null, id)
    if (patch.envId !== undefined) this.db.prepare('UPDATE workspace_tabs SET env_id = ? WHERE id = ?').run(patch.envId || null, id)
  }

  /** Closing a tab drops its unfiled scratch blocks; saved (foldered) queries stay in the library. */
  removeTab(id: string): void {
    this.db.transaction(() => {
      const orphans = this.db
        .prepare(
          `SELECT q.id FROM workspace_blocks b JOIN queries q ON q.id = b.query_id
           WHERE b.tab_id = ? AND q.folder_id IS NULL AND q.pinned = 0
             AND NOT EXISTS (SELECT 1 FROM workspace_blocks o WHERE o.query_id = q.id AND o.tab_id <> ?)`
        )
        .all(id, id) as Array<{ id: string }>
      this.db.prepare('DELETE FROM workspace_tabs WHERE id = ?').run(id)
      for (const o of orphans) this.removeQuery(o.id)
    })()
  }

  blocks(tabId: string): Array<Block & { query: Query }> {
    const rows = this.db
      .prepare('SELECT b.collapsed, b.sort, q.* FROM workspace_blocks b JOIN queries q ON q.id = b.query_id WHERE b.tab_id = ? ORDER BY b.sort')
      .all(tabId) as Array<QueryRow & { collapsed: number; sort: number }>
    return rows.map((r) => ({ queryId: r.id, collapsed: !!r.collapsed, sort: r.sort, query: toQuery(r) }))
  }

  addBlock(tabId: string, queryId: string, afterQueryId?: string): void {
    const exists = this.db.prepare('SELECT 1 FROM workspace_blocks WHERE tab_id = ? AND query_id = ?').get(tabId, queryId)
    if (exists) return
    const ids = this.blocks(tabId).map((b) => b.queryId)
    const at = afterQueryId ? ids.indexOf(afterQueryId) + 1 : ids.length
    ids.splice(at <= 0 && afterQueryId ? ids.length : at, 0, queryId)
    this.db.transaction(() => {
      this.db.prepare('INSERT INTO workspace_blocks (tab_id, query_id, sort) VALUES (?, ?, 0)').run(tabId, queryId)
      this.reorder(tabId, ids)
    })()
  }

  /** Removing a block from a tab deletes the query only if it was never saved anywhere. */
  removeBlock(tabId: string, queryId: string): void {
    this.db.transaction(() => {
      this.db.prepare('DELETE FROM workspace_blocks WHERE tab_id = ? AND query_id = ?').run(tabId, queryId)
      const q = this.db.prepare('SELECT folder_id, pinned FROM queries WHERE id = ?').get(queryId) as { folder_id: string | null; pinned: number } | undefined
      const elsewhere = this.db.prepare('SELECT 1 FROM workspace_blocks WHERE query_id = ?').get(queryId)
      if (q && q.folder_id === null && !q.pinned && !elsewhere) this.removeQuery(queryId)
    })()
  }

  setCollapsed(tabId: string, queryIds: string[], collapsed: boolean): void {
    const stmt = this.db.prepare('UPDATE workspace_blocks SET collapsed = ? WHERE tab_id = ? AND query_id = ?')
    this.db.transaction(() => queryIds.forEach((q) => stmt.run(collapsed ? 1 : 0, tabId, q)))()
  }

  reorder(tabId: string, queryIds: string[]): void {
    const stmt = this.db.prepare('UPDATE workspace_blocks SET sort = ? WHERE tab_id = ? AND query_id = ?')
    this.db.transaction(() => queryIds.forEach((q, i) => stmt.run(i, tabId, q)))()
  }

  // ---------- history ----------

  recordRun(e: Omit<HistoryEntry, 'id' | 'at'>): void {
    this.db.transaction(() => {
      const keepResponse = e.queryId && e.response !== undefined && e.response.length <= MAX_STORED_RESPONSE
      this.db
        .prepare('INSERT INTO history (connection_id, query_id, method, path, body, status, ms, bytes, error, response) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
        .run(e.connectionId, e.queryId ?? null, e.method, e.path, e.body, e.status ?? null, e.ms ?? null, e.bytes ?? null, e.error ?? null, keepResponse ? e.response : null)
      if (e.queryId) {
        this.db
          .prepare("UPDATE queries SET last_status = ?, last_ms = ?, last_run_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?")
          .run(e.status ?? null, e.ms ?? null, e.queryId)
        // Only the last few responses per query are kept; older rows keep the request but drop the body.
        this.db
          .prepare('UPDATE history SET response = NULL WHERE query_id = ? AND response IS NOT NULL AND id NOT IN (SELECT id FROM history WHERE query_id = ? AND response IS NOT NULL ORDER BY id DESC LIMIT ?)')
          .run(e.queryId, e.queryId, RESPONSES_PER_QUERY)
      }
      this.db.prepare('DELETE FROM history WHERE id <= (SELECT MAX(id) FROM history) - ?').run(HISTORY_LIMIT)
    })()
  }

  history(search = '', limit = 200): HistoryEntry[] {
    const { fts } = parseSearch(search)
    const sql = fts
      ? 'SELECT h.* FROM history h WHERE h.id IN (SELECT rowid FROM history_fts WHERE history_fts MATCH ?) ORDER BY h.id DESC LIMIT ?'
      : 'SELECT h.* FROM history h ORDER BY h.id DESC LIMIT ?'
    try {
      const rows = (fts ? this.db.prepare(sql).all(fts, limit) : this.db.prepare(sql).all(limit)) as HistoryRow[]
      return rows.map((r) => toHistory(r, false))
    } catch (err) {
      if (fts && /fts5|syntax/i.test((err as Error).message)) return []
      throw err
    }
  }

  historyCount(): number {
    return (this.db.prepare('SELECT COUNT(*) AS n FROM history').get() as { n: number }).n
  }

  clearHistory(): void {
    this.db.prepare('DELETE FROM history').run()
  }

  responses(queryId: string): HistoryEntry[] {
    return (this.db.prepare('SELECT * FROM history WHERE query_id = ? AND response IS NOT NULL ORDER BY id DESC LIMIT ?').all(queryId, RESPONSES_PER_QUERY) as HistoryRow[]).map((r) => toHistory(r, true))
  }

  // ---------- environments ----------

  environments(): Environment[] {
    const envs = this.db.prepare('SELECT id, name FROM environments ORDER BY name').all() as Array<{ id: string; name: string }>
    return envs.map((e) => ({
      ...e,
      vars: (this.db.prepare('SELECT key, value, secret FROM env_vars WHERE env_id = ? ORDER BY key').all(e.id) as Array<{ key: string; value: string | null; secret: Buffer | null }>).map((v) => ({
        key: v.key,
        // Secret values never leave main.
        value: v.secret ? '' : (v.value ?? ''),
        secret: !!v.secret
      }))
    }))
  }

  saveEnvironment(env: { id?: string; name: string; vars: Array<{ key: string; value: string; secret: boolean }> }): Environment {
    const id = env.id ?? randomUUID()
    this.db.transaction(() => {
      this.db.prepare('INSERT INTO environments (id, name) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET name = excluded.name').run(id, env.name.trim() || 'Untitled')
      const old = new Map(
        (this.db.prepare('SELECT key, secret FROM env_vars WHERE env_id = ?').all(id) as Array<{ key: string; secret: Buffer | null }>).map((r) => [r.key, r.secret])
      )
      this.db.prepare('DELETE FROM env_vars WHERE env_id = ?').run(id)
      const ins = this.db.prepare('INSERT INTO env_vars (env_id, key, value, secret) VALUES (?, ?, ?, ?)')
      for (const v of env.vars) {
        const key = v.key.trim()
        if (!key) continue
        if (v.secret) {
          // Empty value on a secret keeps the stored ciphertext.
          const blob = v.value ? this.encrypt(v.value) : (old.get(key) ?? null)
          ins.run(id, key, null, blob)
        } else ins.run(id, key, v.value, null)
      }
    })()
    return this.environments().find((e) => e.id === id)!
  }

  removeEnvironment(id: string): void {
    this.db.prepare('DELETE FROM environments WHERE id = ?').run(id)
  }

  /** Resolved variables including decrypted secrets — for main-side substitution only. */
  resolveVars(envId: string | undefined): Record<string, string> {
    if (!envId) return {}
    const rows = this.db.prepare('SELECT key, value, secret FROM env_vars WHERE env_id = ?').all(envId) as Array<{ key: string; value: string | null; secret: Buffer | null }>
    return Object.fromEntries(rows.map((r) => [r.key, r.secret ? this.cipher.decrypt(r.secret) : (r.value ?? '')]))
  }

  private encrypt(v: string): Buffer {
    if (!this.cipher.isAvailable()) throw new KabanosError('VALIDATION', 'The macOS Keychain is not available — refusing to store a secret variable')
    return this.cipher.encrypt(v)
  }
}

interface HistoryRow {
  id: number
  connection_id: string
  query_id: string | null
  method: string
  path: string
  body: string
  status: number | null
  ms: number | null
  bytes: number | null
  error: string | null
  response: string | null
  at: string
}

function toHistory(r: HistoryRow, withResponse: boolean): HistoryEntry {
  return {
    id: r.id,
    connectionId: r.connection_id,
    queryId: r.query_id ?? undefined,
    method: r.method as HttpMethod,
    path: r.path,
    body: r.body,
    status: r.status ?? undefined,
    ms: r.ms ?? undefined,
    bytes: r.bytes ?? undefined,
    error: r.error ?? undefined,
    response: withResponse ? (r.response ?? undefined) : undefined,
    at: r.at
  }
}

function toQuery(r: QueryRow): Query {
  return {
    id: r.id,
    folderId: r.folder_id,
    title: r.title,
    method: r.method as HttpMethod,
    path: r.path,
    body: r.body,
    tags: JSON.parse(r.tags) as string[],
    pinned: !!r.pinned,
    lastStatus: r.last_status ?? undefined,
    lastRunAt: r.last_run_at ?? undefined,
    lastMs: r.last_ms ?? undefined,
    createdAt: r.created_at,
    updatedAt: r.updated_at
  }
}

function normTags(tags: string[] | undefined): string[] {
  return [...new Set((tags ?? []).map((t) => t.trim().replace(/^#/, '')).filter(Boolean))]
}
