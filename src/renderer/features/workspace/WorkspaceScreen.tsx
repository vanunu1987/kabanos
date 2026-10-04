import { useQuery } from '@tanstack/react-query'
import { useEffect, useMemo, useRef, useState } from 'react'
import { blockText } from '@shared/consoleParser'
import { formatBlock } from '@shared/format'
import { api } from '../../api'
import type { ConsoleContext } from '../../autocomplete/consoleCompletion'
import { Icon } from '../../shell/icons'
import { ResizeHandle, usePaneWidth } from '../../components/Resizable'
import { keys, queryClient, useTree } from '../../queries'
import { COLORS, useApp } from '../../store'
import { AddToRoutineModal } from './AddToRoutineModal'
import { EnvModal } from './EnvModal'
import { ImportModal } from './ImportModal'
import { LibrarySidebar } from './LibrarySidebar'
import { RequestBlock } from './RequestBlock'
import { ResponsePane } from './ResponsePane'
import { useWorkspace } from './store'

/** Screen 3 — free query builder: workspace tabs of collapsible request blocks + the query library. */
export function WorkspaceScreen() {
  const ws = useWorkspace()
  const connId = useApp((s) => s.activeTab)
  const conn = useApp((s) => s.connections.find((c) => c.id === s.activeTab))
  const tree = useTree(connId ?? '')
  const [renamingTab, setRenamingTab] = useState<string | null>(null)
  const [importing, setImporting] = useState(false)
  const [envOpen, setEnvOpen] = useState(false)
  const [toRoutine, setToRoutine] = useState(false)
  const [respWidth, setRespWidth] = usePaneWidth('ws-response', 420, 280, 1200)
  // ⌘↵ outside an editor runs the active block (inside one, the editor's own action runs its block).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'Enter' && !(e.target as HTMLElement | null)?.closest('.monaco-editor, .modal')) {
        const id = useWorkspace.getState().activeBlock
        if (id) {
          e.preventDefault()
          void useWorkspace.getState().run(id)
        }
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])
  const envs = useQuery({ queryKey: ['envs', ws.libraryVersion], queryFn: () => api.env.list() })

  // Each cluster has its own workspace: switching the connection tab switches tabs, blocks and library.
  useEffect(() => {
    void ws.load(connId ?? undefined)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connId])

  const tab = ws.tabs.find((t) => t.id === ws.activeTab)
  const blocks = ws.activeTab ? (ws.blocks[ws.activeTab] ?? []) : []

  // Autocomplete context shared by every block editor in this tab.
  const ctxRef = useRef<ConsoleContext>(null as unknown as ConsoleContext)
  ctxRef.current = {
    names: () => ({
      indices: tree.data?.indices.map((i) => i.name) ?? [],
      aliases: tree.data?.aliases.map((a) => a.name) ?? [],
      dataStreams: tree.data?.dataStreams.map((d) => d.name) ?? []
    }),
    fields: (target) => (connId ? queryClient.fetchQuery({ queryKey: keys.fields(connId, target), queryFn: () => api.meta.fields(connId, target), staleTime: 60_000 }).catch(() => []) : Promise.resolve([])),
    defaultTarget: () => tab?.defaultTarget
  }
  const context = useMemo<ConsoleContext>(() => ({ names: () => ctxRef.current.names(), fields: (t) => ctxRef.current.fields(t), defaultTarget: () => ctxRef.current.defaultTarget() }), [])

  const targets = useMemo(() => {
    const t = tree.data
    if (!t) return []
    return [...t.aliases.map((a) => ({ name: a.name, hint: `→ ${a.indices.map((i) => i.index).join(', ')}` })), ...t.dataStreams.map((d) => ({ name: d.name, hint: 'data stream' })), ...t.indices.filter((i) => !i.hidden && !i.dataStream).map((i) => ({ name: i.name, hint: '' }))]
  }, [tree.data])
  const resolvedTarget = targets.find((t) => t.name === tab?.defaultTarget)?.hint

  const allCollapsed = blocks.length > 0 && blocks.every((b) => b.collapsed)
  const selectedInOrder = blocks.filter((b) => ws.selected.has(b.queryId)).map((b) => b.queryId)

  const addBlock = () => ws.newBlock()

  if (!connId || !conn)
    return (
      <main className="main workspace">
        <div className="empty-state">
          <h2>No cluster open</h2>
          <p className="hint">Every cluster has its own workspace and query library, so a query written for one cluster never runs on another by mistake. Open a connection to see its queries.</p>
          <button className="btn md primary" onClick={() => useApp.getState().setView('connections')}>
            Go to Connections
          </button>
        </div>
      </main>
    )

  return (
    <>
      <LibrarySidebar connection={conn} />
      <main className="main workspace">
        <div className="qtabs" role="tablist" aria-label="Workspace tabs">
          {ws.tabs.map((t) => (
            <div key={t.id} role="tab" aria-selected={t.id === ws.activeTab} tabIndex={0} className={`qtab${t.id === ws.activeTab ? ' on' : ''}`} onClick={() => ws.selectTab(t.id)} onDoubleClick={() => setRenamingTab(t.id)}>
              {renamingTab === t.id ? (
                <input
                  className="inline-input"
                  autoFocus
                  defaultValue={t.name}
                  onBlur={(e) => {
                    void ws.renameTab(t.id, e.target.value)
                    setRenamingTab(null)
                  }}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
                    if (e.key === 'Escape') setRenamingTab(null)
                  }}
                />
              ) : (
                <span>{t.name}</span>
              )}
              {Object.values(ws.runs).some((r) => r.running) && t.id === ws.activeTab && <span className="dot" style={{ width: 6, height: 6, background: 'var(--accent)' }} />}
              {ws.tabs.length > 1 && (
                <button
                  className="conn-tab-close"
                  aria-label={`Close ${t.name}`}
                  onClick={(e) => {
                    e.stopPropagation()
                    const unsaved = (ws.blocks[t.id] ?? []).filter((b) => b.query.folderId === null && !b.query.pinned).length
                    if (unsaved && !confirm(`Close "${t.name}"? ${unsaved} unsaved block${unsaved === 1 ? '' : 's'} will be discarded (saved queries stay in the library).`)) return
                    void ws.closeTab(t.id)
                  }}
                >
                  {Icon.close()}
                </button>
              )}
            </div>
          ))}
          <button className="qtab back" aria-label="New tab" title="New tab" onClick={() => ws.createTab()}>
            {Icon.plus(14)}
          </button>
        </div>

        <div className="ws-toolbar">
          <span className="hint">Default target</span>
          <div className="target-picker mono">
            <input
              list="ws-targets"
              value={tab?.defaultTarget ?? ''}
              placeholder="none"
              onChange={(e) => ws.setDefaultTarget(e.target.value || null)}
              aria-label="Default target"
              spellCheck={false}
            />
            {resolvedTarget && <span className="faint">{resolvedTarget}</span>}
            <datalist id="ws-targets">
              {targets.map((t) => (
                <option key={t.name} value={t.name} />
              ))}
            </datalist>
          </div>
          <span className="hint">Env</span>
          <select className="select xs" value={tab?.envId ?? ''} onChange={(e) => (e.target.value === '__manage' ? setEnvOpen(true) : ws.setEnv(e.target.value || null))} aria-label="Environment">
            <option value="">none</option>
            {envs.data?.map((e) => (
              <option key={e.id} value={e.id}>
                {e.name}
              </option>
            ))}
            <option value="__manage">Manage environments…</option>
          </select>
          <span className="ws-conn" title={`This workspace belongs to ${conn.name}: its queries only run on this cluster`}>
            <span className="dot" style={{ background: COLORS[conn.color] }} /> {conn.name}
            {conn.isProd && <span className="pill tiny" style={{ color: 'var(--red)' }}>prod</span>}
          </span>
          <div className="spacer" />
          <button className="btn xs ghost" onClick={() => ws.setCollapsed(blocks.map((b) => b.queryId), !allCollapsed)} disabled={!blocks.length}>
            {allCollapsed ? 'Expand all' : 'Collapse all'}
          </button>
          <button
            className="btn xs"
            disabled={!ws.activeBlock}
            title="Auto-indent the active block (⌘I)"
            onClick={() => {
              const b = blocks.find((x) => x.queryId === ws.activeBlock)
              if (b) ws.editText(b.queryId, formatBlock(ws.drafts[b.queryId] ?? blockText(b.query)))
            }}
          >
            Format
          </button>
          <button className="btn xs" onClick={() => setImporting(true)}>
            Import…
          </button>
          <button className="btn xs" disabled={selectedInOrder.length === 0 && !ws.activeBlock} onClick={() => setToRoutine(true)} title="Selected blocks (or the active one) become routine steps">
            Add to routine
          </button>
          {selectedInOrder.length > 1 ? (
            <button className="btn xs primary" onClick={() => ws.runSequence(selectedInOrder)}>
              ▶ Run {selectedInOrder.length} in order
            </button>
          ) : (
            <button className="btn xs primary" disabled={!ws.activeBlock} onClick={() => ws.activeBlock && ws.run(ws.activeBlock)} title="Run the active block (⌘↵)">
              ▶ Run
            </button>
          )}
        </div>

        <div className="ws-split">
          <div className="blocks">
            {blocks.map((b) => (
              <RequestBlock key={b.queryId} block={b} conn={conn} defaultTarget={tab?.defaultTarget} context={context} autoFocus={ws.focusBlock === b.queryId} />
            ))}
            <button className="add-block" onClick={addBlock}>
              {Icon.plus(14)} New request
            </button>
            {blocks.length === 0 && (
              <div className="empty">
                An empty tab. Add a request, open one from the library, or{' '}
                <button className="link" onClick={() => setImporting(true)}>
                  paste a Kibana console export
                </button>
                .
              </div>
            )}
          </div>
          <ResizeHandle width={respWidth} onResize={(w) => setRespWidth(Number.isNaN(w) ? 420 : w)} side="left" label="Resize requests and response" />
          <ResponsePane width={respWidth} />
        </div>
      </main>
      {importing && <ImportModal onClose={() => setImporting(false)} />}
      {toRoutine && (
        <AddToRoutineModal
          queries={(selectedInOrder.length ? selectedInOrder : [ws.activeBlock!]).map((id) => blocks.find((b) => b.queryId === id)!.query)}
          defaultTarget={tab?.defaultTarget}
          onClose={() => setToRoutine(false)}
        />
      )}
      {envOpen && <EnvModal onClose={() => setEnvOpen(false)} onChanged={() => ws.bumpLibrary()} />}
    </>
  )
}
