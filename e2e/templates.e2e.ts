/** Index templates: add, edit and delete mapping fields and edit the whole template — checked against the cluster. */
import { expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { CLUSTERS, connect, launch, pasteInto } from './helpers'

test.describe.configure({ mode: 'serial' })
let app: ElectronApplication
let page: Page
const AUTH = { authorization: `Basic ${Buffer.from('elastic:sift-dev-pass').toString('base64')}` }
type Tpl = { index_patterns: string[]; priority: number; template: { mappings: { properties: Record<string, { type?: string; ignore_above?: number; properties?: Record<string, { type: string }> }> } } }
const tpl = async (): Promise<Tpl> => ((await (await fetch('http://localhost:9202/_index_template/listings-template', { headers: AUTH })).json()) as { index_templates: Array<{ index_template: Tpl }> }).index_templates[0]!.index_template

test.beforeAll(async () => {
  ;({ app, page } = await launch())
  await connect(page, CLUSTERS.es9)
  await page.locator('.tree-row', { hasText: 'listings-template' }).click()
  await expect(page.locator('h1')).toHaveText('listings-template')
})
test.afterAll(async () => app?.close())

test('add a field to the template', async () => {
  await page.getByRole('button', { name: '+ Add field' }).click()
  const dialog = page.getByRole('dialog')
  await dialog.getByLabel('Field name').fill('seller.phone')
  await dialog.getByLabel('Type', { exact: true }).selectOption('keyword')
  await expect(dialog.getByText('Index existing documents')).toHaveCount(0)
  await dialog.getByRole('button', { name: 'Add field' }).click()
  await expect(page.locator('.toast')).toContainText('Added seller.phone')
  expect((await tpl()).template.mappings.properties.seller!.properties!.phone!.type).toBe('keyword')
  await expect(page.locator('.grid-row', { hasText: 'phone' })).toContainText('keyword')
})

test('edit a field — no reindex needed for templates', async () => {
  await page.getByRole('button', { name: 'Edit field status', exact: true }).click()
  const dialog = page.getByRole('dialog')
  await expect(dialog).toContainText('indices created from now on')
  await dialog.getByLabel('ignore_above').fill('64')
  await dialog.getByRole('button', { name: 'Save field' }).click()
  await expect(page.locator('.toast')).toContainText('Updated status')
  expect((await tpl()).template.mappings.properties.status).toEqual({ type: 'keyword', ignore_above: 64 })
})

test('delete fields', async () => {
  for (const f of ['seller.phone', 'status']) {
    await page.getByRole('button', { name: `Edit field ${f}`, exact: true }).click()
    page.once('dialog', (d) => void d.accept())
    await page.getByRole('dialog').getByRole('button', { name: 'Delete field' }).click()
    await expect(page.locator('.toast')).toContainText(`Deleted ${f} from listings-template`)
  }
  const props = (await tpl()).template.mappings.properties
  expect(props.status).toBeUndefined()
  expect(props.seller?.properties?.phone).toBeUndefined()
})

test('edit the whole template as JSON (patterns, priority, mappings)', async () => {
  const before = await tpl()
  await page.getByRole('button', { name: 'Edit template JSON' }).click()
  const dialog = page.getByRole('dialog')
  // Restore the original field and bump the priority in one edit.
  const next = { ...before, priority: 250, template: { ...before.template, mappings: { properties: { ...before.template.mappings.properties, status: { type: 'keyword' } } } } }
  await pasteInto(app, page, dialog.locator('.monaco-editor'), JSON.stringify(next, null, 2))
  await dialog.getByRole('button', { name: 'Save template' }).click()
  await expect(page.locator('.toast')).toContainText('Saved template listings-template')
  const after = await tpl()
  expect(after.priority).toBe(250)
  expect(after.template.mappings.properties.status).toEqual({ type: 'keyword' })
  await expect(page.locator('.pill', { hasText: 'priority 250' })).toBeVisible()
})

test('a rejected change shows the cluster error', async () => {
  await page.getByRole('button', { name: 'Edit template JSON' }).click()
  const dialog = page.getByRole('dialog')
  const t = await tpl()
  await pasteInto(app, page, dialog.locator('.monaco-editor'), JSON.stringify({ ...t, priority: 200, index_patterns: [] }, null, 2))
  await dialog.getByRole('button', { name: 'Save template' }).click()
  await expect(dialog.locator('.hint.error')).toContainText('at least one pattern')
  // Put the seed priority back.
  await pasteInto(app, page, dialog.locator('.monaco-editor'), JSON.stringify({ ...t, priority: 200 }, null, 2))
  await dialog.getByRole('button', { name: 'Save template' }).click()
  await expect(dialog).toHaveCount(0)
  await expect.poll(async () => (await tpl()).priority).toBe(200)
})

test('from the index view, a template opens its own page — not a query tab', async () => {
  await page.locator('.tree-row[title="listings-v7"]').click()
  await page.getByRole('button', { name: 'Query this index' }).click()
  await expect(page.getByRole('tab', { name: 'Aggregations', exact: true })).toBeVisible()
  await page.locator('.tree-row', { hasText: 'listings-template' }).click()
  await expect(page.locator('h1')).toHaveText('listings-template')
  await expect(page.getByRole('button', { name: 'Edit template JSON' })).toBeVisible()
  await expect(page.getByRole('tab', { name: 'Aggregations', exact: true })).toHaveCount(0)
})

test('create a new index template', async () => {
  await page.getByRole('button', { name: 'New index template' }).click()
  const dialog = page.getByRole('dialog')
  await dialog.getByLabel('Name').fill('e2e-orders-template')
  await expect(dialog.locator('.monaco-editor')).toContainText('e2e-orders-*') // pattern follows the name
  await dialog.getByRole('button', { name: 'Create template' }).click()
  await expect(page.locator('.toast')).toContainText('Created index template e2e-orders-template')
  await expect(page.locator('h1')).toHaveText('e2e-orders-template')
  const res = (await (await fetch('http://localhost:9202/_index_template/e2e-orders-template', { headers: AUTH })).json()) as { index_templates: Array<{ index_template: { index_patterns: string[] } }> }
  expect(res.index_templates[0]!.index_template.index_patterns).toEqual(['e2e-orders-*'])
  // An existing name is refused before sending.
  await page.getByRole('button', { name: 'New index template' }).click()
  await page.getByRole('dialog').getByLabel('Name').fill('e2e-orders-template')
  await expect(page.getByRole('dialog')).toContainText('A template with that name exists')
  await expect(page.getByRole('dialog').getByRole('button', { name: 'Create template' })).toBeDisabled()
  await page.getByRole('dialog').getByRole('button', { name: 'Cancel' }).click()
  await fetch('http://localhost:9202/_index_template/e2e-orders-template', { method: 'DELETE', headers: AUTH })
})
