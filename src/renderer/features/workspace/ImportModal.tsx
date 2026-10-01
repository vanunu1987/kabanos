import { useMemo, useState } from 'react'
import { parseConsole, parseCurl, type ParsedRequest } from '@shared/consoleParser'
import { Modal } from '../../components/Modal'
import { useApp } from '../../store'
import { useWorkspace } from './store'

/** Paste a Kibana console export (or a cURL command) → one block per request, titles from `###` comments. */
export function ImportModal({ onClose }: { onClose(): void }) {
  const [text, setText] = useState('')
  const result = useMemo((): { reqs: ParsedRequest[]; note?: string } => {
    const t = text.trim()
    if (!t) return { reqs: [] }
    if (/^curl\s/.test(t)) {
      const c = parseCurl(t)
      return c ? { reqs: [c], note: c.hasCredentials ? 'The cURL command contained credentials — they were dropped. The active connection is used instead.' : undefined } : { reqs: [], note: 'Could not parse that cURL command.' }
    }
    return { reqs: parseConsole(t) }
  }, [text])

  const doImport = async () => {
    const n = await useWorkspace.getState().importRequests(result.reqs)
    useApp.getState().showToast(`Imported ${n} request${n === 1 ? '' : 's'}`)
    onClose()
  }

  return (
    <Modal
      title="Import requests"
      width={720}
      onClose={onClose}
      actions={
        <>
          {result.note && <span className="hint left">{result.note}</span>}
          <button className="btn md" onClick={onClose}>
            Cancel
          </button>
          <button className="btn md primary" disabled={result.reqs.length === 0} onClick={doImport}>
            Import {result.reqs.length || ''} request{result.reqs.length === 1 ? '' : 's'}
          </button>
        </>
      }
    >
      <span>Paste Kibana Dev Tools console text (export or copy) or a cURL command. Comment lines above a request become its name.</span>
      <textarea
        className="input mono import-area"
        autoFocus
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder={'# Cluster health\nGET _cluster/health\n\n### Top cities\nPOST listings/_search\n{ "size": 0 }'}
        spellCheck={false}
        aria-label="Console text"
      />
      {result.reqs.length > 0 && (
        <div className="import-preview">
          {result.reqs.slice(0, 50).map((r, i) => (
            <div key={i} className="inline-row">
              <span className={`mono m-${r.method.toLowerCase()}`} style={{ width: 52 }}>
                {r.method}
              </span>
              <span className="mono">{r.path}</span>
              {r.title && <span className="hint">— {r.title}</span>}
            </div>
          ))}
          {result.reqs.length > 50 && <span className="hint">…and {result.reqs.length - 50} more</span>}
        </div>
      )}
    </Modal>
  )
}
