/** Explorer with a large cluster: hundreds of indices and aliases; sections collapse, also while filtering. */
import { expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { CLUSTERS, connect, launch } from './helpers'

test.describe.configure({ mode: 'serial' })
let app: ElectronApplication
let page: Page
const AUTH = { authorization: `Basic ${Buffer.from('elastic:sift-dev-pass').toString('base64')}`, 'content-type': 'application/json' }
const N = 300
const names = Array.from({ length: N }, (_, i) => `bulk_vehicles_${String(i).padStart(3, '0')}`)
const es = (path: string, init: RequestInit = {}) => fetch(`http://localhost:9202/${path}`, { ...init, headers: AUTH })

test.beforeAll(async () => {
  // 300 tiny indices (1 shard, 0 replicas) and an alias over each 10 of them.
  await es('_index_template/bulk_vehicles', { method: 'PUT', body: JSON.stringify({ index_patterns: ['bulk_vehicles_*'], priority: 50, template: { settings: { number_of_shards: 1, number_of_replicas: 0 } } }) })
  for (let i = 0; i < N; i += 50) await Promise.all(names.slice(i, i + 50).map((n) => es(n, { method: 'PUT' })))
  const actions = names.map((n, i) => ({ add: { index: n, alias: `bulk_alias_${Math.floor(i / 10)}` } }))
  await es('_aliases', { method: 'POST', body: JSON.stringify({ actions }) })
  ;({ app, page } = await launch())
  await connect(page, CLUSTERS.es9)
})
test.afterAll(async () => {
  await app?.close()
  for (let i = 0; i < N; i += 100) await es(names.slice(i, i + 100).join(','), { method: 'DELETE' })
  await es('_index_template/bulk_vehicles', { method: 'DELETE' })
})

const section = (name: string) => page.locator('.tree-section', { has: page.locator('.tree-sec-head', { hasText: name }) })

test('large tree renders with "+ N more" and sections collapse', async () => {
  const indices = section('Indices')
  await expect(indices.locator('.tree-sec-head .count')).toHaveText(String(N + 5))
  await expect(indices.locator('.tree-row.more')).toContainText(`+ ${N + 5 - 12} more`)
  await indices.locator('.tree-sec-head').click()
  await expect(indices.locator('.tree-row')).toHaveCount(0)
  await indices.locator('.tree-sec-head').click()
  await expect(indices.locator('.tree-row:not(.more)')).toHaveCount(12)
})

test('sections still collapse while filtering', async () => {
  await page.getByPlaceholder(/Filter indices/).fill('vehicles')
  const indices = section('Indices')
  await expect(indices.locator('.tree-row').first()).toBeVisible()
  await indices.locator('.tree-sec-head').click()
  await expect(indices.locator('.tree-row')).toHaveCount(0)
  const aliases = section('Aliases')
  await expect(aliases.locator('.tree-row').first()).toBeVisible()
  await aliases.locator('.tree-sec-head').click()
  await expect(aliases.locator('.tree-row')).toHaveCount(0)
  // Searching for a template: matches show, and the section collapses too.
  await page.getByPlaceholder(/Filter indices/).fill('template')
  const templates = section('Index templates')
  await expect(templates.locator('.tree-row').first()).toBeVisible()
  await templates.locator('.tree-sec-head').click()
  await expect(templates.locator('.tree-row')).toHaveCount(0)
  // A new search opens the sections again so its matches are visible.
  await page.getByPlaceholder(/Filter indices/).fill('')
  await page.getByPlaceholder(/Filter indices/).fill('listings')
  await expect(section('Indices').locator('.tree-row').first()).toBeVisible()
  await expect(section('Index templates').locator('.tree-row')).toHaveCount(1)
  await page.screenshot({ path: 'e2e/screens/80-collapsed-filter.png' })
})

test('collapse all / expand all', async () => {
  await page.getByPlaceholder(/Filter indices/).fill('')
  await page.getByRole('button', { name: 'Collapse all sections' }).click()
  await expect(page.locator('.explorer-tree .tree-row')).toHaveCount(0)
  await page.getByRole('button', { name: 'Expand all sections' }).click()
  await expect(section('Indices').locator('.tree-row:not(.more)')).toHaveCount(12)
})
