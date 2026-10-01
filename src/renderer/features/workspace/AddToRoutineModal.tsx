import { useEffect, useState } from 'react'
import { parseBlock, resolvePath } from '@shared/consoleParser'
import type { Query } from '@shared/library'
import type { RoutineStep } from '@shared/routines'
import { Modal } from '../../components/Modal'
import { useApp } from '../../store'
import { useRoutines } from '../routines/store'
import { useWorkspace } from './store'

/** Workspace → routine: selected blocks become steps (saved queries are referenced, scratch ones copied). */
export function AddToRoutineModal({ queries, defaultTarget, onClose }: { queries: Query[]; defaultTarget?: string; onClose(): void }) {
  const { routines } = useRoutines()
  const [target, setTarget] = useState<string>('__new')
  const [name, setName] = useState('New routine')
  useEffect(() => {
    void useRoutines.getState().load()
  }, [])

  const add = async () => {
    const drafts = useWorkspace.getState().drafts
    const steps: Array<Omit<RoutineStep, 'id'>> = queries.map((q) => {
      const parsed = (drafts[q.id] && parseBlock(drafts[q.id]!)) || q
      const path = resolvePath(parsed.path, defaultTarget)
      return {
        name: q.title || `${parsed.method} ${path}`,
        method: parsed.method,
        path,
        body: parsed.body || undefined,
        ...(q.folderId !== null && path === parsed.path ? { queryRef: q.id } : {}),
        onFail: 'stop'
      }
    })
    const st = useRoutines.getState()
    const id = target === '__new' ? (await st.create(name)).id : target
    await st.addSteps(id, steps)
    st.select(id)
    useApp.getState().showToast(`Added ${steps.length} step${steps.length === 1 ? '' : 's'}`)
    useApp.getState().setView('routines')
    onClose()
  }

  return (
    <Modal
      title={`Add ${queries.length} request${queries.length === 1 ? '' : 's'} to a routine`}
      onClose={onClose}
      actions={
        <>
          <button className="btn md" onClick={onClose}>
            Cancel
          </button>
          <button className="btn md primary" onClick={add} disabled={target === '__new' && !name.trim()}>
            Add steps
          </button>
        </>
      }
    >
      <select className="select" value={target} onChange={(e) => setTarget(e.target.value)} aria-label="Routine">
        <option value="__new">New routine…</option>
        {routines.map((r) => (
          <option key={r.id} value={r.id}>
            {r.name} ({r.steps.length} steps)
          </option>
        ))}
      </select>
      {target === '__new' && <input className="input" value={name} onChange={(e) => setName(e.target.value)} aria-label="Routine name" autoFocus />}
      <span className="hint">Saved library queries are linked, so later edits to them flow into the routine. Unsaved blocks are copied.</span>
    </Modal>
  )
}
