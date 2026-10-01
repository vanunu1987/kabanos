/**
 * Sift → kabanos: a profile written by the old app (sift.db, "Sift Safe Storage" key) is migrated
 * on first launch and its stored passwords still work.
 */
import { existsSync, mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { _electron as electron, expect, test } from '@playwright/test'
import { connect } from './helpers'

test('a Sift profile is migrated with its secrets intact', async () => {
  const appData = mkdtempSync(join(tmpdir(), 'kabanos-appdata-'))
  const legacy = join(appData, 'Sift')
  mkdirSync(legacy)
  // 1. Write a profile exactly like the old app: Keychain item "Sift Safe Storage".
  writeFileSync(join(legacy, 'profile.json'), JSON.stringify({ keychainName: 'Sift' }))
  let app = await electron.launch({ args: ['.'], env: { ...process.env, KABANOS_USER_DATA: legacy } })
  let page = await app.firstWindow()
  await page.waitForSelector('text=New connection')
  await connect(page, { url: 'http://elastic:sift-dev-pass@localhost:9202', name: 'Legacy ES 9', verify: true })
  await app.close()
  renameSync(join(legacy, 'kabanos.db'), join(legacy, 'sift.db'))
  for (const f of ['kabanos.db-wal', 'kabanos.db-shm']) if (existsSync(join(legacy, f))) renameSync(join(legacy, f), join(legacy, f.replace('kabanos', 'sift')))
  rmSync(join(legacy, 'profile.json'))

  // 2. First kabanos launch: data copied to <appData>/kabanos, old folder untouched.
  app = await electron.launch({ args: ['.'], env: { ...process.env, KABANOS_APPDATA: appData, KABANOS_USER_DATA: '' } })
  page = await app.firstWindow()
  await page.waitForSelector('text=New connection')
  expect(existsSync(join(appData, 'kabanos', 'kabanos.db'))).toBe(true)
  expect(existsSync(join(legacy, 'sift.db'))).toBe(true)

  // 3. The stored password still decrypts: the connection tests green without re-entering it.
  await page.locator('.conn-row', { hasText: 'Legacy ES 9' }).click()
  await expect(page.locator('#url')).toHaveValue('http://elastic@localhost:9202')
  await page.getByRole('button', { name: 'Test connection' }).click()
  await expect(page.getByText(/Connected · Elasticsearch 9\./)).toBeVisible({ timeout: 15000 })
  await expect(page.locator('.titlebar .wordmark')).toHaveText('kabanos')
  await page.screenshot({ path: 'e2e/screens/60-kabanos.png' })
  await app.close()
})
