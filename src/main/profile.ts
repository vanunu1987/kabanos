import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { app, safeStorage } from 'electron'

export const APP_NAME = 'kabanos'

/** The app was called "Sift" before; its data lives in ~/Library/Application Support/Sift. */
const LEGACY_DIR = 'Sift'
const LEGACY_DB = 'sift.db'
const DB_FILE = 'kabanos.db'

interface ProfileInfo {
  /** Keychain item prefix that holds the safeStorage key ("<name> Safe Storage"). */
  keychainName: string
  migratedFrom?: string
  migratedAt?: string
}

export interface Profile {
  userData: string
  dbFile: string
  migrated: boolean
}

/**
 * Must run before `app.whenReady()`. Picks the data folder, migrates a Sift profile once,
 * and selects the Keychain item: a migrated profile keeps using "Sift Safe Storage" so stored
 * passwords stay readable (safeStorage reads the key under the app name at first use).
 */
export function prepareProfile(): Profile {
  // Tests point the whole app-data root somewhere disposable to exercise the migration.
  if (process.env.KABANOS_APPDATA) app.setPath('appData', process.env.KABANOS_APPDATA)
  const override = process.env.KABANOS_USER_DATA || undefined
  const userData = override ?? join(app.getPath('appData'), APP_NAME)
  const infoFile = join(userData, 'profile.json')
  let migrated = false

  if (!override && !existsSync(join(userData, DB_FILE))) {
    const legacy = join(app.getPath('appData'), LEGACY_DIR)
    if (existsSync(join(legacy, LEGACY_DB))) {
      mkdirSync(userData, { recursive: true })
      // VACUUM INTO gives a consistent copy including anything still in the WAL.
      const old = new Database(join(legacy, LEGACY_DB), { readonly: true })
      old.exec(`VACUUM INTO '${join(userData, DB_FILE).replace(/'/g, "''")}'`)
      old.close()
      // Open tabs and pane widths live in the renderer's localStorage.
      for (const dir of ['Local Storage']) if (existsSync(join(legacy, dir))) cpSync(join(legacy, dir), join(userData, dir), { recursive: true })
      const info: ProfileInfo = { keychainName: LEGACY_DIR, migratedFrom: legacy, migratedAt: new Date().toISOString() }
      writeFileSync(infoFile, JSON.stringify(info, null, 2))
      migrated = true
    }
  }

  let info: ProfileInfo = { keychainName: APP_NAME }
  try {
    info = { ...info, ...(JSON.parse(readFileSync(infoFile, 'utf8')) as ProfileInfo) }
  } catch {
    /* fresh profile */
  }
  app.setPath('userData', userData)
  app.setName(info.keychainName)
  return { userData, dbFile: join(userData, DB_FILE), migrated }
}

/** After ready: load the safeStorage key under the chosen Keychain name, then show the real app name. */
export function finishProfile(): void {
  if (app.getName() !== APP_NAME) {
    if (safeStorage.isEncryptionAvailable()) safeStorage.encryptString('kabanos') // binds the key in-process
    app.setName(APP_NAME)
  }
}

/** Brand files: from the repo in dev, from Resources/brand when packaged. */
export function brandAsset(file: string): string {
  return app.isPackaged ? join(process.resourcesPath, 'brand', file) : join(import.meta.dirname, '../../brand', file)
}
