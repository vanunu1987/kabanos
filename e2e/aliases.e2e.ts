/** Alias targets: add an index, switch the write index, remove — checked against the cluster. */
import { expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { CLUSTERS, connect, launch } from './helpers'

test.describe.configure({ mode: 'serial' })
let app: ElectronApplication
let page: Page
const AUTH = { authorization: `Basic ${Buffer.from('elastic:sift-dev-pass').toString('base64')}` }
const alias = async () =>
  Object.fromEntries(
    Object.entries((await (await fetch('http://localhost:9202/_alias/listings', { headers: AUTH })).json()) as Record<string, { aliases: { listings: { is_write_index?: boolean } } }>).map(([i, v]) => [i, !!v.aliases.listings.is_write_index])
  )

test.beforeAll(async () => {
  ;({ app, page } = await launch())
  await connect(page, CLUSTERS.es9)
})
test.afterAll(async () => app?.close())

test('add, make write index and remove alias targets', async () => {
  expect(await alias()).toEqual({ 'listings-v7': true })
  await page.locator('.tree-row', { hasText: /^listings → / }).click()
  const card = page.getByRole('region', { name: 'Alias targets' })
  await expect(card).toContainText('listings-v7')

  await card.getByRole('button', { name: '+ Add index' }).click()
  await card.getByLabel('Index to add').fill('listings-v6')
  await card.getByRole('button', { name: 'Add', exact: true }).click()
  await expect(page.locator('.toast')).toContainText('Added listings-v6 to listings')
  await expect(card).toContainText('listings-v6')
  expect(await alias()).toEqual({ 'listings-v6': false, 'listings-v7': true })

  // One write index at a time: switching demotes v7 in the same call.
  await card.locator('.alias-target', { hasText: 'listings-v6' }).getByRole('button', { name: 'Make write index' }).click()
  await expect(page.locator('.toast')).toContainText('listings-v6 is now the write index')
  expect(await alias()).toEqual({ 'listings-v6': true, 'listings-v7': false })

  // Removing the write index promotes the one left.
  page.once('dialog', (d) => void d.accept())
  await card.getByRole('button', { name: 'Remove listings-v6 from listings' }).click()
  await expect(page.locator('.toast')).toContainText('Removed listings-v6 from listings')
  await expect(card.locator('.alias-target')).toHaveCount(1)
  expect(await alias()).toEqual({ 'listings-v7': true })
})

test('cancelled removal keeps the alias', async () => {
  const card = page.getByRole('region', { name: 'Alias targets' })
  page.once('dialog', (d) => void d.dismiss())
  await card.getByRole('button', { name: 'Remove listings-v7 from listings' }).click()
  await expect(card.locator('.alias-target')).toHaveCount(1)
  expect(await alias()).toEqual({ 'listings-v7': true })
})
