import { describe, expect, it } from 'vitest'
import { formatBlock, formatBody, reindent } from '../format'

describe('formatBody', () => {
  it('pretty-prints valid JSON', () => {
    expect(formatBody('{"query":{"term":{"status":"active"}},"size":2}')).toBe('{\n  "query": {\n    "term": {\n      "status": "active"\n    }\n  },\n  "size": 2\n}')
  })

  it('keeps NDJSON one document per line', () => {
    expect(formatBody('{ "index": {"_index":"a"} }\n{ "x" : 1 }\n')).toBe('{"index":{"_index":"a"}}\n{"x":1}')
  })

  it('re-indents bodies with comments without losing them', () => {
    const src = '{\n"query": { // only active\n"term": {\n"status": "active"\n}\n},\n# size\n"size": 1\n}'
    expect(formatBody(src)).toBe('{\n  "query": { // only active\n    "term": {\n      "status": "active"\n    }\n  },\n  # size\n  "size": 1\n}')
  })

  it('leaves triple-quoted blocks untouched', () => {
    const src = '{\n"script": {\n"source": """\n    ctx.a = 1;\n  if (x) { y }\n"""\n}\n}'
    expect(formatBody(src)).toBe('{\n  "script": {\n    "source": """\n    ctx.a = 1;\n  if (x) { y }\n"""\n  }\n}')
  })

  it('handles half-typed JSON and braces inside strings', () => {
    expect(reindent('{\n"a": "{[",\n"b": {\n"c": 1')).toBe('{\n  "a": "{[",\n  "b": {\n    "c": 1')
  })
})

describe('formatBlock', () => {
  it('normalises the request line and formats the body', () => {
    expect(formatBlock('GET    listings/_search\n{"size":1}')).toBe('GET listings/_search\n{\n  "size": 1\n}')
    expect(formatBlock('GET _cluster/health')).toBe('GET _cluster/health')
  })
})
