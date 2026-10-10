'use strict'

const http = require('http')
const fs = require('fs')
const path = require('path')
const { DeviceRuntime } = require('../plugin/runtime')
const { D13 } = require('../plugin/profile')

const PORT = Number(process.env.PORT) || 43147
const HOST = process.env.HOST || '0.0.0.0'
const PUBLIC = path.join(__dirname, '..', 'public')

const runtime = new DeviceRuntime({
  simulate: process.env.SIMULATE !== '0',
  deviceId: process.env.TUYA_DEVICE_ID,
  localKey: process.env.TUYA_LOCAL_KEY,
  ip: process.env.TUYA_IP,
  version: process.env.TUYA_VERSION || D13.protocolDefault
})

const clients = new Set()

runtime.on('state', (state) => {
  const payload = `data: ${JSON.stringify(state)}\n\n`
  for (const res of clients) res.write(payload)
})

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.woff2': 'font/woff2'
}

function sendJson(res, code, body) {
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store'
  })
  res.end(JSON.stringify(body))
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    req.on('data', (c) => chunks.push(c))
    req.on('end', () => {
      if (!chunks.length) return resolve({})
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')))
      } catch (err) {
        reject(err)
      }
    })
    req.on('error', reject)
  })
}

function serveStatic(req, res) {
  let urlPath = decodeURIComponent((req.url || '/').split('?')[0])
  if (urlPath === '/' || urlPath === '/signalk-alecoair-d13' || urlPath === '/signalk-alecoair-d13/') {
    urlPath = '/index.html'
  }
  urlPath = urlPath.replace(/^\/signalk-alecoair-d13/, '')
  const file = path.normalize(path.join(PUBLIC, urlPath))
  if (!file.startsWith(PUBLIC)) {
    res.writeHead(403)
    return res.end()
  }
  fs.readFile(file, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' })
      return res.end('Not found')
    }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' })
    res.end(data)
  })
}

const server = http.createServer(async (req, res) => {
  const url = (req.url || '/').split('?')[0]
  const api = url.replace(/^\/signalk-alecoair-d13/, '').replace(/^\/plugins\/signalk-alecoair-d13/, '')

  if (req.method === 'GET' && (api === '/api/state' || api === '/state')) {
    return sendJson(res, 200, runtime.getPublicState())
  }
  if (req.method === 'GET' && (api === '/api/health' || api === '/health')) {
    const state = runtime.getPublicState()
    return sendJson(res, 200, {
      ok: true,
      simulate: runtime.simulate,
      model: D13.model,
      connected: state.connected,
      lastError: state.lastError
    })
  }
  if (req.method === 'GET' && api === '/api/stream') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive'
    })
    res.write(`data: ${JSON.stringify(runtime.getPublicState())}\n\n`)
    clients.add(res)
    req.on('close', () => clients.delete(res))
    return
  }
  if (req.method === 'POST' && (api === '/api/command' || api === '/command')) {
    try {
      const body = await readBody(req)
      const next = await runtime.command(body)
      return sendJson(res, 200, next)
    } catch (err) {
      return sendJson(res, 400, { error: err.message || String(err) })
    }
  }
  if (req.method === 'POST' && (api === '/api/empty-tank' || api === '/empty-tank')) {
    return sendJson(res, 200, runtime.emptyTank())
  }

  return serveStatic(req, res)
})

async function main() {
  await runtime.start()
  server.listen(PORT, HOST, () => {
    // eslint-disable-next-line no-console
    console.log(`ALECOAIR D13 WebApp: http://127.0.0.1:${PORT}`)
  })
}

function shutdown() {
  runtime.stop().finally(() => {
    server.close(() => process.exit(0))
  })
}

process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err)
  process.exit(1)
})
