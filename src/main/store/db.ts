import { randomUUID } from 'node:crypto'
import Database from 'better-sqlite3'

export type Db = Database.Database
type Migration = string | ((db: Db) => void)

/**
 * Ordered migrations. Append only — never edit a shipped entry.
 * Later milestones add the library, workspace, history and routine tables.
 */
const MIGRATIONS: Migration[] = [
  /* 1: connections + secrets */ `
  CREATE TABLE connections (
    id           TEXT PRIMARY KEY,
    name         TEXT NOT NULL,
    folder       TEXT NOT NULL DEFAULT 'Local',
    color        TEXT NOT NULL DEFAULT 'amber',
    favorite     INTEGER NOT NULL DEFAULT 0,
    is_prod      INTEGER NOT NULL DEFAULT 0,
    read_only    INTEGER NOT NULL DEFAULT 0,
    engine       TEXT NOT NULL DEFAULT 'auto',
    url          TEXT NOT NULL,
    auth_kind    TEXT NOT NULL,
    username     TEXT,
    cloud_id     TEXT,
    aws_json     TEXT,
    tls_json     TEXT NOT NULL,
    timeout_ms   INTEGER NOT NULL DEFAULT 30000,
    compression  INTEGER NOT NULL DEFAULT 1,
    headers_json TEXT NOT NULL DEFAULT '{}',
    detected_json TEXT,
    sort         INTEGER NOT NULL DEFAULT 0,
    created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    updated_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  );
  -- Values are Electron safeStorage ciphertext (key held in the macOS Keychain). Never plaintext.
  CREATE TABLE secrets (
    connection_id TEXT NOT NULL REFERENCES connections(id) ON DELETE CASCADE,
    kind          TEXT NOT NULL CHECK (kind IN ('password','apiKey')),
    blob          BLOB NOT NULL,
    PRIMARY KEY (connection_id, kind)
  );
  `,
  /* 2: query library, workspace, history, environments */ `
  CREATE TABLE folders (
    id         TEXT PRIMARY KEY,
    parent_id  TEXT REFERENCES folders(id) ON DELETE CASCADE,
    name       TEXT NOT NULL,
    sort       INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE queries (
    id          TEXT PRIMARY KEY,
    folder_id   TEXT REFERENCES folders(id) ON DELETE SET NULL,
    title       TEXT NOT NULL DEFAULT '',
    method      TEXT NOT NULL,
    path        TEXT NOT NULL,
    body        TEXT NOT NULL DEFAULT '',
    tags        TEXT NOT NULL DEFAULT '[]',
    pinned      INTEGER NOT NULL DEFAULT 0,
    last_status INTEGER,
    last_run_at TEXT,
    last_ms     INTEGER,
    created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    updated_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  );
  -- Dotted field names (city.name) and dashed index names stay single tokens.
  CREATE VIRTUAL TABLE queries_fts USING fts5(query_id UNINDEXED, title, body, path, tags, tokenize = "unicode61 tokenchars '._-'");
  CREATE TABLE environments (
    id   TEXT PRIMARY KEY,
    name TEXT NOT NULL
  );
  CREATE TABLE workspace_tabs (
    id             TEXT PRIMARY KEY,
    name           TEXT NOT NULL,
    sort           INTEGER NOT NULL DEFAULT 0,
    default_target TEXT,
    env_id         TEXT REFERENCES environments(id) ON DELETE SET NULL
  );
  CREATE TABLE workspace_blocks (
    tab_id    TEXT NOT NULL REFERENCES workspace_tabs(id) ON DELETE CASCADE,
    query_id  TEXT NOT NULL REFERENCES queries(id) ON DELETE CASCADE,
    collapsed INTEGER NOT NULL DEFAULT 0,
    sort      INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (tab_id, query_id)
  );
  CREATE TABLE history (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    connection_id TEXT NOT NULL,
    query_id      TEXT,
    method        TEXT NOT NULL,
    path          TEXT NOT NULL,
    body          TEXT NOT NULL DEFAULT '',
    status        INTEGER,
    ms            INTEGER,
    bytes         INTEGER,
    error         TEXT,
    response      TEXT,
    at            TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  );
  CREATE INDEX history_query ON history(query_id, id);
  CREATE VIRTUAL TABLE history_fts USING fts5(path, body, content = 'history', content_rowid = 'id', tokenize = "unicode61 tokenchars '._-'");
  CREATE TRIGGER history_ai AFTER INSERT ON history BEGIN
    INSERT INTO history_fts(rowid, path, body) VALUES (new.id, new.path, new.body);
  END;
  CREATE TRIGGER history_ad AFTER DELETE ON history BEGIN
    INSERT INTO history_fts(history_fts, rowid, path, body) VALUES ('delete', old.id, old.path, old.body);
  END;
  CREATE TABLE env_vars (
    env_id TEXT NOT NULL REFERENCES environments(id) ON DELETE CASCADE,
    key    TEXT NOT NULL,
    value  TEXT,
    -- safeStorage ciphertext when the variable is secret; value is then NULL.
    secret BLOB,
    PRIMARY KEY (env_id, key)
  );
  `,
  /* 3: routines */ `
  CREATE TABLE routines (
    id                     TEXT PRIMARY KEY,
    name                   TEXT NOT NULL,
    default_connection_id  TEXT REFERENCES connections(id) ON DELETE SET NULL,
    variables_json         TEXT NOT NULL DEFAULT '{}',
    steps_json             TEXT NOT NULL DEFAULT '[]',
    created_at             TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    updated_at             TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  );
  CREATE TABLE routine_runs (
    id          TEXT PRIMARY KEY,
    routine_id  TEXT NOT NULL REFERENCES routines(id) ON DELETE CASCADE,
    status      TEXT NOT NULL,
    dry_run     INTEGER NOT NULL DEFAULT 0,
    started_at  TEXT NOT NULL,
    finished_at TEXT,
    -- steps (with truncated responses), log lines and captured values, as JSON
    detail_json TEXT NOT NULL
  );
  CREATE INDEX routine_runs_by_routine ON routine_runs(routine_id, started_at);
  `,
  /* 4: SSH tunnel + proxy; secrets table gains SSH secret kinds (SQLite can't alter a CHECK). */ `
  ALTER TABLE connections ADD COLUMN ssh_json TEXT;
  ALTER TABLE connections ADD COLUMN proxy TEXT;
  CREATE TABLE secrets_v2 (
    connection_id TEXT NOT NULL REFERENCES connections(id) ON DELETE CASCADE,
    kind          TEXT NOT NULL CHECK (kind IN ('password','apiKey','sshPassword','sshPassphrase')),
    blob          BLOB NOT NULL,
    PRIMARY KEY (connection_id, kind)
  );
  INSERT INTO secrets_v2 SELECT connection_id, kind, blob FROM secrets;
  DROP TABLE secrets;
  ALTER TABLE secrets_v2 RENAME TO secrets;
  `,
  // 5: aggregation pipelines are library items too (body = compiled request, pipeline = the stages as JSON).
  `
  ALTER TABLE queries ADD COLUMN pipeline TEXT;
  `,
  // 6: queries, folders and workspace tabs belong to one cluster (connection), so a query written
  // for one cluster can't be run on another by accident. Existing data is assigned in scopeToClusters().
  `
  ALTER TABLE queries ADD COLUMN connection_id TEXT REFERENCES connections(id) ON DELETE SET NULL;
  ALTER TABLE folders ADD COLUMN connection_id TEXT REFERENCES connections(id) ON DELETE SET NULL;
  ALTER TABLE workspace_tabs ADD COLUMN connection_id TEXT REFERENCES connections(id) ON DELETE CASCADE;
  CREATE INDEX queries_connection ON queries(connection_id);
  CREATE INDEX folders_connection ON folders(connection_id);
  CREATE INDEX tabs_connection ON workspace_tabs(connection_id);
  `,
  (db) => scopeToClusters(db)
]

/**
 * Migration 7: give existing queries, folders and tabs a cluster.
 * - A query goes to the cluster it last ran on (history), else the one its saved pipeline names, else the first cluster.
 * - A folder goes to the cluster of the queries in it; when it holds queries of several clusters, each other
 *   cluster gets its own copy of the folder path (same names) and its queries move there.
 * - A tab goes to the cluster most of its blocks belong to; blocks of other clusters move to a copy of the tab.
 */
export function scopeToClusters(db: Db): void {
  const conns = (db.prepare('SELECT id FROM connections ORDER BY created_at, rowid').all() as Array<{ id: string }>).map((c) => c.id)
  if (!conns.length) return
  const known = new Set(conns)
  const first = conns[0]!

  const queries = db.prepare('SELECT id, folder_id, pipeline FROM queries').all() as Array<{ id: string; folder_id: string | null; pipeline: string | null }>
  const lastRun = db.prepare('SELECT connection_id FROM history WHERE query_id = ? ORDER BY id DESC LIMIT 1')
  const setQuery = db.prepare('UPDATE queries SET connection_id = ? WHERE id = ?')
  const connOf = new Map<string, string>()
  for (const q of queries) {
    let c = (lastRun.get(q.id) as { connection_id: string } | undefined)?.connection_id
    if (!c || !known.has(c)) {
      try {
        c = (JSON.parse(q.pipeline ?? 'null') as { connectionId?: string } | null)?.connectionId
      } catch {
        c = undefined
      }
    }
    if (!c || !known.has(c)) c = first
    connOf.set(q.id, c)
    setQuery.run(c, q.id)
  }

  // Folders: copy folder paths per cluster as needed.
  const folders = new Map((db.prepare('SELECT id, parent_id, name, sort FROM folders').all() as Array<{ id: string; parent_id: string | null; name: string; sort: number }>).map((f) => [f.id, f]))
  const owner = new Map<string, string>() // original folder id → cluster that keeps it
  const copies = new Map<string, string>() // `${folderId}|${cluster}` → folder id for that cluster
  const insertFolder = db.prepare('INSERT INTO folders (id, parent_id, name, sort, connection_id) VALUES (?, ?, ?, ?, ?)')
  const folderFor = (folderId: string, c: string): string => {
    const key = `${folderId}|${c}`
    const done = copies.get(key)
    if (done) return done
    const f = folders.get(folderId)!
    const parent = f.parent_id && folders.has(f.parent_id) ? folderFor(f.parent_id, c) : null
    let id: string
    if (!owner.has(folderId) || owner.get(folderId) === c) {
      owner.set(folderId, c)
      id = folderId
      db.prepare('UPDATE folders SET connection_id = ?, parent_id = ? WHERE id = ?').run(c, parent, id)
    } else {
      id = randomUUID()
      insertFolder.run(id, parent, f.name, f.sort, c)
    }
    copies.set(key, id)
    return id
  }
  for (const q of queries) if (q.folder_id && folders.has(q.folder_id)) db.prepare('UPDATE queries SET folder_id = ? WHERE id = ?').run(folderFor(q.folder_id, connOf.get(q.id)!), q.id)
  // Empty folders stay with the first cluster.
  for (const id of folders.keys()) if (!owner.has(id)) folderFor(id, first)

  // Tabs: one per cluster, splitting mixed tabs.
  const tabs = db.prepare('SELECT * FROM workspace_tabs').all() as Array<{ id: string; name: string; sort: number; default_target: string | null; env_id: string | null }>
  for (const t of tabs) {
    const blocks = db.prepare('SELECT query_id FROM workspace_blocks WHERE tab_id = ?').all(t.id) as Array<{ query_id: string }>
    const byConn = new Map<string, string[]>()
    for (const b of blocks) {
      const c = connOf.get(b.query_id) ?? first
      byConn.set(c, [...(byConn.get(c) ?? []), b.query_id])
    }
    const ranked = [...byConn.entries()].sort((a, b) => b[1].length - a[1].length)
    const main = ranked[0]?.[0] ?? first
    db.prepare('UPDATE workspace_tabs SET connection_id = ? WHERE id = ?').run(main, t.id)
    for (const [c, ids] of ranked.slice(1)) {
      const copy = randomUUID()
      db.prepare('INSERT INTO workspace_tabs (id, name, sort, default_target, env_id, connection_id) VALUES (?, ?, ?, ?, ?, ?)').run(copy, t.name, t.sort, t.default_target, t.env_id, c)
      for (const q of ids) db.prepare('UPDATE workspace_blocks SET tab_id = ? WHERE tab_id = ? AND query_id = ?').run(copy, t.id, q)
    }
  }
}

export function openDb(file: string): Db {
  const db = new Database(file)
  db.pragma('journal_mode = WAL')
  db.pragma('foreign_keys = ON')
  migrate(db)
  return db
}

export function migrate(db: Db): void {
  const current = db.pragma('user_version', { simple: true }) as number
  for (let v = current; v < MIGRATIONS.length; v++) {
    db.transaction(() => {
      const m = MIGRATIONS[v]!
      if (typeof m === 'string') db.exec(m)
      else m(db)
      db.pragma(`user_version = ${v + 1}`)
    })()
  }
}
