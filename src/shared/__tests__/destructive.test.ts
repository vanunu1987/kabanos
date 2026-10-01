import { describe, expect, it } from 'vitest'
import { classifyRequest } from '../destructive'
import type { HttpMethod } from '../types'

const cases: Array<[HttpMethod, string, 'read' | 'write' | 'danger', string?]> = [
  ['GET', '_cat/indices', 'read'],
  ['HEAD', 'listings', 'read'],
  ['GET', 'listings/_search', 'read'],
  ['POST', 'listings/_search', 'read'],
  ['POST', '/logs-*/_search?size=0', 'read'],
  ['POST', '_msearch', 'read'],
  ['POST', 'listings/_count', 'read'],
  ['POST', '_mget', 'read'],
  ['POST', 'listings/_field_caps?fields=*', 'read'],
  ['POST', 'listings/_validate/query', 'read'],
  ['POST', 'listings/_explain/42', 'read'],
  ['POST', '_analyze', 'read'],
  ['POST', 'listings/_pit?keep_alive=1m', 'read'],
  ['DELETE', '_pit', 'read'],
  ['POST', '_search/scroll', 'read'],
  ['DELETE', '_search/scroll', 'read'],
  ['POST', '_sql?format=json', 'read'],
  ['POST', '_query', 'read'],
  ['POST', '_plugins/_ppl', 'read'],
  ['POST', '_security/user/_has_privileges', 'read'],
  ['POST', '_index_template/_simulate_index/listings-v7', 'read'],
  ['POST', '_ingest/pipeline/my-pipe/_simulate', 'read'],

  ['PUT', 'listings-v8', 'write'],
  ['POST', 'listings/_doc', 'write'],
  ['PUT', 'listings/_doc/1', 'write'],
  ['POST', '_reindex', 'write'],
  ['PUT', 'listings/_mapping', 'write'],
  ['POST', '_bulk', 'write'],
  ['POST', 'listings/_refresh', 'write'],

  ['DELETE', 'listings-v6', 'danger'],
  ['DELETE', '*', 'danger', 'wildcard'],
  ['DELETE', '_all', 'danger', 'wildcard'],
  ['DELETE', 'listings/_doc/1', 'danger'],
  ['POST', 'listings/_delete_by_query', 'danger'],
  ['POST', 'listings/_update_by_query', 'danger'],
  ['POST', 'listings/_close', 'danger'],
  ['PUT', '_cluster/settings', 'danger'],
  ['PUT', '_security/user/bob', 'danger'],
  ['PUT', '_plugins/_security/api/internalusers/bob', 'danger'],
  ['POST', '_aliases', 'danger'],
  ['POST', '_snapshot/repo/snap1/_restore', 'danger']
]

describe('classifyRequest', () => {
  it.each(cases)('%s %s → %s', (method, path, safety, reason) => {
    const c = classifyRequest(method, path)
    expect(c.safety).toBe(safety)
    if (reason) expect(c.reason).toContain(reason)
  })

  it('flags bulk bodies that delete', () => {
    expect(classifyRequest('POST', '_bulk', '{"delete":{"_index":"a","_id":"1"}}\n').safety).toBe('danger')
    expect(classifyRequest('POST', '_bulk', '{"index":{"_index":"a"}}\n{"x":1}\n').safety).toBe('write')
  })

  it('treats unknown POST endpoints as writes', () => {
    expect(classifyRequest('POST', '_some/new_api').safety).toBe('write')
  })
})
