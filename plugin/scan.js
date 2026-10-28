'use strict'

const dgram = require('dgram')
const crypto = require('crypto')
const net = require('net')
const os = require('os')

/** Well-known Tuya UDP discovery key (not the device localKey). */
const UDP_KEY = Buffer.from('yGAdlopoPVldABfn')
const PORTS = [6666, 6667, 7000]
const HEADER = 0x000055aa
const HEADER_35 = 0x00006699
const TUYA_TCP = 6668

function tryJson(buf) {
  if (!buf || !buf.length) return null
  const text = buf.toString('utf8').replace(/\u0000/g, '')
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start < 0 || end <= start) return null
  try {
    return JSON.parse(text.slice(start, end + 1))
  } catch {
    return null
  }
}

function decryptEcb(buf) {
  if (!buf || buf.length < 16 || buf.length % 16 !== 0) return null
  try {
    const decipher = crypto.createDecipheriv('aes-128-ecb', UDP_KEY, null)
    decipher.setAutoPadding(true)
    return Buffer.concat([decipher.update(buf), decipher.final()])
  } catch {
    return null
  }
}

function framePayload(buf) {
  if (buf.length < 24) return null
  const head = buf.readUInt32BE(0)
  if (head !== HEADER && head !== HEADER_35) return null
  const end = buf.length >= 8 ? buf.length - 8 : buf.length
  if (end <= 16) return null
  return buf.subarray(16, end)
}

function parseDiscoveryPacket(buf) {
  const chunks = [buf]
  const framed = framePayload(buf)
  if (framed) chunks.push(framed)

  for (const chunk of chunks) {
    const plain = tryJson(chunk)
    if (plain) return normalizeDevice(plain)
    const decrypted = decryptEcb(chunk)
    if (decrypted) {
      const json = tryJson(decrypted)
      if (json) return normalizeDevice(json)
    }
  }
  return null
}

function normalizeDevice(json) {
  const id = json.gwId || json.devId || json.id
  if (!id) return null
  return {
    id: String(id),
    ip: json.ip ? String(json.ip) : '',
    version: String(json.version || '3.3'),
    productKey: json.productKey || json.productkey || '',
    name: json.name || json.productKey || 'Tuya'
  }
}

function isLanIp(ip) {
  if (!ip || typeof ip !== 'string') return false
  const parts = ip.split('.').map(Number)
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return false
  if (parts[0] === 10) return true
  if (parts[0] === 192 && parts[1] === 168) return true
  if (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) return true
  return false
}

function pickDevice(devices, options = {}) {
  const list = Array.isArray(devices) ? devices : []
  if (options.deviceId) {
    return list.find((d) => d.id === options.deviceId) || list.find((d) => d.ip === options.ip) || null
  }
  if (options.ip) {
    return list.find((d) => d.ip === options.ip) || null
  }
  if (list.length === 1) return list[0]
  return null
}

function mergeUnique(existing, found) {
  const map = new Map((existing || []).map((d) => [d.id, d]))
  if (found) map.set(found.id, { ...map.get(found.id), ...found })
  return [...map.values()]
}

function scanLan(options = {}) {
  const timeoutMs = Math.max(800, Number(options.timeoutMs) || 5000)
  const discover = options.discover
  if (typeof discover === 'function') {
    return Promise.resolve(discover()).then((list) => list || [])
  }

  return new Promise((resolve) => {
    const found = new Map()
    const sockets = []
    let done = false

    function finish() {
      if (done) return
      done = true
      for (const s of sockets) {
        try { s.close() } catch { /* ignore */ }
      }
      resolve([...found.values()])
    }

    function onMessage(msg, rinfo) {
      const device = parseDiscoveryPacket(msg)
      if (!device) return
      if (!device.ip && rinfo && rinfo.address) device.ip = rinfo.address
      if (!device.ip || !device.id) return
      found.set(device.id, device)
    }

    for (const port of PORTS) {
      const sock = dgram.createSocket({ type: 'udp4', reuseAddr: true })
      sockets.push(sock)
      sock.on('message', onMessage)
      sock.on('error', () => {})
      sock.bind(port, () => {
        try {
          sock.setBroadcast(true)
          sock.send(Buffer.from([0x00]), 6666, '255.255.255.255')
          sock.send(Buffer.from([0x00]), 6667, '255.255.255.255')
        } catch {
          // broadcast may be denied; passive listen still works
        }
      })
    }

    setTimeout(finish, timeoutMs)
  }).then(async (udpDevices) => {
    const tcpHosts = await scanTcp6668({ timeoutMs: 250 })
    return mergeScanResults(udpDevices, tcpHosts)
  })
}

function localPrefixes() {
  const prefixes = new Set()
  for (const addrs of Object.values(os.networkInterfaces())) {
    for (const a of addrs || []) {
      if (a.family !== 'IPv4' && a.family !== 4) continue
      if (a.internal) continue
      const parts = a.address.split('.')
      if (parts[0] === '172' && parts[1] === '17') continue
      prefixes.add(`${parts[0]}.${parts[1]}.${parts[2]}.`)
    }
  }
  const all = [...prefixes]
  const boat = all.filter((p) => p.startsWith('172.22.22.'))
  return boat.length ? boat : all
}

function probePort(ip, port, timeoutMs) {
  return new Promise((resolve) => {
    const sock = net.connect({ host: ip, port, timeout: timeoutMs })
    const done = (ok) => {
      try { sock.destroy() } catch { /* ignore */ }
      resolve(ok)
    }
    sock.once('connect', () => done(true))
    sock.once('timeout', () => done(false))
    sock.once('error', () => done(false))
  })
}

async function scanTcp6668(options = {}) {
  const timeoutMs = Math.max(80, Number(options.timeoutMs) || 250)
  const prefixes = options.prefixes || localPrefixes()
  const ips = []
  for (const prefix of prefixes) {
    for (let i = 1; i < 255; i++) ips.push(`${prefix}${i}`)
  }
  const found = []
  const batch = 64
  for (let i = 0; i < ips.length; i += batch) {
    const slice = ips.slice(i, i + batch)
    const hits = await Promise.all(slice.map(async (ip) => {
      const ok = await probePort(ip, TUYA_TCP, timeoutMs)
      return ok ? ip : null
    }))
    for (const ip of hits) {
      if (ip) found.push({ ip, port: TUYA_TCP })
    }
  }
  return found
}

function mergeScanResults(udpDevices, tcpHosts) {
  const byIp = new Map((udpDevices || []).map((d) => [d.ip, d]))
  for (const host of tcpHosts || []) {
    if (byIp.has(host.ip)) {
      byIp.get(host.ip).tcp = true
      continue
    }
    byIp.set(host.ip, {
      id: '',
      ip: host.ip,
      version: '3.3',
      productKey: '',
      name: 'Tuya (TCP 6668)',
      tcp: true
    })
  }
  return [...byIp.values()]
}

function missingKeyMessage(devices) {
  if (!devices.length) {
    return 'Link Smart Life in the WebApp (Me → scan icon, not +). The plugin stores the device key after that login.'
  }
  const lines = devices.map((d) => {
    const id = d.id ? `${d.id.slice(0, 8)}…` : 'TCP 6668, no ID'
    return `${d.ip} · ${id}`
  })
  return `Found ${devices.length} Tuya host(s) on the LAN. Finish Smart Life setup in the WebApp: ${lines.join('; ')}`
}

module.exports = {
  UDP_KEY,
  parseDiscoveryPacket,
  normalizeDevice,
  isLanIp,
  pickDevice,
  mergeUnique,
  mergeScanResults,
  scanLan,
  scanTcp6668,
  missingKeyMessage
}
