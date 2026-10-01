# kabanos — Elasticsearch / OpenSearch desktop client for macOS

A native-feeling Mac app that pairs MongoDB Compass's layout (saved connections, a tree of indices, a view per index) with the Kibana Dev Tools console's power (free-form requests, autocomplete, stack management).
The app is named **kabanos**. Icon files are in `brand/` (see §10).

The screen designs are in `design/*.dc.html` (one file per screen). They are design mockups, not production code: they use a template syntax (`{{hole}}`, `<sc-for>`, `<sc-if>`, a `renderVals()` class) for sample data. Use them for layout, spacing, colors, and copy. Do not port that syntax.

| File | Screen |
|---|---|
| `design/Main.dc.html` | 1 · Connections (saved list + new connection form) |
| `design/Explorer.dc.html` | 2 · Cluster explorer (tree of indices/aliases/templates, index overview + mapping) |
| `design/Workspace.dc.html` | 3 · Query workspace: free builder with query library |
| `design/IndexQuery.dc.html` | 4 · Index view: method dropdown + path + body, document results |
| `design/Routines.dc.html` | 5 · Routines: run several requests in sequence |
| `design/Security.dc.html` | 6 · Stack management: users, roles, API keys |

---

## 1. Suggested stack (change it if you prefer something else)

- **Electron + TypeScript + React + Vite.** Compass is also built on Electron. It gives the most mature editor and native integration on macOS.
- **Monaco editor** for request bodies, with custom completion providers (see §5).
- **All cluster HTTP goes through the main process** (Node `undici`/`fetch`). This avoids CORS, supports custom CA certificates and proxies, and keeps credentials out of the renderer.
- **Credentials** go in the macOS Keychain, via Electron `safeStorage` or `keytar`. Never write them in plain text to disk or logs.
- **Local data** goes in SQLite (`better-sqlite3`): connections (without secrets), the query library, history, routines, and run logs. Use **FTS5** for library search.
- State: Zustand or Redux Toolkit. Styling: CSS variables with the tokens in §9.
- Packaging: `electron-builder`, a universal macOS build (arm64 + x64). Signing and notarization come later.

## 2. Architecture

```
renderer (React UI)
  └─ IPC (typed, contextIsolation on, no nodeIntegration)
main process
  ├─ ConnectionManager   – parse URL, keychain, TLS/proxy, one HTTP agent per connection
  ├─ ClusterClient       – request(method, path, body) → {status, headers, body, ms, bytes}
  ├─ EngineAdapter       – ElasticsearchAdapter | OpenSearchAdapter (detect on connect)
  ├─ MetadataCache       – indices, aliases, templates, mappings per connection (TTL + manual refresh)
  ├─ LibraryStore        – queries, folders, tags, history (SQLite + FTS5)
  └─ RoutineRunner       – runs steps sequentially, variable capture, assertions, polling
```

## 3. Connections (screen 1)

- Paste a URL like `https://user:pass@host:9243`. Parse it into scheme, host, port, user, and password. Store the password in the Keychain, and **store the URL without credentials**.
- Authentication methods: From URL, Basic, API key, AWS SigV4 (Amazon OpenSearch Service), Cloud ID, None.
- Fields: name, folder, color tag, engine (Auto / Elasticsearch / OpenSearch), verify TLS, custom CA file. Advanced: proxy / SSH tunnel, timeout, compression, default headers, **read-only mode** (blocks everything except GET/HEAD and `_search`/`_count`).
- "Test connection" calls `GET /` and then `GET _cluster/health`, and shows the version, cluster name, health, and number of nodes.
- Show several connections at once as top tabs. Production-colored connections get a warning stripe and confirm before any destructive call.
- Import/export connections as JSON **without secrets**.

## 4. Engine detection and OpenSearch

- Read `GET /` → `version.distribution`. If it is `"opensearch"`, use OpenSearchAdapter. Otherwise use ElasticsearchAdapter, based on `version.number` (support 7.x, 8.x, and 9.x).
- Most read APIs are shared: `_cat/*`, `_search`, `_count`, `_mapping`, `_alias(es)`, `_index_template`, `_component_template`, `_tasks`, `_reindex`.
- Security APIs differ:
  - ES: `_security/user`, `_security/role`, `_security/role_mapping`, `_security/api_key`
  - OS: `_plugins/_security/api/internalusers`, `/roles`, `/rolesmapping` (API keys don't exist, so hide that tab)
- The tab badge shows `ES x.y` (amber) or `OS x.y` (teal).
- OpenSearch is nice-to-have. Build the adapter seam in milestone 1 and fill in the OS parts later.

## 5. Explorer and autocomplete metadata (screen 2)

- Sidebar tree: **Indices** (health dot, size), **Aliases** (→ targets), **Index templates** (composable + component). Filter box. Toggles: hide system (`.`-prefixed), hide closed, sort by name/size/docs.
- Data sources: `_cat/indices?format=json&bytes=b`, `_cat/aliases?format=json`, `_index_template`, `_component_template`.
- Index page tabs: Overview (docs, size, shards, created, aliases, matched template via `_index_template/_simulate_index/<name>`, key settings), Mapping (flattened field tree with type, filterable, raw JSON toggle), Settings, Documents, Shards, Saved queries (library entries that target this index).
- Actions: Query this index (opens screen 4), Open in workspace, and a menu with refresh, clear cache, close/open, and delete (typed-name confirmation).
- **Autocomplete sources**, cached per connection:
  - Paths: index names, alias names, data streams, and API endpoints for the detected engine/version.
  - Body keys: the query DSL grammar (bool, term, match, range, function_score, aggs…).
  - Field names: the flattened mapping of the target (resolve an alias or wildcard to the union of its indices' mappings). Show each field's type. Rank term-friendly fields (keyword, numeric, date) first inside `term`/`terms`/`range`, and text fields first inside `match`.

## 6. Query workspace, the free builder (screen 3)

This fixes the main pain point with the Kibana console, where requests pile up unordered and are hard to find.

- The editor holds a list of **request blocks**, not one long text buffer. Each block has a title, method, path, body, optional tags, and last-run status. Blocks collapse to one line (`▸ POST Top cities by listings  listings/_search · 14 lines · 200 · yesterday`). There is a "Collapse all" action.
- Workspace tabs (for example "Listings relevance", "Cluster ops", "Scratch"). Each tab is saved automatically.
- **Query library** sidebar: folders (nested), Pinned, Recent, History, and #tags.
  - Search (⌘F in the sidebar) matches title, body text, target index, field names used, and tags, via FTS5.
  - Drag a block into a folder to save it.
- Default target selector (alias → resolved index). A block's path can omit the index and inherit it.
- Run the block under the cursor with ⌘↵. Run a selection of blocks one after another. Format JSON (also accept Kibana-console style `GET path\n{body}` pasted text and split it into blocks).
- Response pane: status, time, and size. JSON view (folding, search) or Table view (flatten `hits.hits[]._source`). Copy, Copy as cURL, Export CSV/NDJSON. Per-block history of the last N responses.
- "Add to routine" sends the selected blocks to a new or existing routine.
- Import: paste a Kibana console export and split it into blocks, keeping `###` comments as titles.

## 7. Index view: method + path (screen 4)

- Opening an index or alias from the tree opens a Compass-style tab. Sub-tabs: Query, Documents, Mapping, Aliases, Settings.
- Request bar: **method dropdown** (GET, POST, PUT, HEAD, DELETE; DELETE is red and confirms on prod), a locked prefix `/<index>/`, an editable endpoint, Run, and Save to library.
- Endpoint chips: `_search`, `_count`, `_doc/{id}`, `_mapping`, `_update_by_query`, `_delete_by_query`, `_settings`. Clicking one fills a starter body.
- Results: Documents (cards like Compass, with Edit / Copy / Clone per doc), Table, and JSON, plus paging (from/size, or search_after for deep pages).
- Edit a document by `PUT <index>/_doc/<id>` with a diff preview.

## 8. Routines (screen 5)

A routine is an ordered list of steps run one by one against one connection.

```jsonc
{
  "name": "Reindex listings & swap alias",
  "connectionId": "…",
  "variables": { "source": "listings-v7", "target": "listings-v8", "alias": "listings" },
  "steps": [
    { "id": "health", "method": "GET", "path": "_cluster/health",
      "assert": "status != 'red'", "onFail": "stop" },
    { "id": "count", "method": "POST", "path": "{{source}}/_count", "capture": { "value": "count" } },
    { "id": "reindex", "method": "POST", "path": "_reindex?wait_for_completion=false",
      "bodyRef": "library:<queryId>", "capture": { "task": "task" } },
    { "id": "wait", "method": "GET", "path": "_tasks/{{steps.reindex.task}}",
      "repeat": { "until": "completed == true", "everySec": 10, "timeoutMin": 45 } },
    { "id": "verify", "method": "POST", "path": "{{target}}/_count",
      "assert": "count == steps.count.value" },
    { "id": "swap", "method": "POST", "path": "_aliases", "confirm": true, "body": { "…": "…" } }
  ]
}
```

- Templating: `{{var}}` and `{{steps.<id>.<capturedName>}}`. `capture` maps a name to a JSONPath/dot-path in the response.
- Assertions: a small safe expression language (for example `jsonata` or `expr-eval`). Never use `eval`.
- Per step: onFail (`stop` / `continue`), optional condition to skip, repeat/poll, confirm-before-run (forced for non-GET on production connections).
- Controls: Run all, Step through, Stop, **Dry run** (only runs GET/HEAD; shows what else would run with the variables filled in).
- Run log with timestamps; captured values panel; previous runs stored with full request/response per step.
- Steps can reference library queries (`bodyRef`), so editing the saved query updates the routine.

## 9. Stack management (screen 6)

- Left nav: Security (Users, Roles, Role mappings, API keys), Data (Index lifecycle, Snapshots, Ingest pipelines, Index templates), Cluster (Nodes, Settings, Tasks).
- Users: table (username, full name, roles, status, reserved badge). Create, edit, enable/disable, reset password.
- Role editor: cluster privileges, index privileges (patterns, privileges, field-level security grant/except, document-level query), and a View-as-JSON toggle.
- All writes go through EngineAdapter (§4). If the cluster has security disabled, show an empty state that says so.
- Milestone order: Users and Roles first, then API keys and role mappings, then the Data pages.

## 10. Design tokens (from the mockups)

| Token | Value |
|---|---|
| bg | `#121419` |
| chrome / activity bar | `#0E1014` |
| surface | `#16191F` |
| surface-2 | `#191C22` / `#1D2027` |
| selected row | `#232832` |
| border | `#262A33` (strong `#2A2F39`, `#3A3F49`) |
| text | `#E6E8EC` · secondary `#C9CFD9` · muted `#9AA3B2` · faint `#8B94A3` |
| accent (primary, ES) | `#F2B544` on `#2B2512`; text on accent `#1A1405` |
| OpenSearch | `#4DC4D6` on `#10272B` |
| methods | GET `#5CCB8A` · POST `#F2B544` · PUT `#6AA8FF` · HEAD `#B6A2FF` · DELETE `#FF7A70` |
| health | green `#5CCB8A` · yellow `#F2C94C` · red `#FF7A70` |
| JSON syntax | key `#9CC4FF` · string `#E7C58B` · number `#C7A2FF` · punctuation `#7C8595` |
| fonts | UI: IBM Plex Sans 13px · code: JetBrains Mono 12–12.5px |
| radii | 7–10px controls/cards, 12px window |
| app icon | `brand/kabanos.icns` (Dock/Finder), `brand/kabanos-icon.svg` (master), `brand/kabanos-icon-small.svg` (≤32px, no speed lines), `brand/kabanos-menubarTemplate@2x.png` (menu bar, template image) |
| wordmark | lowercase “kabanos”, Bricolage Grotesque 800, tracking −0.8px |

Layout: macOS title bar with traffic lights and connection tabs (46px) · activity bar 64px (Connections, Explorer, Workspace, Routines, Stack management, Settings) · sidebar 260–320px · main area. ⌘K opens a command palette that jumps to any connection, index, query, or routine.

## 11. Milestones

1. **Scaffold + connections:** Electron/React/TS, IPC layer, URL parsing, Keychain, test connection, engine detection, tabs.
2. **Explorer:** tree, index overview, mapping viewer, metadata cache.
3. **Index view (option 4):** method/path/body, results as documents, table, or JSON.
4. **Workspace + library:** request blocks, collapse, library, FTS search, history, autocomplete (paths, DSL, fields).
5. **Routines:** runner, variables, capture, assert, repeat, dry run, logs.
6. **Stack management:** users and roles on ES, then the OpenSearch adapter, then the Data pages.
7. Polish: ⌘K palette, read-only mode, prod confirmations, import from Kibana console, signing and notarization.

Each milestone should run end to end against a local cluster. Add a `docker-compose.yml` with Elasticsearch 8.x and OpenSearch 2.x (security on) for development and integration tests.

## 12. Non-negotiables

- Credentials never go in logs, SQLite, exports, or the renderer.
- Any non-GET request on a connection tagged production needs explicit confirmation, and read-only mode blocks it entirely.
- Nothing is ever `eval`ed from user input (routine assertions use a sandboxed expression library).
