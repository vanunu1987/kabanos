import { useQuery } from '@tanstack/react-query'
import { useEffect, useMemo, useRef, useState } from 'react'
import { api } from '../api'
import { queryClient } from '../queries'
import { useApp, type View } from '../store'
import { useRoutines } from '../features/routines/store'
import { useWorkspace } from '../features/workspace/store'
import type { ClusterTree } from '@shared/meta'

interface Item {
  id: string
  label: string
  kind: 'connection' | 'index' | 'alias' | 'datastream' | 'template' | 'query' | 'routine' | 'screen'
  hint?: string
  run(): void
}

/** Subsequence match with a score that favours prefix and word-start hits. */
export function fuzzyScore(text: string, q: string): number {
  if (!q) return 1
  const t = text.toLowerCase()
  const s = q.toLowerCase()
  const idx = t.indexOf(s)
  if (idx === 0) return 1000 - t.length
  if (idx > 0) return 500 - idx - t.length / 10
  let ti = 0
  let score = 0
  for (const ch of s) {
    const at = t.indexOf(ch, ti)
    if (at === -1) return -1
    score += at === ti ? 3 : /[\s._\-/]/.test(t[at - 1] ?? '') ? 2 : 1
    ti = at + 1
  }
  return score
}

const SCREENS: Array<[View, string]> = [
  ['connections', 'Connections'],
  ['explorer', 'Explorer'],
  ['workspace', 'Query workspace'],
  ['routines', 'Routines'],
  ['security', 'Stack management'],
  ['settings', 'Settings']
]

/** ⌘K — jump to any connection, index, alias, template, saved query, routine or screen. */
export function CommandPalette({ onClose }: { onClose(): void }) {
  const [q, setQ] = useState('')
  const [sel, setSel] = useState(0)
  const listRef = useRef<HTMLDivElement>(null)
  const { connections, activeTab } = useApp()
  const app = useApp.getState()
  const queries = useQuery({ queryKey: ['palette-queries'], queryFn: () => api.library.queries({ kind: 'all' }) })
  const routines = useQuery({ queryKey: ['palette-routines'], queryFn: () => api.routines.list() })
  const tree = activeTab ? queryClient.getQueryData<ClusterTree>(['tree', activeTab]) : undefined

  const items = useMemo<Item[]>(() => {
    const out: Item[] = []
    const close = (fn: () => void) => () => (fn(), onClose())
    for (const c of connections)
      out.push({ id: `c:${c.id}`, kind: 'connection', label: c.name, hint: c.detected?.label ?? c.folder, run: close(() => (app.openTab(c.id), app.setView('explorer'))) })
    if (activeTab && tree) {
      for (const i of tree.indices.filter((x) => !x.hidden)) out.push({ id: `i:${i.name}`, kind: 'index', label: i.name, hint: 'index', run: close(() => (app.select(activeTab, { kind: 'index', name: i.name }), app.setView('explorer'))) })
      for (const a of tree.aliases) out.push({ id: `a:${a.name}`, kind: 'alias', label: a.name, hint: `alias → ${a.indices.map((x) => x.index).join(', ')}`, run: close(() => (app.select(activeTab, { kind: 'alias', name: a.name }), app.setView('explorer'))) })
      for (const d of tree.dataStreams.filter((x) => !x.hidden)) out.push({ id: `d:${d.name}`, kind: 'datastream', label: d.name, hint: 'data stream', run: close(() => (app.select(activeTab, { kind: 'datastream', name: d.name }), app.setView('explorer'))) })
      for (const t of tree.templates.filter((x) => !x.managed)) out.push({ id: `t:${t.name}`, kind: 'template', label: t.name, hint: `${t.kind} template`, run: close(() => (app.select(activeTab, { kind: 'template', name: t.name }), app.setView('explorer'))) })
    }
    for (const x of queries.data ?? [])
      if (x.folderId !== null || x.pinned)
        out.push({
          id: `q:${x.id}`,
          kind: 'query',
          label: x.title || x.path,
          hint: `${x.method} ${x.path}`,
          run: close(async () => {
            app.setView('workspace')
            const ws = useWorkspace.getState()
            if (!ws.activeTab) await ws.load()
            await ws.openQuery(x.id)
          })
        })
    for (const r of routines.data ?? []) out.push({ id: `r:${r.id}`, kind: 'routine', label: r.name, hint: `routine · ${r.steps.length} steps`, run: close(() => (app.setView('routines'), useRoutines.getState().select(r.id))) })
    for (const [view, label] of SCREENS) out.push({ id: `s:${view}`, kind: 'screen', label, hint: 'screen', run: close(() => app.setView(view)) })
    return out
  }, [connections, activeTab, tree, queries.data, routines.data, app, onClose])

  const results = useMemo(
    () =>
      items
        .map((it) => ({ it, s: Math.max(fuzzyScore(it.label, q), fuzzyScore(it.hint ?? '', q) - 50) }))
        .filter((x) => x.s >= 0)
        .sort((a, b) => b.s - a.s)
        .slice(0, 60)
        .map((x) => x.it),
    [items, q]
  )

  useEffect(() => setSel(0), [q])
  useEffect(() => {
    listRef.current?.querySelector(`[data-idx="${sel}"]`)?.scrollIntoView({ block: 'nearest' })
  }, [sel])

  return (
    <div className="modal-backdrop palette-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="palette" role="dialog" aria-label="Command palette">
        <input
          autoFocus
          className="palette-input"
          placeholder="Jump to connection, index, query, routine…"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          aria-label="Search everything"
          onKeyDown={(e) => {
            if (e.key === 'Escape') onClose()
            if (e.key === 'ArrowDown') (e.preventDefault(), setSel((s) => Math.min(results.length - 1, s + 1)))
            if (e.key === 'ArrowUp') (e.preventDefault(), setSel((s) => Math.max(0, s - 1)))
            if (e.key === 'Enter') results[sel]?.run()
          }}
        />
        <div className="palette-list" ref={listRef} role="listbox">
          {results.map((r, i) => (
            <div key={r.id} data-idx={i} role="option" aria-selected={i === sel} className={`palette-item${i === sel ? ' on' : ''}`} onMouseEnter={() => setSel(i)} onClick={() => r.run()}>
              <span className={`palette-kind k-${r.kind}`}>{r.kind === 'datastream' ? 'stream' : r.kind}</span>
              <span className="palette-label">{r.label}</span>
              {r.hint && <span className="palette-hint mono">{r.hint}</span>}
            </div>
          ))}
          {results.length === 0 && <div className="empty">Nothing matches “{q}”</div>}
        </div>
        <div className="palette-foot hint">↑↓ to move · ↵ to open · esc to close</div>
      </div>
    </div>
  )
}
