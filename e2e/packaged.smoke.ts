/** Smoke test for the packaged .app (run after `pnpm exec electron-builder --mac --arm64 --dir`). */
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { _electron as electron, expect, test } from '@playwright/test'
import { CLUSTERS, connect } from './helpers'

test('packaged app connects and loads the explorer', async () => {
  const app = await electron.launch({ executablePath: 'dist/mac-arm64/kabanos.app/Contents/MacOS/kabanos', env: { ...process.env, KABANOS_USER_DATA: mkdtempSync(join(tmpdir(), 'kabanos-pkg-')) } })
  const page = await app.firstWindow()
  await page.waitForSelector('text=New connection')
  await connect(page, CLUSTERS.es9)
  await expect(page.locator('.tree-row[title="listings-v7"]')).toBeVisible()
  await page.getByRole('button', { name: 'Query workspace' }).click()
  await page.getByRole('button', { name: 'New request' }).click()
  await page.locator('.block').last().getByRole('button', { name: 'Run this request' }).click()
  await expect(page.locator('.response-pane .status-badge')).toHaveText('200')
  await app.close()
})
