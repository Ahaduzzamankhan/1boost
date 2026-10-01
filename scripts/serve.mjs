// @ts-check
// Serves the built renderer over http so the UI can be opened in a browser.
//
// The desktop app is Tauri, so this is not part of shipping anything — it is
// the local preview. It serves exactly what `node scripts/build.mjs renderer`
// produced, which is the same bundle Tauri loads from `frontendDist`, so what
// you see here is what the app renders. The browser falls back to the
// in-memory harness bridge (see src/bridge.ts) because there is no Tauri IPC.
//
// Usage: node scripts/serve.mjs [port]
import { createServer } from 'node:http'
import { createReadStream, existsSync, statSync } from 'node:fs'
import { join, extname, normalize, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const dist = join(root, 'dist')
const port = Number(process.argv[2] ?? process.env.PORT ?? 5173)

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
}

const server = createServer((req, res) => {
  // Strip the query/hash and refuse anything that climbs out of dist/.
  const requested = decodeURIComponent((req.url ?? '/').split('?')[0].split('#')[0])
  const relative = normalize(requested).replace(/^(\.\.[/\\])+/, '').replace(/^[/\\]+/, '')
  let file = join(dist, relative || 'index.html')
  if (!file.startsWith(dist)) {
    res.writeHead(403).end('Forbidden')
    return
  }
  if (existsSync(file) && statSync(file).isDirectory()) file = join(file, 'index.html')
  if (!existsSync(file)) file = join(dist, 'index.html')

  res.writeHead(200, {
    'content-type': TYPES[extname(file)] ?? 'application/octet-stream',
    'cache-control': 'no-store',
  })
  createReadStream(file).pipe(res)
})

if (!existsSync(join(dist, 'index.html'))) {
  console.error('[serve] dist/index.html is missing — run: node scripts/build.mjs renderer')
  process.exit(1)
}

server.listen(port, '0.0.0.0', () => {
  console.log(`[serve] 1Boost renderer on http://0.0.0.0:${port}`)
})
