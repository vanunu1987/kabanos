import { describe, expect, it } from 'vitest'
import { esqlId, esqlValue, toEsql } from '../esql'
import type { Stage } from '../model'
import { mockupStages } from './fixtures'

describe('toEsql', () => {
  it('translates the mockup pipeline and warns about the nested group (acceptance 5)', () => {
    const r = toEsql({ target: 'listings-v7', stages: mockupStages() })
    expect(r.lines).toEqual([
      { text: 'FROM listings-v7' },
      { text: '| WHERE status == "active" AND price <= 2000000', stage: 1 },
      { text: '| WHERE city.name IS NOT NULL', stage: 2 },
      { text: '| STATS avg_price = AVG(price), median_price = MEDIAN(price), sellers = COUNT_DISTINCT(seller_id), doc_count = COUNT(*)', stage: 3 },
      { text: '        BY city.name', stage: 2 },
      { text: '| SORT doc_count DESC', stage: 2 },
      { text: '| LIMIT 10', stage: 2 },
      { text: '| WHERE avg_price > 1500000', stage: 5 },
      { text: '| SORT avg_price DESC', stage: 6 },
      { text: '| LIMIT 5', stage: 6 }
    ])
    expect(r.warnings).toEqual([{ stage: 4, message: "Stage 4 (group by month inside each city) can't be expressed in a single ES|QL STATS, so it is left out here. Turn stage 4 off, or keep using the JSON view." }])
    expect(r.query.split('\n')[0]).toBe('FROM listings-v7')
  })

  it('has no warnings once the nested group is off', () => {
    const stages = mockupStages().map((s) => (s.id === 's4' ? { ...s, enabled: false } : s))
    expect(toEsql({ target: 'x', stages }).warnings).toEqual([])
  })

  it('translates date histograms, comparisons and negations', () => {
    const stages: Stage[] = [
      { id: 'f', kind: 'filter', enabled: true, match: 'any', conditions: [{ field: 'status', op: 'isNot', value: 'sold' }, { field: 'tags', op: 'oneOf', values: ['a', 'b"c'] }, { field: 'x', op: 'missing' }, { field: 'p', op: 'between', value: 1, value2: 2 }] },
      { id: 'f2', kind: 'filter', enabled: true, match: 'all', conditions: [{ field: 'a', op: 'exists' }, { field: 'b', op: 'gt', value: 1 }, { field: 'c', op: 'gte', value: 2 }, { field: 'd', op: 'lt', value: true }, { field: 'title', op: 'contains', value: 'garden' }] },
      { id: 'g', kind: 'groupBy', enabled: true, name: 'month', group: { type: 'date_histogram', field: 'created_at', calendarInterval: 'month', minDocCount: 1 } },
      { id: 'm', kind: 'metrics', enabled: true, metrics: [{ name: 's', op: 'stats', field: 'price' }, { name: 'p', op: 'percentiles', field: 'price', percents: [95] }, { name: 'n', op: 'count' }, { name: 'v', op: 'value_count', field: 'price' }, { name: '', op: 'sum', field: 'price' }] },
      { id: 'r', kind: 'runningTotal', enabled: true, metric: 'n' },
      { id: 's', kind: 'sortLimit', enabled: true, by: '_key', dir: 'asc', size: 12, from: 2 }
    ]
    const r = toEsql({ target: 'logs-*', stages })
    expect(r.lines.map((l) => l.text)).toEqual([
      'FROM logs-*',
      '| WHERE ((status != "sold" OR status IS NULL)) OR (tags IN ("a", "b\\"c")) OR (x IS NULL) OR (p >= 1 AND p <= 2)',
      '| WHERE a IS NOT NULL AND b > 1 AND c >= 2 AND d < true AND title LIKE "*garden*"',
      '| STATS s.count = COUNT(price), s.min = MIN(price), s.max = MAX(price), s.avg = AVG(price), s.sum = SUM(price), `p.95` = PERCENTILE(price, 95), n = COUNT(*), v = COUNT(price), sum_price = SUM(price), doc_count = COUNT(*)',
      '        BY month = BUCKET(created_at, 1 month)',
      '| SORT month ASC',
      '| LIMIT 12'
    ])
    expect(r.warnings.map((w) => w.stage)).toEqual([2, 5, 6])
  })

  it('warns for groups and stages without an equivalent', () => {
    const range: Stage[] = [{ id: 'g', kind: 'groupBy', enabled: true, name: '', group: { type: 'range', field: 'price', ranges: [{ to: 1 }] } }]
    expect(toEsql({ target: 'i', stages: range }).warnings.map((w) => w.stage)).toEqual([1])
    const many: Stage[] = [
      { id: 'm0', kind: 'metrics', enabled: true, metrics: [{ name: 'all', op: 'avg', field: 'price' }] },
      { id: 'g', kind: 'groupBy', enabled: true, name: '', group: { type: 'composite', size: 5, sources: [{ field: 'a', type: 'terms' }, { field: 'b', type: 'terms' }] } },
      { id: 'f', kind: 'filter', enabled: true, match: 'all', conditions: [{ field: 'x', op: 'is', value: 1 }] },
      { id: 't', kind: 'topDocs', enabled: true, size: 2 },
      { id: 'raw', kind: 'filter', enabled: true, match: 'all', conditions: [], raw: { match_all: {} } }
    ]
    const r = toEsql({ target: 'i', stages: many })
    expect(r.lines.map((l) => l.text)).toEqual(['FROM i', '| STATS doc_count = COUNT(*) BY a, b', '| SORT a, b', '| LIMIT 5'])
    expect(r.warnings.map((w) => w.stage)).toEqual([1, 3, 4, 5])
  })

  it('translates plain searches and metrics over all documents', () => {
    expect(toEsql({ target: 'i', stages: [{ id: 't', kind: 'topDocs', enabled: true, size: 3, sort: { field: 'price', dir: 'desc' }, fields: ['title'] }] }).query).toBe('FROM i\n| KEEP title\n| SORT price DESC\n| LIMIT 3')
    expect(toEsql({ target: 'i', stages: [{ id: 's', kind: 'sortLimit', enabled: true, by: 'price', dir: 'asc', size: 7, from: 1 }] }).warnings).toHaveLength(1)
    expect(toEsql({ target: 'i', stages: [{ id: 'm', kind: 'metrics', enabled: true, metrics: [{ name: 'a', op: 'avg', field: 'price' }] }] }).query).toBe('FROM i\n| STATS a = AVG(price)')
    expect(toEsql({ target: 'i', stages: [] }).query).toBe('FROM i\n| LIMIT 10')
    expect(esqlId('9x')).toBe('`9x`')
    expect(esqlValue(undefined)).toBe('""')
  })
})
