import { useQuery } from '@tanstack/react-query'
import { useMemo, useState } from 'react'
import { formatBytes } from '@shared/meta'
import { api } from '../../api'
import { CodeEditor } from '../../components/CodeEditor'
import { relTime } from '../../components/time'
import type { Hit } from '../indexView/DocumentCards'
import { StatusBadge } from '../indexView/IndexView'
import { ResultsTable } from '../indexView/ResultsTable'
import { ExportModal } from '../../components/ExportModal'
import { parseBlock, blockText } from '@shared/consoleParser'
import { useApp } from '../../store'
import { useWorkspace } from './store'

const STATUS_TEXT: Record<number, string> = { 200: 'OK', 201: 'Created', 400: 'Bad Request', 401: 'Unauthorized', 403: 'Forbidden', 404: 'Not Found', 409: 'Conflict', 429: 'Too Many Requests', 500: 'Server Error', 503: 'Unavailable' }

/** Response for the active block, with its previous responses (last 5 kept per saved query). */
export function ResponsePane({ width }: { width?: number }) {
  const activeId = useWorkspace((s) => s.activeBlock)
  const run = useWorkspace((s) => (activeId ? s.runs[activeId] : undefined))
  const [view, setView] = useState<'json' | 'table'>('json')
  const [pick, setPick] = useState<number | 'live'>('live')
  const [exporting, setExporting] = useState(false)
  const conn = useApp((st) => st.connections.find((c) => c.id === st.activeTab))
  const tab = useWorkspace((st) => st.tabs.find((t) => t.id === st.activeTab))
  const draft = useWorkspace((st) => (activeId ? st.drafts[activeId] : undefined))
  const blockQuery = useWorkspace((st) => (activeId ? Object.values(st.blocks).flat().find((b) => b.queryId === activeId)?.query : undefined))
  const resolvedPath = run?.response?.resolvedPath
  // Export is offered for search responses: target = the index part of the request path.
  const exportSource = useMemo(() => {
    const parsed = parseBlock(draft ?? (blockQuery ? blockText(blockQuery) : ''))
    const path = resolvedPath ?? parsed?.path ?? ''
    const target = path.split(/[/?]/)[0] ?? ''
    return target && !target.startsWith('_') && /_search/.test(path) ? { target: decodeURIComponent(target), body: parsed?.body } : undefined
  }, [draft, blockQuery, resolvedPath])

  const previous = useQuery({ queryKey: ['responses', activeId, run?.response?.opaqueId], queryFn: () => api.library.responses(activeId!), enabled: !!activeId })

  const shown = pick === 'live' && run?.response ? { body: run.response.body, status: run.response.status, ms: run.response.ms, bytes: run.response.bytes, at: undefined as string | undefined } : (() => {
    const h = pick === 'live' ? previous.data?.[0] : previous.data?.find((p) => p.id === pick)
    return h ? { body: h.response ?? '', status: h.status ?? 0, ms: h.ms ?? 0, bytes: h.bytes ?? 0, at: h.at } : undefined
  })()

  const pretty = useMemo(() => {
    if (!shown) return ''
    try {
      return JSON.stringify(JSON.parse(shown.body), null, 2)
    } catch {
      return shown.body
    }
  }, [shown?.body])
  const hits = useMemo(() => {
    try {
      return (JSON.parse(shown?.body ?? '') as { hits?: { hits?: Hit[] } }).hits?.hits
    } catch {
      return undefined
    }
  }, [shown?.body])

  if (!activeId) return <section className="response-pane" style={{ width }}><div className="empty">Select a request block</div></section>

  return (
    <section className="response-pane" style={{ width }}>
      <div className="pane-head">
        <span className="pane-title">Response</span>
        {run?.running ? (
          <span className="hint">
            <span className="spin inline" /> Running…
          </span>
        ) : shown ? (
          <>
            <StatusBadge status={shown.status} />
            <span className="hint mono" style={{ whiteSpace: 'nowrap' }}>
              {STATUS_TEXT[shown.status] ?? ''} · {shown.ms} ms · {formatBytes(shown.bytes)}
              {shown.at && ` · ${relTime(shown.at)}`}
            </span>
          </>
        ) : null}
        <div className="spacer" />
        {hits && (
          <div role="group" aria-label="Response view" className="segmented sm">
            <button className={view === 'json' ? 'on' : ''} onClick={() => setView('json')}>
              JSON
            </button>
            <button className={view === 'table' ? 'on' : ''} onClick={() => setView('table')}>
              Table
            </button>
          </div>
        )}
        {hits && conn && exportSource && (
          <button className="link-btn" onClick={() => setExporting(true)} title="Export this page or every matching document">
            Export…
          </button>
        )}
        {shown && (
          <button className="link-btn" onClick={() => navigator.clipboard.writeText(pretty)}>
            Copy
          </button>
        )}
      </div>
      {(previous.data?.length ?? 0) > 0 && (
        <div className="prev-bar">
          <span className="hint">Previous</span>
          <select className="select xs" value={String(pick)} onChange={(e) => setPick(e.target.value === 'live' ? 'live' : Number(e.target.value))} aria-label="Previous responses">
            <option value="live">Latest</option>
            {previous.data!.map((p) => (
              <option key={p.id} value={p.id}>
                {p.status} · {relTime(p.at)} · {p.ms} ms
              </option>
            ))}
          </select>
        </div>
      )}
      {exporting && conn && exportSource && <ExportModal conn={conn} target={exportSource.target} body={exportSource.body} envId={tab?.envId} pageHits={hits} onClose={() => setExporting(false)} />}
      <div className="response-body">
        {run?.error && pick === 'live' ? (
          <div className="error-box">{run.error}</div>
        ) : !shown ? (
          <div className="empty">Run the request (⌘↵ or ▶) to see the response here.</div>
        ) : view === 'table' && hits ? (
          <div style={{ padding: 10, height: '100%' }}>
            <ResultsTable hits={hits} />
          </div>
        ) : (
          <CodeEditor value={pretty} readOnly language="json" path={`response://${activeId}`} options={{ lineNumbers: 'off', folding: true, renderLineHighlight: 'none' }} />
        )}
      </div>
    </section>
  )
}
