import { join } from 'node:path'
import { app, BrowserWindow, dialog, Menu, nativeImage, safeStorage, shell, Tray } from 'electron'
import { ConnectionManager, type ConfirmWrite } from './connections/ConnectionManager'
import { SecretStore } from './connections/secrets'
import { registerIpc } from './ipc/handlers'
import { MetadataService } from './metadata/MetadataService'
import { openDb } from './store/db'
import { LibraryStore } from './store/LibraryStore'
import { RoutineRunner } from './routines/RoutineRunner'
import { RoutineStore } from './routines/RoutineStore'
import { SecurityService } from './security/SecurityService'
import { ROUTINE_EVENT_CHANNEL } from '@shared/routines'
import { classifyRequest } from '@shared/destructive'
import { APP_NAME, brandAsset, finishProfile, prepareProfile } from './profile'

let mainWindow: BrowserWindow | null = null
let tray: Tray | null = null

// Data folder, one-time migration from "Sift", Keychain item. KABANOS_USER_DATA gives e2e tests a throwaway profile.
const profile = prepareProfile()

function createWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1100,
    minHeight: 700,
    show: false,
    backgroundColor: '#121419',
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 14, y: 16 },
    webPreferences: {
      preload: join(import.meta.dirname, '../preload/index.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  })
  win.once('ready-to-show', () => win.show())
  // External links open in the browser; the app window never navigates away.
  win.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url)
    return { action: 'deny' }
  })
  win.webContents.on('will-navigate', (e) => e.preventDefault())

  if (process.env.ELECTRON_RENDERER_URL) void win.loadURL(process.env.ELECTRON_RENDERER_URL)
  else void win.loadFile(join(import.meta.dirname, '../renderer/index.html'))
  return win
}

/** Native dialog in main, so no renderer code path can skip the production check. */
const confirmWrite: ConfirmWrite = async (conn, req, c) => {
  const opts = {
    type: 'warning' as const,
    buttons: ['Cancel', c.safety === 'danger' ? 'Run anyway' : 'Run'],
    defaultId: 0,
    cancelId: 0,
    message: `${req.method} ${req.path}`,
    detail: `"${conn.name}" is a production connection.\nThis request ${c.reason}.`
  }
  const res = mainWindow ? await dialog.showMessageBox(mainWindow, opts) : await dialog.showMessageBox(opts)
  return res.response === 1
}

function showWindow(): BrowserWindow {
  if (!mainWindow || mainWindow.isDestroyed()) mainWindow = createWindow()
  if (mainWindow.isMinimized()) mainWindow.restore()
  mainWindow.show()
  mainWindow.focus()
  return mainWindow
}

/** Menu-bar icon: open the app, jump straight to a connection, quit. */
function createTray(listConnections: () => Array<{ id: string; name: string; folder: string; isProd: boolean }>): void {
  const icon = nativeImage.createFromPath(brandAsset('kabanos-menubarTemplate@2x.png'))
  if (icon.isEmpty()) return
  icon.setTemplateImage(true)
  tray = new Tray(icon)
  tray.setToolTip(APP_NAME)
  tray.on('click', () => {
    const conns = listConnections()
    const menu = Menu.buildFromTemplate([
      { label: `Open ${APP_NAME}`, click: () => showWindow() },
      { type: 'separator' },
      ...(conns.length
        ? conns.slice(0, 20).map((c) => ({
            label: `${c.name}${c.isProd ? '  · prod' : ''}`,
            sublabel: c.folder,
            click: () => showWindow().webContents.send('kabanos:open-connection', c.id)
          }))
        : [{ label: 'No saved connections', enabled: false }]),
      { type: 'separator' },
      { label: `Quit ${APP_NAME}`, role: 'quit' as const }
    ])
    tray?.popUpContextMenu(menu)
  })
}

app.whenReady().then(() => {
  finishProfile()
  app.setAboutPanelOptions({ applicationName: APP_NAME, applicationVersion: app.getVersion(), copyright: 'Elasticsearch & OpenSearch, organised.' })
  // Packaged builds take the Dock icon from the .icns; in dev, show the brand icon instead of Electron's.
  if (!app.isPackaged && process.platform === 'darwin') app.dock?.setIcon(nativeImage.createFromPath(brandAsset('kabanos-icon-1024.png')))
  const db = openDb(profile.dbFile)
  const cipher = {
    isAvailable: () => safeStorage.isEncryptionAvailable(),
    encrypt: (plain: string) => safeStorage.encryptString(plain),
    decrypt: (blob: Buffer) => safeStorage.decryptString(blob)
  }
  const secrets = new SecretStore(db, cipher)
  const connections = new ConnectionManager(db, secrets, confirmWrite)
  const metadata = new MetadataService((req) => connections.request(req))
  const library = new LibraryStore(db, cipher)
  const routines = new RoutineStore(db)
  routines.markInterrupted()
  const runner = new RoutineRunner({
    request: async (req) => {
      const res = await connections.request(req)
      if (res.status < 400 && classifyRequest(req.method, req.path, req.body).safety !== 'read') metadata.invalidate(req.connectionId)
      return res
    },
    cancel: (id) => connections.cancel(id),
    connection: (id) => connections.get(id),
    query: (id) => library.query(id),
    confirm: async (step, conn, req) => {
      const opts = { type: 'question' as const, buttons: ['Cancel', 'Run step'], defaultId: 0, cancelId: 0, message: `Run “${step.name}”?`, detail: `${req.method} ${req.path}\non ${conn.name}` }
      const res = mainWindow ? await dialog.showMessageBox(mainWindow, opts) : await dialog.showMessageBox(opts)
      return res.response === 1
    },
    emit: (e) => mainWindow?.webContents.send(ROUTINE_EVENT_CHANNEL, e),
    save: (run) => routines.saveRun(run)
  })
  const security = new SecurityService((req) => connections.request(req), (id) => connections.get(id))
  registerIpc(connections, metadata, library, routines, runner, security)

  mainWindow = createWindow()
  if (!process.env.KABANOS_USER_DATA && !process.env.KABANOS_APPDATA) createTray(() => connections.list())
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) mainWindow = createWindow()
  })
  app.on('before-quit', () => {
    void connections.closeAll()
    db.close()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
