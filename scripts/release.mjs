// Build both DMGs and publish them as a GitHub release (the website reads the latest release).
//   pnpm release            → builds, checksums, then `gh release create v<version>` with notes from release-notes/v<version>.md
//   pnpm release --dry-run  → builds and checksums only
// Needs the GitHub CLI signed in (`gh auth login`). The version comes from package.json.
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createReadStream, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const dry = process.argv.includes('--dry-run')
const root = new URL('..', import.meta.url).pathname
const { version } = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const tag = `v${version}`
const notes = join(root, 'release-notes', `${tag}.md`)
const run = (cmd, args) => execFileSync(cmd, args, { cwd: root, stdio: 'inherit' })

if (!dry) {
  if (!existsSync(notes)) throw new Error(`Write the release notes first: release-notes/${tag}.md (bullet points; the first three appear on the website)`)
  const status = execFileSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' }).trim()
  if (status) throw new Error('Commit or stash your changes first — the release is built from the current commit.')
}

run('pnpm', ['run', 'dist'])

const sha = (file) =>
  new Promise((resolve, reject) => {
    const h = createHash('sha256')
    createReadStream(file).on('data', (d) => h.update(d)).on('end', () => resolve(h.digest('hex'))).on('error', reject)
  })
const assets = []
for (const arch of ['arm64', 'x64']) {
  const dmg = join(root, 'dist', `kabanos-mac-${arch}.dmg`)
  if (!existsSync(dmg)) throw new Error(`Missing ${dmg}`)
  const sum = await sha(dmg)
  writeFileSync(`${dmg}.sha256`, `${sum}  kabanos-mac-${arch}.dmg\n`)
  assets.push(dmg, `${dmg}.sha256`)
  console.log(`${arch}: ${sum}`)
}

if (dry) {
  console.log(`Dry run: ${assets.length} files ready in dist/ — nothing published.`)
} else {
  run('gh', ['release', 'create', tag, ...assets, '--title', `kabanos ${version}`, '--notes-file', notes, '--target', execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim()])
  console.log(`Published ${tag}. The website picks it up within 15 minutes (or use “Refresh from GitHub” in /admin).`)
}
