/**
 * Milestone 4: workspace blocks, library, search, import, environments, persistence, prod safety.
 * Needs `pnpm build`, `pnpm clusters:up` and `pnpm clusters:seed`.
 */
import { expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { CLUSTERS, connect, launch, pasteInto, suggest } from './helpers'

test.describe.configure({ mode: 'serial' })

let app: ElectronApplication
let page: Page
let dataDir: string

test.beforeAll(async () => {
  ;({ app, page, dataDir } = await launch())
  await connect(page, CLUSTERS.es9)
  await page.getByRole('button', { name: 'Query workspace' }).click()
})
test.afterAll(async () => app?.close())

const blocks = () => page.locator('.block')
const lastEditor = () => blocks().last().locator('.monaco-editor')
/** Add a block and wait until it is rendered and focused (its autofocus would otherwise steal keystrokes). */
async function addBlock() {
  const n = await blocks().count()
  await page.getByRole('button', { name: 'New request' }).click()
  await expect(blocks()).toHaveCount(n + 1)
  await expect(blocks().last().locator('.monaco-editor.focused')).toBeVisible()
}

test('new request block runs and shows the response', async () => {
  await expect(page.getByRole('tab', { name: 'Scratch' })).toBeVisible()
  await addBlock()
  await pasteInto(app, page, lastEditor(), 'POST listings/_search\n{\n  "size": 2,\n  "query": { "match_all": {} }\n}')
  await blocks().last().getByRole('button', { name: 'Run this request' }).click()
  await expect(page.locator('.response-pane .status-badge')).toHaveText('200')
  await expect(page.locator('.response-pane')).toContainText('"hits"')
  await expect(blocks().last().locator('.block-meta')).toContainText('200')
})

test('request-line autocomplete: endpoints and index names', async () => {
  await addBlock()
  await pasteInto(app, page, lastEditor(), 'GET _clu')
  await page.keyboard.press('End')
  await suggest(page, '_cluster/health')
  await page.keyboard.press('Escape')
  await pasteInto(app, page, lastEditor(), 'GET list')
  await page.keyboard.press('End')
  await suggest(page, 'listings-v7')
  await page.keyboard.press('Escape')
})

test('body autocomplete: spec keys and mapping fields', async () => {
  await pasteInto(app, page, lastEditor(), 'POST listings/_search\n{"query":{"term":{"ci')
  await page.keyboard.press('Meta+ArrowDown')
  await page.keyboard.press('End')
  await suggest(page, 'city.name')
  await page.keyboard.press('Escape')
  await pasteInto(app, page, lastEditor(), 'POST listings/_search\n{"query":{"bool":{"fil')
  await page.keyboard.press('Meta+ArrowDown')
  await page.keyboard.press('End')
  await suggest(page, 'filter')
  await page.keyboard.press('Escape')
  await blocks().last().getByRole('button', { name: 'Block actions' }).click()
  await page.getByRole('menuitem', { name: 'Delete block' }).click()
  await expect(blocks()).toHaveCount(1)
})

test('import a Kibana console export into titled blocks', async () => {
  await page.getByRole('button', { name: 'Import…' }).click()
  await page.getByLabel('Console text').fill('### Cluster health\nGET _cluster/health\n\n# Count active listings\nPOST listings/_count\n{ "query": { "term": { "status": "active" } } }\n\n// Biggest indices\nGET _cat/indices?s=store.size:desc&format=json\n')
  await expect(page.getByRole('dialog')).toContainText('Count active listings')
  await page.getByRole('button', { name: 'Import 3 requests' }).click()
  await expect(blocks()).toHaveCount(4)
  await expect(page.locator('.block-title')).toContainText(['Untitled request', 'Cluster health', 'Count active listings', 'Biggest indices'])
})

test('collapse all, run selected blocks in order', async () => {
  await page.getByRole('button', { name: 'Collapse all' }).click()
  await expect(page.locator('.block.collapsed')).toHaveCount(4)
  await expect(page.locator('.block').nth(2).locator('.block-path')).toHaveText('listings/_count')
  await page.locator('.block').nth(1).getByLabel('Select for sequential run').check()
  await page.locator('.block').nth(2).getByLabel('Select for sequential run').check()
  await page.getByRole('button', { name: 'Run 2 in order' }).click()
  await expect(page.locator('.block').nth(1).locator('.block-meta')).toContainText('200')
  await expect(page.locator('.block').nth(2).locator('.block-meta')).toContainText('200')
  await page.getByRole('button', { name: 'Expand all' }).click()
  await expect(page.locator('.block.collapsed')).toHaveCount(0)
})

test('save to a library folder, then find it by field name and #tag', async () => {
  await page.getByRole('button', { name: 'New folder' }).click()
  const rename = page.locator('.lib-folder-head .inline-input')
  await rename.fill('Listings relevance')
  await rename.press('Enter')
  await expect(page.locator('.lib-folder-head', { hasText: 'Listings relevance' })).toBeVisible()

  const block = page.locator('.block').nth(2)
  await block.getByRole('button', { name: 'Block actions' }).click()
  await page.getByRole('menuitem', { name: 'Save to folder…' }).click()
  const dialog = page.getByRole('dialog')
  await dialog.getByLabel('Tags').fill('#relevance')
  await dialog.getByRole('button', { name: 'Save' }).click()
  await expect(block.locator('.pill', { hasText: '#relevance' })).toBeVisible()
  await expect(page.locator('.lib-folder', { hasText: 'Listings relevance' }).locator('.lib-row')).toContainText('Count active listings')

  await page.getByLabel('Search queries').fill('status')
  await expect(page.locator('.lib-row')).toHaveCount(1)
  await page.getByLabel('Search queries').fill('')
  await page.locator('.chip', { hasText: '#relevance' }).click()
  await expect(page.locator('.lib-row')).toHaveCount(1)
  await page.locator('.chip', { hasText: 'History' }).click()
  await expect(page.locator('.lib-row', { hasText: '_cluster/health' })).toHaveCount(1)
  await expect(page.locator('.lib-row').first()).toContainText('listings/_count') // newest first
  await page.locator('.chip', { hasText: 'All' }).click()
})

test('default target and environment variables', async () => {
  await page.getByLabel('Default target').fill('listings')
  await addBlock()
  await pasteInto(app, page, lastEditor(), 'GET _count')
  await expect(blocks().last().locator('.block-path')).toContainText('listings/_count')
  await blocks().last().getByRole('button', { name: 'Run this request' }).click()
  await expect(page.locator('.response-pane')).toContainText('"count": 400')

  await page.getByLabel('Environment').selectOption('__manage')
  const dialog = page.getByRole('dialog')
  await dialog.getByRole('button', { name: 'New environment' }).click()
  await dialog.getByLabel('Environment name').fill('dev')
  await dialog.getByLabel('Variable name').fill('idx')
  await dialog.getByLabel('Variable value').fill('listings-v6')
  await dialog.getByRole('button', { name: 'Save environment' }).click()
  await dialog.getByRole('button', { name: 'Done' }).click()
  await page.getByLabel('Environment').selectOption({ label: 'dev' })
  await pasteInto(app, page, lastEditor(), 'GET {{idx}}/_count')
  await blocks().last().getByRole('button', { name: 'Run this request' }).click()
  await expect(page.locator('.response-pane')).toContainText('"count": 150')
  await pasteInto(app, page, lastEditor(), 'GET {{nope}}/_count')
  await blocks().last().getByRole('button', { name: 'Run this request' }).click()
  await expect(page.locator('.response-pane .error-box')).toContainText('Unknown variable {{nope}}')
})

test('declined production confirmation never sends the request', async () => {
  await connect(page, { ...CLUSTERS.es9, name: 'ES 9 as prod' }, 'Production')
  await app.evaluate(({ dialog }) => {
    ;(dialog as unknown as { showMessageBox: () => Promise<{ response: number }> }).showMessageBox = async () => ({ response: 0 })
  })
  await page.getByRole('button', { name: 'Query workspace' }).click()
  await addBlock()
  await pasteInto(app, page, lastEditor(), 'DELETE listings-v6')
  await blocks().last().getByRole('button', { name: 'Run this request' }).click()
  await expect(page.locator('.response-pane .error-box')).toContainText('confirmation declined')
  const res = await fetch('http://localhost:9202/listings-v6', { method: 'HEAD', headers: { authorization: `Basic ${Buffer.from('elastic:sift-dev-pass').toString('base64')}` } })
  expect(res.status).toBe(200)
})

test('tabs, blocks and the library survive a restart', async () => {
  await app.close()
  ;({ app, page } = await launch(dataDir))
  await page.getByRole('button', { name: 'Query workspace' }).click()
  await expect(page.locator('.block-title', { hasText: 'Count active listings' })).toBeVisible()
  await expect(page.locator('.lib-folder', { hasText: 'Listings relevance' })).toBeVisible()
  await expect(page.getByLabel('Default target')).toHaveValue('listings')
  await expect(page.getByRole('tab', { name: /ES 9 as prod/ })).toBeVisible() // connection tabs are restored too
  await page.screenshot({ path: 'e2e/screens/20-workspace.png' })
})
