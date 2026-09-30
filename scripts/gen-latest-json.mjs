// Generates the Tauri updater manifest (latest.json) for a release.
//
// Tauri's updater consumes a JSON manifest instead of electron-updater's
// latest.yml. For each release CI attaches:
//   - 1Boost-Setup-<version>-x64-setup.exe        (the NSIS installer)
//   - 1Boost-Setup-<version>-x64-setup.exe.sig    (minisign signature)
// and this script writes latest.json pointing at the asset download URL.
//
// Usage: node scripts/gen-latest-json.mjs <version> <notes-file> <outfile>
//   version like 1.2.0 (no v prefix); notes-file is the rendered changelog.
import { readFileSync, writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const [version, notesFile, outfile] = process.argv.slice(2)

if (!version || !notesFile || !outfile) {
  console.error('usage: node scripts/gen-latest-json.mjs <version> <notes-file> <outfile>')
  process.exit(2)
}

const notes = readFileSync(join(root, notesFile), 'utf8')
const owner = 'Ahaduzzamankhan'
const repo = '1boost'
const asset = `1Boost-Setup-${version}-x64-setup.exe`
const url = `https://github.com/${owner}/${repo}/releases/download/v${version}/${asset}`

const manifest = {
  version,
  notes,
  pub_date: new Date().toISOString(),
  platforms: {
    'windows-x86_64': {
      signature: '', // placeholder; CI replaces with the contents of the .sig file
      url,
    },
  },
}

writeFileSync(join(root, outfile), JSON.stringify(manifest, null, 2) + '\n', 'utf8')
console.log(`[latest-json] wrote ${outfile} for ${version} -> ${url}`)
