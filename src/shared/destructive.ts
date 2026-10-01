import type { HttpMethod } from './types'

export type RequestSafety = 'read' | 'write' | 'danger'

export interface Classification {
  safety: RequestSafety
  /** Human-readable reason, shown in the confirmation dialog. */
  reason: string
}

/**
 * Endpoints that use POST (or DELETE for cleanup) but never change cluster data.
 * Matched against the last path segment(s), so `logs-*\/_search` and `_search` both hit.
 */
const READ_POST_ENDPOINTS: RegExp[] = [
  /(^|\/)_search(\/template)?$/,
  /(^|\/)_msearch(\/template)?$/,
  /(^|\/)_search\/scroll$/,
  /(^|\/)_count$/,
  /(^|\/)_mget$/,
  /(^|\/)_field_caps$/,
  /(^|\/)_validate\/query$/,
  /(^|\/)_explain(\/[^/]+)?$/,
  /(^|\/)_analyze$/,
  /(^|\/)_termvectors(\/[^/]+)?$/,
  /(^|\/)_mtermvectors$/,
  /(^|\/)_rank_eval$/,
  /(^|\/)_render\/template(\/[^/]+)?$/,
  /(^|\/)_terms_enum$/,
  /(^|\/)_knn_search$/,
  /(^|\/)_async_search$/,
  /(^|\/)_pit$/,
  /(^|\/)_search\/point_in_time$/,
  /^_sql(\/translate)?$/,
  /^_query$/,
  /^_query\/async$/,
  /^_plugins\/_sql(\/_explain)?$/,
  /^_plugins\/_ppl(\/_explain)?$/,
  /^_plugins\/_asynchronous_search$/,
  /^_security\/user\/_has_privileges$/,
  /^_security\/_authenticate$/,
  /^_index_template\/_simulate(_index\/[^/]+)?(\/[^/]+)?$/,
  /^_ingest\/pipeline(\/[^/]+)?\/_simulate$/
]

/** DELETEs that only release server-side read context. */
const READ_DELETE_ENDPOINTS: RegExp[] = [
  /^_pit$/,
  /^_search\/point_in_time(\/_all)?$/,
  /^_search\/scroll(\/.*)?$/,
  /^_async_search\/[^/]+$/,
  /^_query\/async\/[^/]+$/
]

const DANGER: Array<[RegExp, string]> = [
  [/(^|\/)_delete_by_query$/, 'deletes documents matching a query'],
  [/(^|\/)_update_by_query$/, 'rewrites documents matching a query'],
  [/(^|\/)_close$/, 'closes an index'],
  [/(^|\/)_shrink\/|(^|\/)_split\/|(^|\/)_clone\//, 'resizes / clones an index'],
  [/(^|\/)_forcemerge$/, 'force-merges segments (heavy I/O)'],
  [/^_cluster\/settings$/, 'changes cluster settings'],
  [/^_security\//, 'changes security configuration'],
  [/^_plugins\/_security\//, 'changes security configuration'],
  [/^_aliases$/, 'changes aliases'],
  [/^_snapshot\/.+\/_restore$/, 'restores a snapshot over live indices']
]

function normalisePath(path: string): string {
  return path.trim().replace(/^\/+/, '').split(/[?#]/)[0]!.replace(/\/+$/, '')
}

/**
 * Classify a request for the prod-confirmation and read-only guards.
 * Anything that isn't a known read is a write — the safe default for unknown endpoints.
 */
export function classifyRequest(method: HttpMethod, rawPath: string, body?: string): Classification {
  const path = normalisePath(rawPath)

  if (method === 'GET' || method === 'HEAD') return { safety: 'read', reason: 'read request' }

  if (method === 'DELETE') {
    if (READ_DELETE_ENDPOINTS.some((re) => re.test(path))) return { safety: 'read', reason: 'releases a search context' }
    if (path === '' || path === '*' || path === '_all' || /(^|,)(\*|_all)(,|$)/.test(path.split('/')[0] ?? '')) {
      return { safety: 'danger', reason: 'deletes indices matched by a wildcard' }
    }
    return { safety: 'danger', reason: path.includes('/') ? `deletes ${path}` : `deletes index ${path}` }
  }

  if (method === 'POST' && READ_POST_ENDPOINTS.some((re) => re.test(path))) {
    return { safety: 'read', reason: 'search / read request' }
  }

  for (const [re, reason] of DANGER) {
    if (re.test(path)) return { safety: 'danger', reason }
  }

  if (/(^|\/)_bulk$/.test(path) && body && /"delete"\s*:/.test(body)) {
    return { safety: 'danger', reason: 'bulk request containing deletes' }
  }

  if (method === 'PUT' && /(^|\/)_(mapping|settings)$/.test(path)) {
    return { safety: 'write', reason: 'changes index mapping / settings' }
  }

  return { safety: 'write', reason: `${method} ${path || '/'} modifies the cluster` }
}
