import { useState } from 'react'
import type { ConnectionConfig } from '@shared/types'
import { api, KabanosError } from '../../api'
import { CodeEditor, JsonDiff } from '../../components/CodeEditor'
import { Modal } from '../../components/Modal'
import { useApp } from '../../store'
import { reason } from '../explorer/indexActions'
import type { Hit } from './DocumentCards'

/**
 * Edit (PUT with optimistic concurrency), clone (POST as a new doc) or create a document.
 * Shows a diff preview before saving an edit.
 */
export function EditDocModal({ conn, hit, mode, index, onClose, onSaved }: { conn: ConnectionConfig; hit?: Hit; mode: 'edit' | 'clone'; index: string; onClose(): void; onSaved(): void }) {
  const original = JSON.stringify(hit?._source ?? {}, null, 2)
  const [text, setText] = useState(original)
  const [step, setStep] = useState<'edit' | 'diff'>('edit')
  const [error, setError] = useState<string>()
  const [busy, setBusy] = useState(false)

  const targetIndex = hit?._index ?? index
  const parsed = (() => {
    try {
      return { ok: true as const, value: JSON.parse(text) as unknown }
    } catch (e) {
      return { ok: false as const, error: (e as Error).message }
    }
  })()

  const save = async () => {
    if (!parsed.ok) return
    setBusy(true)
    setError(undefined)
    try {
      const concurrency = hit && hit._seq_no !== undefined && hit._primary_term !== undefined ? `&if_seq_no=${hit._seq_no}&if_primary_term=${hit._primary_term}` : ''
      const path =
        mode === 'edit' && hit
          ? `${encodeURIComponent(targetIndex)}/_doc/${encodeURIComponent(hit._id)}?refresh=wait_for${concurrency}`
          : `${encodeURIComponent(targetIndex)}/_doc?refresh=wait_for`
      const res = await api.cluster.request({ connectionId: conn.id, method: mode === 'edit' ? 'PUT' : 'POST', path, body: JSON.stringify(parsed.value) })
      if (res.status === 409) setError('The document changed since it was loaded (version conflict). Re-run the query and edit again.')
      else if (res.status >= 400) setError(reason(res.body))
      else {
        const id = (JSON.parse(res.body) as { _id?: string })._id
        useApp.getState().showToast(mode === 'edit' ? `Saved ${hit?._id}` : `Created ${id}`)
        onSaved()
        onClose()
      }
    } catch (e) {
      if (!(e instanceof KabanosError && e.code === 'NOT_CONFIRMED')) setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const changed = text !== original
  return (
    <Modal
      title={mode === 'edit' ? `Edit ${hit?._id} · ${targetIndex}` : `New document in ${targetIndex}`}
      onClose={onClose}
      width={760}
      actions={
        <>
          {error && <span className="hint error left">{error}</span>}
          {!parsed.ok && <span className="hint error left">Invalid JSON: {parsed.error}</span>}
          <button className="btn md" onClick={step === 'diff' ? () => setStep('edit') : onClose}>
            {step === 'diff' ? 'Back' : 'Cancel'}
          </button>
          {mode === 'edit' && step === 'edit' ? (
            <button className="btn md primary" disabled={!parsed.ok || !changed} onClick={() => setStep('diff')}>
              Review changes
            </button>
          ) : (
            <button className="btn md primary" disabled={!parsed.ok || busy} onClick={save}>
              {mode === 'edit' ? 'Save document' : 'Create document'}
            </button>
          )}
        </>
      }
    >
      <div className="editor-box" style={{ height: 420 }}>
        {step === 'edit' ? <CodeEditor value={text} onChange={setText} path={`doc://${conn.id}/${targetIndex}/${hit?._id ?? 'new'}`} onRun={() => (mode === 'edit' ? changed && parsed.ok && setStep('diff') : save())} /> : <JsonDiff original={original} modified={JSON.stringify(parsed.ok ? parsed.value : {}, null, 2)} />}
      </div>
      {mode === 'edit' && <span className="hint">Saved with PUT and if_seq_no / if_primary_term, so concurrent changes are never overwritten.</span>}
    </Modal>
  )
}
