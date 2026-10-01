import { useQuery } from '@tanstack/react-query'
import { useEffect, useState } from 'react'
import { FORMAT_LABEL, type ExportFormat, type ExportProgress } from '@shared/export'
import type { ConnectionConfig } from '@shared/types'
import { api, KabanosError } from '../api'
import { useApp } from '../store'
import { Modal } from './Modal'

export interface ExportHit {
  _id: string
  _index: string
  _source?: Record<string, unknown>
}

/**
 * Export documents: the current results page, every document matching a query, or a whole index.
 * Full exports stream from the cluster to disk in main (scroll API) with live progress and cancel.
 */
export function ExportModal({ conn, target, body, envId, pageHits, definition, onClose }: { conn: ConnectionConfig; target: string; body?: string; envId?: string; pageHits?: ExportHit[]; definition?: boolean; onClose(): void }) {
  const queryBody = body?.trim() ? body : undefined
  const [scope, setScope] = useState<'page' | 'all'>(pageHits?.length ? 'page' : 'all')
  const [format, setFormat] = useState<ExportFormat>('ndjson')
  const [includeMeta, setIncludeMeta] = useState(true)
  const [limit, setLimit] = useState('')
  const [withDefinition, setWithDefinition] = useState(false)
  const [progress, setProgress] = useState<ExportProgress | null>(null)
  const [exportId, setExportId] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  // How many documents "all" means (count API with the same query).
  const count = useQuery({
    queryKey: ['export-count', conn.id, target, queryBody],
    queryFn: async () => {
      let q: unknown
      try {
        q = queryBody ? (JSON.parse(queryBody) as { query?: unknown }).query : undefined
      } catch {
        q = undefined
      }
      const res = await api.cluster.request({ connectionId: conn.id, method: 'POST', path: `${encodeURIComponent(target)}/_count`, body: q ? JSON.stringify({ query: q }) : undefined })
      return res.status < 400 ? (JSON.parse(res.body) as { count: number }).count : undefined
    },
    retry: false
  })

  useEffect(() => {
    if (!exportId) return
    return window.kabanosIpc.onExportProgress((p) => p.exportId === exportId && setProgress(p))
  }, [exportId])

  const done = (n: number, path: string, extra = '') => {
    useApp.getState().showToast(`Exported ${n.toLocaleString()} document${n === 1 ? '' : 's'} to ${path.split('/').pop()}${extra}`)
    onClose()
  }

  const run = async () => {
    setError(null)
    try {
      if (scope === 'page') {
        const res = await api.export.writeHits({ target, hits: pageHits!, format, includeMeta })
        if (res) done(res.count, res.path)
        return
      }
      const id = `exp-${crypto.randomUUID()}`
      setExportId(id)
      setProgress({ exportId: id, count: 0 })
      const res = await api.export.toFile({
        connectionId: conn.id,
        target,
        body: queryBody,
        envId,
        format,
        includeMeta,
        limit: limit ? Number(limit) : undefined,
        withDefinition: definition && withDefinition,
        exportId: id
      })
      setExportId(null)
      if (!res) return setProgress(null)
      if (res.cancelled) {
        useApp.getState().showToast(`Export cancelled after ${res.count.toLocaleString()} documents (partial file kept)`)
        return onClose()
      }
      done(res.count, res.path, res.definitionPath ? ' (+ mapping & settings)' : '')
    } catch (e) {
      setExportId(null)
      setProgress(null)
      if (!(e instanceof KabanosError && e.code === 'CANCELLED')) setError((e as Error).message)
    }
  }

  const running = !!exportId
  const pct = progress?.total ? Math.round((progress.count / progress.total) * 100) : undefined
  const allCount = count.data !== undefined ? count.data.toLocaleString() : '…'

  return (
    <Modal
      title={queryBody ? `Export results · ${target}` : `Export ${target}`}
      width={560}
      onClose={() => !running && onClose()}
      actions={
        <>
          {error && <span className="hint error left">{error}</span>}
          {running ? (
            <button className="btn md danger" onClick={() => exportId && api.export.cancel(exportId)}>
              Cancel export
            </button>
          ) : (
            <>
              <button className="btn md" onClick={onClose}>
                Cancel
              </button>
              <button className="btn md primary" onClick={run}>
                Export…
              </button>
            </>
          )}
        </>
      }
    >
      {pageHits?.length ? (
        <div role="radiogroup" aria-label="What to export" className="export-scope">
          <label className={`scope-opt${scope === 'page' ? ' on' : ''}`}>
            <input type="radio" name="scope" checked={scope === 'page'} onChange={() => setScope('page')} disabled={running} />
            <span>
              <b>This page</b>
              <span className="hint">{pageHits.length.toLocaleString()} documents shown in the results</span>
            </span>
          </label>
          <label className={`scope-opt${scope === 'all' ? ' on' : ''}`}>
            <input type="radio" name="scope" checked={scope === 'all'} onChange={() => setScope('all')} disabled={running} />
            <span>
              <b>All matching documents</b>
              <span className="hint">{allCount} documents · streamed from the cluster</span>
            </span>
          </label>
        </div>
      ) : (
        <span>
          {queryBody ? 'Every document matching the query' : 'Every document in the index'} — <b>{allCount}</b> documents, streamed straight from the cluster to disk.
        </span>
      )}
      <div className="field">
        <label>Format</label>
        <div role="group" aria-label="Export format" className="segmented">
          {(['ndjson', 'json', 'csv'] as const).map((f) => (
            <button key={f} className={format === f ? 'on' : ''} onClick={() => setFormat(f)} disabled={running}>
              {f.toUpperCase()}
            </button>
          ))}
        </div>
        <span className="hint">{FORMAT_LABEL[format]}</span>
      </div>
      <label className="check">
        <input type="checkbox" checked={includeMeta} onChange={(e) => setIncludeMeta(e.target.checked)} disabled={running} />
        Include <span className="mono">_id</span> and <span className="mono">_index</span>
      </label>
      {scope === 'all' && (
        <div className="field">
          <label htmlFor="exp-limit">Limit (optional)</label>
          <input id="exp-limit" className="input sm mono" style={{ width: 160 }} value={limit} onChange={(e) => setLimit(e.target.value.replace(/\D/g, ''))} placeholder="all" disabled={running} />
        </div>
      )}
      {definition && scope === 'all' && (
        <label className="check">
          <input type="checkbox" checked={withDefinition} onChange={(e) => setWithDefinition(e.target.checked)} disabled={running} />
          <span>
            Also save mapping, settings &amp; aliases <span className="sub">— as &lt;file&gt;.definition.json, to recreate the index elsewhere</span>
          </span>
        </label>
      )}
      {progress && (
        <div className="empty-progress">
          <div className="progress det export">
            <span style={{ width: pct !== undefined ? `${pct}%` : '5%' }} />
          </div>
          <span className="hint mono" aria-live="polite">
            {progress.count.toLocaleString()}
            {progress.total !== undefined ? ` / ${progress.total.toLocaleString()}` : ''} documents written{pct !== undefined ? ` · ${pct}%` : ''}
          </span>
        </div>
      )}
    </Modal>
  )
}
