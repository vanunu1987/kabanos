import type { HttpMethod } from './types'

/** A saved request. Workspace blocks are queries opened in a tab; unfiled ones have `folderId: null`. */
export interface Query {
  id: string
  /** The cluster (saved connection) this query belongs to — it only runs there. */
  connectionId: string | null
  folderId: string | null
  title: string
  method: HttpMethod
  path: string
  body: string
  tags: string[]
  pinned: boolean
  lastStatus?: number
  lastRunAt?: string
  lastMs?: number
  /** Aggregation pipeline (JSON of `Pipeline`) — set for items saved from the Aggregations tab; `body` holds the compiled request. */
  pipeline?: string
  createdAt: string
  updatedAt: string
}

export type QueryPatch = Partial<Pick<Query, 'folderId' | 'title' | 'method' | 'path' | 'body' | 'tags' | 'pinned' | 'pipeline'>>

export interface Folder {
  id: string
  connectionId: string | null
  parentId: string | null
  name: string
  sort: number
}

export interface WorkspaceTab {
  id: string
  connectionId: string | null
  name: string
  sort: number
  defaultTarget?: string
  envId?: string
}

export interface Block {
  queryId: string
  collapsed: boolean
  sort: number
}

export interface HistoryEntry {
  id: number
  connectionId: string
  queryId?: string
  method: HttpMethod
  path: string
  body: string
  status?: number
  ms?: number
  bytes?: number
  error?: string
  response?: string
  at: string
}

export interface Environment {
  id: string
  name: string
  vars: Array<{ key: string; value: string; secret: boolean }>
}

export type LibraryFilter = { kind: 'all' } | { kind: 'pinned' } | { kind: 'recent' } | { kind: 'tag'; tag: string }

/** Turns a search box string into an FTS5 query: words are AND-ed prefixes, `#tag` filters by tag. */
export function parseSearch(input: string): { fts?: string; tags: string[] } {
  const tags: string[] = []
  const terms: string[] = []
  for (const raw of input.trim().split(/\s+/).filter(Boolean)) {
    if (raw.startsWith('#') && raw.length > 1) tags.push(raw.slice(1).toLowerCase())
    else {
      const t = raw.replace(/"/g, '')
      if (t) terms.push(`"${t}"*`)
    }
  }
  return { fts: terms.length ? terms.join(' AND ') : undefined, tags }
}

/** `{{name}}` placeholders → values. Unknown names are left as-is so the error is visible. */
export function substituteVars(text: string, vars: Record<string, string>): string {
  return text.replace(/\{\{\s*([\w.-]+)\s*\}\}/g, (m, name: string) => (name in vars ? vars[name]! : m))
}
