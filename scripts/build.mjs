// @ts-check
// Unified esbuild script for main / preload / renderer builds (ESM CLI API).
// Usage: node scripts/build.mjs <main|preload|renderer|all> [--watch] [--dev]
import { execSync } from 'node:child_process'
import { existsSync, copyFileSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import * as esbuild from 'esbuild'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const watch = process.argv.includes('--watch')
const dev = process.argv.includes('--dev')

const define = {
  'process.env.NODE_ENV': dev ? '"development"' : '"production"',
  'process.platform': '"win32"',
}

/** @type {import('esbuild').BuildOptions} */
const common = {
  bundle: true,
  sourcemap: dev ? 'inline' : false,
  minify: !dev,
  logLevel: 'info',
  legalComments: 'none',
  target: ['es2022'],
}

const mainEntry = join(root, 'electron', 'main', 'index.ts')
const preloadEntry = join(root, 'electron', 'preload', 'index.ts')
const rendererEntry = join(root, 'src', 'main.tsx')
const rendererHtml = join(root, 'src', 'index.html')

/** @type {import('esbuild').BuildOptions} */
const mainOpts = {
  ...common,
  entryPoints: [mainEntry],
  outfile: join(root, 'dist-electron', 'main', 'index.cjs'),
  platform: 'node',
  format: 'cjs',
  // koffi ships native binaries + its own loader; keep it external.
  external: ['electron', 'koffi'],
  define,
}

/** @type {import('esbuild').BuildOptions} */
const preloadOpts = {
  ...common,
  entryPoints: [preloadEntry],
  outfile: join(root, 'dist-electron', 'preload', 'index.cjs'),
  platform: 'node',
  format: 'cjs',
  external: ['electron'],
  define,
}

/** @type {import('esbuild').BuildOptions} */
const rendererOpts = {
  ...common,
  entryPoints: [rendererEntry],
  // ESM + splitting so React.lazy modules load on demand: opening 1Boost
  // only pays for the shell, not for every tool in the app.
  outdir: join(root, 'dist'),
  platform: 'browser',
  format: 'esm',
  splitting: true,
  chunkNames: 'chunks/[name]-[hash]',
  // index.html loads ./index.js regardless of the entry file name.
  entryNames: 'index',
  jsx: 'automatic',
  define,
  loader: { '.svg': 'dataurl' },
}

async function buildOne(name) {
  const t0 = Date.now()
  if (name === 'main') await esbuild.build(mainOpts)
  else if (name === 'preload') await esbuild.build(preloadOpts)
  else if (name === 'renderer') {
    await esbuild.build(rendererOpts)
    if (!existsSync(join(root, 'dist'))) mkdirSync(join(root, 'dist'), { recursive: true })
    copyFileSync(rendererHtml, join(root, 'dist', 'index.html'))
    // Both stylesheets ship side by side; index.html links them in order.
    for (const sheet of ['index.css', 'modules.css']) {
      copyFileSync(join(root, 'src', sheet), join(root, 'dist', sheet))
    }
  }
  console.log(`[build] ${name} done in ${Date.now() - t0}ms`)
}

async function main() {
  const targets = process.argv.filter((a) => !a.startsWith('-')).slice(2)
  const all = targets.length === 0 || targets.includes('all') || targets.every((t) => !['main', 'preload', 'renderer'].includes(t))
  const list = all ? ['main', 'preload', 'renderer'] : targets.filter((t) => ['main', 'preload', 'renderer'].includes(t))
  if (list.length === 0) {
    console.error('usage: node scripts/build.mjs <main|preload|renderer|all> [--watch] [--dev]')
    process.exit(1)
  }
  for (const t of list) await buildOne(t)
  if (watch) {
    const contexts = []
    if (list.includes('main')) contexts.push(await esbuild.context(mainOpts))
    if (list.includes('preload')) contexts.push(await esbuild.context(preloadOpts))
    if (list.includes('renderer')) contexts.push(await esbuild.context(rendererOpts))
    for (const ctx of contexts) {
      await ctx.watch()
    }
    console.log('[build] watching for changes…')
    // keep process alive
    setInterval(() => {}, 1 << 30)
  }
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
