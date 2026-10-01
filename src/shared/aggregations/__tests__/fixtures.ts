import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Stage } from '../model'

const dir = join(__dirname, '..', '__fixtures__', 'aggs')

export const fixtures = (): Array<[string, Record<string, unknown>]> =>
  readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .sort()
    .map((f) => [f, JSON.parse(readFileSync(join(dir, f), 'utf8')) as Record<string, unknown>])

export const fixture = (name: string) => JSON.parse(readFileSync(join(dir, name), 'utf8')) as Record<string, unknown>

/** The pipeline from the mockup, built the way the forms build it. */
export function mockupStages(): Stage[] {
  return [
    { id: 's1', kind: 'filter', enabled: true, match: 'all', conditions: [{ field: 'status', op: 'is', value: 'active' }, { field: 'price', op: 'lte', value: 2000000 }] },
    { id: 's2', kind: 'groupBy', enabled: true, name: 'by_city', group: { type: 'terms', field: 'city.name', size: 10, order: { by: '_count', dir: 'desc' }, missing: 'skip' } },
    {
      id: 's3',
      kind: 'metrics',
      enabled: true,
      metrics: [
        { name: 'avg_price', op: 'avg', field: 'price' },
        { name: 'median_price', op: 'median', field: 'price' },
        { name: 'sellers', op: 'cardinality', field: 'seller_id' }
      ]
    },
    { id: 's4', kind: 'groupBy', enabled: true, name: 'by_month', group: { type: 'date_histogram', field: 'created_at', calendarInterval: 'month' } },
    { id: 's5', kind: 'keepOnly', enabled: true, name: 'keep_expensive', rules: [{ metric: 'avg_price', cmp: '>', value: 1500000 }] },
    { id: 's6', kind: 'sortLimit', enabled: true, by: 'avg_price', dir: 'desc', size: 5 }
  ]
}

export const FIELDS = [
  { path: 'status', name: 'status', type: 'keyword', depth: 0, details: '', multiField: false },
  { path: 'price', name: 'price', type: 'long', depth: 0, details: '', multiField: false },
  { path: 'seller_id', name: 'seller_id', type: 'long', depth: 0, details: '', multiField: false },
  { path: 'created_at', name: 'created_at', type: 'date', depth: 0, details: '', multiField: false },
  { path: 'city', name: 'city', type: 'object', depth: 0, details: '', multiField: false },
  { path: 'city.name', name: 'name', type: 'keyword', depth: 1, details: '', multiField: false },
  { path: 'title', name: 'title', type: 'text', depth: 0, details: '', multiField: false },
  { path: 'title.keyword', name: 'keyword', type: 'keyword', depth: 1, details: '', multiField: true }
]
