import { useEffect, useMemo, useRef, useState } from 'react'
import { formatBody } from '@shared/format'
import { formatBytes } from '@shared/meta'
import type { ConnectionConfig, HttpMethod } from '@shared/types'
import { api, KabanosError } from '../../api'
import { registerBodySource, ensureBodyCompletion } from '../../autocomplete/bodyCompletion'
import { Async } from '../../components/Async'
import { ResizeHandle, usePaneWidth } from '../../components/Resizable'
import { CodeEditor } from '../../components/CodeEditor'
import { JsonView } from '../../components/JsonView'
import { Icon } from '../../shell/icons'
import { refreshConnection, useFields, useIndexDetail, useTree } from '../../queries'
import { useApp } from '../../store'
import { reason } from '../explorer/indexActions'
import { HealthPill, SettingsTable } from '../explorer/IndexPage'
import { MappingTable } from '../explorer/MappingTable'
import { MappingEditor } from '../explorer/MappingEditor'
import { DeleteModal, EmptyModal } from '../explorer/DangerModals'
import { Menu } from '../../components/Menu'
import { ExportModal } from '../../components/ExportModal'
import { DocumentCards, type Hit } from './DocumentCards'
import { EditDocModal } from './EditDocModal'
import { SaveQueryModal } from '../workspace/SaveQueryModal'
import { useWorkspace } from '../workspace/store'
import { closePit, openPit, pitPage, type PitPage } from './pit'
import { ResultsTable } from './ResultsTable'
import { AggregationsTab } from '../aggregations/AggregationsTab'
import { ENDPOINTS, METHODS, tabKey, useQueryTabs, type QueryTabState, type SubTab } from './state'

const VIEW_LABEL = { documents: 'Documents', table: 'Table', json: 'JSON' } as const

const SUBTABS: Array<[SubTab, string]> = [
  ['query', 'Query'],
  ['aggregations', 'Aggregations'],
  ['documents', 'Documents'],
  ['mapping', 'Mapping'],
  ['aliases', 'Aliases'],
  ['settings', 'Settings']
]

/** Compass-style index tab (screen 4): method + locked prefix + endpoint, JSON body, document results. */
export function IndexView({ conn }: { conn: ConnectionConfig }) {
  const ex = useApp((s) => s.explorer[conn.id])
  const target = ex?.activeQuery
  const tabs = ex?.queryTabs ?? []
  const { openQuery, closeQuery, updateExplorer } = useApp.getState()
  if (!target) return null

  return (
    <main className="main index-view">
      <div className="qtabs" role="tablist" aria-label="Open indices">
        <button className="qtab back" title="Back to the explorer" onClick={() => updateExplorer(conn.id, { mode: 'inspect' })}>
          ← Explorer
        </button>
        {tabs.map((t) => (
          <div key={t} role="tab" aria-selected={t === target} tabIndex={0} className={`qtab mono${t === target ? ' on' : ''}`} onClick={() => openQuery(conn.id, t)}>
            <span>{t}</span>
            <button className="conn-tab-close" aria-label={`Close ${t}`} onClick={(e) => (e.stopPropagation(), closeQuery(conn.id, t))}>
              {Icon.close()}
            </button>
          </div>
        ))}
      </div>
      <TargetPane key={target} conn={conn} target={target} />
    </main>
  )
}

function TargetPane({ conn, target }: { conn: ConnectionConfig; target: string }) {
  const key = tabKey(conn.id, target)
  const state = useQueryTabs((s) => s.tabs[key]) ?? useQueryTabs.getState().get(key)
  const patch = (p: Partial<QueryTabState>) => useQueryTabs.getState().patch(key, p)
  const tree = useTree(conn.id)
  const [danger, setDanger] = useState<'delete' | 'empty' | null>(null)

  const info = useMemo(() => {
    const t = tree.data
    if (!t) return undefined
    const idx = t.indices.find((i) => i.name === target)
    if (idx) return { kind: 'index', docs: idx.docs, bytes: idx.storeBytes, health: idx.health, closed: idx.status === 'close' }
    const alias = t.aliases.find((a) => a.name === target)
    const ds = t.dataStreams.find((d) => d.name === target)
    const members = alias ? alias.indices.map((i) => i.index) : ds ? ds.indices : []
    const rows = t.indices.filter((i) => members.includes(i.name))
    return { kind: alias ? 'alias' : ds ? 'data stream' : 'pattern', docs: rows.reduce((n, i) => n + i.docs, 0), bytes: rows.reduce((n, i) => n + i.storeBytes, 0), health: ds?.health ?? rows[0]?.health ?? 'unknown', closed: false }
  }, [tree.data, target])

  // Templates aren't queryable: a template opened here (e.g. a tab restored from before) points to its own page.
  const t = tree.data
  const isTemplateOnly = !!t && t.templates.some((x) => x.name === target) && !t.indices.some((i) => i.name === target) && !t.aliases.some((x) => x.name === target) && !t.dataStreams.some((d) => d.name === target)
  if (isTemplateOnly)
    return (
      <div className="empty-state">
        <h2 className="mono">{target}</h2>
        <p className="hint">This is an index template, not an index — it can’t be queried. Open its page to read and change its settings, mappings and patterns.</p>
        <button
          className="btn md primary"
          onClick={() => {
            useApp.getState().closeQuery(conn.id, target)
            useApp.getState().select(conn.id, { kind: 'template', name: target })
          }}
        >
          Open template
        </button>
      </div>
    )

  return (
    <>
      <div className="iv-head">
        <div className="title-row">
          <h1 className="mono">{target}</h1>
          {info && (
            <span className="hint">
              {info.kind !== 'index' && `${info.kind} · `}
              {info.docs.toLocaleString()} docs · {formatBytes(info.bytes)}
            </span>
          )}
          {info && <HealthPill health={info.closed ? 'closed' : info.health} />}
          <div className="spacer" />
          {info && (info.kind === 'index' || info.kind === 'data stream') && (
            <Menu
              label="Index actions"
              items={[
                { label: `Empty ${info.kind} (delete all documents)…`, danger: true, onSelect: () => setDanger('empty'), disabled: info.closed },
                { label: `Delete ${info.kind}…`, danger: true, onSelect: () => setDanger('delete') }
              ]}
            >
              ⋯
            </Menu>
          )}
        </div>
        {danger === 'delete' && <DeleteModal conn={conn} name={target} kind={info?.kind === 'data stream' ? 'datastream' : 'index'} onClose={() => setDanger(null)} onDone={() => (setDanger(null), useApp.getState().closeQuery(conn.id, target))} />}
        {danger === 'empty' && <EmptyModal conn={conn} name={target} onClose={() => setDanger(null)} onDone={() => setDanger(null)} />}
        <div className="tabs" role="tablist">
          {SUBTABS.map(([id, label]) => (
            <button key={id} role="tab" aria-selected={state.subTab === id} className={state.subTab === id ? 'on' : ''} onClick={() => patch({ subTab: id })}>
              {label}
            </button>
          ))}
        </div>
      </div>
      {state.subTab === 'query' ? (
        <QueryTab conn={conn} target={target} state={state} patch={patch} />
      ) : state.subTab === 'aggregations' ? (
        <AggregationsTab conn={conn} target={target} docs={info?.docs} />
      ) : state.subTab === 'documents' ? (
        <DocsBrowser conn={conn} target={target} />
      ) : state.subTab === 'mapping' ? (
        <FieldsTab conn={conn} target={target} />
      ) : state.subTab === 'aliases' ? (
        <AliasesTab conn={conn} target={target} />
      ) : (
        <SettingsTab conn={conn} target={target} />
      )}
    </>
  )
}

function QueryTab({ conn, target, state, patch }: { conn: ConnectionConfig; target: string; state: QueryTabState; patch(p: Partial<QueryTabState>): void }) {
  const fields = useFields(conn.id, target)
  const fieldsRef = useRef(fields.data ?? [])
  fieldsRef.current = fields.data ?? []
  const reqRef = useRef({ method: state.method, path: `${target}/${state.endpoint.replace(/^\/+/, '')}` })
  reqRef.current = { method: state.method, path: `${target}/${state.endpoint.replace(/^\/+/, '')}` }
  const modelPath = `body://${conn.id}/${encodeURIComponent(target)}`
  useEffect(() => {
    ensureBodyCompletion()
    return registerBodySource(modelPath, { request: () => reqRef.current, fields: async () => fieldsRef.current })
  }, [modelPath])

  const [methodOpen, setMethodOpen] = useState(false)
  const [bodyWidth, setBodyWidth] = usePaneWidth('index-body', 460, 280, 1100)
  const [editing, setEditing] = useState<{ hit?: Hit; mode: 'edit' | 'clone' } | null>(null)
  const [saving, setSaving] = useState(false)
  const bodyAllowed = state.method !== 'HEAD'

  const run = async (overrideBody?: string) => {
    const opaqueId = `kabanos-${crypto.randomUUID()}`
    const body = overrideBody ?? state.body
    patch({ running: opaqueId, error: undefined, ...(overrideBody !== undefined ? { body: overrideBody } : {}) })
    try {
      const path = `${encodeURIComponent(target)}/${state.endpoint.replace(/^\/+/, '')}`
      const response = await api.cluster.run({ connectionId: conn.id, method: state.method, path, body: bodyAllowed && body.trim() ? body : undefined, opaqueId })
      patch({ response, running: undefined })
      if (state.method !== 'GET' && state.method !== 'HEAD' && !/_search|_count/.test(state.endpoint)) void refreshConnection(conn.id)
    } catch (e) {
      const cancelled = e instanceof KabanosError && (e.code === 'CANCELLED' || e.code === 'NOT_CONFIRMED')
      patch({ running: undefined, error: cancelled ? (e.code === 'CANCELLED' ? 'Request cancelled' : 'Not sent — confirmation declined') : (e as Error).message })
    }
  }
  const cancel = () => state.running && api.cluster.cancel(state.running)
  const runRef = useRef(run)
  runRef.current = run
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'Enter' && !(e.target as HTMLElement | null)?.closest('.monaco-editor, .modal')) {
        e.preventDefault()
        void runRef.current()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const parsed = useMemo(() => {
    if (!state.response) return undefined
    try {
      return JSON.parse(state.response.body) as { hits?: { total?: { value: number; relation?: string } | number; hits: Hit[] } }
    } catch {
      return undefined
    }
  }, [state.response])
  const hits = parsed?.hits?.hits
  const total = parsed?.hits?.total
  const totalN = typeof total === 'number' ? total : total?.value

  // from/size paging by rewriting the body.
  const paging = useMemo(() => {
    try {
      const b = JSON.parse(state.body || '{}') as { from?: number; size?: number }
      return { from: b.from ?? 0, size: b.size ?? 10, ok: true }
    } catch {
      return { from: 0, size: 10, ok: false }
    }
  }, [state.body])
  const page = (dir: 1 | -1) => {
    const b = JSON.parse(state.body || '{}') as Record<string, unknown>
    b.from = Math.max(0, paging.from + dir * paging.size)
    void run(JSON.stringify(b, null, 2))
  }

  const openEdit = async (hit: Hit) => {
    // Re-read the document so the edit carries its current seq_no / primary_term.
    const res = await api.cluster.request({ connectionId: conn.id, method: 'GET', path: `${encodeURIComponent(hit._index)}/_doc/${encodeURIComponent(hit._id)}` })
    if (res.status >= 400) return useApp.getState().showToast(`Could not load ${hit._id}: ${reason(res.body)}`)
    setEditing({ hit: JSON.parse(res.body) as Hit, mode: 'edit' })
  }
  const remove = async (hit: Hit) => {
    if (!confirm(`Delete document ${hit._id} from ${hit._index}?`)) return
    try {
      const res = await api.cluster.request({ connectionId: conn.id, method: 'DELETE', path: `${encodeURIComponent(hit._index)}/_doc/${encodeURIComponent(hit._id)}?refresh=wait_for` })
      useApp.getState().showToast(res.status < 400 ? `Deleted ${hit._id}` : reason(res.body))
      if (res.status < 400) void run()
    } catch (e) {
      if (!(e instanceof KabanosError && e.code === 'NOT_CONFIRMED')) useApp.getState().showToast((e as Error).message)
    }
  }
  const [exporting, setExporting] = useState(false)

  return (
    <>
      <div className="reqbar-wrap">
        <div className="reqbar">
          <div className="method-wrap">
            <button className={`method-btn mono m-${state.method.toLowerCase()}`} aria-haspopup="listbox" aria-expanded={methodOpen} aria-label={`HTTP method ${state.method}`} onClick={() => setMethodOpen((o) => !o)}>
              {state.method}
              {Icon.chevronDown()}
            </button>
            {methodOpen && (
              <div className="method-list" role="listbox" aria-label="HTTP method">
                {METHODS.map((m, i) => (
                  <div key={m.method}>
                    {i === METHODS.length - 1 && <div className="menu-sep" />}
                    <div
                      role="option"
                      aria-selected={state.method === m.method}
                      className={`method-opt${state.method === m.method ? ' on' : ''}`}
                      onClick={() => {
                        patch({ method: m.method as HttpMethod })
                        setMethodOpen(false)
                      }}
                    >
                      <span className={`mono m-${m.method.toLowerCase()}`}>{m.method}</span>
                      <span className="hint">{m.hint}</span>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
          <div className="pathbox mono">
            <span className="prefix">/{target}/</span>
            <input aria-label="Endpoint path" value={state.endpoint} onChange={(e) => patch({ endpoint: e.target.value })} onKeyDown={(e) => e.key === 'Enter' && run()} spellCheck={false} />
          </div>
          {state.running ? (
            <button className="btn primary run" onClick={cancel}>
              Cancel
            </button>
          ) : (
            <button className="btn primary run" onClick={() => run()} title="Run (⌘↵)">
              ▶ Run
            </button>
          )}
          <button className="btn" onClick={() => setSaving(true)}>
            Save to library
          </button>
        </div>
        <div className="chips">
          <span className="hint" style={{ marginRight: 4 }}>
            Endpoints
          </span>
          {ENDPOINTS.map((e) => (
            <button key={e.label} className={`chip mono${state.endpoint === e.path ? ' on' : ''}`} onClick={() => patch({ method: e.method, endpoint: e.path, ...(e.body !== undefined ? { body: e.body || state.body } : {}) })}>
              {e.label}
            </button>
          ))}
        </div>
      </div>
      <div className="iv-split">
        <div className="iv-body" style={{ width: bodyWidth }}>
          <div className="pane-head">
            <span className="pane-title">Body</span>
            <span className="hint">{bodyAllowed ? `JSON · autocompletes fields of ${target}` : 'HEAD requests have no body'}</span>
            <button className="link-btn" style={{ marginLeft: 'auto' }} onClick={() => formatBodyInto(state.body, (b) => patch({ body: b }))} title="Auto-indent (⌘I)">
              Format
            </button>
          </div>
          <div className="editor-box flex">
            <CodeEditor value={state.body} onChange={(body) => patch({ body })} path={modelPath} onRun={() => run()} readOnly={!bodyAllowed} />
          </div>
        </div>
        <ResizeHandle width={bodyWidth} onResize={(w) => setBodyWidth(Number.isNaN(w) ? 460 : w)} side="right" label="Resize query and results" />
        <div className="iv-results">
          <div className="pane-head">
            {state.running ? (
              <span className="hint">
                <span className="spin inline" /> Running…
              </span>
            ) : state.response ? (
              <>
                <StatusBadge status={state.response.status} />
                <span className="hint">
                  {hits ? `${hits.length ? `${paging.from + 1}–${paging.from + hits.length}` : '0'} of ${totalN?.toLocaleString() ?? '?'}${typeof total === 'object' && total.relation === 'gte' ? '+' : ''} hits · ` : ''}
                  {state.response.ms} ms · {formatBytes(state.response.bytes)}
                </span>
              </>
            ) : (
              <span className="hint">Run the request to see results (⌘↵)</span>
            )}
            <div className="spacer" />
            {hits && (
              <>
                <div role="group" aria-label="Result view" className="segmented sm">
                  {(['documents', 'table', 'json'] as const).map((v) => (
                    <button key={v} className={state.view === v ? 'on' : ''} onClick={() => patch({ view: v })}>
                      {VIEW_LABEL[v]}
                    </button>
                  ))}
                </div>
                <button className="square-btn sm" aria-label="Previous page" disabled={!paging.ok || paging.from === 0 || !!state.running} onClick={() => page(-1)}>
                  ‹
                </button>
                <button className="square-btn sm" aria-label="Next page" disabled={!paging.ok || !totalN || paging.from + paging.size >= totalN || !!state.running} onClick={() => page(1)}>
                  ›
                </button>
                <button className="link-btn" onClick={() => setExporting(true)} title="Export this page or every matching document">
                  Export…
                </button>
              </>
            )}
            {state.response && (
              <button className="link-btn" onClick={() => navigator.clipboard.writeText(state.response!.body)}>
                Copy
              </button>
            )}
          </div>
          <div className="results-body">
            {state.error ? (
              <div className="error-box">{state.error}</div>
            ) : !state.response ? null : hits && state.view === 'documents' ? (
              <DocumentCards
                hits={hits}
                actions={(h) => (
                  <>
                    <button onClick={() => openEdit(h)}>Edit</button>
                    <button onClick={() => navigator.clipboard.writeText(JSON.stringify(h._source, null, 2))}>Copy</button>
                    <button onClick={() => setEditing({ hit: h, mode: 'clone' })}>Clone</button>
                    <button className="danger" onClick={() => remove(h)}>
                      Delete
                    </button>
                  </>
                )}
              />
            ) : hits && state.view === 'table' ? (
              <ResultsTable hits={hits} />
            ) : (
              <JsonView value={prettyOr(state.response.body)} />
            )}
          </div>
        </div>
      </div>
      {exporting && <ExportModal conn={conn} target={target} body={/_search/.test(state.endpoint) ? state.body : undefined} pageHits={hits} definition={false} onClose={() => setExporting(false)} />}
      {saving && (
        <SaveQueryModal
          connectionId={conn.id}
          initial={{ title: '', folderId: null, tags: [] }}
          onClose={() => setSaving(false)}
          onSave={async (v) => {
            await api.library.createQuery({ ...v, connectionId: conn.id, method: state.method, path: `${target}/${state.endpoint.replace(/^\/+/, '')}`, body: bodyAllowed ? state.body : '' })
            useWorkspace.getState().bumpLibrary()
            setSaving(false)
            useApp.getState().showToast(`Saved “${v.title}” to the library`)
          }}
        />
      )}
      {editing && <EditDocModal conn={conn} hit={editing.hit} mode={editing.mode} index={target} onClose={() => setEditing(null)} onSaved={() => run()} />}
    </>
  )
}

export function StatusBadge({ status }: { status: number }) {
  const cls = status < 300 ? 'ok' : status < 500 ? 'warn' : 'bad'
  return <span className={`status-badge mono ${cls}`}>{status}</span>
}

function prettyOr(body: string): string {
  try {
    return JSON.stringify(JSON.parse(body), null, 2)
  } catch {
    return body || '(empty response)'
  }
}

function formatBodyInto(body: string, set: (b: string) => void): void {
  set(formatBody(body))
}

/** Browse every document with PIT + search_after (no 10k from/size limit). */
function DocsBrowser({ conn, target }: { conn: ConnectionConfig; target: string }) {
  const [page, setPage] = useState<PitPage>()
  const [cursors, setCursors] = useState<Array<unknown[] | undefined>>([undefined])
  const [error, setError] = useState<string>()
  const [loading, setLoading] = useState(true)
  const [view, setView] = useState<'documents' | 'table'>('documents')
  const [exporting, setExporting] = useState(false)
  const pit = useRef<string | null>(null)
  const SIZE = 20

  const load = async (cursor: unknown[] | undefined) => {
    setLoading(true)
    setError(undefined)
    try {
      pit.current ??= await openPit(conn, target)
      const p = await pitPage(conn, pit.current, SIZE, cursor)
      pit.current = p.pitId
      setPage(p)
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    void load(undefined)
    return () => {
      if (pit.current) void closePit(conn, pit.current)
      pit.current = null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conn.id, target])

  const pageNo = cursors.length
  const next = () => {
    if (!page?.next) return
    setCursors((c) => [...c, page.next])
    void load(page.next)
  }
  const prev = () => {
    if (cursors.length <= 1) return
    const c = cursors.slice(0, -1)
    setCursors(c)
    void load(c.at(-1))
  }

  return (
    <div className="iv-results full">
      <div className="pane-head">
        <span className="hint">
          {page ? `${((pageNo - 1) * SIZE + (page.hits.length ? 1 : 0)).toLocaleString()}–${((pageNo - 1) * SIZE + page.hits.length).toLocaleString()} of ${page.total.toLocaleString()} documents · point-in-time snapshot` : 'Loading…'}
        </span>
        <div className="spacer" />
        <div role="group" aria-label="Result view" className="segmented sm">
          {(['documents', 'table'] as const).map((v) => (
            <button key={v} className={view === v ? 'on' : ''} onClick={() => setView(v)}>
              {VIEW_LABEL[v]}
            </button>
          ))}
        </div>
        <button className="square-btn sm" aria-label="Previous page" disabled={loading || pageNo <= 1} onClick={prev}>
          ‹
        </button>
        <button className="square-btn sm" aria-label="Next page" disabled={loading || !page?.next} onClick={next}>
          ›
        </button>
        <button className="link-btn" onClick={() => setExporting(true)} title="Export every document">
          Export…
        </button>
      </div>
      <div className="results-body">
        {error ? <div className="error-box">{error}</div> : page && (view === 'documents' ? <DocumentCards hits={page.hits} /> : <ResultsTable hits={page.hits} />)}
      </div>
      {exporting && <ExportModal conn={conn} target={target} pageHits={page?.hits} definition onClose={() => setExporting(false)} />}
    </div>
  )
}

function FieldsTab({ conn, target }: { conn: ConnectionConfig; target: string }) {
  const tree = useTree(conn.id)
  const isIndex = !!tree.data?.indices.some((i) => i.name === target)
  if (isIndex) return <IndexMappingTab conn={conn} target={target} />
  return <UnionFieldsTab conn={conn} target={target} />
}

/** Concrete index: editable mapping. */
function IndexMappingTab({ conn, target }: { conn: ConnectionConfig; target: string }) {
  const q = useIndexDetail(conn.id, target)
  return (
    <div className="page-body">
      <Async query={q}>{(d) => <MappingEditor conn={conn} detail={d} />}</Async>
    </div>
  )
}

/** Alias / data stream / pattern: read-only union of the members' fields (edit the backing index instead). */
function UnionFieldsTab({ conn, target }: { conn: ConnectionConfig; target: string }) {
  const q = useFields(conn.id, target)
  return (
    <div className="page-body">
      <Async query={q}>{(fields) => <MappingTable fields={fields} raw={fields} fill />}</Async>
    </div>
  )
}

function AliasesTab({ conn, target }: { conn: ConnectionConfig; target: string }) {
  const tree = useTree(conn.id)
  const { select } = useApp.getState()
  return (
    <div className="page-body">
      <Async query={tree}>
        {(t) => {
          const asAlias = t.aliases.find((a) => a.name === target)
          const pointing = t.aliases.filter((a) => a.indices.some((i) => i.index === target))
          return (
            <section className="card pad">
              <h2>{asAlias ? `${target} points to` : `Aliases on ${target}`}</h2>
              {(asAlias ? asAlias.indices.map((i) => ({ name: i.index, write: i.isWriteIndex, filter: i.filter, kind: 'index' as const })) : pointing.map((a) => ({ name: a.name, write: a.indices.find((i) => i.index === target)?.isWriteIndex, filter: a.indices.find((i) => i.index === target)?.filter, kind: 'alias' as const }))).map((r) => (
                <div key={r.name} className="inline-row">
                  <button className="link mono" onClick={() => select(conn.id, { kind: r.kind, name: r.name })}>
                    {r.name}
                  </button>
                  {r.write && <span className="pill tiny accent">write index</span>}
                  {r.filter && <span className="pill tiny">filtered</span>}
                </div>
              ))}
              {!asAlias && pointing.length === 0 && <span className="hint">No aliases point at {target}</span>}
            </section>
          )
        }}
      </Async>
    </div>
  )
}

function SettingsTab({ conn, target }: { conn: ConnectionConfig; target: string }) {
  const [state, setState] = useState<{ data?: Record<string, Record<string, string>>; error?: string }>({})
  useEffect(() => {
    api.cluster
      .request({ connectionId: conn.id, method: 'GET', path: `${encodeURIComponent(target)}/_settings?flat_settings=true` })
      .then((r) => (r.status < 400 ? setState({ data: Object.fromEntries(Object.entries(JSON.parse(r.body) as Record<string, { settings: Record<string, string> }>).map(([k, v]) => [k, v.settings])) }) : setState({ error: reason(r.body) })))
      .catch((e: Error) => setState({ error: e.message }))
  }, [conn.id, target])
  if (state.error) return <div className="error-box">{state.error}</div>
  if (!state.data) return <div className="loading">Loading…</div>
  const entries = Object.entries(state.data)
  return (
    <div className="page-body">
      {entries.length > 1 && <div className="hint" style={{ marginBottom: 8 }}>Showing settings of {entries[0]![0]} ({entries.length} indices behind {target})</div>}
      <SettingsTable settings={entries[0]?.[1] ?? {}} />
    </div>
  )
}
