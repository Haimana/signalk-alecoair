'use strict'

/**
 * 0.0.6: one server log line when a unit's LAN connection is lost (first
 * failure only, with the error) and one when it is back (with how long it
 * was away). Never one per retry, never the device id or the local key.
 */

const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const path = require('path')
const factory = require('../plugin')
const { formatDuration } = require('../plugin')
const { DeviceRuntime } = require('../plugin/runtime')
const { DiscoveryService } = require('../plugin/discovery')
const { PROFILES } = require('../plugin/profiles')
const { createCodec } = require('../plugin/mapper')
const { D13_DPS, tmpDir, fakeApp, fakeRouter, wait } = require('./helpers/fakes')

const TUYA_ID = 'bfTESTDEVICE0001'
const LOCAL_KEY = 'fake-local-key-123'

/** A LAN fake whose connect fails while `Lan.fail` is set, and that can drop. */
function controllableLan() {
  class Lan {
    constructor(options) {
      this.options = options
      this.disconnectHandler = null
      Lan.instances.push(this)
    }

    async connect() { if (Lan.fail) throw new Error(Lan.fail) }
    async get() {
      if (Lan.getFail) throw new Error(Lan.getFail)
      return { ...D13_DPS }
    }

    async setDps() {}
    onData() {}
    onError() {}
    onDisconnect(fn) { this.disconnectHandler = fn }
    disconnect() {}
  }
  Lan.instances = []
  Lan.fail = null
  Lan.getFail = null
  return Lan
}

function runtimeWith(Lan) {
  const runtime = new DeviceRuntime({
    key: 'd13',
    tuyaId: TUYA_ID,
    localKey: LOCAL_KEY,
    ip: '172.22.22.224',
    protocol: '3.5',
    codec: createCodec(PROFILES.traditio, {}, 'D13')
  }, { TuyaLanDevice: Lan })
  const events = []
  runtime.on('lan-lost', (e) => events.push(['lost', e]))
  runtime.on('lan-back', (e) => events.push(['back', e]))
  return { runtime, events }
}

test('formatDuration', () => {
  assert.equal(formatDuration(0), '0 s')
  assert.equal(formatDuration(4000), '4 s')
  assert.equal(formatDuration(75000), '1 min 15 s')
  assert.equal(formatDuration(3720000), '1 h 2 min')
})

test('a unit away at start: one lost event however many retries, one back event when it answers', async () => {
  const Lan = controllableLan()
  const { runtime, events } = runtimeWith(Lan)
  Lan.fail = 'connect EHOSTUNREACH 172.22.22.224:6668'
  await runtime.start()
  await runtime.reconnect()
  await runtime.reconnect()
  assert.equal(events.length, 1)
  assert.equal(events[0][0], 'lost')
  assert.equal(events[0][1].atStart, true)
  assert.match(events[0][1].error, /EHOSTUNREACH/)
  Lan.fail = null
  await runtime.reconnect()
  assert.equal(runtime.state.connected, true)
  assert.equal(events.length, 2)
  assert.equal(events[1][0], 'back')
  assert.equal(events[1][1].lostLogged, true)
  assert.equal(events[1][1].atStart, true)
  assert.ok(events[1][1].offlineMs >= 0)
  await runtime.reconnect()
  assert.equal(events.length, 2, 'no line for a reconnect while it was up')
  await runtime.stop()
})

test('a unit that drops after being connected: lost with the reconnect error, then back with the time away', async () => {
  const Lan = controllableLan()
  const { runtime, events } = runtimeWith(Lan)
  await runtime.start()
  assert.equal(events.length, 0, 'nothing logged for a normal start')
  const first = Lan.instances.at(-1)
  Lan.fail = 'connection timed out'
  first.disconnectHandler()
  if (runtime.reconnectTimer) { clearTimeout(runtime.reconnectTimer); runtime.reconnectTimer = null }
  await wait(30)
  await runtime.reconnect()
  if (runtime.reconnectTimer) { clearTimeout(runtime.reconnectTimer); runtime.reconnectTimer = null }
  await runtime.reconnect()
  assert.deepEqual(events.map((e) => e[0]), ['lost'])
  assert.equal(events[0][1].atStart, false)
  assert.equal(events[0][1].error, 'connection timed out')
  Lan.fail = null
  await runtime.reconnect()
  assert.deepEqual(events.map((e) => e[0]), ['lost', 'back'])
  assert.equal(events[1][1].lostLogged, true)
  assert.equal(events[1][1].atStart, false)
  assert.ok(events[1][1].offlineMs >= 25, `offline ${events[1][1].offlineMs} ms`)
  await runtime.stop()
})

test('a short drop that is back on the first reconnect gives a single line', async () => {
  const Lan = controllableLan()
  const { runtime, events } = runtimeWith(Lan)
  await runtime.start()
  Lan.instances.at(-1).disconnectHandler()
  if (runtime.reconnectTimer) { clearTimeout(runtime.reconnectTimer); runtime.reconnectTimer = null }
  await runtime.reconnect()
  assert.deepEqual(events.map((e) => e[0]), ['back'])
  assert.equal(events[0][1].lostLogged, false)
  assert.equal(events[0][1].error, 'connection closed')
  await runtime.stop()
})

test('failed reads count from the first one; the reconnect error is the one logged', async () => {
  const Lan = controllableLan()
  const { runtime, events } = runtimeWith(Lan)
  await runtime.start()
  Lan.getFail = 'timeout'
  for (let i = 0; i < 5; i++) await runtime.poll()
  if (runtime.reconnectTimer) { clearTimeout(runtime.reconnectTimer); runtime.reconnectTimer = null }
  Lan.fail = 'connect EHOSTUNREACH 172.22.22.224:6668'
  await runtime.reconnect()
  assert.deepEqual(events.map((e) => e[0]), ['lost'])
  assert.match(events[0][1].error, /EHOSTUNREACH/)
  Lan.fail = null
  Lan.getFail = null
  if (runtime.reconnectTimer) { clearTimeout(runtime.reconnectTimer); runtime.reconnectTimer = null }
  await runtime.reconnect()
  assert.deepEqual(events.map((e) => e[0]), ['lost', 'back'])
  await runtime.stop()
})

test('a stop is not an outage', async () => {
  const Lan = controllableLan()
  const { runtime, events } = runtimeWith(Lan)
  await runtime.start()
  await runtime.stop()
  Lan.fail = 'connection refused'
  await runtime.reconnect()
  assert.equal(events.length, 0)
})

test('the logged error never holds the device id or the local key', async () => {
  const Lan = controllableLan()
  const { runtime, events } = runtimeWith(Lan)
  Lan.fail = `device ${TUYA_ID} with key ${LOCAL_KEY} did not answer`
  await runtime.start()
  if (runtime.reconnectTimer) { clearTimeout(runtime.reconnectTimer); runtime.reconnectTimer = null }
  const text = events[0][1].error
  assert.ok(!text.includes(TUYA_ID))
  assert.ok(!text.includes(LOCAL_KEY))
  assert.match(text, /did not answer/)
  await runtime.stop()
})

test('plugin: the lost line goes to the server log without debug, with the error and no device id', async () => {
  const root = tmpDir('alecoair-lanlog-')
  const dataRoot = path.join(root, 'plugin-config-data')
  fs.mkdirSync(dataRoot)
  fs.writeFileSync(path.join(dataRoot, 'signalk-alecoair.store.json'), JSON.stringify({
    storeVersion: 2,
    account: { linked: false, devices: [] },
    devices: { [TUYA_ID]: { localKey: LOCAL_KEY, reportedDps: ['1', '2', '5', '6', '16', '17', '19'] } }
  }))
  const app = fakeApp(dataRoot)
  app.logs = []
  const Lan = controllableLan()
  Lan.fail = 'connect ECONNREFUSED 172.22.22.224:6668'
  const plugin = factory(app, { dataRoot, TuyaLanDevice: Lan, discovery: new DiscoveryService({ scan: async () => [] }), log: (m) => app.logs.push(m) })
  plugin.registerWithRouter(fakeRouter())
  plugin.start({
    configVersion: 2,
    devices: [{ key: 'd13', name: 'D13', tuyaId: TUYA_ID, ip: '172.22.22.224', profile: 'traditio', model: 'D13', protocol: '3.5' }]
  })
  await wait(200)
  const lines = app.logs.filter((m) => /LAN connection/.test(m))
  assert.equal(lines.length, 1, JSON.stringify(lines))
  assert.match(lines[0], /^d13: LAN connection failed at start \(connect ECONNREFUSED 172\.22\.22\.224:6668\); retrying every 15 s/)
  assert.ok(!app.logs.join('\n').includes(TUYA_ID))
  assert.ok(!app.logs.join('\n').includes(LOCAL_KEY))
  await plugin.stop()
})
