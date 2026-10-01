/** Light / dark theme: toggle, persistence, editors and native window follow. */
import { expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { CLUSTERS, connect, launch, pasteInto, suggest } from './helpers'

test.describe.configure({ mode: 'serial' })
let app: ElectronApplication
let page: Page
let dataDir: string
test.beforeAll(async () => {
  ;({ app, page, dataDir } = await launch())
  await connect(page, CLUSTERS.es9)
})
test.afterAll(async () => app?.close())

const bg = () => page.evaluate(() => getComputedStyle(document.body).backgroundColor)

test('the title-bar toggle switches to light and back', async () => {
  expect(await bg()).toBe('rgb(18, 20, 25)')
  await page.getByRole('button', { name: 'Switch to light mode' }).click()
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light')
  expect(await bg()).toBe('rgb(246, 247, 249)')
  expect(await app.evaluate(({ nativeTheme }) => nativeTheme.themeSource)).toBe('light')
})

test('editors use the light Monaco theme', async () => {
  await page.locator('.tree-row[title="listings-v7"]').click()
  await page.getByRole('button', { name: 'Query this index' }).click()
  await expect(page.locator('.iv-body .monaco-editor')).toHaveClass(/vs(?!-dark)/)
  const editorBg = await page.locator('.iv-body .monaco-editor .monaco-editor-background').evaluate((e) => getComputedStyle(e).backgroundColor)
  expect(editorBg).toBe('rgb(255, 255, 255)')
  await page.screenshot({ path: 'e2e/screens/70-light-index.png' })
  await page.getByRole('button', { name: 'Query workspace' }).click()
  await page.getByRole('button', { name: 'New request' }).click()
  await page.locator('.block').last().getByRole('button', { name: 'Run this request' }).click()
  await expect(page.locator('.response-pane .status-badge')).toHaveText('200')
  await expect(page.locator('.response-pane .view-lines')).toContainText('hits')
  await page.screenshot({ path: 'e2e/screens/71-light-workspace.png' })
})

test('the choice survives a restart; Settings offers Match system', async () => {
  await app.close()
  ;({ app, page } = await launch(dataDir))
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light')
  expect(await app.evaluate(({ nativeTheme }) => nativeTheme.themeSource)).toBe('light')
  await page.getByRole('button', { name: 'Settings' }).click()
  await page.getByRole('group', { name: 'Theme' }).getByRole('button', { name: 'Dark' }).click()
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark')
  await page.getByRole('group', { name: 'Theme' }).getByRole('button', { name: 'Match system' }).click()
  expect(await app.evaluate(({ nativeTheme }) => nativeTheme.themeSource)).toBe('system')
})

test('light mode: the selected suggestion is readable', async () => {
  await page.getByRole('group', { name: 'Theme' }).getByRole('button', { name: 'Light' }).click()
  await page.getByRole('button', { name: 'Query workspace' }).click()
  await page.getByRole('button', { name: 'New request' }).click()
  const ed = page.locator('.block').last().locator('.monaco-editor')
  await expect(ed).toHaveClass(/focused/)
  await pasteInto(app, page, ed, 'GET listings-v7/_search\n{\n  "query": {\n    r\n  }\n}')
  await page.keyboard.press('Meta+ArrowUp')
  for (let i = 0; i < 3; i++) await page.keyboard.press('ArrowDown')
  await page.keyboard.press('End')
  await suggest(page, 'range')
  const row = page.locator('.suggest-widget.visible .monaco-list-row.focused').first()
  const [fg, bg] = await row.evaluate((r) => {
    const label = r.querySelector('.label-name') as HTMLElement
    return [getComputedStyle(label).color, getComputedStyle(r).backgroundColor]
  })
  // Dark text on the pale amber selection (was near-white before).
  const lum = (rgb: string) => {
    const [r, g, b] = rgb.match(/\d+/g)!.slice(0, 3).map(Number).map((c) => c / 255).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4))
    return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!
  }
  const contrast = (lum(bg) + 0.05) / (lum(fg) + 0.05)
  expect(contrast).toBeGreaterThan(7)
  await page.screenshot({ path: 'e2e/screens/72-light-suggest.png' })
})
