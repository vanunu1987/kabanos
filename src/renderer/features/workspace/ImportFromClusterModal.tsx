import { useQuery } from '@tanstack/react-query'
import { useMemo, useState } from 'react'
import type { Folder, Query } from '@shared/library'
import type { ConnectionConfig } from '@shared/types'
import { api } from '../../api'
import { Modal } from '../../components/Modal'
import { COLORS, useApp } from '../../store'

/**
 * Copy saved queries from another cluster into this one — the only way a query crosses clusters, so running
 * a dev query on prod is always a deliberate choice. Copies keep their folder path; the originals stay put.
 */
export function ImportFromClusterModal({ target, onClose, onDone }: { target: ConnectionConfig; onClose(): void; onDone(): void }) {
  // Select the stable array and filter in a memo — a selector returning a new array re-renders forever.
  const connections = useApp((s) => s.connections)
  const others = useMemo(() => connections.filter((c) => c.id !== target.id), [connections, target.id])
  const [source, setSource] = useState(others[0]?.id ?? '')
  const [picked, setPicked] = useState<Set<string>>(new Set())
  const [filter, setFilter] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()
  const folders = useQuery({ queryKey: ['import-folders', source], queryFn: () => api.library.folders(source), enabled: !!source })
  const queries = useQuery({ queryKey: ['import-queries', source], queryFn: () => api.library.queries(source, { kind: 'all' }), enabled: !!source })

  // Saved queries only (in a folder or pinned): unsaved scratch blocks aren't worth copying.
  const groups = useMemo(() => {
    const path = folderPaths(folders.data ?? [])
    const t = filter.trim().toLowerCase()
    const list = (queries.data ?? []).filter((q) => (q.folderId || q.pinned) && (!t || `${q.title} ${q.path} ${q.tags.join(' ')}`.toLowerCase().includes(t)))
    const byFolder = new Map<string, Query[]>()
    for (const q of list) {
      const key = q.folderId ? (path.get(q.folderId) ?? 'Folder') : 'Pinned'
      byFolder.set(key, [...(byFolder.get(key) ?? []), q])
    }
    return [...byFolder.entries()].sort(([a], [b]) => a.localeCompare(b))
  }, [folders.data, queries.data, filter])

  const toggle = (ids: string[], on: boolean) =>
    setPicked((p) => {
      const n = new Set(p)
      for (const id of ids) {
        if (on) n.add(id)
        else n.delete(id)
      }
      return n
    })
  const sourceConn = others.find((c) => c.id === source)

  const run = async () => {
    setBusy(true)
    setError(undefined)
    try {
      const { imported } = await api.library.importQueries(target.id, [...picked])
      useApp.getState().showToast(`Copied ${imported} quer${imported === 1 ? 'y' : 'ies'} from ${sourceConn?.name} into ${target.name}`)
      onDone()
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal
      title={`Import queries into ${target.name}`}
      width={640}
      onClose={onClose}
      actions={
        <>
          {error && <span className="hint error left">{error}</span>}
          <button className="btn md" onClick={onClose}>
            Cancel
          </button>
          <button className={`btn md ${target.isProd ? 'danger-fill' : 'primary'}`} disabled={!picked.size || busy} onClick={run}>
            {busy ? 'Copying…' : `Copy ${picked.size || ''} into ${target.name}`}
          </button>
        </>
      }
    >
      <p className="hint" style={{ margin: 0 }}>
        Queries belong to one cluster and only run there. Copying makes an independent copy in <b>{target.name}</b> — the originals in the other cluster don’t change.
      </p>
      {target.isProd && (
        <div className="reindex-note warn" role="alert">
          <b>⚠ {target.name} is a production cluster.</b> Imported queries will run against production. Writes still ask for confirmation.
        </div>
      )}
      {others.length === 0 ? (
        <div className="empty">There are no other saved connections to import from.</div>
      ) : (
        <>
          <div className="row" style={{ display: 'flex', gap: 10 }}>
            <label className="field" style={{ flex: 1 }}>
              <span className="field-label">From cluster</span>
              <select className="select" value={source} onChange={(e) => (setSource(e.target.value), setPicked(new Set()))} aria-label="Source cluster">
                {others.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                    {c.isProd ? ' (prod)' : ''}
                  </option>
                ))}
              </select>
            </label>
            <label className="field" style={{ flex: 1 }}>
              <span className="field-label">Filter</span>
              <input className="input" value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="name, path or #tag" aria-label="Filter queries" />
            </label>
          </div>
          <div className="import-list" role="group" aria-label="Queries to import">
            {sourceConn && (
              <div className="hint import-from">
                <span className="dot" style={{ background: COLORS[sourceConn.color] }} /> {sourceConn.name}
              </div>
            )}
            {groups.map(([folder, list]) => {
              const all = list.every((q) => picked.has(q.id))
              return (
                <div key={folder} className="import-group">
                  <label className="check import-folder">
                    <input type="checkbox" checked={all} onChange={(e) => toggle(list.map((q) => q.id), e.target.checked)} /> <b>{folder}</b> <span className="hint">· {list.length}</span>
                  </label>
                  {list.map((q) => (
                    <label key={q.id} className="check import-row">
                      <input type="checkbox" checked={picked.has(q.id)} onChange={(e) => toggle([q.id], e.target.checked)} aria-label={`Import ${q.title || q.path}`} />
                      <span className={`lib-method mono ${q.pipeline ? 'lib-agg' : `m-${q.method.toLowerCase()}`}`}>{q.pipeline ? '∑' : q.method}</span>
                      <span className="import-title">{q.title || q.path}</span>
                      <span className="hint mono import-path">{q.path}</span>
                    </label>
                  ))}
                </div>
              )
            })}
            {!groups.length && <div className="empty">{queries.isLoading ? 'Loading…' : 'No saved queries in that cluster.'}</div>}
          </div>
        </>
      )}
    </Modal>
  )
}

function folderPaths(folders: Folder[]): Map<string, string> {
  const byId = new Map(folders.map((f) => [f.id, f]))
  const path = (f: Folder): string => (f.parentId && byId.has(f.parentId) ? `${path(byId.get(f.parentId)!)} / ${f.name}` : f.name)
  return new Map(folders.map((f) => [f.id, path(f)]))
}
