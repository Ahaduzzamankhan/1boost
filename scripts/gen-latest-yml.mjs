// Generates an electron-updater `latest.yml` shim for a release.
//
// 1Boost v1.1.x installs run Electron and update through electron-updater,
// which reads `latest.yml` from the newest published GitHub release. This
// repo's app is now Tauri, so CI ships a minimal latest.yml beside
// latest.json that points electron-updater at the NSIS installer. Once the
// user is on 1.2.x they are served by the Tauri updater (latest.json).
//
// Usage: node scripts/gen-latest-yml.mjs <version> <installer-file> <outfile>
import { createHash } from 'node:crypto'
import { readFileSync, statSync, writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const [version, installerFile, outfile] = process.argv.slice(2)

if (!version || !installerFile || !outfile) {
  console.error('usage: node scripts/gen-latest-yml.mjs <version> <installer-file> <outfile>')
  process.exit(2)
}

const file = readFileSync(installerFile)
const sha512 = createHash('sha512').update(file).digest('base64')
const size = statSync(installerFile).size
const name = installerFile.split(/[\\/]/).pop()

// electron-updater (GitHub provider) resolves the download URL from the
// release itself; `path` is just the asset file name. Ship both the legacy
// flat fields and the `files` array for compatibility across updater
// versions.
const yml = [
  `version: ${version}`,
  `path: ${name}`,
  `sha512: ${sha512}`,
  `releaseDate: '${new Date().toISOString()}'`,
  'files:',
  `  - url: ${name}`,
  `    sha512: ${sha512}`,
  `size: ${size}`,
  '',
].join('\n')

writeFileSync(join(root, outfile), yml, 'utf8')
console.log(`[latest-yml] wrote ${outfile} for ${version} (sha512 of ${size} bytes)`)
