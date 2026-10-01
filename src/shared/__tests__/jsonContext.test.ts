import { describe, expect, it } from 'vitest'
import { jsonContextAt } from '../jsonContext'

describe('jsonContextAt', () => {
  it('knows it is typing a key at the root', () => {
    expect(jsonContextAt('{ "si')).toMatchObject({ path: [], position: 'key', inString: true, partial: 'si', container: 'object' })
    expect(jsonContextAt('{\n  ')).toMatchObject({ position: 'key', inString: false, partial: '' })
  })

  it('tracks nested query paths', () => {
    const c = jsonContextAt('{"query":{"bool":{"filter":[{"term":{"ci')
    expect(c).toMatchObject({ path: ['query', 'bool', 'filter', 'term'], position: 'key', partial: 'ci' })
    expect(c.path.at(-1)).toBe('term')
  })

  it('reports value positions and the owning key', () => {
    expect(jsonContextAt('{"aggs":{"by_city":{"terms":{"field":"ci')).toMatchObject({ position: 'value', key: 'field', partial: 'ci', inString: true })
    expect(jsonContextAt('{"_source":["title", "pr')).toMatchObject({ position: 'value', key: '_source', container: 'array', partial: 'pr' })
    expect(jsonContextAt('{"size": 2')).toMatchObject({ position: 'value', key: 'size', inString: false, partial: '2' })
  })

  it('sees sort objects as keyed by sort', () => {
    expect(jsonContextAt('{"sort":[{"pri')).toMatchObject({ path: ['sort'], position: 'key', partial: 'pri' })
  })

  it('resets to key position after a comma and closes containers', () => {
    expect(jsonContextAt('{"query":{"match_all":{}}, "s')).toMatchObject({ path: [], position: 'key', partial: 's' })
  })

  it('ignores braces inside strings and comments', () => {
    expect(jsonContextAt('{"q": "a { [ b", // {[\n "x')).toMatchObject({ path: [], position: 'key', partial: 'x' })
    expect(jsonContextAt('{"a": "say \\"hi\\" {", "b')).toMatchObject({ position: 'key', partial: 'b' })
  })
})
