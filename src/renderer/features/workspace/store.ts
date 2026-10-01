import { create } from 'zustand'
import { blockText, parseBlock, resolvePath, type ParsedRequest } from '@shared/consoleParser'
import type { Block, Query, QueryPatch, WorkspaceTab } from '@shared/library'
import type { ClusterResponse } from '@shared/types'
import { api, KabanosError } from '../../api'
import { useApp } from '../../store'

export interface RunState {
  running?: string
  response?: ClusterResponse & { resolvedPath: string }
  error?: string
}

interface WorkspaceStore {
  tabs: WorkspaceTab[]
  activeTab?: string
  blocks: Record<string, Array<Block & { query: Query }>>
  /** Editor text per query while it is being edited (source of truth for the editor). */
  drafts: Record<string, string>
  runs: Record<string, RunState>
  activeBlock?: string
  selected: Set<string>
  /** Bumped when the library changes, so the sidebar refetches. */
  libraryVersion: number
  /** A just-created block whose editor should take focus once mounted. */
  focusBlock?: string

  load(): Promise<void>
  selectTab(id: string): Promise<void>
  loadBlocks(tabId: string): Promise<void>
  createTab(name?: string): Promise<void>
  renameTab(id: string, name: string): Promise<void>
  closeTab(id: string): Promise<void>
  setDefaultTarget(target: string | null): Promise<void>
  setEnv(envId: string | null): Promise<void>

  newBlock(init?: Partial<ParsedRequest>, after?: string): Promise<string | undefined>
  openQuery(queryId: string): Promise<void>
  importRequests(reqs: ParsedRequest[], folderId?: string | null): Promise<number>
  editText(queryId: string, text: string): void
  patchQuery(queryId: string, patch: QueryPatch): Promise<void>
  removeBlock(queryId: string): Promise<void>
  setCollapsed(queryIds: string[], collapsed: boolean): Promise<void>
  move(queryId: string, delta: -1 | 1): Promise<void>
  setActive(queryId: string): void
  toggleSelected(queryId: string): void

  run(queryId: string): Promise<boolean>
  runSequence(queryIds: string[]): Promise<void>
  cancel(queryId: string): Promise<void>
  bumpLibrary(): void
}

const saveTimers = new Map<string, ReturnType<typeof setTimeout>>()

const DEFAULT_NEW = { method: 'GET' as const, path: '_search', body: '{\n  "query": {\n    "match_all": {}\n  }\n}' }

export const useWorkspace = create<WorkspaceStore>((set, get) => ({
  tabs: [],
  blocks: {},
  drafts: {},
  runs: {},
  selected: new Set(),
  libraryVersion: 0,

  load: async () => {
    const tabs = await api.workspace.tabs()
    const active = get().activeTab && tabs.some((t) => t.id === get().activeTab) ? get().activeTab! : tabs[0]!.id
    set({ tabs })
    await get().selectTab(active)
  },
  selectTab: async (id) => {
    set({ activeTab: id, selected: new Set() })
    await get().loadBlocks(id)
  },
  loadBlocks: async (tabId) => {
    const list = await api.workspace.blocks(tabId)
    set((s) => ({ blocks: { ...s.blocks, [tabId]: list }, activeBlock: s.activeBlock && list.some((b) => b.queryId === s.activeBlock) ? s.activeBlock : list.find((b) => !b.collapsed)?.queryId }))
  },
  createTab: async (name) => {
    const n = name ?? `Tab ${get().tabs.length + 1}`
    const tab = await api.workspace.createTab(n)
    set((s) => ({ tabs: [...s.tabs, tab] }))
    await get().selectTab(tab.id)
  },
  renameTab: async (id, name) => {
    await api.workspace.updateTab(id, { name })
    set((s) => ({ tabs: s.tabs.map((t) => (t.id === id ? { ...t, name: name.trim() || t.name } : t)) }))
  },
  closeTab: async (id) => {
    await api.workspace.removeTab(id)
    const tabs = await api.workspace.tabs()
    set({ tabs })
    await get().selectTab(tabs.find((t) => t.id === get().activeTab)?.id ?? tabs[0]!.id)
    get().bumpLibrary()
  },
  setDefaultTarget: async (target) => {
    const id = get().activeTab
    if (!id) return
    await api.workspace.updateTab(id, { defaultTarget: target })
    set((s) => ({ tabs: s.tabs.map((t) => (t.id === id ? { ...t, defaultTarget: target || undefined } : t)) }))
  },
  setEnv: async (envId) => {
    const id = get().activeTab
    if (!id) return
    await api.workspace.updateTab(id, { envId })
    set((s) => ({ tabs: s.tabs.map((t) => (t.id === id ? { ...t, envId: envId || undefined } : t)) }))
  },

  newBlock: async (init, after) => {
    const tabId = get().activeTab
    if (!tabId) return undefined
    const q = await api.library.createQuery({ ...DEFAULT_NEW, ...init, title: init?.title ?? '' })
    await api.workspace.addBlock(tabId, q.id, after)
    set({ focusBlock: q.id })
    await get().loadBlocks(tabId)
    set({ activeBlock: q.id })
    get().bumpLibrary()
    return q.id
  },
  openQuery: async (queryId) => {
    const tabId = get().activeTab
    if (!tabId) return
    await api.workspace.addBlock(tabId, queryId)
    await api.workspace.setCollapsed(tabId, [queryId], false)
    await get().loadBlocks(tabId)
    set({ activeBlock: queryId })
    requestAnimationFrame(() => document.getElementById(`block-${queryId}`)?.scrollIntoView({ block: 'nearest', behavior: 'smooth' }))
  },
  importRequests: async (reqs, folderId = null) => {
    const tabId = get().activeTab
    if (!tabId) return 0
    for (const r of reqs) {
      const q = await api.library.createQuery({ title: r.title ?? '', method: r.method, path: r.path, body: r.body, folderId })
      await api.workspace.addBlock(tabId, q.id)
    }
    // Imported blocks start collapsed so a long Kibana export stays scannable.
    const ids = (await api.workspace.blocks(tabId)).slice(-reqs.length).map((b) => b.queryId)
    if (reqs.length > 3) await api.workspace.setCollapsed(tabId, ids, true)
    await get().loadBlocks(tabId)
    get().bumpLibrary()
    return reqs.length
  },

  editText: (queryId, text) => {
    set((s) => ({ drafts: { ...s.drafts, [queryId]: text } }))
    const parsed = parseBlock(text)
    if (!parsed) return
    clearTimeout(saveTimers.get(queryId))
    saveTimers.set(
      queryId,
      setTimeout(() => {
        saveTimers.delete(queryId)
        void get().patchQuery(queryId, parsed)
      }, 400)
    )
  },
  patchQuery: async (queryId, patch) => {
    const q = await api.library.updateQuery(queryId, patch)
    set((s) => ({ blocks: Object.fromEntries(Object.entries(s.blocks).map(([t, list]) => [t, list.map((b) => (b.queryId === queryId ? { ...b, query: q } : b))])) }))
    if (patch.folderId !== undefined || patch.title !== undefined || patch.tags !== undefined || patch.pinned !== undefined) get().bumpLibrary()
  },
  removeBlock: async (queryId) => {
    const tabId = get().activeTab
    if (!tabId) return
    await api.workspace.removeBlock(tabId, queryId)
    await get().loadBlocks(tabId)
    get().bumpLibrary()
  },
  setCollapsed: async (ids, collapsed) => {
    const tabId = get().activeTab
    if (!tabId) return
    set((s) => ({ blocks: { ...s.blocks, [tabId]: (s.blocks[tabId] ?? []).map((b) => (ids.includes(b.queryId) ? { ...b, collapsed } : b)) } }))
    await api.workspace.setCollapsed(tabId, ids, collapsed)
  },
  move: async (queryId, delta) => {
    const tabId = get().activeTab
    if (!tabId) return
    const ids = (get().blocks[tabId] ?? []).map((b) => b.queryId)
    const i = ids.indexOf(queryId)
    const j = i + delta
    if (i < 0 || j < 0 || j >= ids.length) return
    ;[ids[i], ids[j]] = [ids[j]!, ids[i]!]
    await api.workspace.reorder(tabId, ids)
    await get().loadBlocks(tabId)
  },
  setActive: (queryId) => set({ activeBlock: queryId }),
  toggleSelected: (queryId) =>
    set((s) => {
      const n = new Set(s.selected)
      if (n.has(queryId)) n.delete(queryId)
      else n.add(queryId)
      return { selected: n }
    }),

  run: async (queryId) => {
    const connectionId = useApp.getState().activeTab
    if (!connectionId) {
      useApp.getState().showToast('Open a connection first (Connections → Save & connect)')
      return false
    }
    const tab = get().tabs.find((t) => t.id === get().activeTab)
    const block = Object.values(get().blocks).flat().find((b) => b.queryId === queryId)
    const text = get().drafts[queryId] ?? (block ? blockText(block.query) : '')
    const parsed = parseBlock(text)
    if (!parsed) {
      set((s) => ({ runs: { ...s.runs, [queryId]: { error: 'The first line must be a request line, e.g. GET _cluster/health' } } }))
      return false
    }
    // Flush a pending autosave so history and the library match what ran.
    if (saveTimers.has(queryId)) {
      clearTimeout(saveTimers.get(queryId))
      saveTimers.delete(queryId)
      void get().patchQuery(queryId, parsed)
    }
    const opaqueId = `kabanos-${crypto.randomUUID()}`
    set((s) => ({ activeBlock: queryId, runs: { ...s.runs, [queryId]: { ...s.runs[queryId], running: opaqueId, error: undefined } } }))
    try {
      const response = await api.cluster.run({
        connectionId,
        method: parsed.method,
        path: resolvePath(parsed.path, tab?.defaultTarget),
        body: parsed.body.trim() ? parsed.body : undefined,
        opaqueId,
        queryId,
        envId: tab?.envId
      })
      set((s) => ({ runs: { ...s.runs, [queryId]: { response } } }))
      const q = await api.library.query(queryId)
      set((s) => ({ blocks: Object.fromEntries(Object.entries(s.blocks).map(([t, list]) => [t, list.map((b) => (b.queryId === queryId ? { ...b, query: q } : b))])) }))
      return response.status < 400
    } catch (e) {
      const msg = e instanceof KabanosError && e.code === 'NOT_CONFIRMED' ? 'Not sent — production confirmation declined' : e instanceof KabanosError && e.code === 'CANCELLED' ? 'Request cancelled' : (e as Error).message
      set((s) => ({ runs: { ...s.runs, [queryId]: { error: msg } } }))
      return false
    }
  },
  runSequence: async (queryIds) => {
    for (const id of queryIds) {
      const ok = await get().run(id)
      if (!ok) {
        useApp.getState().showToast('Stopped: a request failed — later blocks were not run')
        return
      }
    }
  },
  cancel: async (queryId) => {
    const r = get().runs[queryId]
    if (r?.running) await api.cluster.cancel(r.running)
  },
  bumpLibrary: () => set((s) => ({ libraryVersion: s.libraryVersion + 1 }))
}))
