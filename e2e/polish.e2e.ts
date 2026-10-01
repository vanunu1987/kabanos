/** Milestone 7: command palette, read-only mode, settings. */
import { expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { CLUSTERS, connect, launch, pasteInto } from './helpers'

test.describe.configure({ mode: 'serial' })
let app: ElectronApplication
let page: Page
test.beforeAll(async () => {
  ;({ app, page } = await launch())
  await connect(page, CLUSTERS.es9)
})
test.afterAll(async () => app?.close())

test('⌘K jumps to an index and to screens', async () => {
  await page.keyboard.press('Meta+K')
  await page.getByLabel('Search everything').fill('lstv7')
  await expect(page.locator('.palette-item').first()).toContainText('listings-v7')
  await page.keyboard.press('Enter')
  await expect(page.locator('.title-row h1')).toHaveText('listings-v7')
  await page.keyboard.press('Meta+K')
  await page.getByLabel('Search everything').fill('routines')
  await page.keyboard.press('Enter')
  await expect(page.locator('.tree-title', { hasText: 'Routines' })).toBeVisible()
})

test('read-only connections show RO and block writes before they reach the cluster', async () => {
  await page.getByRole('button', { name: 'Connections' }).first().click()
  await page.locator('.conn-row', { hasText: 'Docker ES 9' }).click()
  await page.getByRole('button', { name: /Advanced/ }).click()
  await page.getByLabel(/Read-only mode/).check()
  await page.getByRole('button', { name: 'Save & connect' }).click()
  await expect(page.getByRole('tab', { name: /Docker ES 9/ }).locator('.badge.ro')).toBeVisible()
  await page.getByRole('button', { name: 'Query workspace' }).click()
  await page.getByRole('button', { name: 'New request' }).click()
  await expect(page.locator('.block').last().locator('.monaco-editor.focused')).toBeVisible()
  await pasteInto(app, page, page.locator('.block').last().locator('.monaco-editor'), 'DELETE listings-v6')
  await page.locator('.block').last().getByRole('button', { name: 'Run this request' }).click()
  await expect(page.locator('.response-pane .error-box')).toContainText('is read-only')
  // Reads still work.
  await pasteInto(app, page, page.locator('.block').last().locator('.monaco-editor'), 'POST listings-v6/_count')
  await page.locator('.block').last().getByRole('button', { name: 'Run this request' }).click()
  await expect(page.locator('.response-pane')).toContainText('"count": 150')
})

test('settings show the data folder and shortcuts', async () => {
  await page.getByRole('button', { name: 'Settings' }).click()
  await expect(page.locator('.settings')).toContainText('Data folder')
  await expect(page.locator('.settings')).toContainText('⌘K')
})
