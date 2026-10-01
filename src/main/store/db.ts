import Database from 'better-sqlite3'

export type Db = Database.Database

/**
 * Ordered migrations. Append only — never edit a shipped entry.
 * Later milestones add the library, workspace, history and routine tables.
 */
const MIGRATIONS: string[] = [
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
  `
]

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
      db.exec(MIGRATIONS[v]!)
      db.pragma(`user_version = ${v + 1}`)
    })()
  }
}
