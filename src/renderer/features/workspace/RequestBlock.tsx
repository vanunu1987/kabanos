import { useState } from 'react'
import { blockText, parseBlock, resolvePath, toCurl } from '@shared/consoleParser'
import type { Block, Query } from '@shared/library'
import type { ConnectionConfig } from '@shared/types'
import type { ConsoleContext } from '../../autocomplete/consoleCompletion'
import { Menu } from '../../components/Menu'
import { relTime } from '../../components/time'
import { Icon } from '../../shell/icons'
import { useApp } from '../../store'
import { ConsoleEditor } from './ConsoleEditor'
import { DRAG_TYPE } from './LibrarySidebar'
import { SaveQueryModal } from './SaveQueryModal'
import { useWorkspace } from './store'

/** A request block: one-line header when collapsed, Monaco console editor when expanded (SPEC §6). */
export function RequestBlock({ block, conn, defaultTarget, context, autoFocus }: { block: Block & { query: Query }; conn?: ConnectionConfig; defaultTarget?: string; context: ConsoleContext; autoFocus?: boolean }) {
  const q = block.query
  const draft = useWorkspace((s) => s.drafts[q.id])
  const run = useWorkspace((s) => s.runs[q.id])
  const active = useWorkspace((s) => s.activeBlock === q.id)
  const selected = useWorkspace((s) => s.selected.has(q.id))
  const ws = useWorkspace.getState()
  const [editingTitle, setEditingTitle] = useState(false)
  const [saving, setSaving] = useState(false)

  const text = draft ?? blockText(q)
  const parsed = parseBlock(text)
  const lines = text.split('\n').length
  const shownPath = parsed ? resolvePath(parsed.path, defaultTarget) : q.path
  const inherited = parsed && shownPath !== parsed.path
  const status = run?.response?.status ?? q.lastStatus

  const copyCurl = () => {
    if (!parsed || !conn) return
    const auth = conn.authKind === 'apikey' || (conn.authKind === 'cloudid' && conn.hasApiKey) ? 'apikey' : conn.username ? 'basic' : undefined
    void navigator.clipboard.writeText(toCurl(conn.url, parsed.method, shownPath, parsed.body, { auth, username: conn.username }))
    useApp.getState().showToast('Copied as cURL (credentials not included)')
  }

  // The one-click trash button: saved or pinned queries stay in the library, so close at once;
  // anything else is gone for good, so ask first. (The ⋯ menu's “Delete block” is already explicit.)
  const keptInLibrary = q.folderId !== null || q.pinned
  const remove = () => {
    if (!keptInLibrary && !confirm(`Delete “${q.title || parsed?.path || 'this request'}”? It isn’t saved in the library.`)) return
    void ws.removeBlock(q.id)
  }

  return (
    <div id={`block-${q.id}`} data-text={text} className={`block${active ? ' active' : ''}${block.collapsed ? ' collapsed' : ''}`} onMouseDown={() => !active && ws.setActive(q.id)}>
      <div
        className="block-head"
        draggable
        onDragStart={(e) => {
          e.dataTransfer.setData(DRAG_TYPE, q.id)
          e.dataTransfer.effectAllowed = 'move'
        }}
        onClick={(e) => {
          if ((e.target as HTMLElement).closest('button, input, .menu-wrap')) return
          void ws.setCollapsed([q.id], !block.collapsed)
        }}
      >
        <input type="checkbox" className="block-check" checked={selected} onChange={() => ws.toggleSelected(q.id)} aria-label="Select for sequential run" title="Select to run in sequence" />
        <span className={`block-method mono m-${(parsed?.method ?? q.method).toLowerCase()}`}>{parsed?.method ?? q.method}</span>
        {editingTitle ? (
          <input
            className="inline-input title"
            autoFocus
            defaultValue={q.title}
            placeholder="Name this request"
            onBlur={(e) => {
              void ws.patchQuery(q.id, { title: e.target.value.trim() })
              setEditingTitle(false)
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
              if (e.key === 'Escape') setEditingTitle(false)
            }}
          />
        ) : (
          <button className={`block-title${q.title ? '' : ' untitled'}`} onDoubleClick={() => setEditingTitle(true)} onClick={() => !block.collapsed && setEditingTitle(true)} title="Click to rename">
            {q.title || 'Untitled request'}
          </button>
        )}
        {q.tags.map((t) => (
          <span key={t} className="pill tiny">
            #{t}
          </span>
        ))}
        {q.folderId === null && <span className="pill tiny unsaved" title="Not in a library folder yet — drag it onto a folder or use Save to folder">unsaved</span>}
        <span className="block-path mono" title={shownPath}>
          {block.collapsed || inherited ? shownPath : ''}
          {inherited && !block.collapsed && <span className="faint"> (default target)</span>}
        </span>
        <span className="block-meta">
          {lines} line{lines === 1 ? '' : 's'} · {run?.running ? 'running…' : status ? <span className={status < 400 ? 'ok' : 'bad'}>{status}</span> : run?.error ? <span className="bad">error</span> : 'never run'}
          {!run?.running && q.lastRunAt && ` · ${relTime(q.lastRunAt)}`}
        </span>
        <span className="block-actions">
          {run?.running ? (
            <button className="icon-btn xs run" aria-label="Cancel request" title="Cancel" onClick={() => ws.cancel(q.id)}>
              ■
            </button>
          ) : (
            <button className="icon-btn xs run" aria-label="Run this request" title="Run (⌘↵)" onClick={() => ws.run(q.id)}>
              ▶
            </button>
          )}
          <button className={`icon-btn xs${q.pinned ? ' pinned' : ''}`} aria-label={q.pinned ? 'Unpin' : 'Pin'} onClick={() => ws.patchQuery(q.id, { pinned: !q.pinned })}>
            {Icon.star(12, q.pinned)}
          </button>
          <Menu
            label="Block actions"
            items={[
              { label: q.folderId ? 'Rename / move / tags…' : 'Save to folder…', onSelect: () => setSaving(true) },
              { label: 'Rename', onSelect: () => setEditingTitle(true) },
              { label: 'Duplicate', onSelect: () => parsed && ws.newBlock({ ...parsed, title: q.title ? `${q.title} (copy)` : '' }, q.id) },
              { label: 'Copy as cURL', onSelect: copyCurl, disabled: !parsed || !conn },
              { label: 'Move up', onSelect: () => ws.move(q.id, -1) },
              { label: 'Move down', onSelect: () => ws.move(q.id, 1) },
              'sep',
              { label: q.folderId ? 'Close (stays in library)' : 'Delete block', danger: !q.folderId, onSelect: () => void ws.removeBlock(q.id) }
            ]}
          >
            ⋯
          </Menu>
          <button
            className="icon-btn xs block-delete"
            aria-label={keptInLibrary ? `Close ${q.title || 'request'} (stays in library)` : `Delete ${q.title || 'request'}`}
            title={keptInLibrary ? 'Close — stays in the library' : 'Delete block'}
            onClick={remove}
          >
            {Icon.trash()}
          </button>
        </span>
      </div>
      {!block.collapsed && (
        <ConsoleEditor id={q.id} value={text} onChange={(v) => ws.editText(q.id, v)} onRun={() => ws.run(q.id)} onFocus={() => ws.setActive(q.id)} context={context} autoFocus={autoFocus} />
      )}
      {!block.collapsed && !parsed && <div className="block-error">First line must be a request line, e.g. <span className="mono">GET _cluster/health</span></div>}
      {saving && (
        <SaveQueryModal
          initial={{ title: q.title || (parsed ? `${parsed.method} ${parsed.path}` : ''), folderId: q.folderId, tags: q.tags }}
          onClose={() => setSaving(false)}
          onSave={async (v) => {
            await ws.patchQuery(q.id, v)
            setSaving(false)
            useApp.getState().showToast(`Saved “${v.title}” to the library`)
          }}
        />
      )}
    </div>
  )
}
