/** Queries belong to one cluster: each workspace shows only its own, crossing clusters is an explicit import. */
import { expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { CLUSTERS, connect, launch, pasteInto } from './helpers'

test.describe.configure({ mode: 'serial' })
let app: ElectronApplication
let page: Page

const blocks = () => page.locator('.block')
const libRows = () => page.locator('.library .lib-row')
const tabFor = (name: string) => page.locator('.conn-tab, [role="tab"]', { hasText: name }).first()
const ipc = (method: string, ...args: unknown[]) =>
  page.evaluate(([m, a]) => (window as unknown as { kabanosIpc: { invoke(m: string, a: unknown[]): Promise<{ ok: boolean; value?: unknown; error?: { message: string } }> } }).kabanosIpc.invoke(m as string, a as unknown[]), [method, args] as const)

test.beforeAll(async () => {
  ;({ app, page } = await launch())
  await connect(page, { ...CLUSTERS.os2, name: 'Logs OS' })
  await connect(page, { ...CLUSTERS.es9, name: 'Search ES' })
})
test.afterAll(async () => app?.close())

test('a query saved on one cluster is not shown on another', async () => {
  await page.getByRole('button', { name: 'Query workspace' }).click()
  await expect(page.locator('.lib-owner')).toContainText('Search ES')
  await page.getByRole('button', { name: 'New request' }).click()
  await pasteInto(app, page, blocks().last().locator('.monaco-editor'), 'GET listings/_count')
  await blocks().last().getByRole('button', { name: 'Block actions' }).click()
  await page.getByRole('menuitem', { name: 'Save to folder…' }).click()
  const dialog = page.getByRole('dialog')
  await expect(dialog.getByRole('heading')).toContainText('Search ES')
  await dialog.locator('#q-title').fill('Count listings (ES)')
  await dialog.getByLabel('New folder').fill('Counts')
  await dialog.getByRole('button', { name: /^Save/ }).click()
  await expect(libRows().filter({ hasText: 'Count listings (ES)' })).toHaveCount(1)

  // Switch to the OpenSearch cluster: its workspace and library are its own.
  await tabFor('Logs OS').click()
  await page.getByRole('button', { name: 'Query workspace' }).click()
  await expect(page.locator('.lib-owner')).toContainText('Logs OS')
  await expect(libRows().filter({ hasText: 'Count listings (ES)' })).toHaveCount(0)
  await expect(blocks().filter({ hasText: 'Count listings (ES)' })).toHaveCount(0)
})

test('the main process refuses to run a query on another cluster', async () => {
  const conns = (await ipc('connections.list')).value as Array<{ id: string; name: string }>
  const es = conns.find((c) => c.name === 'Search ES')!
  const os = conns.find((c) => c.name === 'Logs OS')!
  const esQueries = (await ipc('library.queries', es.id, { kind: 'all' })).value as Array<{ id: string; title: string }>
  const q = esQueries.find((x) => x.title === 'Count listings (ES)')!
  const res = await ipc('cluster.run', { connectionId: os.id, method: 'GET', path: 'listings/_count', queryId: q.id })
  expect(res.ok).toBe(false)
  expect(res.error?.message).toContain('belongs to Search ES')
  expect(res.error?.message).toContain('Import it into Logs OS')
})

test('importing copies the query into this cluster on purpose', async () => {
  await page.getByRole('button', { name: 'Import queries from another cluster' }).click()
  const dialog = page.getByRole('dialog')
  await expect(dialog.getByRole('heading')).toContainText('Import queries into Logs OS')
  await dialog.getByLabel('Source cluster').selectOption({ label: 'Search ES' })
  await dialog.getByLabel('Import Count listings (ES)').check()
  await dialog.getByRole('button', { name: /^Copy 1 into Logs OS/ }).click()
  await expect(page.locator('.toast')).toContainText('Copied 1 query from Search ES into Logs OS')
  const copy = libRows().filter({ hasText: 'Count listings (ES)' })
  await expect(copy).toHaveCount(1)
  await expect(page.locator('.library')).toContainText('Counts') // folder path kept

  // The copy runs here; the original is still only on Search ES.
  await copy.click()
  await blocks().filter({ hasText: 'Count listings (ES)' }).getByRole('button', { name: 'Run this request' }).click()
  await expect(page.locator('.response-pane .status-badge')).toHaveText('200')
  await tabFor('Search ES').click()
  await page.getByRole('button', { name: 'Query workspace' }).click()
  await expect(libRows().filter({ hasText: 'Count listings (ES)' })).toHaveCount(1)
})
