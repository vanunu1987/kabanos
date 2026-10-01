# kabanos

A macOS desktop client for **Elasticsearch and OpenSearch**: MongoDB Compass's layout (saved connections, a tree of indices, a view per index) with the power of Kibana's Dev Tools console, plus an organised, searchable query library and routines.

Design spec and screen mockups: [`SPEC.md`](SPEC.md), [`design/`](design).

## Screens

| Screen | What it does |
|---|---|
| **Connections** | Paste `https://user:pass@host:9200`; credentials are split out and encrypted with the macOS Keychain. Auth: URL, Basic, API key, Cloud ID, AWS SigV4 (OpenSearch Service / Serverless), none. TLS: custom CA, self-signed, or SHA-256 fingerprint pinning. SSH tunnel or HTTP proxy. Production tag (warning stripe + confirm every write), read-only mode, colors, folders, favorites, import/export without secrets. |
| **Explorer** | Tree of indices, data streams, aliases, index/component templates (filter, hide system/closed, sort). Index overview: stats, mapping tree, aliases, matched template, key settings, shards, documents, saved queries. Refresh / clear cache / open / close / delete (typed-name confirmation). |
| **Index view** | Method dropdown + locked `/<index>/` prefix + endpoint chips. JSON body with mapping-aware autocomplete. Results as documents, table or JSON, from/size paging; Documents tab pages a point-in-time snapshot with `search_after`. Edit (diff preview, `if_seq_no`/`if_primary_term`), clone, delete documents. Streaming CSV/NDJSON export. |
| **Query workspace** | Tabs of collapsible request blocks in Kibana console syntax. Autocomplete for endpoints, query params, index names, body keys (from the Elasticsearch API spec) and mapping fields ranked by query context. Default target, `{{variables}}` from environments (secret values encrypted). Run a block (⌘↵) or selected blocks in order. Response pane with previous responses. Import Kibana console exports (comment lines become titles) and cURL; copy as cURL (never with credentials). |
| **Query library** | Nested folders, pinned, recent, history, #tags; full-text search over names, bodies, target index and field names (⌘F). Drag blocks onto folders. |
| **Routines** | Ordered steps with a default connection and per-step overrides; `{{var}}` / `{{steps.<id>.<name>}}` templating; capture, assert, run-when and repeat-until (polling) with jsonata expressions; stop/continue on failure; ask-before-run. Run all, step through, stop, dry run (reads only). Live run log, captured values, previous runs. |
| **Stack management** | Users, roles (cluster + index privileges, field- and document-level security, masked fields on OpenSearch, JSON view), role mappings, API keys (Elasticsearch), tenants (OpenSearch). Data: lifecycle (ILM/ISM), snapshots, ingest pipelines, templates. Cluster: nodes, settings, tasks (with cancel). |
| **⌘K** | Jump to any connection, index, alias, template, saved query, routine or screen. |

## Develop

Requires Node 22 (`nvm use`), pnpm, and Docker for the local clusters.

```sh
pnpm install
pnpm clusters:up        # ES 8 (https :9200), ES 9 (:9202), OpenSearch 2 (https :9201)
pnpm clusters:seed      # sample indices, aliases, templates, a data stream
pnpm dev                # run the app with hot reload
```

Connection URLs for the dev clusters:

| Cluster | URL | Note |
|---|---|---|
| ES 9 | `http://elastic:sift-dev-pass@localhost:9202` | |
| ES 8 | `https://elastic:sift-dev-pass@localhost:9200` | self-signed: untick *Verify TLS* or pin `pnpm clusters:fingerprint` |
| OpenSearch 2 | `https://admin:Sift-dev-Pass_42@localhost:9201` | untick *Verify TLS* |

### Tests

```sh
pnpm test                       # unit tests (Vitest, run inside Electron-as-Node for better-sqlite3)
KABANOS_IT=1 pnpm test             # + integration tests against the docker clusters
pnpm e2e                        # builds, then drives the real app with Playwright (needs clusters + seed)
pnpm pack && pnpm smoke         # package an unpacked .app and smoke-test it
```

### Build

```sh
pnpm dist:arm64                 # dist/kabanos-<version>-arm64.dmg  (pnpm dist → arm64 + x64)
```

The build is **unsigned** until an Apple Developer ID is configured (`electron-builder.yml`). On macOS 15+, open it once via *System Settings → Privacy & Security → Open Anyway*, or run `xattr -dr com.apple.quarantine /Applications/kabanos.app`. Auto-update needs a `publish` target (S3 or GitHub Releases) — not set up yet.

Maintenance scripts: `pnpm spec:build` regenerates the autocomplete index from [elastic/elasticsearch-specification](https://github.com/elastic/elasticsearch-specification) (Apache-2.0); `node scripts/gen-monaco-entry.mjs` regenerates the trimmed Monaco entry after upgrading `monaco-editor`.

## Architecture

```
renderer (React, sandboxed)  ── one typed IPC channel (zod-validated) ──  main process
  shell, screens, Monaco                                                    ConnectionManager  URL/Cloud ID parsing, safeStorage secrets, guards
  autocomplete (spec index,                                                 ClusterClient      undici, TLS/pinning, SigV4, SSH tunnel, proxy, cancel
  mapping fields)                                                           MetadataService    tree / index / alias / fields (cached)
                                                                            LibraryStore       queries, folders, FTS5 search, tabs, history, environments
                                                                            RoutineRunner      steps, jsonata, polling, dry run, events → renderer
                                                                            SecurityService    ES _security / OpenSearch security plugin adapter
                                                                            SQLite (better-sqlite3) in the user data folder
```

**Safety rules** (enforced in main, so every screen and routines go through them):

- Cluster HTTP never runs in the renderer, and credentials never reach it, nor logs, exports or plaintext on disk.
- Requests are classified as read / write / danger. Writes on production connections need a native confirmation, and read-only connections block them outright.
- `{{variables}}` are resolved in main; history stores the request as written, never resolved secrets.
- Routine expressions use jsonata (sandboxed), never `eval`.

## Known limitations

- Field- and document-level security on Elasticsearch needs a Platinum/Enterprise license (the cluster's error is shown as-is). OpenSearch supports it out of the box.
- Body autocomplete uses the Elasticsearch spec for both engines; OpenSearch-only APIs (`_plugins/*`) get path suggestions only.
- AWS SigV4 is covered by unit tests with static credentials. It has not been tested against a live AWS domain from this repo.
- Fingerprint pinning can't be combined with an HTTP proxy (use a CA file), and an SSH tunnel can't be combined with a proxy.
