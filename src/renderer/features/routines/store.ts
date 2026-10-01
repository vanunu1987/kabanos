import { create } from 'zustand'
import { newStepId, type Routine, type RoutineEvent, type RoutineRun, type RoutineStep } from '@shared/routines'
import { api } from '../../api'
import { useApp } from '../../store'
import { queryClient } from '../../queries'

interface RoutinesStore {
  routines: Routine[]
  selected?: string
  /** Latest run per routine (live while running). */
  runs: Record<string, RoutineRun>
  paused: Record<string, string | undefined>
  /** Step being edited (expanded card). */
  editingStep?: string

  load(): Promise<void>
  select(id: string): void
  create(name?: string, steps?: RoutineStep[]): Promise<Routine>
  update(id: string, patch: Partial<Pick<Routine, 'name' | 'defaultConnectionId' | 'variables' | 'steps'>>): void
  remove(id: string): Promise<void>
  addSteps(id: string, steps: Array<Omit<RoutineStep, 'id'> & { id?: string }>): Promise<void>
  start(id: string, opts: { dryRun?: boolean; stepThrough?: boolean }): Promise<void>
  resume(id: string): Promise<void>
  stop(id: string): Promise<void>
  onEvent(e: RoutineEvent): void
}

const timers = new Map<string, ReturnType<typeof setTimeout>>()

export const useRoutines = create<RoutinesStore>((set, get) => ({
  routines: [],
  runs: {},
  paused: {},

  load: async () => {
    const routines = await api.routines.list()
    set((s) => ({ routines, selected: s.selected && routines.some((r) => r.id === s.selected) ? s.selected : routines[0]?.id }))
    const sel = get().selected
    if (sel && !get().runs[sel]) {
      const [last] = await api.routines.runs(sel)
      if (last) set((s) => ({ runs: { ...s.runs, [sel]: last } }))
    }
  },
  select: (id) => {
    set({ selected: id, editingStep: undefined })
    if (!get().runs[id]) void api.routines.runs(id).then(([last]) => last && set((s) => ({ runs: { ...s.runs, [id]: last } })))
  },
  create: async (name = 'New routine', steps = []) => {
    const r = await api.routines.save({ name, variables: {}, steps, defaultConnectionId: useApp.getState().activeTab ?? undefined })
    set((s) => ({ routines: [...s.routines, r].sort((a, b) => a.name.localeCompare(b.name)), selected: r.id }))
    return r
  },
  update: (id, patch) => {
    set((s) => ({ routines: s.routines.map((r) => (r.id === id ? { ...r, ...patch } : r)) }))
    clearTimeout(timers.get(id))
    timers.set(
      id,
      setTimeout(() => {
        timers.delete(id)
        const r = get().routines.find((x) => x.id === id)
        if (r) void api.routines.save({ id: r.id, name: r.name, defaultConnectionId: r.defaultConnectionId, variables: r.variables, steps: r.steps })
      }, 300)
    )
  },
  remove: async (id) => {
    await api.routines.remove(id)
    await get().load()
  },
  addSteps: async (id, steps) => {
    const r = get().routines.find((x) => x.id === id)
    if (!r) return
    const all = [...r.steps]
    for (const s of steps) all.push({ ...s, id: s.id ?? newStepId(all, s.name || s.path.split(/[/?]/).filter(Boolean).pop() || 'step') })
    get().update(id, { steps: all })
    await flush(id)
  },
  start: async (id, opts) => {
    await flush(id)
    try {
      await api.routines.start(id, opts)
    } catch (e) {
      useApp.getState().showToast((e as Error).message)
    }
  },
  resume: async (id) => {
    const run = get().runs[id]
    if (run) await api.routines.resume(run.id)
    set((s) => ({ paused: { ...s.paused, [id]: undefined } }))
  },
  stop: async (id) => {
    const run = get().runs[id]
    if (run) await api.routines.stop(run.id)
  },
  onEvent: (e) => {
    if (e.type === 'run') {
      set((s) => ({ runs: { ...s.runs, [e.run.routineId]: e.run }, paused: e.run.status !== 'running' ? { ...s.paused, [e.run.routineId]: undefined } : s.paused }))
      if (e.run.status !== 'running') {
        set((s) => ({ routines: s.routines.map((r) => (r.id === e.run.routineId ? { ...r, lastStatus: e.run.status, lastRunAt: e.run.startedAt } : r)) }))
        // A routine may have created, changed or deleted indices: refresh the clusters it touched.
        const touched = new Set(e.run.steps.map((st) => st.connectionId).filter((id): id is string => !!id))
        void queryClient.invalidateQueries({ predicate: (q) => typeof q.queryKey[1] === 'string' && touched.has(q.queryKey[1]) })
      }
    } else {
      const routineId = Object.values(get().runs).find((r) => r.id === e.runId)?.routineId
      if (routineId) set((s) => ({ paused: { ...s.paused, [routineId]: e.nextStepId } }))
    }
  }
}))

/** Persist pending edits now (before running). */
async function flush(id: string): Promise<void> {
  if (!timers.has(id)) return
  clearTimeout(timers.get(id))
  timers.delete(id)
  const r = useRoutines.getState().routines.find((x) => x.id === id)
  if (r) await api.routines.save({ id: r.id, name: r.name, defaultConnectionId: r.defaultConnectionId, variables: r.variables, steps: r.steps })
}

let subscribed = false
export function subscribeRoutineEvents(): void {
  if (subscribed) return
  subscribed = true
  window.kabanosIpc.onRoutineEvent((e) => useRoutines.getState().onEvent(e))
}
