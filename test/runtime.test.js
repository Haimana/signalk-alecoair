'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')
const { DeviceRuntime } = require('../plugin/runtime')
const { PROFILES } = require('../plugin/profiles')
const { createCodec } = require('../plugin/mapper')
const { makeFakeLan, D13_DPS } = require('./helpers/fakes')

function d13Runtime(FakeLan, extra = {}, deps = {}) {
  return new DeviceRuntime({
    key: 'd13',
    tuyaId: 'bfTEST',
    localKey: 'fake-key',
    ip: '172.22.22.224',
    protocol: 'auto',
    codec: createCodec(PROFILES.traditio, {}, 'D13'),
    ...extra
  }, { TuyaLanDevice: FakeLan, ...deps })
}

test('connects, learns the reported DPs and exposes only those controls', async () => {
  const FakeLan = makeFakeLan()
  const runtime = d13Runtime(FakeLan)
  let learned = null
  runtime.on('capabilities', (c) => { learned = c.reportedDps })
  await runtime.start()
  const state = runtime.getPublicState()
  assert.equal(state.connected, true)
  assert.deepEqual(learned.sort(), Object.keys(D13_DPS).sort())
  assert.equal(state.controls.fan, false)
  assert.equal(state.controls.timer, true)
  await runtime.stop()
})

test('never writes a DP the device has not reported', async () => {
  const FakeLan = makeFakeLan()
  const runtime = d13Runtime(FakeLan)
  await runtime.start()
  // Traditio maps fan to DP 4, but the D13 never reports DP 4.
  await assert.rejects(() => runtime.command({ fan: 'high' }), /Refusing to write DP 4/)
  assert.deepEqual(FakeLan.writes, [])
  await runtime.command({ power: false })
  assert.deepEqual(FakeLan.writes, [{ 1: false }])
  await runtime.stop()
})

test('generic profile never writes anything', async () => {
  const FakeLan = makeFakeLan()
  const runtime = d13Runtime(FakeLan, { codec: createCodec(PROFILES.generic) })
  await runtime.start()
  await assert.rejects(() => runtime.command({ power: true }), /not supported/)
  assert.equal(runtime.getPublicState().controls.power, false)
  assert.deepEqual(FakeLan.writes, [])
  await runtime.stop()
})

test('leaving Continuous restores the last hygrostat target', async () => {
  const FakeLan = makeFakeLan({ ...D13_DPS, 2: 45 })
  const runtime = d13Runtime(FakeLan)
  await runtime.start()
  await runtime.command({ mode: 'continuous' })
  assert.deepEqual(FakeLan.writes[0], { 2: 25, 5: 'Manual' })
  await runtime.command({ mode: 'auto' })
  assert.deepEqual(FakeLan.writes[1], { 5: 'Manual', 2: 45 })
  await runtime.stop()
})

test('uses the shared resolver only when no IP is configured', async () => {
  const FakeLan = makeFakeLan()
  let calls = 0
  const resolveIp = async () => { calls += 1; return { ip: '172.22.22.99' } }
  const fixed = d13Runtime(FakeLan, {}, { resolveIp })
  await fixed.start()
  assert.equal(calls, 0)
  assert.equal(FakeLan.instances[0].options.ip, '172.22.22.224')
  await fixed.stop()

  const auto = d13Runtime(FakeLan, { ip: '' }, { resolveIp })
  await auto.start()
  assert.equal(calls, 1)
  assert.equal(FakeLan.instances.at(-1).options.ip, '172.22.22.99')
  await auto.stop()
})

test('an explicit protocol is tried first; auto uses the learned hint', async () => {
  const FakeLan = makeFakeLan()
  FakeLan.failVersions = ['3.5']
  const runtime = d13Runtime(FakeLan, { protocol: 'auto', protocolHint: '3.4' })
  await runtime.start()
  assert.equal(FakeLan.instances[0].options.version, '3.4')
  await runtime.stop()

  const explicit = d13Runtime(FakeLan, { protocol: '3.3' })
  await explicit.start()
  assert.equal(FakeLan.instances.at(-1).options.version, '3.3')
  await explicit.stop()
})

test('without a local key the runtime reports where to set it up', async () => {
  const runtime = d13Runtime(makeFakeLan(), { localKey: '' })
  await runtime.start()
  const state = runtime.getPublicState()
  assert.equal(state.connected, false)
  assert.match(state.lastError, /Plugin Config/)
  await runtime.stop()
})

test('a unit the shared scan cannot find is not probed with a per-device UDP find', async () => {
  const FakeLan = makeFakeLan()
  const runtime = d13Runtime(FakeLan, { ip: '' }, { resolveIp: async () => null })
  await runtime.start()
  assert.equal(FakeLan.instances.length, 0)
  assert.match(runtime.getPublicState().lastError, /Not found on the LAN/)
  await runtime.stop()
})
