/** Captures the website screenshots from the running app. Not part of the test suite. Run: SCREENS_OUT=… pnpm exec playwright test e2e/site-screens.capture.ts --config playwright.capture.config.ts */
import { expect, test, type Page } from '@playwright/test'
import { CLUSTERS, connect, launch } from './helpers'

const OUT = process.env.SCREENS_OUT ?? '../kabanos-site/public/screens'
const ipc = (page: Page, method: string, ...args: unknown[]) =>
  page.evaluate(async ([m, a]) => {
    const r = await (window as unknown as { kabanosIpc: { invoke(m: string, a: unknown[]): Promise<{ ok: boolean; value?: unknown; error?: { message: string } }> } }).kabanosIpc.invoke(m as string, a as unknown[])
    if (!r.ok) throw new Error(r.error?.message)
    return r.value as any
  }, [method, args] as const)
const shot = async (page: Page, name: string) => {
  await page.mouse.move(1430, 890)
  await page.waitForTimeout(700)
  await page.screenshot({ path: `${OUT}/${name}.png` })
}

test('capture', async () => {
  test.setTimeout(240_000)
  const { app, page } = await launch()
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setSize(1440, 900))
  await connect(page, { ...CLUSTERS.os2, name: 'Logs · OpenSearch' }, 'Local')
  await connect(page, { ...CLUSTERS.es9, name: 'Search · Docker' })
  const conns = await ipc(page, 'connections.list')
  const es = conns.find((c: { name: string }) => c.name.startsWith('Search'))

  // ---- library + workspace ----
  const tuning = await ipc(page, 'library.createFolder', 'Search tuning', null)
  const ops = await ipc(page, 'library.createFolder', 'Ops', null)
  const q = (title: string, path: string, body: string, folderId: string, tags: string[], pinned = false) => ipc(page, 'library.createQuery', { title, method: path.startsWith('GET') ? 'GET' : 'POST', path: path.replace(/^(GET|POST) /, ''), body, folderId, tags, pinned })
  const a = await q('Active listings in Tel Aviv', 'POST listings-v7/_search', JSON.stringify({ size: 10, query: { bool: { filter: [{ term: { status: 'active' } }, { term: { 'city.name': 'Tel Aviv' } }] } }, sort: [{ price: 'desc' }] }, null, 2), tuning.id, ['relevance'], true)
  const b = await q('Price stats by city', 'POST listings-v7/_search', JSON.stringify({ size: 0, aggs: { by_city: { terms: { field: 'city.name', size: 5 }, aggs: { avg_price: { avg: { field: 'price' } } } } } }, null, 2), tuning.id, ['analytics'])
  await q('Garden apartments', 'POST listings/_search', JSON.stringify({ query: { match: { description: 'garden' } } }, null, 2), tuning.id, ['relevance'])
  const c = await q('Cluster health', 'GET _cluster/health', '', ops.id, ['ops'], true)
  await q('Shard allocation', 'GET _cat/shards?v', '', ops.id, ['ops'])
  await q('Pending tasks', 'GET _cluster/pending_tasks', '', ops.id, ['ops'])
  const tab = (await ipc(page, 'workspace.tabs'))[0]
  for (const x of [c, a, b]) await ipc(page, 'workspace.addBlock', tab.id, x.id)
  await page.getByRole('button', { name: 'Query workspace' }).click()
  await page.reload()
  await page.getByRole('button', { name: 'Query workspace' }).click()
  await expect(page.locator('.block')).toHaveCount(3, { timeout: 15000 })
  await page.locator('.block').nth(1).locator('.run-btn, button[title*="Run"]').first().click()
  await page.waitForTimeout(1500)
  await shot(page, 'workspace')

  // ---- explorer ----
  await page.getByRole('button', { name: 'Explorer' }).first().click()
  await page.locator('.tree-row[title="listings-v7"]').click()
  await page.waitForTimeout(800)
  await shot(page, 'explorer')

  // ---- index view ----
  await page.getByRole('button', { name: 'Query this index' }).click()
  await page.getByRole('button', { name: /Run/ }).first().click()
  await expect(page.locator('.doc-card').first()).toBeVisible()
  await shot(page, 'index')

  // ---- aggregations (built from the mockup's request) ----
  await page.getByRole('tab', { name: 'Aggregations', exact: true }).click()
  await page.getByRole('tab', { name: 'JSON', exact: true }).click()
  const body = { size: 0, query: { bool: { filter: [{ term: { status: 'active' } }, { range: { price: { lte: 2000000 } } }] } }, aggs: { by_city: { terms: { field: 'city.name', size: 10 }, aggs: { avg_price: { avg: { field: 'price' } }, median_price: { percentiles: { field: 'price', percents: [50] } }, rooms: { avg: { field: 'rooms' } }, by_month: { date_histogram: { field: 'created_at', calendar_interval: 'month' } }, keep_expensive: { bucket_selector: { buckets_path: { p: 'avg_price' }, script: 'params.p > 700000' } }, top_5: { bucket_sort: { sort: [{ avg_price: { order: 'desc' } }], size: 5 } } } } } }
  await page.locator('.agg-json .monaco-editor .view-lines').click()
  await app.evaluate(({ clipboard }, t) => clipboard.writeText(t), JSON.stringify(body, null, 2))
  await page.keyboard.press('Meta+A')
  await page.keyboard.press('Meta+V')
  await page.waitForTimeout(1500)
  await page.getByRole('tab', { name: 'Stages', exact: true }).click()
  await page.getByLabel('Pipeline name').fill('Expensive cities')
  await page.locator('.agg-card').nth(1).click({ position: { x: 300, y: 12 } })
  await expect(page.locator('.agg-card').nth(2).locator('.agg-table')).toBeVisible({ timeout: 15000 })
  await page.waitForTimeout(1200)
  await shot(page, 'aggregations')

  // ---- routines ----
  await ipc(page, 'routines.save', {
    name: 'Reindex & swap alias',
    defaultConnectionId: es.id,
    variables: { source: 'listings-v7', target: 'listings-v8' },
    steps: [
      { id: 'health', name: 'Cluster is healthy', method: 'GET', path: '_cluster/health', assert: "status != 'red'", onFail: 'stop' },
      { id: 'count', name: 'Count source documents', method: 'POST', path: '{{source}}/_count', capture: { value: 'count' }, onFail: 'stop' },
      { id: 'create', name: 'Create the new index', method: 'PUT', path: '{{target}}', body: '{"settings":{"number_of_replicas":0}}', onFail: 'stop' },
      { id: 'reindex', name: 'Reindex', method: 'POST', path: '_reindex?wait_for_completion=false', body: '{"source":{"index":"{{source}}"},"dest":{"index":"{{target}}"}}', capture: { task: 'task' }, onFail: 'stop' },
      { id: 'wait', name: 'Wait for the task', method: 'GET', path: '_tasks/{{steps.reindex.task}}', repeat: { until: 'completed = true', everySec: 2, timeoutMin: 10 }, onFail: 'stop' },
      { id: 'verify', name: 'Counts match', method: 'POST', path: '{{target}}/_count', when: 'steps.reindex.task', assert: 'count = steps.count.value', onFail: 'stop' },
      { id: 'swap', name: 'Move the alias', method: 'POST', path: '_aliases', body: '{"actions":[{"remove":{"index":"{{source}}","alias":"listings"}},{"add":{"index":"{{target}}","alias":"listings","is_write_index":true}}]}', confirm: true, onFail: 'stop' }
    ]
  })
  await page.getByRole('button', { name: 'Routines' }).first().click()
  await page.reload()
  await page.getByRole('button', { name: 'Routines' }).first().click()
  await page.getByText('Reindex & swap alias').first().click()
  await page.getByLabel(/Dry run/).check()
  await page.getByRole('button', { name: '▶ Run all' }).click()
  await page.waitForTimeout(3000)
  await shot(page, 'routines')

  // ---- stack management ----
  await page.getByRole('button', { name: /Stack management|Security/ }).first().click()
  await page.waitForTimeout(1500)
  await shot(page, 'security')

  // ---- connections ----
  await page.getByRole('button', { name: 'Connections' }).first().click()
  await page.locator('aside.sidebar').getByText('Search · Docker').first().click()
  await page.waitForTimeout(800)
  const testBtn = page.getByRole('button', { name: /Test connection/ })
  if (await testBtn.count()) await testBtn.first().click()
  await page.waitForTimeout(1500)
  await shot(page, 'connections')
  await app.close()
})
