import { describe, expect, it } from 'vitest'
import { compile } from '../compiler'
import { decompile, stageFragment, stagesFromFragment } from '../decompiler'
import { fixture, fixtures, mockupStages } from './fixtures'

describe('decompile', () => {
  it.each(fixtures())('round-trips %s unchanged (acceptance 4)', (_name, body) => {
    const d = decompile(body)
    expect(d.exact).toBe(true)
    expect(compile({ stages: d.stages }).request).toEqual(body)
  })

  it('maps the mockup request back to the six form stages', () => {
    const d = decompile(fixture('mockup.json'))
    expect(d.unsupported).toEqual([])
    expect(d.stages.map((s) => s.kind)).toEqual(['filter', 'groupBy', 'metrics', 'groupBy', 'keepOnly', 'sortLimit'])
    const strip = (o: unknown) => JSON.parse(JSON.stringify(o, (k, v) => (k === 'id' ? undefined : v))) as unknown
    const expected = mockupStages()
    // The forms' defaults (order by count desc, skip missing) aren't in the JSON.
    ;(expected[1] as { group: Record<string, unknown> }).group = { type: 'terms', field: 'city.name', size: 10 }
    ;(expected[5] as { name?: string }).name = 'top_5'
    expect(strip(d.stages)).toEqual(strip(expected))
  })

  it('keeps everything it cannot map as Custom JSON', () => {
    const d = decompile(fixture('unsupported.json'))
    expect(d.unsupported).toEqual(['aggs.by_city', 'aggs.keywords', 'aggs.scripted'])
    expect(d.stages.map((s) => s.kind)).toEqual(['filter', 'custom', 'custom', 'custom', 'groupBy', 'custom'])
    expect(d.stages[0]).toMatchObject({ raw: { multi_match: { query: 'garden', fields: ['title', 'description'] } } })
    expect(d.stages.at(-1)).toMatchObject({ kind: 'custom', place: 'request', json: { track_total_hits: true } })
  })

  it('maps pipeline aggs, % change pairs and filter aggs', () => {
    const d = decompile(fixture('timeseries.json'))
    expect(d.stages.map((s) => s.kind)).toEqual(['filter', 'groupBy', 'metrics', 'runningTotal', 'changeOverTime', 'changeOverTime'])
    expect(d.stages[5]).toMatchObject({ name: 'growth', mode: 'pct', metric: 'revenue' })
    const n = decompile(fixture('nested-filter.json'))
    expect(n.stages.map((s) => s.kind)).toEqual(['filter', 'groupBy', 'filter', 'metrics', 'topDocs', 'sortLimit'])
    expect(n.stages[0]).toMatchObject({ match: 'any' })
  })

  it('falls back to coarser stages instead of losing anything', () => {
    // A bucket_sort on _count placed after the nested group: it can't be told apart from one inside it.
    const body = { size: 0, aggs: { a: { terms: { field: 'x', size: 2 }, aggs: { b: { terms: { field: 'y', size: 2 } }, s: { bucket_sort: { sort: [{ _count: { order: 'asc' } }], size: 1 } } } } } }
    const d = decompile(body)
    expect(d.exact).toBe(true)
    expect(compile({ stages: d.stages }).request).toEqual(body)
    const weird = { size: 0, aggs: { a: { terms: { field: 'x', size: 2 }, aggs: { b: { terms: { field: 'y', size: 2 }, aggs: { m: { avg: { field: 'z' } } } }, m: { avg: { field: 'z' } }, k: { bucket_selector: { buckets_path: { p: 'm' }, script: 'params.p > 1' } } } } } }
    const w = decompile(weird)
    expect(compile({ stages: w.stages }).request).toEqual(weird)
    const empty = decompile({})
    expect(empty.stages).toEqual([])
    expect(decompile({ query: 'oops' as unknown as object, size: -1, from: 'x', sort: 'price', _source: false }).exact).toBe(true)
  })

  it('edits one stage through its JSON fragment', () => {
    const stages = mockupStages()
    const frag = stageFragment({ stages }, 1)
    expect(frag).toEqual({ by_city: { terms: { field: 'city.name', size: 10 } } })
    const edited = stagesFromFragment({ by_city: { terms: { field: 'city.name', size: 25 } } }, true)
    expect(edited).toMatchObject([{ kind: 'groupBy', name: 'by_city', group: { size: 25 } }])
    expect(stageFragment({ stages }, 0)).toEqual({ query: fixture('mockup.json').query })
    expect(stagesFromFragment(stageFragment({ stages }, 0), true)).toMatchObject([{ kind: 'filter', conditions: [{ op: 'is' }, { op: 'lte' }] }])
    expect(stageFragment({ stages }, 2)).toEqual({ avg_price: { avg: { field: 'price' } }, median_price: { percentiles: { field: 'price', percents: [50] } }, sellers: { cardinality: { field: 'seller_id' } } })
    expect(stagesFromFragment(stageFragment({ stages }, 4), false)).toMatchObject([{ kind: 'keepOnly', rules: [{ metric: 'avg_price', cmp: '>', value: 1500000 }] }])
    expect(stagesFromFragment({ x: { geo_bounds: { field: 'loc' } } }, false)).toMatchObject([{ kind: 'custom', name: 'x' }])
    expect(stagesFromFragment({ size: 5, sort: [{ price: { order: 'asc' } }] }, true)).toMatchObject([{ kind: 'sortLimit', by: 'price', size: 5 }])
    const custom = { id: 'c', kind: 'custom' as const, enabled: true, name: 'opts', place: 'request' as const, json: { timeout: '1s' } }
    expect(stageFragment({ stages: [custom] }, 0)).toEqual({ timeout: '1s' })
  })
})

const g = (aggs: Record<string, unknown>) => ({ size: 0, aggs: { a: { terms: { field: 'x', size: 2 }, aggs } } })

/** Odd shapes the decompiler must keep intact — each one either maps to forms or becomes Custom JSON. */
const TRICKY: Array<Record<string, unknown>> = [
  { size: 10 },
  { from: 5, sort: [{ a: { order: 'asc' } }] },
  { size: 0, sort: [{ a: { order: 'asc' } }], _source: ['x'], from: 2, aggs: { m: { avg: { field: 'p' } } } },
  { size: 3, aggs: { m: { avg: { field: 'p' } } }, _source: { includes: ['a'] } },
  { size: 3, from: 1, _source: { includes: ['a'] } },
  { query: { bool: { filter: [{ term: { a: { value: 1 } } }] } } },
  { query: { bool: { filter: [{ term: { a: 1 } }, { bool: { should: [{ term: { b: 2 } }], minimum_should_match: 1 } }, { match_all: {} }] } } },
  { query: { bool: { filter: [{ match_all: {} }], must_not: [{ term: { a: 1 } }, { exists: { field: 'b' } }] } } },
  { query: { bool: { must_not: [{ term: { a: 1 } }] } } },
  { query: { bool: { must_not: [{ range: { a: { gt: 1 } } }] } } },
  { query: { bool: { filter: { term: { a: 1 } } } } },
  { query: { bool: { filter: [] } } },
  { query: { bool: { should: [{ bool: { must_not: [{ range: { a: { gt: 1 } } }] } }], minimum_should_match: 1 } } },
  { query: { bool: { should: [{ terms: { a: [] } }, { range: { a: { gt: 1, format: 'x' } } }, { exists: { field: 1 } }, { term: { a: 1, b: 2 } }, 'x'], minimum_should_match: 1 } } },
  { query: { bool: { filter: [{ range: { a: { gte: 1, lt: 2 } } }, { match: { a: { query: 'x' } } }, { range: { a: 5 } }, { unknown: 1 }, {}] } } },
  { query: { bool: { filter: [{ bool: { must_not: [{ term: { a: 1 } }, { term: { b: 1 } }] } }] } } },
  g({ m: { avg: { field: 'p', missing: 0 } }, n: { percentiles: { field: 'p' } }, o: { percentiles: { field: 'p', percents: ['x'] } }, q: { percentiles: { field: 'p', percents: [50], keyed: false } }, r: { avg: 1 }, s: { avg: { field: 'p' }, meta: {} } }),
  g({ k: { bucket_selector: { buckets_path: { p: 'm' }, script: 'params.p > x' } }, k2: { bucket_selector: { buckets_path: { p: 1 }, script: 'params.p > 1' } }, k3: { bucket_selector: { buckets_path: 'm', script: 'params.p > 1' } }, k4: { bucket_selector: { buckets_path: { p: 'm' }, script: 'params.q > 1' } } }),
  g({ s: { bucket_sort: { size: 1 } }, s2: { bucket_sort: { sort: [{ m: 'asc' }], size: 1 } }, s3: { bucket_sort: { sort: [{ _count: { order: 'asc' } }], size: 1, from: 0 } }, s4: { bucket_sort: { sort: [{ _count: { order: 'up' } }], size: 1 } }, s5: { bucket_sort: { sort: [{ a: { order: 'asc' }, b: { order: 'asc' } }], size: 1 } } }),
  g({ c: { cumulative_sum: { buckets_path: 'm', format: 'x' } }, d: { derivative: { buckets_path: ['m'] } }, b: { bucket_script: { buckets_path: { d: 'nope', v: 'm' }, script: 'params.d / (params.v - params.d) * 100' } }, x: { serial_diff: { buckets_path: 'm' } } }),
  g({ t: { top_hits: { size: 0 } }, t2: { top_hits: { size: 2, sort: ['_score'] } }, t3: { top_hits: { size: 2, _source: false } }, t4: { top_hits: { size: 2, from: 1 } }, t5: { top_hits: { size: 2 }, aggs: {} } }),
  { size: 0, aggs: { t: { top_hits: { size: 2 } }, k: { bucket_selector: { buckets_path: { p: '_count' }, script: 'params.p > 1' } }, f: { filter: { term: { a: 1 } }, aggs: { m: { avg: { field: 'p' } } } } } },
  { size: 0, aggs: { a: { terms: { field: 'x', size: 2, order: [{ _count: 'asc' }] } } } },
  { size: 0, aggs: { a: { terms: { field: 'x', size: 2, order: { _count: 'up' } } } } },
  { size: 0, aggs: { a: { terms: { field: 'x', size: 2, missing: 'N/A' } } } },
  { size: 0, aggs: { a: { terms: { field: 'x', size: -1 } } } },
  { size: 0, aggs: { a: { terms: { field: 'x' } } } },
  { size: 0, aggs: { a: { terms: 'x' } } },
  { size: 0, aggs: { a: { histogram: { field: 'x', interval: '1' } } } },
  { size: 0, aggs: { a: { date_histogram: { field: 'x', interval: '1d' } } } },
  { size: 0, aggs: { a: { range: { field: 'x', ranges: [{ from: 1 }], format: 'x' } } } },
  { size: 0, aggs: { a: { date_range: { field: 'x', ranges: [{ from: 'now' }], keyed: true } } } },
  { size: 0, aggs: { a: { filters: { filters: [{ term: { a: 1 } }] } } } },
  { size: 0, aggs: { a: { filters: { filters: { x: { match_all: {} } } } } } },
  { size: 0, aggs: { a: { composite: { size: 5, sources: [{ a: { terms: { field: 'a' } }, b: {} }] } } } },
  { size: 0, aggs: { a: { composite: { size: 5, sources: [{ a: { geotile_grid: { field: 'a' } } }] } } } },
  { size: 0, aggs: { a: { composite: { size: 5, sources: [{ a: { terms: { script: 'x' } } }] } } } },
  { size: 0, aggs: { a: { composite: { size: 5, sources: ['a'] } } } },
  { size: 0, aggs: { a: { composite: { size: 5, sources: [{ a: 'terms' }] } } } },
  { size: 0, aggs: { a: { composite: { size: 5, after: {}, sources: [] } } } },
  { size: 0, aggs: { a: { terms: { field: 'x', size: 2 }, aggs: { f: { filter: { match_all: {} }, aggs: { m: { avg: { field: 'p' } } } } } } } },
  { size: 0, aggs: { a: 'x', b: { terms: { field: 'x', size: 1 }, meta: { a: 1 } } } }
]

describe('decompile edge cases', () => {
  it.each(TRICKY.map((b, i) => [i, b] as const))('round-trips shape %i', (_i, body) => {
    const d = decompile(body as Record<string, unknown>)
    expect(compile({ stages: d.stages }).request).toEqual(body)
  })
})
