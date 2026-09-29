// Extracts one version's section from CHANGELOG.md for the GitHub Release
// body. Usage: node scripts/release-notes.mjs <version> [outfile]
//   node scripts/release-notes.mjs 1.1.4 release-notes.md
// Prints the notes to stdout when no outfile is given; exits non-zero when
// the version has no section (CI should fail loudly rather than publish an
// empty changelog).
import { readFileSync, writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const [version, outfile] = process.argv.slice(2)

if (!version) {
  console.error('usage: node scripts/release-notes.mjs <version> [outfile]')
  process.exit(2)
}

const changelog = readFileSync(join(root, 'CHANGELOG.md'), 'utf8')
const lines = changelog.split(/\r?\n/)

// Headings look like "## [1.1.4] - 2026-09-29" (also accept "## 1.1.4").
const start = lines.findIndex((l) => /^##\s+\[?v?\d/.test(l) && l.includes(version))
if (start === -1) {
  console.error(`[release-notes] no CHANGELOG.md section for ${version}`)
  process.exit(1)
}

const rest = lines.slice(start + 1)
const end = rest.findIndex((l) => /^##\s/.test(l))
const body = (end === -1 ? rest : rest.slice(0, end))
  .join('\n')
  .trim()

if (!body) {
  console.error(`[release-notes] CHANGELOG.md section for ${version} is empty`)
  process.exit(1)
}

const notes = `## What's changed in ${version}\n\n${body}\n`
if (outfile) {
  writeFileSync(join(root, outfile), notes, 'utf8')
  console.log(`[release-notes] wrote ${outfile} (${notes.length} chars)`)
} else {
  process.stdout.write(notes)
}
