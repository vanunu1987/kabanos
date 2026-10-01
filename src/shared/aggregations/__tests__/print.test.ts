import { describe, expect, it } from 'vitest'
import { compile } from '../compiler'
import { printJson, stageOfPath } from '../print'
import { mockupStages } from './fixtures'

describe('printJson', () => {
  it('prints like the mockup and maps lines to stages', () => {
    const c = compile({ stages: mockupStages() })
    const { text, lines } = printJson(c.request)
    expect(JSON.parse(text)).toEqual(c.request)
    const gutter = lines.map((l) => (l.closing ? '' : String((stageOfPath(l.path, c.stages) ?? -1) + 1 || '')))
    const show = lines.map((l, i) => `${gutter[i]}|${l.text}`)
    expect(show).toEqual([
      '|{',
      '|  "size": 0,',
      '1|  "query": { "bool": { "filter": [{ "term": { "status": "active" } }, { "range": { "price": { "lte": 2000000 } } }] } },',
      '|  "aggs": {',
      '2|    "by_city": {',
      '2|      "terms": { "field": "city.name", "size": 10 },',
      '|      "aggs": {',
      '3|        "avg_price": { "avg": { "field": "price" } },',
      '3|        "median_price": { "percentiles": { "field": "price", "percents": [50] } },',
      '3|        "sellers": { "cardinality": { "field": "seller_id" } },',
      '4|        "by_month": { "date_histogram": { "field": "created_at", "calendar_interval": "month" } },',
      '5|        "keep_expensive": {',
      '5|          "bucket_selector": { "buckets_path": { "p": "avg_price" }, "script": "params.p > 1500000" }',
      '|        },',
      '6|        "top_5": { "bucket_sort": { "sort": [{ "avg_price": { "order": "desc" } }], "size": 5 } }',
      '|      }',
      '|    }',
      '|  }',
      '|}'
    ])
    expect(Math.max(...lines.map((l) => l.text.length))).toBeLessThanOrEqual(120)
  })

  it('breaks long lines and keeps empty containers inline', () => {
    const { lines } = printJson({ a: [1, { b: 'x'.repeat(30) }], e: {}, f: [] }, 20)
    expect(lines.map((l) => l.text)).toEqual(['{', '  "a": [', '    1,', '    {', `      "b": "${'x'.repeat(30)}"`, '    }', '  ],', '  "e": {},', '  "f": []', '}'])
    expect(printJson(null).text).toBe('null')
  })
})
