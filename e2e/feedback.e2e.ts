/**
 * Review round 1: resizable panes, structure hints, ⌘I, ⌘↵ per block, mapping editing, empty index.
 */
import { expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { CLUSTERS, connect, launch, pasteInto, suggest } from './helpers'

test.describe.configure({ mode: 'serial' })
let app: ElectronApplication
let page: Page
const AUTH = { authorization: `Basic ${Buffer.from('elastic:sift-dev-pass').toString('base64')}` }
const es = (path: string, init: RequestInit = {}) => fetch(`http://localhost:9202/${path}`, { ...init, headers: { ...AUTH, 'content-type': 'application/json', ...(init.headers ?? {}) } })

test.beforeAll(async () => {
  for (const i of ['listings-v8', 'listings-v9']) await es(i, { method: 'DELETE' })
  ;({ app, page } = await launch())
  await connect(page, CLUSTERS.es9)
})
test.afterAll(async () => {
  await app?.close()
  for (const i of ['listings-v8', 'listings-v9']) await es(i, { method: 'DELETE' })
})

/** A block's current text (Monaco recycles line elements, so the DOM isn't a reliable source). */
const editorText = async (loc: ReturnType<Page['locator']>) => (await loc.locator('xpath=ancestor::div[contains(concat(" ", @class, " "), " block ")][1]').getAttribute('data-text')) ?? ''

test('⌘↵ runs the focused block, not the last one', async () => {
  await page.getByRole('button', { name: 'Query workspace' }).click()
  for (const n of [1, 2]) {
    await page.getByRole('button', { name: 'New request' }).click()
    await expect(page.locator('.block')).toHaveCount(n)
    await expect(page.locator('.block').last().locator('.monaco-editor.focused')).toBeVisible()
  }
  await pasteInto(app, page, page.locator('.block').nth(0).locator('.monaco-editor'), 'GET _cluster/health')
  await pasteInto(app, page, page.locator('.block').nth(1).locator('.monaco-editor'), 'GET _cat/indices?format=json')
  await page.locator('.block').nth(0).locator('.view-lines').click()
  await page.keyboard.press('Meta+Enter')
  await expect(page.locator('.response-pane')).toContainText('"cluster_name"')
  await expect(page.locator('.block').nth(1).locator('.block-meta')).toContainText('never run')
})

test('⌘I auto-indents the block', async () => {
  const ed = page.locator('.block').nth(1).locator('.monaco-editor')
  await pasteInto(app, page, ed, 'POST   listings-v7/_search\n{"size":1,"query":{"term":{"status":"active"}}}')
  await page.keyboard.press('Meta+I')
  await expect.poll(() => editorText(ed)).toContain('POST listings-v7/_search\n{\n  "size": 1,\n  "query": {\n    "term": {')
  await page.keyboard.press('Meta+Z')
  await expect.poll(() => editorText(ed)).toContain('{"size":1,')
})

test('picking "term" inserts its structure and then suggests fields', async () => {
  const ed = page.locator('.block').nth(1).locator('.monaco-editor')
  await pasteInto(app, page, ed, 'POST listings-v7/_search\n{\n  "query": {\n    "te\n  }\n}')
  await page.keyboard.press('Meta+ArrowUp')
  await page.keyboard.press('ArrowDown')
  await page.keyboard.press('ArrowDown')
  await page.keyboard.press('ArrowDown')
  await page.keyboard.press('End')
  await suggest(page, 'term')
  await page.keyboard.press('Enter')
  await expect.poll(() => editorText(ed)).toMatch(/"term": \{\s+"FIELD": \{\s+"value": "VALUE"\s+\}\s+\}/)
  // The FIELD placeholder is selected and field suggestions are already open.
  await expect(page.locator('.suggest-widget.visible')).toContainText('city.name')
  await page.keyboard.type('city.na')
  await page.keyboard.press('Enter')
  await expect.poll(() => editorText(ed)).toMatch(/"city\.name": \{\s+"value": "VALUE"/)
  await page.keyboard.press('Tab') // → VALUE
  await page.keyboard.type('Haifa')
  await expect.poll(() => editorText(ed)).toContain('"value": "Haifa"')
  await page.keyboard.press('Meta+Enter')
  await expect(page.locator('.response-pane')).toContainText('"hits"')
})

test('the response pane can be resized and keeps its width', async () => {
  const pane = page.locator('.response-pane')
  const before = (await pane.boundingBox())!.width
  const handle = page.getByRole('separator', { name: 'Resize requests and response' })
  const box = (await handle.boundingBox())!
  await page.mouse.move(box.x + 2, box.y + 200)
  await page.mouse.down()
  await page.mouse.move(box.x - 200, box.y + 200, { steps: 8 })
  await page.mouse.up()
  const after = (await pane.boundingBox())!.width
  expect(after).toBeGreaterThan(before + 150)
  await page.screenshot({ path: 'e2e/screens/50-resized.png' })
})

test('index view: query/results splitter', async () => {
  await page.getByRole('button', { name: 'Explorer' }).click()
  await page.locator('.tree-row[title="listings-v6"]').click()
  await page.getByRole('button', { name: 'Query this index' }).click()
  const body = page.locator('.iv-body')
  const w0 = (await body.boundingBox())!.width
  const handle = page.getByRole('separator', { name: 'Resize query and results' })
  const box = (await handle.boundingBox())!
  await page.mouse.move(box.x + 2, box.y + 100)
  await page.mouse.down()
  await page.mouse.move(box.x + 250, box.y + 100, { steps: 8 })
  await page.mouse.up()
  expect((await body.boundingBox())!.width).toBeGreaterThan(w0 + 200)
})

test('mapping: add a field in place', async () => {
  await page.locator('.qtab.back').click()
  await page.locator('.tree-row[title="listings-v6"]').click()
  await page.getByRole('tab', { name: 'Mapping' }).click()
  await page.getByRole('button', { name: '+ Add field' }).click()
  const dialog = page.getByRole('dialog')
  await dialog.getByLabel('Field name').fill('seller.phone')
  await dialog.getByLabel('Type', { exact: true }).selectOption('keyword')
  await dialog.getByRole('button', { name: 'Add field' }).click()
  await expect(page.locator('.toast')).toContainText('Added seller.phone')
  await expect(page.locator('.grid-row', { hasText: 'phone' })).toContainText('keyword')
  const m = (await (await es('listings-v6/_mapping')).json()) as Record<string, { mappings: { properties: Record<string, { properties?: Record<string, { type: string }> }> } }>
  expect(m['listings-v6']!.mappings.properties.seller!.properties!.phone!.type).toBe('keyword')
})

test('mapping: an allowed parameter change applies in place after the warning', async () => {
  await page.locator('.grid-row', { hasText: 'phone' }).hover()
  await page.getByRole('button', { name: 'Edit field seller.phone', exact: true }).click()
  const dialog = page.getByRole('dialog')
  await expect(dialog).toContainText('usually requires a reindex')
  await dialog.getByLabel('ignore_above').fill('64')
  await dialog.getByRole('button', { name: 'Review change' }).click()
  await expect(page.getByRole('dialog')).toContainText('This change needs a reindex')
  await page.getByRole('button', { name: 'Try in place' }).click()
  await expect(page.locator('.toast')).toContainText('Mapping updated in place')
})

test('mapping: a type change creates a reindex routine that runs end to end', async () => {
  await page.locator('.grid-row', { hasText: 'price' }).first().hover()
  await page.getByRole('button', { name: 'Edit field price', exact: true }).click()
  let dialog = page.getByRole('dialog')
  await dialog.getByLabel('Type', { exact: true }).selectOption('double')
  await dialog.getByRole('button', { name: 'Review change' }).click()
  dialog = page.getByRole('dialog')
  await expect(dialog).toContainText("Existing fields can't be changed or removed in place")
  await expect(dialog.getByLabel('New index name')).toHaveValue('listings-v8')
  await page.getByRole('button', { name: 'Try in place' }).click()
  await expect(dialog).toContainText('rejected the in-place change')
  await page.getByRole('button', { name: 'Create reindex routine' }).click()
  await expect(page.getByLabel('Routine name')).toHaveValue('Reindex listings-v6 → listings-v8 (mapping change)')
  await expect(page.locator('.step-card')).toHaveCount(6)
  await page.getByRole('button', { name: '▶ Run all' }).click()
  await expect(page.locator('.run-badge.lg')).toContainText('ok', { timeout: 30_000 })
  const m = (await (await es('listings-v8/_mapping')).json()) as Record<string, { mappings: { properties: Record<string, { type?: string }> } }>
  expect(m['listings-v8']!.mappings.properties.price!.type).toBe('double')
  const c = (await (await es('listings-v8/_count')).json()) as { count: number }
  expect(c.count).toBe(150)
})

test('empty index: typed-name confirmation, then _delete_by_query match_all', async () => {
  await page.getByRole('button', { name: 'Explorer' }).click()
  await page.locator('.tree-row[title="listings-v8"]').click()
  await page.getByRole('button', { name: 'More actions' }).click()
  await page.getByRole('menuitem', { name: /Empty index/ }).click()
  const dialog = page.getByRole('dialog')
  await expect(dialog).toContainText('_delete_by_query')
  const go = dialog.getByRole('button', { name: 'Delete all documents' })
  await expect(go).toBeDisabled()
  await dialog.getByLabel('Type the name to confirm').fill('listings-v')
  await expect(go).toBeDisabled()
  await dialog.getByLabel('Type the name to confirm').fill('listings-v8')
  await go.click()
  await expect(page.locator('.toast')).toContainText('Emptied listings-v8: 150 documents deleted', { timeout: 20_000 })
  const c = (await (await es('listings-v8/_count')).json()) as { count: number }
  expect(c.count).toBe(0)
  const exists = await es('listings-v8', { method: 'HEAD' })
  expect(exists.status).toBe(200) // the index (and its mapping) is kept
})
