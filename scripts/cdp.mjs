// CDP probe: evaluates JS in the running Electron page and captures console
// output + exceptions. Usage: node scripts/cdp.mjs '<expression>' [--console]
// Extra commands: --screenshot <file>, --click <selector-text>, --pages
import crypto from 'node:crypto'
import http from 'node:http'
import net from 'node:net'

function getJSON(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      let d = ''
      res.on('data', (c) => (d += c))
      res.on('end', () => resolve(JSON.parse(d)))
    }).on('error', reject)
  })
}

class WS {
  constructor(url) {
    this.url = url
    this.socket = null
    this.onmessage = null
  }

  connect() {
    return new Promise((resolve, reject) => {
      const key = crypto.randomBytes(16).toString('base64')
      const u = new URL(this.url)
      this.socket = net.connect({ host: u.hostname, port: u.port }, () => {
        const headers = [
          'GET ' + u.pathname + ' HTTP/1.1',
          'Host: ' + u.host,
          'Upgrade: websocket',
          'Connection: Upgrade',
          'Sec-WebSocket-Key: ' + key,
          'Sec-WebSocket-Version: 13',
          '',
          '',
        ].join('\r\n')
        this.socket.write(headers)
      })
      let buf = Buffer.alloc(0)
      let upgraded = false
      this.socket.on('data', (d) => {
        buf = Buffer.concat([buf, d])
        if (!upgraded) {
          const idx = buf.indexOf('\r\n\r\n')
          if (idx >= 0) {
            upgraded = true
            buf = buf.slice(idx + 4)
            resolve()
          }
          return
        }
        while (buf.length >= 2) {
          const opcode = buf[0] & 0x0f
          const masked = (buf[1] & 0x80) !== 0
          let len = buf[1] & 0x7f
          let off = 2
          if (len === 126) {
            len = buf.readUInt16BE(2)
            off = 4
          } else if (len === 127) {
            len = Number(buf.readBigUInt64BE(2))
            off = 10
          }
          if (buf.length < off + len + (masked ? 4 : 0)) break
          let payload = buf.slice(off, off + len)
          if (masked) {
            const mask = buf.slice(off, off + 4)
            for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i % 4]
          }
          buf = buf.slice(off + len + (masked ? 4 : 0))
          if (opcode === 1 && this.onmessage) this.onmessage(payload.toString())
          if (opcode === 8) this.socket.end()
        }
      })
      this.socket.on('error', reject)
    })
  }

  send(str) {
    const payload = Buffer.from(str)
    const mask = crypto.randomBytes(4)
    let header
    if (payload.length < 126) {
      header = Buffer.from([0x81, 0x80 | payload.length])
    } else if (payload.length < 65536) {
      header = Buffer.alloc(4)
      header[0] = 0x81
      header[1] = 0x80 | 126
      header.writeUInt16BE(payload.length, 2)
    } else {
      header = Buffer.alloc(10)
      header[0] = 0x81
      header[1] = 0x80 | 127
      header.writeBigUInt64BE(BigInt(payload.length), 2)
    }
    const masked = Buffer.alloc(payload.length)
    for (let i = 0; i < payload.length; i++) masked[i] = payload[i] ^ mask[i % 4]
    this.socket.write(Buffer.concat([header, mask, masked]))
  }
}

const expr = process.argv[2] ?? 'document.title'
const withConsole = process.argv.includes('--console')

const pages = await getJSON('http://127.0.0.1:9222/json')
const page = pages.find((p) => p.type === 'page')
if (!page) {
  console.error('NO PAGE — is the app running with --remote-debugging-port=9222?')
  process.exit(1)
}
const ws = new WS(page.webSocketDebuggerUrl)
await ws.connect()
let id = 0
const pending = new Map()
const consoleLines = []
ws.onmessage = (data) => {
  const msg = JSON.parse(data)
  if (msg.id && pending.has(msg.id)) {
    pending.get(msg.id)(msg)
    pending.delete(msg.id)
  } else if (msg.method === 'Runtime.consoleAPICalled') {
    const line = msg.params.args.map((a) => a.value ?? a.description ?? '').join(' ')
    consoleLines.push(`[${msg.params.type}] ${line}`)
  } else if (msg.method === 'Runtime.exceptionThrown') {
    const d = msg.params.exceptionDetails
    consoleLines.push(`[EXCEPTION] ${d.text} ${d.exception?.description ?? ''}`)
  }
}
function send(method, params = {}) {
  return new Promise((resolve) => {
    const mid = ++id
    pending.set(mid, resolve)
    ws.send(JSON.stringify({ id: mid, method, params }))
  })
}
await send('Runtime.enable')
// Give console events a moment to flush after evaluate.
const res = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true })
if (res.result?.exceptionDetails) {
  console.error('EVAL ERROR:', JSON.stringify(res.result.exceptionDetails, null, 1))
} else {
  console.log(JSON.stringify(res.result?.result?.value, null, 1))
}
await new Promise((r) => setTimeout(r, 400))
if (withConsole) {
  console.log('--- CONSOLE ---')
  for (const l of consoleLines) console.log(l)
}

const shotIdx = process.argv.indexOf('--screenshot')
if (shotIdx > 0) {
  await send('Page.enable')
  const shot = await send('Page.captureScreenshot', { format: 'png' })
  const { writeFileSync } = await import('node:fs')
  writeFileSync(process.argv[shotIdx + 1], Buffer.from(shot.result.data, 'base64'))
  console.log('screenshot saved: ' + process.argv[shotIdx + 1])
}
process.exit(0)
