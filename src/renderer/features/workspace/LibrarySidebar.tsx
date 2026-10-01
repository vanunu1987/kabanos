import { useQuery } from '@tanstack/react-query'
import { useEffect, useMemo, useRef, useState, type DragEvent } from 'react'
import type { Folder, LibraryFilter, Query } from '@shared/library'
import { api } from '../../api'
import { Menu } from '../../components/Menu'
import { relTime } from '../../components/time'
import { Icon } from '../../shell/icons'
import { useApp } from '../../store'
import { openSavedPipeline } from '../aggregations/AggregationsTab'
import { tabKey, useQueryTabs } from '../indexView/state'
import { useWorkspace } from './store'

export const DRAG_TYPE = 'application/x-kabanos-query'
type Chip = { id: string; label: string; filter: LibraryFilter | 'history' }

/** Query library (SPEC §6): nested folders, Pinned/Recent/History/#tags, FTS search, drag to file. */
export function LibrarySidebar() {
  const version = useWorkspace((s) => s.libraryVersion)
  const activeBlock = useWorkspace((s) => s.activeBlock)
  const { openQuery, bumpLibrary, newBlock } = useWorkspace.getState()
  const [search, setSearch] = useState('')
  const [chip, setChip] = useState('all')
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set(['__unsaved']))
  const [renaming, setRenaming] = useState<string | null>(null)
  const searchRef = useRef<HTMLInputElement>(null)

  // ⌘F focuses library search when no editor has focus (Monaco keeps its own ⌘F).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'f' && !(document.activeElement as HTMLElement | null)?.closest('.monaco-editor')) {
        e.preventDefault()
        searchRef.current?.focus()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const tags = useQuery({ queryKey: ['tags', version], queryFn: () => api.library.tags() })
  const chips: Chip[] = [
    { id: 'all', label: 'All', filter: { kind: 'all' } },
    { id: 'pinned', label: 'Pinned', filter: { kind: 'pinned' } },
    { id: 'recent', label: 'Recent', filter: { kind: 'recent' } },
    { id: 'history', label: 'History', filter: 'history' },
    ...(tags.data ?? []).slice(0, 4).map((t) => ({ id: `#${t.tag}`, label: `#${t.tag}`, filter: { kind: 'tag', tag: t.tag } as LibraryFilter }))
  ]
  const active = chips.find((c) => c.id === chip) ?? chips[0]!

  const folders = useQuery({ queryKey: ['folders', version], queryFn: () => api.library.folders() })
  const queries = useQuery({
    queryKey: ['queries', version, active.id, search],
    queryFn: () => api.library.queries(active.filter === 'history' ? { kind: 'all' } : active.filter, search),
    enabled: active.filter !== 'history'
  })
  const history = useQuery({ queryKey: ['history', version, search], queryFn: () => api.library.history(search, 200), enabled: active.filter === 'history' })

  const flat = search.trim() !== '' || active.id !== 'all'
  const tree = useMemo(() => buildTree(folders.data ?? [], queries.data ?? []), [folders.data, queries.data])

  const moveTo = async (queryId: string, folderId: string | null) => {
    await api.library.updateQuery(queryId, { folderId })
    bumpLibrary()
    void useWorkspace.getState().loadBlocks(useWorkspace.getState().activeTab!)
  }
  const onDrop = (folderId: string) => (e: DragEvent) => {
    const id = e.dataTransfer.getData(DRAG_TYPE)
    e.currentTarget.classList.remove('drop')
    if (id) void moveTo(id, folderId)
  }
  const dropProps = (folderId: string) => ({
    onDragOver: (e: DragEvent) => {
      if (e.dataTransfer.types.includes(DRAG_TYPE)) {
        e.preventDefault()
        e.currentTarget.classList.add('drop')
      }
    },
    onDragLeave: (e: DragEvent) => e.currentTarget.classList.remove('drop'),
    onDrop: onDrop(folderId)
  })

  const newFolder = async (parentId: string | null = null) => {
    const f = await api.library.createFolder('New folder', parentId)
    bumpLibrary()
    setRenaming(f.id)
    if (parentId) setCollapsed((c) => new Set([...c].filter((x) => x !== parentId)))
  }

  const row = (q: Query, depth: number) => (
    <QueryRow key={q.id} q={q} depth={depth} active={q.id === activeBlock} folders={folders.data ?? []} onOpen={() => openQuery(q.id)} onMove={(f) => moveTo(q.id, f)} />
  )

  const renderFolder = (node: TreeNode, depth: number) => {
    const isCollapsed = collapsed.has(node.folder.id)
    const toggle = () => setCollapsed((c) => (c.has(node.folder.id) ? new Set([...c].filter((x) => x !== node.folder.id)) : new Set([...c, node.folder.id])))
    return (
      <div key={node.folder.id} className="lib-folder">
        <div className={`lib-folder-head${isCollapsed ? ' collapsed' : ''}`} style={{ paddingLeft: 8 + depth * 14 }} {...dropProps(node.folder.id)}>
          <button className="lib-folder-toggle" onClick={toggle} aria-expanded={!isCollapsed}>
            {Icon.chevronDown()}
            {renaming === node.folder.id ? (
              <input
                className="inline-input"
                autoFocus
                defaultValue={node.folder.name}
                onClick={(e) => e.stopPropagation()}
                onBlur={async (e) => {
                  await api.library.updateFolder(node.folder.id, { name: e.target.value })
                  setRenaming(null)
                  bumpLibrary()
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
                  if (e.key === 'Escape') setRenaming(null)
                }}
              />
            ) : (
              <span onDoubleClick={() => setRenaming(node.folder.id)}>{node.folder.name}</span>
            )}
          </button>
          <span className="count">{node.count}</span>
          <Menu
            label={`Folder ${node.folder.name} actions`}
            items={[
              { label: 'New query here', onSelect: async () => { const id = await newBlock(); if (id) await moveTo(id, node.folder.id) } },
              { label: 'New subfolder', onSelect: () => newFolder(node.folder.id) },
              { label: 'Rename', onSelect: () => setRenaming(node.folder.id) },
              'sep',
              {
                label: 'Delete folder',
                danger: true,
                onSelect: async () => {
                  if (!confirm(`Delete folder "${node.folder.name}"? Its queries move up one level.`)) return
                  await api.library.removeFolder(node.folder.id)
                  bumpLibrary()
                }
              }
            ]}
          >
            ⋯
          </Menu>
        </div>
        {!isCollapsed && (
          <>
            {node.children.map((c) => renderFolder(c, depth + 1))}
            {node.queries.map((q) => row(q, depth + 1))}
            {node.children.length === 0 && node.queries.length === 0 && <div className="tree-empty" style={{ paddingLeft: 28 + depth * 14 }}>Drop queries here</div>}
          </>
        )}
      </div>
    )
  }

  return (
    <aside className="sidebar library">
      <div className="sidebar-head lib-head">
        <div className="tree-title">Query library</div>
        <div style={{ display: 'flex', gap: 6 }}>
          <button className="square-btn sm2" aria-label="New folder" title="New folder" onClick={() => newFolder(null)}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
              <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2zM12 11v5M9.5 13.5h5" />
            </svg>
          </button>
          <button className="square-btn sm2" aria-label="New query" title="New query" onClick={() => newBlock()}>
            {Icon.plus(14)}
          </button>
        </div>
      </div>
      <div className="tree-tools">
        <label className="filter lib-search" style={{ margin: 0 }}>
          {Icon.search()}
          <input ref={searchRef} aria-label="Search queries" placeholder="Search name, body, index, field, #tag" value={search} onChange={(e) => setSearch(e.target.value)} onKeyDown={(e) => e.key === 'Escape' && setSearch('')} />
          <span className="mono" style={{ fontSize: 11 }}>
            ⌘F
          </span>
        </label>
        <div className="chips">
          {chips.map((c) => (
            <button key={c.id} className={`chip sm${chip === c.id ? ' on' : ''}`} onClick={() => setChip(c.id)}>
              {c.label}
            </button>
          ))}
        </div>
        <div className="hint" style={{ fontSize: 11.5 }}>
          {active.filter === 'history' ? 'Every request you ran, newest first. Click to reopen.' : 'Searches names, bodies, target index and field names.'}
        </div>
      </div>
      <div className="sidebar-scroll lib-scroll">
        {active.filter === 'history' ? (
          (history.data ?? []).map((h) => (
            <button
              key={h.id}
              className="lib-row"
              style={{ paddingLeft: 10 }}
              onClick={() => newBlock({ method: h.method, path: h.path, body: h.body })}
              title={`${h.method} ${h.path}`}
            >
              <span className={`lib-method mono m-${h.method.toLowerCase()}`}>{h.method}</span>
              <span className="lib-text">
                <span className="lib-name mono">{h.path}</span>
                <span className="lib-meta mono">
                  {h.error ? 'error' : (h.status ?? '—')} · {relTime(h.at)}
                  {h.ms !== undefined && ` · ${h.ms} ms`}
                </span>
              </span>
            </button>
          ))
        ) : flat ? (
          <>
            {(queries.data ?? []).map((q) => row(q, 0))}
            {queries.data?.length === 0 && <div className="empty">{search ? `No queries match “${search}”` : 'Nothing here yet'}</div>}
          </>
        ) : (
          <>
            {tree.roots.map((n) => renderFolder(n, 0))}
            {tree.unsaved.length > 0 && (
              <div className="lib-folder">
                <div className={`lib-folder-head${collapsed.has('__unsaved') ? ' collapsed' : ''}`} style={{ paddingLeft: 8 }}>
                  <button className="lib-folder-toggle muted" onClick={() => setCollapsed((c) => (c.has('__unsaved') ? new Set([...c].filter((x) => x !== '__unsaved')) : new Set([...c, '__unsaved'])))}>
                    {Icon.chevronDown()}
                    <span>Unsaved (in tabs)</span>
                  </button>
                  <span className="count">{tree.unsaved.length}</span>
                </div>
                {!collapsed.has('__unsaved') && tree.unsaved.map((q) => row(q, 1))}
              </div>
            )}
            {tree.roots.length === 0 && (
              <div className="empty">
                No folders yet.{' '}
                <button className="link" onClick={() => newFolder(null)}>
                  Create one
                </button>{' '}
                and drag requests into it.
              </div>
            )}
          </>
        )}
      </div>
    </aside>
  )
}

/** Saved aggregation pipelines open in the index view's Aggregations tab on the active connection. */
function openPipeline(q: Query): void {
  const app = useApp.getState()
  const connectionId = app.activeTab
  if (!connectionId || !q.pipeline) return app.showToast('Open a connection first')
  if (!openSavedPipeline(connectionId, q.id, q.pipeline)) return app.showToast('This pipeline could not be read')
  const target = (JSON.parse(q.pipeline) as { target: string }).target
  useQueryTabs.getState().patch(tabKey(connectionId, target), { subTab: 'aggregations' })
  app.openQuery(connectionId, target)
}

function QueryRow({ q, depth, active, folders, onOpen, onMove }: { q: Query; depth: number; active: boolean; folders: Folder[]; onOpen(): void; onMove(folderId: string | null): void }) {
  const { bumpLibrary, patchQuery, loadBlocks } = useWorkspace.getState()
  const target = q.path.split(/[/?]/)[0]
  return (
    <div
      className={`lib-row${active ? ' active' : ''}`}
      style={{ paddingLeft: 10 + depth * 14 }}
      draggable
      onDragStart={(e) => {
        e.dataTransfer.setData(DRAG_TYPE, q.id)
        e.dataTransfer.effectAllowed = 'move'
      }}
      onClick={q.pipeline ? () => openPipeline(q) : onOpen}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => e.key === 'Enter' && (q.pipeline ? openPipeline(q) : onOpen())}
      title={`${q.method} ${q.path}`}
    >
      {q.pipeline ? (
        <span className="lib-method mono lib-agg" title="Aggregation pipeline">
          ∑
        </span>
      ) : (
        <span className={`lib-method mono m-${q.method.toLowerCase()}`}>{q.method}</span>
      )}
      <span className="lib-text">
        <span className="lib-name">{q.title || q.path}</span>
        <span className="lib-meta mono">
          {target && !target.startsWith('_') ? `${target} · ` : ''}
          {q.lastRunAt ? relTime(q.lastRunAt) : relTime(q.updatedAt).replace(/^/, 'edited ')}
          {q.tags.length > 0 && ` · ${q.tags.map((t) => `#${t}`).join(' ')}`}
        </span>
      </span>
      <span className="lib-actions" onClick={(e) => e.stopPropagation()}>
        <button className={`icon-btn xs${q.pinned ? ' pinned' : ''}`} aria-label={q.pinned ? 'Unpin' : 'Pin'} title={q.pinned ? 'Unpin' : 'Pin'} onClick={() => patchQuery(q.id, { pinned: !q.pinned })}>
          {Icon.star(12, q.pinned)}
        </button>
        <Menu
          label={`Query ${q.title || q.path} actions`}
          items={[
            ...(q.pipeline ? [{ label: 'Open in Aggregations', onSelect: () => openPipeline(q) }] : []),
            { label: 'Open in workspace', onSelect: onOpen },
            ...folders.filter((f) => f.id !== q.folderId).slice(0, 12).map((f) => ({ label: `Move to ${f.name}`, onSelect: () => onMove(f.id) })),
            ...(q.folderId ? [{ label: 'Remove from folder', onSelect: () => onMove(null) }] : []),
            'sep' as const,
            {
              label: 'Delete query',
              danger: true,
              onSelect: async () => {
                if (!confirm(`Delete "${q.title || q.path}" from the library?`)) return
                await api.library.removeQuery(q.id)
                bumpLibrary()
                const tab = useWorkspace.getState().activeTab
                if (tab) void loadBlocks(tab)
                useApp.getState().showToast('Query deleted')
              }
            }
          ]}
        >
          ⋯
        </Menu>
      </span>
    </div>
  )
}

interface TreeNode {
  folder: Folder
  children: TreeNode[]
  queries: Query[]
  count: number
}

function buildTree(folders: Folder[], queries: Query[]): { roots: TreeNode[]; unsaved: Query[] } {
  const nodes = new Map<string, TreeNode>(folders.map((f) => [f.id, { folder: f, children: [], queries: [], count: 0 }]))
  const roots: TreeNode[] = []
  for (const n of nodes.values()) {
    const parent = n.folder.parentId ? nodes.get(n.folder.parentId) : undefined
    if (parent) parent.children.push(n)
    else roots.push(n)
  }
  const unsaved: Query[] = []
  for (const q of queries) {
    const n = q.folderId ? nodes.get(q.folderId) : undefined
    if (n) n.queries.push(q)
    else unsaved.push(q)
  }
  const count = (n: TreeNode): number => (n.count = n.queries.length + n.children.reduce((s, c) => s + count(c), 0))
  roots.forEach(count)
  return { roots, unsaved }
}
