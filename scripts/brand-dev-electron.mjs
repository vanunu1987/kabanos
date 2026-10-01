// Dev mode runs the app inside node_modules/electron's generic Electron.app, so macOS shows
// "Electron" (Dock label, process name) whatever the app calls itself. This builds a properly
// named dev bundle — dist/kabanos.app, the same renaming electron-builder does for releases —
// and points the `electron` package (path.txt) at it, so `pnpm dev`, tests and Playwright use it.
// Idempotent: runs after install and before `pnpm dev`. Packaged builds are unaffected.
import { execFileSync } from 'node:child_process'
import { copyFileSync, existsSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

if (process.platform !== 'darwin') process.exit(0)
const NAME = 'kabanos'
// Own bundle id (the Dock caches labels by id); distinct from the packaged io.kabanos.desktop.
const BUNDLE_ID = 'io.kabanos.dev'
const VERSION = 1 // bump to force a rebuild when this script changes

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const pkg = join(root, 'node_modules/electron')
const dist = join(pkg, 'dist')
const src = join(dist, 'Electron.app')
const dst = join(dist, `${NAME}.app`)
const pathTxt = join(pkg, 'path.txt')
const stamp = join(dist, '.kabanos-dev-bundle')
const icon = join(root, 'brand/kabanos.icns')
if (!existsSync(src)) process.exit(0)

const electronVersion = readFileSync(join(dist, 'version'), 'utf8').trim()
const want = `${VERSION}:${electronVersion}:${existsSync(icon) ? readFileSync(icon).length : 0}`
const target = `${NAME}.app/Contents/MacOS/${NAME}`
if (existsSync(dst) && existsSync(stamp) && readFileSync(stamp, 'utf8') === want && readFileSync(pathTxt, 'utf8') === target) process.exit(0)

const plist = (file, sets) => {
  for (const [key, value] of Object.entries(sets)) {
    try {
      execFileSync('/usr/libexec/PlistBuddy', ['-c', `Set :${key} ${value}`, file], { stdio: 'ignore' })
    } catch {
      execFileSync('/usr/libexec/PlistBuddy', ['-c', `Add :${key} string ${value}`, file], { stdio: 'ignore' })
    }
  }
}

rmSync(dst, { recursive: true, force: true })
// APFS clone: instant and takes no extra disk space.
execFileSync('cp', ['-cR', src, dst])

// Main executable + Info.plist.
renameSync(join(dst, 'Contents/MacOS/Electron'), join(dst, `Contents/MacOS/${NAME}`))
if (existsSync(icon)) copyFileSync(icon, join(dst, `Contents/Resources/${NAME}.icns`))
plist(join(dst, 'Contents/Info.plist'), { CFBundleExecutable: NAME, CFBundleName: NAME, CFBundleDisplayName: NAME, CFBundleIdentifier: BUNDLE_ID, CFBundleIconFile: `${NAME}.icns` })

// Helper apps: Electron looks them up as "<executable name> Helper (…)".
const frameworks = join(dst, 'Contents/Frameworks')
for (const entry of readdirSync(frameworks)) {
  const m = /^Electron Helper(.*)\.app$/.exec(entry)
  if (!m) continue
  const suffix = m[1] // '', ' (GPU)', ' (Renderer)', ' (Plugin)'
  const helperName = `${NAME} Helper${suffix}`
  const app = join(frameworks, `${helperName}.app`)
  renameSync(join(frameworks, entry), app)
  renameSync(join(app, `Contents/MacOS/Electron Helper${suffix}`), join(app, `Contents/MacOS/${helperName}`))
  const idSuffix = suffix.replace(/[^\w]/g, '').toLowerCase()
  plist(join(app, 'Contents/Info.plist'), { CFBundleExecutable: helperName, CFBundleName: helperName, CFBundleDisplayName: helperName, CFBundleIdentifier: `${BUNDLE_ID}.helper${idSuffix ? `.${idSuffix}` : ''}` })
}

// Renaming breaks the signature; Apple silicon refuses to launch it unless re-signed.
execFileSync('codesign', ['--force', '--deep', '--sign', '-', dst], { stdio: 'ignore' })
try {
  execFileSync('/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister', ['-f', dst], { stdio: 'ignore' })
} catch {
  /* best effort */
}
writeFileSync(pathTxt, target)
writeFileSync(stamp, want)
console.log(`dev bundle ready: ${dst}`)
