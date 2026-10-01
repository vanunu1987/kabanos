import { describe, expect, it } from 'vitest'
import { blockText, parseBlock, parseConsole, parseCurl, resolvePath, toCurl } from '../consoleParser'

const KIBANA_EXPORT = `# Top cities by listings
GET listings/_search
{
  "size": 0,
  "aggs": { "cities": { "terms": { "field": "city.name" } } }
}

### Cluster health
GET _cluster/health

// count active
POST /listings/_count
{
  // only active
  "query": { "term": { "status": "active" } }
}
GET _cat/indices?v
PUT _ingest/pipeline/p1
{
  "processors": [{ "script": { "source": """
    ctx.a = 1;
    ctx.b = "x";
  """ } }]
}
POST _bulk
{"index":{"_index":"a"}}
{"x":1}
`

describe('parseConsole', () => {
  const reqs = parseConsole(KIBANA_EXPORT)

  it('splits every request', () => {
    expect(reqs.map((r) => `${r.method} ${r.path}`)).toEqual([
      'GET listings/_search',
      'GET _cluster/health',
      'POST listings/_count',
      'GET _cat/indices?v',
      'PUT _ingest/pipeline/p1',
      'POST _bulk'
    ])
  })

  it('turns comment lines above a request into its title', () => {
    expect(reqs.map((r) => r.title)).toEqual(['Top cities by listings', 'Cluster health', 'count active', undefined, undefined, undefined])
  })

  it('keeps bodies (with inner comments) and empty bodies', () => {
    expect(JSON.parse(reqs[0]!.body)).toEqual({ size: 0, aggs: { cities: { terms: { field: 'city.name' } } } })
    expect(reqs[1]!.body).toBe('')
    expect(reqs[2]!.body).toContain('// only active')
  })

  it('converts triple-quoted strings to JSON strings', () => {
    const body = JSON.parse(reqs[4]!.body)
    expect(body.processors[0].script.source).toContain('ctx.b = "x";')
  })

  it('keeps NDJSON lines', () => {
    expect(reqs[5]!.body.split('\n')).toHaveLength(2)
  })
})

describe('parseBlock / blockText', () => {
  it('round-trips', () => {
    const b = { method: 'POST' as const, path: 'listings/_search', body: '{\n  "size": 1\n}' }
    expect(parseBlock(blockText(b))).toEqual(b)
    expect(parseBlock('get _cat/indices')).toEqual({ method: 'GET', path: '_cat/indices', body: '' })
    expect(parseBlock('not a request')).toBeUndefined()
  })
})

describe('parseCurl', () => {
  it('parses method, URL, body and flags credentials', () => {
    const c = parseCurl(`curl -X POST "https://elastic:pw@es.local:9200/listings/_search?size=1" -H 'Content-Type: application/json' -d '{"query":{"match_all":{}}}'`)
    expect(c).toMatchObject({ method: 'POST', path: 'listings/_search?size=1', baseUrl: 'https://es.local:9200', hasCredentials: true })
    expect(JSON.parse(c!.body)).toEqual({ query: { match_all: {} } })
  })
  it('defaults to GET, or POST with data, and handles line continuations', () => {
    expect(parseCurl('curl localhost:9200/_cat/indices')).toMatchObject({ method: 'GET', path: '_cat/indices', hasCredentials: false })
    expect(parseCurl(`curl -u elastic:x \\\n  localhost:9200/a/_doc --data '{"a":1}'`)).toMatchObject({ method: 'POST', path: 'a/_doc', hasCredentials: true })
  })
  it('rejects non-curl text', () => {
    expect(parseCurl('GET _search')).toBeUndefined()
  })
})

describe('toCurl', () => {
  it('never embeds credentials', () => {
    const s = toCurl('https://es.local:9200', 'POST', 'listings/_search', '{\n "size": 1 }', { auth: 'basic', username: 'elastic' })
    expect(s).toContain(`curl -XPOST 'https://es.local:9200/listings/_search'`)
    expect(s).toContain(`-u 'elastic:$ES_PASSWORD'`)
    expect(s).toContain(`-d '{"size":1}'`)
  })
})

describe('resolvePath', () => {
  it('prefixes index-scoped endpoints with the default target only', () => {
    expect(resolvePath('_search', 'listings')).toBe('listings/_search')
    expect(resolvePath('_doc/1', 'listings')).toBe('listings/_doc/1')
    expect(resolvePath('_cat/indices', 'listings')).toBe('_cat/indices')
    expect(resolvePath('_cluster/health', 'listings')).toBe('_cluster/health')
    expect(resolvePath('other/_search', 'listings')).toBe('other/_search')
    expect(resolvePath('_search')).toBe('_search')
  })
})
