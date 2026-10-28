'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')
const crypto = require('crypto')
const {
  UDP_KEY,
  parseDiscoveryPacket,
  pickDevice,
  mergeScanResults,
  missingKeyMessage,
  isLanIp
} = require('../plugin/scan')
const { DeviceRuntime } = require('../plugin/runtime')

test('parses plaintext Tuya UDP JSON', () => {
  const buf = Buffer.from(JSON.stringify({
    ip: '172.22.22.50',
    gwId: 'bfabc123',
    version: '3.3',
    productKey: 'hp1sjssyokokbrsg'
  }))
  const device = parseDiscoveryPacket(buf)
  assert.equal(device.ip, '172.22.22.50')
  assert.equal(device.id, 'bfabc123')
  assert.equal(device.version, '3.3')
})

test('parses AES-ECB discovery payload', () => {
  const plain = Buffer.from(JSON.stringify({
    ip: '172.22.22.77',
    gwId: 'bfdeadbeef',
    version: '3.4'
  }))
  const cipher = crypto.createCipheriv('aes-128-ecb', UDP_KEY, null)
  const enc = Buffer.concat([cipher.update(plain), cipher.final()])
  const device = parseDiscoveryPacket(enc)
  assert.equal(device.ip, '172.22.22.77')
  assert.equal(device.id, 'bfdeadbeef')
})

test('picks configured id, otherwise the only device', () => {
  const devices = [
    { id: 'aaa', ip: '172.22.22.1', version: '3.3' },
    { id: 'bbb', ip: '172.22.22.2', version: '3.3' }
  ]
  assert.equal(pickDevice(devices, { deviceId: 'bbb' }).ip, '172.22.22.2')
  assert.equal(pickDevice(devices, {}), null)
  assert.equal(pickDevice(devices.slice(0, 1), {}).id, 'aaa')
})

test('runtime scan fills id and ip before asking for localKey', async () => {
  const runtime = new DeviceRuntime({
    simulate: false,
    autoScan: true,
    localKey: ''
  }, {
    discover: async () => [{ id: 'bf12', ip: '172.22.22.50', version: '3.3' }]
  })
  await runtime.start()
  const state = runtime.getPublicState()
  assert.equal(state.connected, false)
  assert.equal(state.adopted.deviceId, 'bf12')
  assert.equal(state.adopted.ip, '172.22.22.50')
  assert.equal(state.discovery.devices.length, 1)
  assert.match(state.lastError, /Smart Life|WebApp/)
  await runtime.stop()
})

test('LAN runtime without credentials reports a clear error', async () => {
  const runtime = new DeviceRuntime({
    simulate: false,
    deviceId: '',
    localKey: '',
    autoScan: true
  }, { discover: async () => [] })
  await runtime.start()
  assert.equal(runtime.getPublicState().connected, false)
  assert.match(runtime.getPublicState().lastError || '', /Smart Life|Tuya|WebApp/)
  await runtime.stop()
})

test('accepts discovery JSON without ip (filled later from UDP source)', () => {
  const device = parseDiscoveryPacket(Buffer.from(JSON.stringify({
    gwId: 'bfnoip',
    version: '3.3'
  })))
  assert.equal(device.id, 'bfnoip')
  assert.equal(device.ip, '')
})

test('merges TCP 6668 hosts that never broadcast UDP', () => {
  const merged = mergeScanResults([], [{ ip: '172.22.22.224', port: 6668 }])
  assert.equal(merged.length, 1)
  assert.equal(merged[0].ip, '172.22.22.224')
  assert.equal(merged[0].tcp, true)
})

test('rejects public WAN addresses as LAN IPs', () => {
  assert.equal(isLanIp('172.22.22.224'), true)
  assert.equal(isLanIp('86.124.189.23'), false)
  assert.equal(isLanIp(''), false)
})

test('missing key message lists found devices', () => {
  const msg = missingKeyMessage([{ id: 'bf1234567890', ip: '172.22.22.9', version: '3.3' }])
  assert.match(msg, /172\.22\.22\.9/)
  assert.match(msg, /Smart Life|WebApp/)
})
