import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { _electron as electron, expect, type ElectronApplication, type Page } from '@playwright/test'

export async function launch(dataDir = mkdtempSync(join(tmpdir(), 'kabanos-e2e-'))): Promise<{ app: ElectronApplication; page: Page; dataDir: string }> {
  const app = await electron.launch({ args: ['.'], env: { ...process.env, KABANOS_USER_DATA: dataDir } })
  const page = await app.firstWindow()
  await page.waitForSelector('text=New connection')
  return { app, page, dataDir }
}

export const CLUSTERS = {
  es9: { url: 'http://elastic:sift-dev-pass@localhost:9202', name: 'Docker ES 9', verify: true },
  os2: { url: 'https://admin:Sift-dev-Pass_42@localhost:9201', name: 'Docker OpenSearch', verify: false }
}

/** Fill the connection form and Save & connect; lands in the Explorer. */
export async function connect(page: Page, c: { url: string; name: string; verify: boolean }, folder = 'Local'): Promise<void> {
  await page.getByRole('button', { name: 'Connections' }).first().click()
  await page.getByRole('button', { name: 'New connection' }).first().click()
  await page.fill('#url', c.url)
  await page.fill('#cname', c.name)
  await page.fill('#folder', folder)
  if (!c.verify) await page.getByLabel('Verify TLS certificate').uncheck()
  await page.getByRole('button', { name: 'Save & connect' }).click()
  await expect(page.getByRole('tab', { name: new RegExp(c.name) })).toBeVisible({ timeout: 15000 })
}

/** Replace the focused Monaco editor's content via the clipboard (typing would trigger auto-closing). */
export async function pasteInto(app: ElectronApplication, page: Page, editor: ReturnType<Page['locator']>, text: string): Promise<void> {
  await editor.locator('.view-lines').click()
  await expect(editor).toHaveClass(/focused/)
  await app.evaluate(({ clipboard }, t) => clipboard.writeText(t), text)
  await page.keyboard.press('Meta+A')
  await page.keyboard.press('Meta+V')
  // Monaco renders spaces as nbsp (matched by \s); check the whole first line landed.
  const first = text.split('\n')[0]!.trim()
  await expect(editor.locator('.view-lines')).toContainText(new RegExp(first.split(/\s+/).map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('\\s+')))
}

/** Open the suggest widget on settled text and wait for an entry (retries if Monaco raced the edit). */
export async function suggest(page: Page, expected: string): Promise<void> {
  for (let i = 0; i < 3; i++) {
    await page.keyboard.press('Escape')
    await page.waitForTimeout(150)
    await page.keyboard.press('Control+Space')
    try {
      await expect(page.locator('.suggest-widget.visible')).toContainText(expected, { timeout: 2500 })
      return
    } catch {
      /* retry */
    }
  }
  await expect(page.locator('.suggest-widget.visible')).toContainText(expected)
}
