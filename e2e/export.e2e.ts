/** Export: current page, all matching documents, and a whole index with its definition. */
import { existsSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { CLUSTERS, connect, launch, pasteInto } from './helpers'

test.describe.configure({ mode: 'serial' })
let app: ElectronApplication
let page: Page
const dir = mkdtempSync(join(tmpdir(), 'kabanos-exports-'))
const AUTH = { authorization: `Basic ${Buffer.from('elastic:sift-dev-pass').toString('base64')}`, 'content-type': 'application/json' }

/** The native save dialog returns this path. */
async function saveAs(name: string): Promise<string> {
  const file = join(dir, name)
  await app.evaluate(({ dialog }, f) => {
    ;(dialog as unknown as { showSaveDialog: () => Promise<{ canceled: boolean; filePath: string }> }).showSaveDialog = async () => ({ canceled: false, filePath: f })
  }, file)
  return file
}

test.beforeAll(async () => {
  ;({ app, page } = await launch())
  await connect(page, CLUSTERS.es9)
})
test.afterAll(async () => app?.close())

test('index view: export this page as JSON', async () => {
  await page.locator('.tree-row[title="listings-v7"]').click()
  await page.getByRole('button', { name: 'Query this index' }).click()
  await pasteInto(app, page, page.locator('.iv-body .monaco-editor'), '{"size":20,"query":{"term":{"status":"active"}}}')
  await page.getByRole('button', { name: /Run/ }).click()
  await expect(page.locator('.status-badge')).toHaveText('200')
  await page.getByRole('button', { name: 'Export…' }).click()
  const dialog = page.getByRole('dialog')
  await expect(dialog).toContainText('20 documents shown in the results')
  await dialog.getByRole('button', { name: 'JSON', exact: true }).click()
  const file = await saveAs('page.json')
  await dialog.getByRole('button', { name: 'Export…' }).click()
  await expect(page.locator('.toast')).toContainText('Exported 20 documents to page.json')
  const docs = JSON.parse(readFileSync(file, 'utf8')) as Array<{ _id: string; status: string }>
  expect(docs).toHaveLength(20)
  expect(docs.every((d) => d._id && d.status === 'active')).toBe(true)
})

test('index view: export every matching document as NDJSON', async () => {
  const expected = ((await (await fetch('http://localhost:9202/listings-v7/_count', { method: 'POST', headers: AUTH, body: '{"query":{"term":{"status":"active"}}}' })).json()) as { count: number }).count
  await page.getByRole('button', { name: 'Export…' }).click()
  const dialog = page.getByRole('dialog')
  await dialog.getByText('All matching documents').click()
  await expect(dialog).toContainText(`${expected.toLocaleString()} documents · streamed from the cluster`)
  await dialog.getByLabel('Include _id and _index').uncheck()
  const file = await saveAs('active.ndjson')
  await dialog.getByRole('button', { name: 'Export…' }).click()
  await expect(page.locator('.toast')).toContainText(`Exported ${expected.toLocaleString()} documents`)
  const lines = readFileSync(file, 'utf8').trim().split('\n').map((l) => JSON.parse(l) as Record<string, unknown>)
  expect(lines).toHaveLength(expected)
  expect(lines[0]).not.toHaveProperty('_id')
  expect(lines.every((d) => d.status === 'active')).toBe(true)
})

test('explorer: export the whole index as CSV with its definition', async () => {
  await page.locator('.qtab.back').click()
  await page.locator('.tree-row[title="listings-v7"]').click()
  await page.getByRole('button', { name: 'More actions' }).click()
  await page.getByRole('menuitem', { name: 'Export documents…' }).click()
  const dialog = page.getByRole('dialog')
  await expect(dialog).toContainText('Every document in the index — 400 documents')
  await dialog.getByRole('button', { name: 'CSV', exact: true }).click()
  await dialog.getByLabel(/Also save mapping/).check()
  const file = await saveAs('listings.csv')
  await dialog.getByRole('button', { name: 'Export…' }).click()
  await expect(page.locator('.toast')).toContainText('Exported 400 documents to listings.csv (+ mapping & settings)')
  const rows = readFileSync(file, 'utf8').trim().split('\n')
  expect(rows).toHaveLength(401)
  expect(rows[0]).toContain('city.name')
  const def = file.replace(/\.csv$/, '.definition.json')
  expect(existsSync(def)).toBe(true)
  const d = JSON.parse(readFileSync(def, 'utf8')) as Record<string, { mappings: { properties: Record<string, unknown> }; aliases: Record<string, unknown> }>
  expect(d['listings-v7']!.mappings.properties).toHaveProperty('location')
  expect(d['listings-v7']!.aliases).toHaveProperty('listings')
})

test('workspace: export a search response', async () => {
  await page.getByRole('button', { name: 'Query workspace' }).click()
  await page.getByRole('button', { name: 'New request' }).click()
  await expect(page.locator('.block').last().locator('.monaco-editor.focused')).toBeVisible()
  await pasteInto(app, page, page.locator('.block').last().locator('.monaco-editor'), 'POST users/_search\n{"size":5}')
  await page.locator('.block').last().getByRole('button', { name: 'Run this request' }).click()
  await expect(page.locator('.response-pane .status-badge')).toHaveText('200')
  await page.locator('.response-pane').getByRole('button', { name: 'Export…' }).click()
  const dialog = page.getByRole('dialog')
  await expect(dialog).toContainText('Export results · users')
  await dialog.getByText('All matching documents').click()
  await expect(dialog).toContainText('80 documents')
  const file = await saveAs('users.ndjson')
  await dialog.getByRole('button', { name: 'Export…' }).click()
  await expect(page.locator('.toast')).toContainText('Exported 80 documents')
  expect(readFileSync(file, 'utf8').trim().split('\n')).toHaveLength(80)
})
