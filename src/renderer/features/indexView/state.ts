import { create } from 'zustand'
import type { ClusterResponse, HttpMethod } from '@shared/types'

export type ResultView = 'documents' | 'table' | 'json'
export type SubTab = 'query' | 'documents' | 'mapping' | 'aliases' | 'settings'

export interface QueryTabState {
  method: HttpMethod
  endpoint: string
  body: string
  subTab: SubTab
  view: ResultView
  running?: string
  response?: ClusterResponse
  error?: string
}

export const DEFAULT_BODY = `{
  "size": 20,
  "query": {
    "match_all": {}
  }
}`

const fresh = (): QueryTabState => ({ method: 'POST', endpoint: '_search?track_total_hits=true', body: DEFAULT_BODY, subTab: 'query', view: 'documents' })

interface Store {
  tabs: Record<string, QueryTabState>
  get(key: string): QueryTabState
  patch(key: string, p: Partial<QueryTabState>): void
}

/** Index view tab state, keyed by `${connectionId}::${target}` so it survives switching tabs. */
export const useQueryTabs = create<Store>((set, get) => ({
  tabs: {},
  get: (key) => get().tabs[key] ?? fresh(),
  patch: (key, p) => set((s) => ({ tabs: { ...s.tabs, [key]: { ...(s.tabs[key] ?? fresh()), ...p } } }))
}))

export const tabKey = (connectionId: string, target: string) => `${connectionId}::${target}`

export interface Endpoint {
  label: string
  method: HttpMethod
  path: string
  body?: string
}

/** SPEC §7 endpoint chips — each fills method, path and a starter body. */
export const ENDPOINTS: Endpoint[] = [
  { label: '_search', method: 'POST', path: '_search?track_total_hits=true', body: DEFAULT_BODY },
  { label: '_count', method: 'POST', path: '_count', body: '{\n  "query": {\n    "match_all": {}\n  }\n}' },
  { label: '_doc/{id}', method: 'GET', path: '_doc/', body: '' },
  { label: '_mapping', method: 'GET', path: '_mapping', body: '' },
  {
    label: '_update_by_query',
    method: 'POST',
    path: '_update_by_query?conflicts=proceed&wait_for_completion=false',
    body: '{\n  "query": {\n    "term": { "status": "expired" }\n  },\n  "script": {\n    "source": "ctx._source.archived = true",\n    "lang": "painless"\n  }\n}'
  },
  { label: '_delete_by_query', method: 'POST', path: '_delete_by_query?conflicts=proceed', body: '{\n  "query": {\n    "term": { "status": "expired" }\n  }\n}' },
  { label: '_settings', method: 'GET', path: '_settings?flat_settings=true', body: '' }
]

export const METHODS: Array<{ method: HttpMethod; hint: string }> = [
  { method: 'GET', hint: 'read' },
  { method: 'POST', hint: 'search / create' },
  { method: 'PUT', hint: 'create / replace' },
  { method: 'HEAD', hint: 'exists check' },
  { method: 'DELETE', hint: 'asks to confirm on prod' }
]
