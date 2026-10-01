import { describe, expect, it } from 'vitest'
import { compile, SAMPLE_AGG } from '../compiler'
import { bucketsOf, flatten, hitsTotal, levelGroups, outputColumns } from '../flatten'
import { mockupStages } from './fixtures'

const month = (key_as_string: string, doc_count: number) => ({ key: 0, key_as_string, doc_count })

const RESPONSE = {
  hits: { total: { value: 48213, relation: 'eq' }, hits: [] },
  aggregations: {
    by_city: {
      sum_other_doc_count: 900,
      buckets: [
        { key: '[City A]', doc_count: 6120, avg_price: { value: 1912400 }, median_price: { values: { '50.0': 1840000 } }, sellers: { value: 2311 }, by_month: { buckets: [month('2026-01', 500), month('2026-02', 620)] } },
        { key: '[City B]', doc_count: 4880, avg_price: { value: 1688150 }, median_price: { values: { '50.0': 1620000 } }, sellers: { value: 1904 }, by_month: { buckets: [month('2026-01', 400)] } }
      ]
    }
  }
}

describe('flatten', () => {
  const c = compile({ stages: mockupStages() })

  it('produces one row per leaf bucket combination', () => {
    const t = flatten(RESPONSE, c)
    expect(t.columns).toEqual(['city.name', 'created_at', 'doc_count', 'avg_price', 'median_price', 'sellers'])
    expect(t.rows).toEqual([
      { 'city.name': '[City A]', created_at: '2026-01', doc_count: 500, avg_price: 1912400, median_price: 1840000, sellers: 2311 },
      { 'city.name': '[City A]', created_at: '2026-02', doc_count: 620, avg_price: 1912400, median_price: 1840000, sellers: 2311 },
      { 'city.name': '[City B]', created_at: '2026-01', doc_count: 400, avg_price: 1688150, median_price: 1620000, sellers: 1904 }
    ])
  })

  it('stops at a given level for the Metrics table', () => {
    const t = flatten(RESPONSE, c, 1)
    expect(t.columns).toEqual(['city.name', 'doc_count', 'avg_price', 'median_price', 'sellers'])
    expect(t.rows[1]).toEqual({ 'city.name': '[City B]', doc_count: 4880, avg_price: 1688150, median_price: 1620000, sellers: 1904 })
    expect(flatten(RESPONSE, c, 0).rows).toEqual([{ doc_count: 48213 }])
  })

  it('groups nested buckets by parent', () => {
    const g = levelGroups(RESPONSE, c, 2)
    expect(g.total).toBe(3)
    expect(g.parents.map((p) => [p.keys, p.buckets.length])).toEqual([
      [['[City A]'], 2],
      [['[City B]'], 1]
    ])
    expect(levelGroups(RESPONSE, c, 1).parents[0]!.otherDocs).toBe(900)
  })

  it('reads stats, percentiles, counts, hits, raw and composite keys through single-bucket levels', () => {
    const cc = compile({
      stages: [
        { id: 'g', kind: 'groupBy', enabled: true, name: 'combo', group: { type: 'composite', size: 10, sources: [{ field: 'city.name', type: 'terms' }, { field: 'rooms', type: 'terms' }] } },
        { id: 'f', kind: 'filter', enabled: true, match: 'all', conditions: [{ field: 'x', op: 'exists' }] },
        { id: 'm', kind: 'metrics', enabled: true, metrics: [{ name: 's', op: 'stats', field: 'price' }, { name: 'p', op: 'percentiles', field: 'price', percents: [90, 99] }, { name: 'n', op: 'count' }] },
        { id: 't', kind: 'topDocs', enabled: true, size: 1 },
        { id: 'c', kind: 'custom', enabled: true, name: 'raw', json: { geo_bounds: { field: 'loc' } } }
      ]
    })
    const res = {
      aggregations: {
        combo: {
          buckets: [
            {
              key: { city_name: 'A', rooms: 3 },
              doc_count: 10,
              filter_2: { doc_count: 4, s: { count: 4, min: 1, max: 9, avg: 5, sum: 20 }, p: { values: { '90.0': 8, '99.0': 9 } }, top_docs: { hits: { hits: [{ _id: '1' }] } }, raw: { bounds: {} } }
            }
          ]
        }
      }
    }
    const t = flatten(res, cc)
    expect(t.columns).toEqual(['city_name', 'rooms', 'doc_count', 's.count', 's.min', 's.max', 's.avg', 's.sum', 'p.90', 'p.99', 'n', 'top_docs', 'raw'])
    expect(t.rows[0]).toEqual({ city_name: 'A', rooms: 3, doc_count: 4, 's.count': 4, 's.min': 1, 's.max': 9, 's.avg': 5, 's.sum': 20, 'p.90': 8, 'p.99': 9, n: 4, top_docs: [{ _id: '1' }], raw: { bounds: {} } })
    expect(levelGroups(res, cc, 1).parents[0]!.buckets).toEqual([{ key: 'A · 3', docCount: 10 }])
  })

  it('unwraps the sampler and handles keyed buckets', () => {
    const sampled = compile({ stages: mockupStages().slice(0, 2) }, { sample: { kind: 'random', probability: 0.1 } })
    const res = { aggregations: { [SAMPLE_AGG]: { doc_count: 99, by_city: { buckets: [{ key: 'A', doc_count: 9 }] } } } }
    expect(flatten(res, sampled).rows).toEqual([{ 'city.name': 'A', doc_count: 9 }])
    expect(bucketsOf({ buckets: { cheap: { doc_count: 1 } } })).toEqual([{ key: 'cheap', node: { doc_count: 1 } }])
    expect(bucketsOf(null)).toEqual([])
    expect(hitsTotal({ hits: { total: 7 } })).toBe(7)
    expect(outputColumns({ level: 1, name: 'm', stageIndex: 0, kind: 'percentiles', percents: [50] })).toEqual(['m'])
  })
})
