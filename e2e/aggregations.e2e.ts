/** Aggregation pipeline: build the mockup pipeline through the forms, preview every stage, run, JSON / ES|QL views, save. */
import { expect, test, type ElectronApplication, type Locator, type Page } from '@playwright/test'
import { CLUSTERS, connect, launch, pasteInto } from './helpers'

test.describe.configure({ mode: 'serial' })
let app: ElectronApplication
let page: Page
const AUTH = { authorization: `Basic ${Buffer.from('elastic:sift-dev-pass').toString('base64')}`, 'content-type': 'application/json' }
const es = async <T>(path: string, body: unknown): Promise<T> => (await (await fetch(`http://localhost:9202/${path}`, { method: 'POST', headers: AUTH, body: JSON.stringify(body) })).json()) as T

const stage = (n: number) => page.locator('.agg-card').nth(n - 1)
async function pick(scope: Locator, label: string, option: RegExp | string): Promise<void> {
  await scope.getByRole('button', { name: label, exact: true }).click()
  const list = page.getByRole('listbox', { name: label, exact: true })
  const search = list.getByRole('textbox')
  if (typeof option === 'string' && (await search.count())) await search.fill(option)
  await list.getByRole('option', { name: typeof option === 'string' ? new RegExp(`^${option.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`) : option }).first().click()
}
async function addStage(kind: string): Promise<Locator> {
  const before = await page.locator('.agg-card').count()
  await page.locator('.agg-add-row').getByRole('button', { name: kind, exact: true }).click()
  await expect(page.locator('.agg-card')).toHaveCount(before + 1)
  return stage(before + 1)
}

test.beforeAll(async () => {
  ;({ app, page } = await launch())
  await connect(page, CLUSTERS.es9)
})
test.afterAll(async () => app?.close())

test('builds the mockup pipeline stage by stage, each with its own output', async () => {
  await page.locator('.tree-row[title="listings-v7"]').click()
  await page.getByRole('button', { name: 'Query this index' }).click()
  await page.getByRole('tab', { name: 'Aggregations', exact: true }).click()
  await expect(page.getByText('Build an aggregation step by step')).toBeVisible()

  // 1 · Filter status is "active" — output: exact document count + sample docs.
  const active = (await es<{ count: number }>('listings-v7/_count', { query: { term: { status: 'active' } } })).count
  const f = await addStage('Filter')
  await pick(f, 'Condition 1 field', 'status')
  await f.getByLabel('Condition 1 value').fill('active')
  await expect(f.locator('.agg-out-head')).toContainText(`${active.toLocaleString('en-US')} documents`)
  await expect(f.locator('.agg-doc')).toHaveCount(3)

  // 2 · Group by city.name
  const g = await addStage('Group by')
  await pick(g, 'Group field', 'city.name')
  await g.getByLabel('Group name').fill('by_city')
  await expect(g.locator('.agg-out-head')).toContainText(/\d+ buckets/)
  await expect(g.locator('.agg-note')).toContainText('Each next stage runs inside every city bucket')

  // 3 · Metrics: avg_price, median_price, cities (unique count)
  const m = await addStage('Metrics')
  await m.getByLabel('Metric 1 name').fill('avg_price')
  await pick(m, 'Metric 1 field', 'price')
  await m.getByRole('button', { name: /^\+ Metric/ }).click()
  await m.getByLabel('Metric 2 name').fill('median_price')
  await m.getByLabel('Metric 2 operation').selectOption('median')
  await pick(m, 'Metric 2 field', 'price')
  await expect(m.locator('.agg-table .agg-tr.head')).toContainText('avg_price')
  await expect(m.locator('.agg-table .agg-tr.head')).toContainText('median_price')

  // 4 · Group by month (nested)
  const month = await addStage('Group by')
  await month.getByLabel('Group kind').selectOption('date_histogram')
  await pick(month, 'Group field', 'created_at')
  await month.getByLabel('Group name').fill('by_month')
  await expect(month.locator('.agg-out-head')).toContainText(/buckets per city/)

  // 5 · Keep only avg_price > 400,000 — attaches to the city level (where avg_price lives).
  const k = await addStage('Keep only (having)')
  await pick(k, 'Rule 1 metric', 'avg_price')
  await k.getByLabel('Rule 1 value').fill('400000')
  await expect(k.locator('.agg-card-head .hint')).toContainText('applies to city buckets')
  await expect(k.locator('.agg-out-head')).toContainText(/\d+ of \d+ city buckets kept/)

  // 6 · Sort & limit by avg_price desc, keep 5
  const s = await addStage('Sort & limit')
  await pick(s, 'Sort by', 'avg_price')
  await s.getByLabel('Keep', { exact: true }).fill('5')
  await expect(s.locator('.agg-out-head')).toContainText(/[1-5] city buckets returned/)

  // The flow bar summarises every stage.
  const flow = page.locator('.agg-flow')
  await expect(flow).toContainText('1 Filter')
  await expect(flow).toContainText('2 Group by city')
  await expect(flow).toContainText('4 By month')
})

test('Run executes the full pipeline and matches Elasticsearch', async () => {
  await page.getByRole('button', { name: '▶ Run' }).click()
  await expect(page.locator('.agg-results .status-badge')).toHaveText('200')
  // Same request straight to ES: cities with avg > 400k among the top 10 by count, top 5 by avg, × months.
  const res = await es<{ aggregations: { by_city: { buckets: Array<{ by_month: { buckets: unknown[] } }> } } }>('listings-v7/_search', {
    size: 0,
    query: { bool: { filter: [{ term: { status: 'active' } }] } },
    aggs: {
      by_city: {
        terms: { field: 'city.name', size: 10 },
        aggs: {
          avg_price: { avg: { field: 'price' } },
          median_price: { percentiles: { field: 'price', percents: [50] } },
          by_month: { date_histogram: { field: 'created_at', calendar_interval: 'month' } },
          keep_5: { bucket_selector: { buckets_path: { p: 'avg_price' }, script: 'params.p > 400000' } },
          top_5: { bucket_sort: { sort: [{ avg_price: { order: 'desc' } }], size: 5 } }
        }
      }
    }
  })
  const rows = res.aggregations.by_city.buckets.reduce((n, b) => n + b.by_month.buckets.length, 0)
  await expect(page.locator('.agg-results .pane-head .hint')).toHaveText(new RegExp(`^${rows.toLocaleString()} rows`))
  await expect(page.locator('.agg-results .rtable-row.head')).toContainText('city.name')
  await expect(page.locator('.agg-results .rtable-row.head')).toContainText('created_at')
})

test('disabling a stage removes it from the request', async () => {
  await stage(4).getByRole('button', { name: 'Disable' }).click()
  await expect(page.locator('.agg-flow')).not.toContainText('By month')
  await page.getByRole('button', { name: '▶ Run' }).click()
  await expect(page.locator('.agg-results .pane-head .hint')).toHaveText(/^[1-5] rows/)
  await expect(page.locator('.agg-results .rtable-row.head')).not.toContainText('created_at')
  await stage(4).getByRole('button', { name: 'Enable' }).click()
})

test('JSON view shows the generated request with stage numbers and edits flow back', async () => {
  await page.getByRole('tab', { name: 'JSON', exact: true }).click()
  const editor = page.locator('.agg-json .monaco-editor')
  await expect(editor).toContainText('"by_city"')
  await expect(editor).toContainText('bucket_selector')
  await expect(page.locator('.agg-json-side')).toContainText('How stages map to Elasticsearch')
  // Gutter numbers come from the stage map.
  await expect(editor.locator('.line-numbers').filter({ hasText: /^2$/ }).first()).toBeVisible()
  const body = {
    size: 0,
    query: { bool: { filter: [{ term: { status: 'sold' } }] } },
    aggs: { by_tags: { terms: { field: 'tags', size: 3 }, aggs: { cheapest: { min: { field: 'price' } }, sig: { significant_terms: { field: 'city.name' } } } } }
  }
  await pasteInto(app, page, editor, JSON.stringify(body, null, 2))
  await expect(page.locator('.agg-json-main .agg-note')).toContainText('1 part kept as Custom JSON stage', { timeout: 5000 })
  await page.getByRole('tab', { name: 'Stages', exact: true }).click()
  // Disabled stages are kept; the request maps to Filter → Group by → Metrics → Custom JSON.
  await expect(page.locator('.agg-card')).toHaveCount(4)
  await expect(stage(4)).toContainText('Custom JSON')
  await expect(stage(2).getByRole('button', { name: 'Group field' })).toContainText('tags')
})

test('ES|QL view translates and warns for what it cannot express', async () => {
  // Back to a nested pipeline: add Group by month inside tags.
  const month = await addStage('Group by')
  await month.getByLabel('Group kind').selectOption('date_histogram')
  await pick(month, 'Group field', 'created_at')
  await page.getByRole('tab', { name: 'ES|QL', exact: true }).click()
  const code = page.getByLabel('ES|QL query')
  await expect(code).toContainText('FROM listings-v7')
  await expect(code).toContainText('STATS')
  await expect(code).toContainText('BY tags')
  await expect(page.getByRole('note').filter({ hasText: 'Stage 5 (group by month inside each tags)' })).toContainText("can't be expressed in a single ES|QL STATS")
  await expect(page.getByRole('note').filter({ hasText: 'Stage 4: Custom JSON' })).toBeVisible()
  await page.getByRole('button', { name: '▶ Run ES|QL' }).click()
  await expect(page.locator('.agg-esql .agg-table')).toContainText('doc_count')
  await page.getByRole('tab', { name: 'Stages', exact: true }).click()
})

test('saves the pipeline to the library and reopens it', async () => {
  await page.getByLabel('Pipeline name').fill('Sold by tag')
  await page.locator('.agg-toolbar').getByRole('button', { name: 'Save', exact: true }).click()
  const dialog = page.getByRole('dialog')
  await expect(dialog.locator('#q-title')).toHaveValue('Sold by tag')
  await dialog.getByLabel('New folder').fill('Aggregations')
  await dialog.getByRole('button', { name: /^Save/ }).click()
  await expect(page.locator('.toast')).toContainText('Saved “Sold by tag” to the library')
  await page.getByRole('button', { name: 'Workspace' }).first().click()
  const row = page.locator('.lib-row', { hasText: 'Sold by tag' })
  await expect(row.locator('.lib-agg')).toHaveText('∑')
  // Start over, then reopen from the library.
  await page.getByRole('button', { name: 'Explorer' }).first().click()
  page.once('dialog', (d) => void d.accept())
  await page.getByRole('button', { name: 'New pipeline' }).click()
  await expect(page.locator('.agg-card')).toHaveCount(0)
  await page.getByRole('button', { name: 'Workspace' }).first().click()
  await row.click()
  await expect(page.getByRole('tab', { name: 'Aggregations', exact: true })).toHaveAttribute('aria-selected', 'true')
  await expect(page.locator('.agg-card')).toHaveCount(5)
  await expect(page.getByLabel('Pipeline name')).toHaveValue('Sold by tag')
})

test('works on OpenSearch (sampler instead of random_sampler, no ES|QL)', async () => {
  await connect(page, CLUSTERS.os2, 'OS')
  await page.locator('.tree-row[title="listings-v7"]').click()
  await page.getByRole('button', { name: 'Query this index' }).click()
  await page.getByRole('tab', { name: 'Aggregations', exact: true }).click()
  await expect(page.getByRole('tab', { name: 'ES|QL', exact: true })).toHaveCount(0)
  const g = await addStage('Group by')
  await pick(g, 'Group field', 'city.name')
  await expect(g.locator('.agg-out-head')).toContainText(/\d+ buckets/)
  const m = await addStage('Metrics')
  await pick(m, 'Metric 1 field', 'price')
  await expect(m.locator('.agg-table .agg-tr.head')).toContainText('avg_price')
  await page.getByText('Fast (sampled)').click()
  await expect(page.locator('.agg-flow-note')).toContainText('OpenSearch: sampler')
  await expect(g.locator('.agg-out-head')).toContainText(/≈/)
})
