import { describe, expect, it } from 'vitest'
import spec from '../../renderer/autocomplete/spec/es.json'
import { jsonContextAt } from '../jsonContext'
import { bodySuggestions, matchEndpoint, pathSuggestions, type Spec } from '../specEngine'

const S = spec as unknown as Spec
const names = { indices: ['listings-v7', '.security-7'], aliases: ['listings'], dataStreams: ['search-logs'] }
const body = (path: string, text: string) => {
  const m = matchEndpoint(S, 'POST', path)!
  return bodySuggestions(S, m.endpoint.b!, jsonContextAt(text))
}

describe('matchEndpoint', () => {
  it('matches index-scoped and cluster endpoints', () => {
    expect(matchEndpoint(S, 'POST', 'listings/_search?size=0')?.endpoint.n).toBe('search')
    expect(matchEndpoint(S, 'GET', '_cluster/health')?.endpoint.n).toBe('cluster.health')
    expect(matchEndpoint(S, 'GET', 'listings/_doc/42')?.endpoint.n).toBe('get')
    expect(matchEndpoint(S, 'PUT', 'listings-v8')?.endpoint.n).toBe('indices.create')
  })
})

describe('pathSuggestions', () => {
  it('offers endpoints and index names for the first segment', () => {
    const s = pathSuggestions(S, 'GET', '', names)
    expect(s.map((x) => x.label)).toEqual(expect.arrayContaining(['_cat/indices', '_cluster/health', 'listings-v7', 'listings', 'search-logs']))
    expect(s.map((x) => x.label)).not.toContain('.security-7')
  })
  it('offers index-level endpoints after an index', () => {
    const s = pathSuggestions(S, 'POST', 'listings/', names).map((x) => x.label)
    expect(s).toEqual(expect.arrayContaining(['_search', '_count', '_delete_by_query']))
  })
  it('offers query params after ?', () => {
    const s = pathSuggestions(S, 'POST', 'listings/_search?track_total_hits=true&', names).map((x) => x.label)
    expect(s).toContain('size')
    expect(s).not.toContain('track_total_hits')
  })
})

describe('bodySuggestions', () => {
  it('root keys of a search body', () => {
    const w = body('listings/_search', '{ "')
    expect(w?.kind).toBe('keys')
    expect(w && 'keys' in w && w.keys).toEqual(expect.arrayContaining(['query', 'aggs', 'size', 'sort', 'track_total_hits']))
  })
  it('query types inside query and bool clauses', () => {
    const w = body('_search', '{"query":{"bool":{"filter":[{"')
    expect(w && 'keys' in w && w.keys).toEqual(expect.arrayContaining(['term', 'range', 'match', 'bool', 'exists']))
  })
  it('fields as keys of term / range / match', () => {
    expect(body('_search', '{"query":{"term":{"')).toEqual({ kind: 'fields' })
    expect(body('_search', '{"query":{"range":{"')).toEqual({ kind: 'fields' })
  })
  it('options under a field in a range query', () => {
    const w = body('_search', '{"query":{"range":{"price":{"')
    expect(w && 'keys' in w && w.keys).toEqual(expect.arrayContaining(['gte', 'lte', 'format']))
  })
  it('fields as values of "field" in aggregations and enums for values', () => {
    expect(body('_search', '{"aggs":{"by_city":{"terms":{"field":"')).toEqual({ kind: 'fields' })
    const w = body('_search', '{"aggs":{"by_city":{"terms":{"')
    expect(w && 'keys' in w && w.keys).toEqual(expect.arrayContaining(['field', 'size', 'order']))
    const op = body('_search', '{"query":{"match":{"title":{"operator":"')
    expect(op && 'values' in op && op.values.map((v) => v.toLowerCase())).toEqual(expect.arrayContaining(['and', 'or']))
  })
  it('agg names are free-form', () => {
    expect(body('_search', '{"aggs":{"')).toBeNull()
  })
})
