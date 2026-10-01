/**
 * Milestone 1 end-to-end: paste a URL, test, save & connect, reopen and edit.
 * Needs `pnpm build` and `pnpm clusters:up`. Run: pnpm e2e
 */
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test'

let app: ElectronApplication
let page: Page

test.beforeAll(async () => {
  app = await electron.launch({ args: ['.'], env: { ...process.env, KABANOS_USER_DATA: mkdtempSync(join(tmpdir(), 'kabanos-e2e-')) } })
  page = await app.firstWindow()
  await page.waitForSelector('text=New connection')
})
test.afterAll(async () => app?.close())

test('connect to ES 9 from a pasted URL', async () => {
  await page.screenshot({ path: 'e2e/screens/01-empty.png' })
  await page.fill('#url', 'http://elastic:sift-dev-pass@localhost:9202')
  await expect(page.locator('.part-value').filter({ hasText: 'elastic' })).toBeVisible()
  await page.fill('#cname', 'Docker ES 9')
  await page.getByRole('button', { name: 'Test connection' }).click()
  await expect(page.getByText(/Connected · Elasticsearch 9\./)).toBeVisible({ timeout: 15000 })
  await page.locator('#url').blur()
  await page.screenshot({ path: 'e2e/screens/02-tested.png' })

  await page.getByRole('button', { name: 'Save & connect' }).click()
  const tab = page.getByRole('tab', { name: /Docker ES 9/ })
  await expect(tab).toBeVisible()
  await expect(tab.locator('.badge')).toHaveText(/ES 9\.\d+/)
  await page.screenshot({ path: 'e2e/screens/03-connected.png' })
})

test('the stored password is kept when editing, never shown', async () => {
  await page.getByRole('button', { name: 'Connections' }).first().click()
  await page.locator('.conn-row', { hasText: 'Docker ES 9' }).click()
  await expect(page.locator('#url')).toHaveValue('http://elastic@localhost:9202')
  await page.getByRole('button', { name: 'Test connection' }).click()
  await expect(page.getByText(/Connected · Elasticsearch 9\./)).toBeVisible({ timeout: 15000 })
})

test('wrong password reports 401 clearly', async () => {
  await page.getByRole('button', { name: 'New connection' }).first().click()
  await page.fill('#url', 'http://elastic:wrong@localhost:9202')
  await page.getByRole('button', { name: 'Test connection' }).click()
  await expect(page.getByText(/Authentication failed \(401\)/)).toBeVisible({ timeout: 15000 })
})

test('OpenSearch with self-signed TLS gets the OS badge', async () => {
  await page.getByRole('button', { name: 'New connection' }).first().click()
  await page.fill('#url', 'https://admin:Sift-dev-Pass_42@localhost:9201')
  await page.getByRole('button', { name: 'Test connection' }).click()
  await expect(page.getByText(/TLS error/)).toBeVisible({ timeout: 15000 })
  await page.getByLabel('Verify TLS certificate').uncheck()
  await page.fill('#cname', 'Docker OpenSearch')
  await page.fill('#folder', 'Staging')
  await page.getByRole('button', { name: 'teal' }).click()
  await page.getByRole('button', { name: 'Save & connect' }).click()
  await expect(page.getByRole('tab', { name: /Docker OpenSearch/ }).locator('.badge.os')).toHaveText(/OS 2\.19/)
})

test('production connections show the stripe', async () => {
  await page.getByRole('button', { name: 'New connection' }).first().click()
  await page.fill('#url', 'http://elastic:sift-dev-pass@localhost:9202')
  await page.fill('#cname', 'Search · Production')
  await page.fill('#folder', 'Production')
  await expect(page.getByLabel(/Production/)).toBeChecked()
  await page.getByRole('button', { name: 'Save & connect' }).click()
  await expect(page.getByRole('tab', { name: /Search · Production/ })).toHaveClass(/prod/)
  await page.getByRole('button', { name: 'Connections' }).first().click()
  await page.screenshot({ path: 'e2e/screens/04-list.png' })
})
