import { create } from 'zustand'
import type { ConnectionConfig } from '@shared/types'
import { api } from './api'

export type View = 'connections' | 'explorer' | 'workspace' | 'routines' | 'security' | 'settings'

export type NodeKind = 'index' | 'alias' | 'datastream' | 'template'
export interface ExplorerSel {
  kind: NodeKind
  name: string
}
/** Per-connection Explorer state: what is selected in the tree and which index query tabs are open. */
export interface ExplorerState {
  sel?: ExplorerSel
  tab: string
  mode: 'inspect' | 'query'
  queryTabs: string[]
  activeQuery?: string
}
const EMPTY_EXPLORER: ExplorerState = { tab: 'overview', mode: 'inspect', queryTabs: [] }

interface AppState {
  view: View
  connections: ConnectionConfig[]
  /** Connections opened as title-bar tabs, in tab order. */
  openTabs: string[]
  activeTab: string | null
  /** Connection being edited on the Connections screen; null = new connection form. */
  editingId: string | null
  /** Bumped on every edit() so re-selecting the same target still resets the form. */
  formNonce: number
  toast: string | null
  paletteOpen: boolean
  explorer: Record<string, ExplorerState>

  setView(view: View): void
  refresh(): Promise<void>
  edit(id: string | null): void
  openTab(id: string): void
  closeTab(id: string): void
  showToast(msg: string): void
  explorerOf(connectionId: string): ExplorerState
  updateExplorer(connectionId: string, patch: Partial<ExplorerState>): void
  select(connectionId: string, sel: ExplorerSel): void
  /** Open (or focus) an index/alias query tab — the Index view. */
  openQuery(connectionId: string, target: string): void
  closeQuery(connectionId: string, target: string): void
}

const TABS_KEY = 'kabanos.openTabs'
function loadTabs(): { openTabs: string[]; activeTab: string | null } {
  try {
    const v = JSON.parse(localStorage.getItem(TABS_KEY) ?? localStorage.getItem('sift.openTabs') ?? 'null') as { openTabs?: string[]; activeTab?: string | null } | null
    return { openTabs: v?.openTabs ?? [], activeTab: v?.activeTab ?? null }
  } catch {
    return { openTabs: [], activeTab: null }
  }
}

export const useApp = create<AppState>((set, get) => ({
  view: 'connections',
  connections: [],
  // Connection tabs are reopened on the next launch (ids only — nothing sensitive).
  ...loadTabs(),
  editingId: null,
  formNonce: 0,
  toast: null,
  paletteOpen: false,
  explorer: {},

  setView: (view) => set({ view }),
  refresh: async () => {
    const connections = await api.connections.list()
    const ids = new Set(connections.map((c) => c.id))
    const openTabs = get().openTabs.filter((id) => ids.has(id))
    const activeTab = get().activeTab && ids.has(get().activeTab!) ? get().activeTab : (openTabs[0] ?? null)
    const editingId = get().editingId && ids.has(get().editingId!) ? get().editingId : null
    set({ connections, openTabs, activeTab, editingId })
  },
  edit: (id) => set((s) => ({ editingId: id, view: 'connections', formNonce: s.formNonce + 1 })),
  openTab: (id) => set((s) => ({ openTabs: s.openTabs.includes(id) ? s.openTabs : [...s.openTabs, id], activeTab: id })),
  closeTab: (id) =>
    set((s) => {
      const openTabs = s.openTabs.filter((t) => t !== id)
      const idx = s.openTabs.indexOf(id)
      const activeTab = s.activeTab === id ? (openTabs[Math.max(0, idx - 1)] ?? null) : s.activeTab
      return { openTabs, activeTab }
    }),
  explorerOf: (id) => get().explorer[id] ?? EMPTY_EXPLORER,
  updateExplorer: (id, patch) => set((s) => ({ explorer: { ...s.explorer, [id]: { ...(s.explorer[id] ?? EMPTY_EXPLORER), ...patch } } })),
  select: (id, sel) => get().updateExplorer(id, { sel, mode: 'inspect', tab: 'overview' }),
  openQuery: (id, target) => {
    const ex = get().explorerOf(id)
    get().updateExplorer(id, { mode: 'query', activeQuery: target, queryTabs: ex.queryTabs.includes(target) ? ex.queryTabs : [...ex.queryTabs, target] })
    set({ view: 'explorer' })
  },
  closeQuery: (id, target) => {
    const ex = get().explorerOf(id)
    const queryTabs = ex.queryTabs.filter((t) => t !== target)
    const idx = ex.queryTabs.indexOf(target)
    const activeQuery = ex.activeQuery === target ? queryTabs[Math.max(0, idx - 1)] : ex.activeQuery
    get().updateExplorer(id, { queryTabs, activeQuery, mode: queryTabs.length ? ex.mode : 'inspect' })
  },
  showToast: (msg) => {
    set({ toast: msg })
    setTimeout(() => get().toast === msg && set({ toast: null }), 3500)
  }
}))

export const COLORS: Record<ConnectionConfig['color'], string> = {
  amber: '#F2B544',
  red: '#FF7A70',
  teal: '#4DC4D6',
  blue: '#6AA8FF',
  green: '#5CCB8A',
  grey: '#8B94A3'
}

export function hostOf(c: ConnectionConfig): string {
  if (c.authKind === 'cloudid') return c.cloudId?.split(':')[0] ? `cloud: ${c.cloudId.split(':')[0]}` : 'Elastic Cloud'
  try {
    const u = new URL(c.url)
    return u.port ? `${u.hostname}:${u.port}` : u.hostname
  } catch {
    return c.url
  }
}

useApp.subscribe((s, prev) => {
  if (s.openTabs === prev.openTabs && s.activeTab === prev.activeTab) return
  try {
    localStorage.setItem(TABS_KEY, JSON.stringify({ openTabs: s.openTabs, activeTab: s.activeTab }))
  } catch {
    /* storage unavailable — tabs just won't be restored */
  }
})
