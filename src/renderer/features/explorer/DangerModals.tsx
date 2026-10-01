import { useEffect, useRef, useState } from 'react'
import type { ConnectionConfig, HttpMethod } from '@shared/types'
import { api, KabanosError } from '../../api'
import { Modal } from '../../components/Modal'
import { refreshConnection } from '../../queries'
import { useApp } from '../../store'
import { reason } from './indexActions'

/** Destructive action gated by typing the target's name (on top of main's production confirmation). */
function ConfirmByName({ title, name, conn, children, actionLabel, busy, onConfirm, onClose }: { title: string; name: string; conn: ConnectionConfig; children: React.ReactNode; actionLabel: string; busy: boolean; onConfirm(): void; onClose(): void }) {
  const [typed, setTyped] = useState('')
  return (
    <Modal
      title={title}
      onClose={onClose}
      actions={
        <>
          <button className="btn md" onClick={onClose}>
            Cancel
          </button>
          <button className="btn md danger-fill" disabled={typed !== name || busy} onClick={onConfirm}>
            {actionLabel}
          </button>
        </>
      }
    >
      <div style={{ margin: 0 }}>{children}</div>
      <p style={{ margin: 0 }}>
        On <b>{conn.name}</b>. Type <span className="mono ts">{name}</span> to confirm.
      </p>
      <input className="input mono" autoFocus value={typed} onChange={(e) => setTyped(e.target.value)} aria-label="Type the name to confirm" onKeyDown={(e) => e.key === 'Enter' && typed === name && !busy && onConfirm()} />
    </Modal>
  )
}

async function send(conn: ConnectionConfig, method: HttpMethod, path: string, body?: unknown) {
  return api.cluster.request({ connectionId: conn.id, method, path, body: body === undefined ? undefined : JSON.stringify(body) })
}

export function DeleteModal({ conn, name, kind, onClose, onDone }: { conn: ConnectionConfig; name: string; kind: 'index' | 'datastream'; onClose(): void; onDone(): void }) {
  const [busy, setBusy] = useState(false)
  const run = async () => {
    setBusy(true)
    try {
      const res = await send(conn, 'DELETE', kind === 'index' ? encodeURIComponent(name) : `_data_stream/${encodeURIComponent(name)}`)
      if (res.status >= 400) return useApp.getState().showToast(`Delete failed: ${reason(res.body)}`)
      useApp.getState().showToast(`Deleted ${name}`)
      await refreshConnection(conn.id)
      onDone()
    } catch (e) {
      if (!(e instanceof KabanosError && e.code === 'NOT_CONFIRMED')) useApp.getState().showToast((e as Error).message)
    } finally {
      setBusy(false)
    }
  }
  return (
    <ConfirmByName title={`Delete ${name}?`} name={name} conn={conn} actionLabel={kind === 'index' ? 'Delete index' : 'Delete data stream'} busy={busy} onConfirm={run} onClose={onClose}>
      This permanently deletes the {kind === 'index' ? 'index, its mapping and settings' : 'data stream and all its backing indices'}, and every document in it.
    </ConfirmByName>
  )
}

interface DbqTask {
  completed: boolean
  task?: { status?: { total?: number; deleted?: number; version_conflicts?: number } }
  response?: { deleted?: number; failures?: unknown[] }
  error?: { reason?: string }
}

/** Remove every document but keep the index (mapping, settings, aliases): _delete_by_query + match_all. */
export function EmptyModal({ conn, name, onClose, onDone }: { conn: ConnectionConfig; name: string; onClose(): void; onDone(): void }) {
  const [busy, setBusy] = useState(false)
  const [progress, setProgress] = useState<{ deleted: number; total?: number; taskId: string } | null>(null)
  const stopped = useRef(false)
  useEffect(() => () => void (stopped.current = true), [])

  const run = async () => {
    setBusy(true)
    try {
      const res = await send(conn, 'POST', `${encodeURIComponent(name)}/_delete_by_query?conflicts=proceed&refresh=true&wait_for_completion=false`, { query: { match_all: {} } })
      if (res.status >= 400) {
        setBusy(false)
        return useApp.getState().showToast(`Empty failed: ${reason(res.body)}`)
      }
      const taskId = (JSON.parse(res.body) as { task: string }).task
      setProgress({ deleted: 0, taskId })
      // Poll the task so large indices show progress instead of a frozen dialog.
      for (;;) {
        if (stopped.current) return
        await new Promise((r) => setTimeout(r, 700))
        const t = await send(conn, 'GET', `_tasks/${encodeURIComponent(taskId)}`)
        const j = JSON.parse(t.body) as DbqTask
        const st = j.task?.status
        setProgress({ deleted: j.response?.deleted ?? st?.deleted ?? 0, total: st?.total, taskId })
        if (j.completed) {
          if (j.error) throw new Error(j.error.reason ?? 'delete_by_query failed')
          useApp.getState().showToast(`Emptied ${name}: ${(j.response?.deleted ?? st?.deleted ?? 0).toLocaleString()} documents deleted`)
          await refreshConnection(conn.id)
          onDone()
          return
        }
      }
    } catch (e) {
      if (!(e instanceof KabanosError && e.code === 'NOT_CONFIRMED')) useApp.getState().showToast((e as Error).message)
      setBusy(false)
    }
  }

  return (
    <ConfirmByName title={`Empty ${name}?`} name={name} conn={conn} actionLabel={progress ? 'Emptying…' : 'Delete all documents'} busy={busy} onConfirm={run} onClose={onClose}>
      Deletes <b>every document</b> but keeps the index, its mapping, settings and aliases. Runs <span className="mono">POST {name}/_delete_by_query</span> with <span className="mono">{'{ "query": { "match_all": {} } }'}</span>.
      {progress && (
        <div className="empty-progress">
          <div className="progress det">
            <span style={{ width: progress.total ? `${Math.round((progress.deleted / progress.total) * 100)}%` : '5%' }} />
          </div>
          <span className="hint mono">
            {progress.deleted.toLocaleString()}
            {progress.total !== undefined ? ` / ${progress.total.toLocaleString()}` : ''} deleted · task {progress.taskId}
          </span>
        </div>
      )}
    </ConfirmByName>
  )
}
