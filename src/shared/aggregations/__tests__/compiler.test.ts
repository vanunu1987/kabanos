import { describe, expect, it } from 'vitest'
import { compile, fieldsUsed, SAMPLE_AGG } from '../compiler'
import { newStage, type Stage } from '../model'
import { FIELDS, fixture, mockupStages } from './fixtures'

const at = (o: unknown, path: Array<string | number>) => path.reduce<unknown>((v, k) => (v as Record<string, unknown>)?.[k as string], o)

describe('compile', () => {
  it('builds exactly the JSON shown in the mockup (acceptance 1)', () => {
    const c = compile({ stages: mockupStages() }, { fields: FIELDS })
    expect(c.errors).toEqual([])
    // Same keys in the same order — what the JSON view prints.
    expect(JSON.stringify(c.request)).toBe(JSON.stringify(fixture('mockup.json')))
  })

  it('maps every stage to its JSON paths', () => {
    const c = compile({ stages: mockupStages() })
    expect(c.stages.map((s) => s.paths)).toEqual([
      [
        ['query', 'bool', 'filter', 0],
        ['query', 'bool', 'filter', 1]
      ],
      [['aggs', 'by_city']],
      [
        ['aggs', 'by_city', 'aggs', 'avg_price'],
        ['aggs', 'by_city', 'aggs', 'median_price'],
        ['aggs', 'by_city', 'aggs', 'sellers']
      ],
      [['aggs', 'by_city', 'aggs', 'by_month']],
      [['aggs', 'by_city', 'aggs', 'keep_expensive']],
      [['aggs', 'by_city', 'aggs', 'top_5']]
    ])
    for (const s of c.stages) for (const p of s.paths) expect(at(c.request, p)).toBeDefined()
    // Keep only / Sort & limit read city-level metrics, so they attach to the city level, not inside months.
    expect(c.stages.map((s) => s.level)).toEqual([0, 0, 1, 1, 1, 1])
    expect(c.levels.map((l) => [l.kind, l.name, l.keys])).toEqual([
      ['root', undefined, []],
      ['multi', 'by_city', ['city.name']],
      ['multi', 'by_month', ['created_at']]
    ])
  })

  it('compiles a prefix for previews', () => {
    const c = compile({ stages: mockupStages() }, { upto: 2 })
    expect(Object.keys(at(c.request, ['aggs', 'by_city', 'aggs']) as object)).toEqual(['avg_price', 'median_price', 'sellers'])
    const f = compile({ stages: mockupStages() }, { upto: 0, preview: true, sourceFields: fieldsUsed(mockupStages()) })
    expect(f.request).toEqual({
      size: 3,
      query: fixture('mockup.json').query,
      _source: { includes: ['status', 'price', 'city.name', 'seller_id', 'created_at'] },
      track_total_hits: true,
      timeout: '10s'
    })
    expect(f.documents).toBe(true)
  })

  it('applies preview caps but keeps the real values for Run', () => {
    const stages = mockupStages()
    ;(stages[1] as Extract<Stage, { kind: 'groupBy' }>).group = { type: 'terms', field: 'city.name', size: 50 }
    stages.push({ id: 't', kind: 'topDocs', enabled: true, size: 20 })
    const preview = compile({ stages }, { preview: true })
    expect(at(preview.request, ['aggs', 'by_city', 'terms', 'size'])).toBe(10)
    expect(at(preview.request, ['aggs', 'by_city', 'aggs', 'by_month', 'aggs', 'top_docs', 'top_hits', 'size'])).toBe(3)
    expect(preview.request.size).toBe(0)
    expect(preview.request.timeout).toBe('10s')
    const run = compile({ stages })
    expect(at(run.request, ['aggs', 'by_city', 'terms', 'size'])).toBe(50)
    expect(at(run.request, ['aggs', 'by_city', 'aggs', 'by_month', 'aggs', 'top_docs', 'top_hits', 'size'])).toBe(20)
    expect(run.request.timeout).toBeUndefined()
  })

  it('drops disabled stages and re-validates the rest (acceptance 3)', () => {
    const stages = mockupStages().map((s) => (s.id === 's4' ? { ...s, enabled: false } : s))
    const c = compile({ stages })
    expect(at(c.request, ['aggs', 'by_city', 'aggs', 'by_month'])).toBeUndefined()
    expect(c.errors).toEqual([])
    const noGroup = mockupStages().map((s) => (s.id === 's2' ? { ...s, enabled: false } : s))
    const d = compile({ stages: noGroup })
    expect(d.errors.map((e) => [e.stageIndex, e.message])).toEqual([
      [4, 'No metric named “avg_price” at this level.'],
      [5, 'No metric named “avg_price” at this level.']
    ])
    // Metrics without a Group by run over all documents; the month histogram becomes the first level.
    expect(Object.keys(d.request.aggs as object)).toEqual(['avg_price', 'median_price', 'sellers', 'by_month'])
    const onlyKeep = compile({ stages: [mockupStages()[4]!] })
    expect(onlyKeep.errors[0]!.message).toBe('Needs a Group by above it.')
  })

  it('validates fields against the mapping', () => {
    const c = compile(
      {
        stages: [
          { id: 'a', kind: 'groupBy', enabled: true, name: '', group: { type: 'terms', field: 'title', size: 5 } },
          { id: 'b', kind: 'metrics', enabled: true, metrics: [{ name: '', op: 'avg', field: 'status' }, { name: '', op: 'cardinality', field: 'status' }, { name: '', op: 'sum', field: '' }] },
          { id: 'c', kind: 'groupBy', enabled: true, name: '', group: { type: 'histogram', field: 'created_at', interval: 10 } },
          { id: 'd', kind: 'groupBy', enabled: true, name: '', group: { type: 'date_histogram', field: 'price' } },
          { id: 'e', kind: 'filter', enabled: true, match: 'all', conditions: [{ field: '', op: 'is', value: 'x' }] },
          { id: 'f', kind: 'filter', enabled: true, match: 'all', conditions: [{ field: 'price', op: 'between', value: 1 }] },
          { id: 'g', kind: 'filter', enabled: true, match: 'all', conditions: [{ field: 'status', op: 'oneOf', values: [] }, { field: 'status', op: 'is', value: '' }] }
        ]
      },
      { fields: FIELDS }
    )
    expect(c.errors.map((e) => [e.stageIndex, e.message])).toEqual([
      [0, '“title” is a text field and can\'t be grouped — use title.keyword.'],
      [1, 'Metric 1: average needs a numeric field; “status” is keyword.'],
      [1, 'Metric 3: pick a field.'],
      [2, 'Histogram needs a numeric field; “created_at” is date.'],
      [3, 'Date grouping needs a date field; “price” is long.'],
      [4, 'pick a field.'],
      [5, 'between needs two values.'],
      [6, 'Condition 1: add at least one value.'],
      [6, 'Condition 2: enter a value.']
    ])
    // The valid metric still compiles at the root.
    expect(c.request.aggs).toEqual({ unique_status: { cardinality: { field: 'status' } } })
  })

  it('needs a histogram for running totals and change over time', () => {
    const terms: Stage = { id: 'g', kind: 'groupBy', enabled: true, name: 'by_city', group: { type: 'terms', field: 'city.name', size: 3 } }
    const m: Stage = { id: 'm', kind: 'metrics', enabled: true, metrics: [{ name: 'rev', op: 'sum', field: 'price' }] }
    const c = compile({ stages: [terms, m, { id: 'r', kind: 'runningTotal', enabled: true, metric: 'rev' }, { id: 'x', kind: 'changeOverTime', enabled: true, metric: '', mode: 'diff' }] })
    expect(c.errors.map((e) => e.message)).toEqual(['Running total works only inside a Histogram or Date histogram group.', 'Pick a metric.'])
  })

  it('names, de-duplicates and generates safe bucket_selector scripts', () => {
    const c = compile({
      stages: [
        { id: 'g', kind: 'groupBy', enabled: true, name: '', group: { type: 'terms', field: 'title.keyword', size: 3 } },
        { id: 'm', kind: 'metrics', enabled: true, metrics: [{ name: '', op: 'avg', field: 'price' }, { name: '', op: 'avg', field: 'price' }, { name: 'p stats', op: 'stats', field: 'price' }, { name: 'n', op: 'count' }] },
        { id: 'k', kind: 'keepOnly', enabled: true, rules: [{ metric: 'avg_price', cmp: '>=', value: 1.5 }, { metric: 'p_stats.max', cmp: '<', value: 10 }, { metric: 'n', cmp: '>', value: 2 }] },
        { id: 'k2', kind: 'keepOnly', enabled: true, rules: [{ metric: 'p_stats', cmp: '>', value: 1 }] },
        { id: 'k3', kind: 'keepOnly', enabled: true, rules: [{ metric: 'avg_price', cmp: '>', value: Number.NaN }] }
      ]
    })
    expect(Object.keys(at(c.request, ['aggs', 'by_title', 'aggs']) as object)).toEqual(['avg_price', 'avg_price_2', 'p_stats', 'keep_3'])
    expect(at(c.request, ['aggs', 'by_title', 'aggs', 'keep_3'])).toEqual({
      bucket_selector: { buckets_path: { p0: 'avg_price', p1: 'p_stats.max', p2: '_count' }, script: 'params.p0 >= 1.5 && params.p1 < 10 && params.p2 > 2' }
    })
    expect(c.errors.map((e) => e.message)).toEqual(['No metric named “p_stats” at this level.', '“avg_price”: the value must be a number.'])
  })

  it('orders terms by a metric defined later and supports missing buckets', () => {
    const c = compile({
      stages: [
        { id: 'g', kind: 'groupBy', enabled: true, name: 'by_city', group: { type: 'terms', field: 'city.name', size: 5, order: { by: 'med', dir: 'asc' }, missing: 'bucket', minDocCount: 2 } },
        { id: 'm', kind: 'metrics', enabled: true, metrics: [{ name: 'med', op: 'median', field: 'price' }] }
      ]
    })
    expect(at(c.request, ['aggs', 'by_city', 'terms'])).toEqual({ field: 'city.name', size: 5, order: { 'med.50': 'asc' }, missing: '(missing)', min_doc_count: 2 })
    const bad = compile({ stages: [{ id: 'g', kind: 'groupBy', enabled: true, name: '', group: { type: 'terms', field: 'city.name', size: 5, order: { by: 'nope', dir: 'asc' } } }] })
    expect(bad.errors[0]!.message).toBe('Order by: no metric named “nope” inside this group.')
  })

  it('puts a Filter after a Group by into a filter agg that wraps the rest', () => {
    const c = compile({
      stages: [
        { id: 'g', kind: 'groupBy', enabled: true, name: 'by_city', group: { type: 'terms', field: 'city.name', size: 3 } },
        { id: 'f', kind: 'filter', enabled: true, match: 'any', conditions: [{ field: 'rooms', op: 'gte', value: 3 }, { field: 'status', op: 'isNot', value: 'sold' }] },
        { id: 'm', kind: 'metrics', enabled: true, metrics: [{ name: 'avg', op: 'avg', field: 'price' }] },
        { id: 's', kind: 'sortLimit', enabled: true, by: 'avg', dir: 'asc', size: 2, from: 1 }
      ]
    })
    expect(at(c.request, ['aggs', 'by_city', 'aggs'])).toEqual({
      filter_2: {
        filter: { bool: { should: [{ range: { rooms: { gte: 3 } } }, { bool: { must_not: [{ term: { status: 'sold' } }] } }], minimum_should_match: 1 } },
        aggs: { avg: { avg: { field: 'price' } } }
      },
      top_2: { bucket_sort: { sort: [{ 'filter_2>avg': { order: 'asc' } }], size: 2, from: 1 } }
    })
    expect(c.levels.map((l) => l.kind)).toEqual(['root', 'multi', 'single'])
  })

  it('compiles a document search when there is no Group by', () => {
    const c = compile({
      stages: [
        { id: 'f', kind: 'filter', enabled: true, match: 'any', conditions: [{ field: 'status', op: 'oneOf', values: ['a', 'b'] }, { field: 'seller_id', op: 'missing' }] },
        { id: 's', kind: 'sortLimit', enabled: true, by: 'price', dir: 'asc', size: 20, from: 40 }
      ]
    })
    expect(c.request).toEqual({
      size: 20,
      from: 40,
      query: { bool: { should: [{ terms: { status: ['a', 'b'] } }, { bool: { must_not: [{ exists: { field: 'seller_id' } }] } }], minimum_should_match: 1 } },
      sort: [{ price: { order: 'asc' } }]
    })
    expect(c.documents).toBe(true)
    expect(c.stages[0]!.paths).toEqual([['query']])
  })

  it('wraps aggs in a sampler for fast previews', () => {
    const random = compile({ stages: mockupStages() }, { preview: true, sample: { kind: 'random', probability: 0.01 } })
    expect(Object.keys(random.request.aggs as object)).toEqual([SAMPLE_AGG])
    expect(at(random.request, ['aggs', SAMPLE_AGG, 'random_sampler'])).toEqual({ probability: 0.01 })
    expect(random.stages[1]!.paths).toEqual([['aggs', SAMPLE_AGG, 'aggs', 'by_city']])
    const sampler = compile({ stages: mockupStages() }, { sample: { kind: 'sampler' } })
    expect(at(sampler.request, ['aggs', SAMPLE_AGG, 'sampler'])).toEqual({ shard_size: 10000 })
    expect(compile({ stages: mockupStages() }, { profile: true }).request.profile).toBe(true)
  })

  it('compiles every group and metric kind', () => {
    const groups: Stage[] = [
      { id: '1', kind: 'groupBy', enabled: true, name: '', group: { type: 'range', field: 'price', ranges: [{ to: 10 }, { from: 10, key: 'big' }] } },
      { id: '2', kind: 'groupBy', enabled: true, name: '', group: { type: 'date_range', field: 'created_at', format: 'yyyy', ranges: [{ from: 'now-1y' }] } },
      { id: '3', kind: 'groupBy', enabled: true, name: '', group: { type: 'filters', filters: [{ name: 'cheap', condition: { field: 'price', op: 'lt', value: 5 } }] } },
      { id: '4', kind: 'groupBy', enabled: true, name: '', group: { type: 'composite', size: 100, sources: [{ field: 'city.name', type: 'terms' }, { field: 'price', type: 'histogram', interval: 50 }, { field: 'created_at', type: 'date_histogram', interval: 'week' }] } },
      { id: '5', kind: 'groupBy', enabled: true, name: '', group: { type: 'date_histogram', field: 'created_at', fixedInterval: '12h', minDocCount: 1, format: 'yyyy-MM-dd', timeZone: 'Asia/Jerusalem' } },
      { id: '6', kind: 'metrics', enabled: true, metrics: [{ name: '', op: 'percentiles', field: 'price', percents: [25, 75] }, { name: '', op: 'value_count', field: 'price' }, { name: '', op: 'min', field: 'price' }] },
      { id: '7', kind: 'changeOverTime', enabled: true, metric: 'min_price', mode: 'pct' },
      { id: '8', kind: 'runningTotal', enabled: true, metric: '_count' },
      { id: '9', kind: 'topDocs', enabled: true, size: 500, sort: { field: 'price', dir: 'desc' }, fields: ['title'] },
      { id: '10', kind: 'custom', enabled: true, name: 'sig', json: { significant_terms: { field: 'tags' } } },
      { id: '11', kind: 'custom', enabled: true, name: 'opts', place: 'request', json: { track_total_hits: false } }
    ]
    const c = compile({ stages: groups })
    expect(c.errors).toEqual([])
    expect(c.stages[8]!.warnings).toEqual(['Capped at 100 documents per bucket.'])
    const l5 = at(c.request, ['aggs', 'by_price', 'aggs', 'by_created_at', 'aggs', 'by_filter', 'aggs', 'by_city_name_and_price_and_created_at', 'aggs', 'by_created_at']) as Record<string, Record<string, unknown>>
    expect(l5.date_histogram).toEqual({ field: 'created_at', fixed_interval: '12h', min_doc_count: 1, format: 'yyyy-MM-dd', time_zone: 'Asia/Jerusalem' })
    expect(Object.keys(l5.aggs!)).toEqual(['percentiles_price', 'count_price', 'min_price', 'min_price_change_diff', 'min_price_change', 'running_count', 'top_docs', 'sig'])
    expect((l5.aggs as Record<string, unknown>).top_docs).toEqual({ top_hits: { size: 100, sort: [{ price: { order: 'desc' } }], _source: { includes: ['title'] } } })
    expect(c.request.track_total_hits).toBe(false)
    expect(at(c.request, ['aggs', 'by_price', 'aggs', 'by_created_at', 'aggs', 'by_filter', 'aggs', 'by_city_name_and_price_and_created_at', 'composite', 'sources'])).toEqual([
      { city_name: { terms: { field: 'city.name' } } },
      { price: { histogram: { field: 'price', interval: 50 } } },
      { created_at: { date_histogram: { field: 'created_at', calendar_interval: 'week' } } }
    ])
  })

  it('creates sensible new stages', () => {
    for (const k of ['filter', 'groupBy', 'metrics', 'keepOnly', 'sortLimit', 'runningTotal', 'changeOverTime', 'topDocs', 'custom'] as const) {
      expect(newStage(k, { keyword: 'city.name', numeric: 'price' }).kind).toBe(k)
    }
  })
})
