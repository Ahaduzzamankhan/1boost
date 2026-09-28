// @ts-check
import { execSync } from 'node:child_process'
import { copyFileSync, mkdirSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const profile = process.argv.includes('--dev') ? 'debug' : 'release'
const src = join(root, 'electron', 'native', 'target', profile, 'oneboost_native.dll')
const destDir = join(root, 'resources', 'native')
const dest = join(destDir, 'oneboost_native.dll')

if (!existsSync(src)) {
  console.error(`[copy-native] built DLL not found at ${src}`)
  process.exit(1)
}
mkdirSync(destDir, { recursive: true })
try {
  copyFileSync(src, dest)
} catch (e) {
  if (e.code === 'EBUSY' || e.code === 'EPERM') {
    // Destination locked by a running app: copy via a temp file + rename retry.
    const tmp = dest + '.new'
    copyFileSync(src, tmp)
    try {
      const { renameSync, unlinkSync } = await import('node:fs')
      try {
        unlinkSync(dest)
      } catch {
        /* ignore */
      }
      renameSync(tmp, dest)
    } catch {
      console.warn(`[copy-native] destination locked; keeping existing DLL (${e.code})`)
      try {
        const { unlinkSync } = await import('node:fs')
        unlinkSync(tmp)
      } catch {
        /* ignore */
      }
    }
  } else {
    throw e
  }
}
console.log(`[copy-native] copied ${profile} DLL -> ${dest}`)
