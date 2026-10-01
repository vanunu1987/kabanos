/**
 * Milestones 2 + 3: Explorer tree / index pages and the Index view.
 * Needs `pnpm build`, `pnpm clusters:up` and `pnpm clusters:seed`.
 */
import { expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { CLUSTERS, connect, launch, suggest } from './helpers'

// Steps build on each other; stop at the first failure instead of cascading timeouts.
test.describe.configure({ mode: 'serial' })

let app: ElectronApplication
let page: Page

test.beforeAll(async () => {
  ;({ app, page } = await launch())
})
test.afterAll(async () => app?.close())

test('explorer shows indices, aliases, data streams and templates', async () => {
  await connect(page, CLUSTERS.es9)
  const tree = page.locator('.explorer-tree')
  await expect(tree.locator('.tree-row[title="listings-v7"]')).toBeVisible()
  await expect(tree.locator('.tree-row[title="listings → listings-v7"]')).toBeVisible()
  await expect(tree.locator('.tree-row[title="search-logs"]')).toBeVisible()
  await expect(tree.locator('.tree-row[title="listings-template"]')).toBeVisible()
  // System indices and built-in templates are hidden by default.
  await expect(tree.locator('.tree-row', { hasText: /^\.security/ })).toHaveCount(0)
  await tree.getByRole('button', { name: 'Hide closed' }).click()
  await expect(tree.locator('.tree-row[title="archive-2025"]')).toHaveCount(0)
  await tree.getByRole('button', { name: 'Hide closed' }).click()
  await tree.getByPlaceholder(/Filter/).fill('users')
  await expect(tree.locator('.tree-row')).toHaveCount(3) // users-2026.09, users alias, users-template
  await tree.getByPlaceholder(/Filter/).fill('')
})

test('index overview: stats, mapping, aliases, matched template', async () => {
  await page.locator('.tree-row[title="listings-v7"]').click()
  await expect(page.locator('.stat', { hasText: 'Documents' })).toContainText('400')
  await expect(page.getByRole('button', { name: 'alias: listings', exact: true })).toBeVisible()
  await expect(page.locator('.side-cards')).toContainText('listings-template')
  await expect(page.locator('.side-cards')).toContainText('priority 200')
  await expect(page.locator('.grid-row', { hasText: 'geo_point' })).toBeVisible()
  await page.getByPlaceholder('Filter fields').first().fill('city')
  await expect(page.locator('.grid-row:not(.head)')).toHaveCount(3) // city, city.id, city.name
  await page.screenshot({ path: 'e2e/screens/10-explorer.png' })

  await page.getByRole('tab', { name: 'Shards' }).click()
  await expect(page.locator('.grid-row.shards', { hasText: 'started' })).toHaveCount(1)
  await page.getByRole('tab', { name: 'Settings' }).click()
  await expect(page.locator('.kv-row', { hasText: 'index.number_of_shards' })).toBeVisible()
  await page.getByRole('tab', { name: 'Documents' }).click()
  await expect(page.locator('.doc-card')).toHaveCount(20)
})

test('alias and template pages link back to indices', async () => {
  await page.locator('.tree-row[title="listings-read → listings-v7"]').click()
  await expect(page.locator('.side-cards')).toContainText('filtered')
  await page.locator('.tree-row[title="listings-template"]').click()
  await expect(page.locator('.side-cards')).toContainText('Matching indices · 2')
})

test('index view: run a search, page, switch views', async () => {
  await page.locator('.tree-row[title="listings-v7"]').click()
  await page.getByRole('button', { name: 'Query this index' }).click()
  await expect(page.locator('.pathbox .prefix')).toHaveText('/listings-v7/')
  await page.getByRole('button', { name: /Run/ }).click()
  await expect(page.locator('.status-badge')).toHaveText('200')
  await expect(page.locator('.iv-results .pane-head')).toContainText('1–20 of 400 hits')
  await expect(page.locator('.doc-card')).toHaveCount(20)
  await page.getByRole('button', { name: 'Next page' }).click()
  await expect(page.locator('.iv-results .pane-head')).toContainText('21–40 of 400 hits')
  await page.getByRole('button', { name: 'Table', exact: true }).click()
  await expect(page.locator('.rtable-row.head')).toContainText('city.name')
  await page.getByRole('button', { name: 'JSON', exact: true }).click()
  await expect(page.locator('.results-body .json-view')).toContainText('"hits"')
  await page.getByRole('button', { name: 'Documents', exact: true }).click()
  await page.screenshot({ path: 'e2e/screens/11-index-view.png' })
})

test('endpoint chips and method dropdown', async () => {
  await page.locator('.chip', { hasText: '_count' }).click()
  await page.getByRole('button', { name: /Run/ }).click()
  await expect(page.locator('.results-body .json-view')).toContainText('"count": 400')
  await page.getByRole('button', { name: /HTTP method/ }).click()
  await expect(page.getByRole('listbox', { name: 'HTTP method' })).toContainText('asks to confirm on prod')
  await page.getByRole('option', { name: /GET/ }).click()
  await expect(page.getByRole('button', { name: /HTTP method GET/ })).toBeVisible()
})

test('body autocomplete suggests mapped fields', async () => {
  await page.locator('.chip', { hasText: '_search' }).click()
  const editor = page.locator('.iv-body .monaco-editor').first()
  await editor.click()
  await page.keyboard.press('Meta+A')
  await page.keyboard.type('{"query":{"term":{"ci')
  await suggest(page, 'city.name')
  await page.keyboard.press('Escape')
})

test('edit a document with diff preview and optimistic concurrency', async () => {
  await page.locator('.chip', { hasText: '_search' }).click()
  await page.getByRole('button', { name: /Run/ }).click()
  const first = page.locator('.doc-card').first()
  const id = (await first.locator('.doc-head .ts').textContent())!
  await first.getByRole('button', { name: 'Edit' }).click()
  const modal = page.getByRole('dialog')
  await modal.locator('.monaco-editor .view-lines').click()
  await page.keyboard.press('Meta+A')
  await app.evaluate(({ clipboard }) => clipboard.writeText('{"title":"edited by e2e","status":"active"}'))
  await page.keyboard.press('Meta+V')
  await modal.getByRole('button', { name: 'Review changes' }).click()
  await expect(modal.locator('.monaco-diff-editor')).toBeVisible()
  await modal.getByRole('button', { name: 'Save document' }).click()
  await expect(page.locator('.toast')).toContainText(`Saved ${id}`)
  // Find it again by query: the edit is visible and the ID is unchanged.
  await page.locator('.iv-body .monaco-editor .view-lines').click()
  await page.keyboard.press('Meta+A')
  await app.evaluate(({ clipboard }) => clipboard.writeText('{"query":{"match_phrase":{"title":"edited by e2e"}}}'))
  await page.keyboard.press('Meta+V')
  await page.getByRole('button', { name: /Run/ }).click()
  await expect(page.locator('.doc-card')).toHaveCount(1)
  await expect(page.locator('.doc-card .doc-head .ts')).toHaveText(id)
})

test('documents tab pages through a point in time', async () => {
  await page.getByRole('tab', { name: 'Documents' }).click()
  await expect(page.locator('.iv-results .pane-head')).toContainText('1–20 of 400 documents')
  await page.getByRole('button', { name: 'Next page' }).click()
  await expect(page.locator('.iv-results .pane-head')).toContainText('21–40 of 400 documents')
  await page.getByRole('button', { name: 'Previous page' }).click()
  await expect(page.locator('.iv-results .pane-head')).toContainText('1–20 of 400 documents')
})

test('OpenSearch: explorer and PIT paging use the OpenSearch APIs', async () => {
  await connect(page, CLUSTERS.os2)
  await expect(page.locator('.tree-row[title="listings-v7"]')).toBeVisible()
  await page.locator('.tree-row[title="listings-v7"]').click()
  await expect(page.locator('.stat', { hasText: 'Documents' })).toContainText('400')
  await page.getByRole('button', { name: 'Query this index' }).click()
  await page.getByRole('tab', { name: 'Documents' }).click()
  await expect(page.locator('.iv-results .pane-head')).toContainText('1–20 of 400 documents')
  await page.getByRole('button', { name: 'Next page' }).click()
  await expect(page.locator('.iv-results .pane-head')).toContainText('21–40 of 400 documents')
})
