import { create } from 'zustand'
import type { Compiled } from '@shared/aggregations/compiler'
import { isPipeline, newPipeline, type Pipeline } from '@shared/aggregations/model'

export type AggView = 'stages' | 'json' | 'esql'

export interface AggRun {
  status: 'running' | 'done' | 'error'
  opaqueId?: string
  httpStatus?: number
  response?: Record<string, unknown>
  compiled?: Compiled
  ms?: number
  bytes?: number
  error?: string
  /** Profile run: total ms per agg name. */
  profile?: Record<string, number>
}

export interface AggTab {
  pipeline: Pipeline
  view: AggView
  /** Stage being edited (amber in the flow bar; target of ⌘D / ⌘⌫ / ⌘⌥↑↓). */
  focus?: string
  run?: AggRun
  resultView: 'table' | 'json'
  /** Library item this pipeline was saved as. */
  savedId?: string
  /** Bumped by Run so previews refresh even when live preview is off. */
  refreshNonce: number
}

const KEY = 'kabanos.aggregations'

function load(): Record<string, Pick<AggTab, 'pipeline' | 'view' | 'savedId'>> {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? '{}') as Record<string, Pick<AggTab, 'pipeline' | 'view' | 'savedId'>>
    return Object.fromEntries(Object.entries(raw).filter(([, v]) => isPipeline(v?.pipeline)))
  } catch {
    return {}
  }
}

let saveTimer: ReturnType<typeof setTimeout> | undefined
function persist(tabs: Record<string, AggTab>): void {
  clearTimeout(saveTimer)
  saveTimer = setTimeout(() => {
    try {
      localStorage.setItem(KEY, JSON.stringify(Object.fromEntries(Object.entries(tabs).map(([k, t]) => [k, { pipeline: t.pipeline, view: t.view, savedId: t.savedId }]))))
    } catch {
      /* storage full or unavailable: drafts just don't survive a restart */
    }
  }, 300)
}

interface Store {
  tabs: Record<string, AggTab>
  get(key: string, target: string, connectionId: string): AggTab
  patch(key: string, p: Partial<AggTab>): void
  setPipeline(key: string, fn: (p: Pipeline) => Pipeline): void
}

const saved = load()

/** Aggregation pipelines per index-view tab (`${connectionId}::${target}`); drafts survive restarts. */
export const useAggs = create<Store>((set, get) => ({
  tabs: Object.fromEntries(Object.entries(saved).map(([k, v]) => [k, { ...v, view: v.view ?? 'stages', resultView: 'table', refreshNonce: 0 }])),
  get: (key, target, connectionId) => get().tabs[key] ?? { pipeline: newPipeline(target, connectionId), view: 'stages', resultView: 'table', refreshNonce: 0 },
  patch: (key, p) =>
    set((s) => {
      const cur = s.tabs[key]
      if (!cur && !p.pipeline) return s
      const tabs = { ...s.tabs, [key]: { ...(cur ?? { view: 'stages', resultView: 'table', refreshNonce: 0 }), ...p } as AggTab }
      persist(tabs)
      return { tabs }
    }),
  setPipeline: (key, fn) => {
    const cur = get().tabs[key]
    if (!cur) return
    get().patch(key, { pipeline: { ...fn(cur.pipeline), updatedAt: new Date().toISOString() } })
  }
}))
