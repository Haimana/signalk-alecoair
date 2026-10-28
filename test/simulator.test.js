'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')
const { D13Simulator } = require('../plugin/simulator')
const { DeviceRuntime } = require('../plugin/runtime')
const { MODE } = require('../plugin/profile')

test('simulator extracts humidity and draws rated power when above target', () => {
  const sim = new D13Simulator({ humidity: 70, targetHumidity: 50, tankLiters: 0.2 })
  sim.command({ power: true, mode: MODE.AUTO, fan: 'high' })
  sim.tick(120)
  const state = sim.getState()
  assert.equal(state.compressor, true)
  assert.equal(state.powerWatts, 170)
  assert.ok(state.humidity < 70)
  assert.ok(state.tankLiters > 0.2)
})

test('hygrostat stops compressor at target + 1%', () => {
  const sim = new D13Simulator({ humidity: 50.4, targetHumidity: 50, tankLiters: 0 })
  sim.command({ power: true, mode: MODE.AUTO })
  sim.tick(2)
  assert.equal(sim.getState().compressor, false)
})

test('continuous mode keeps the compressor on', () => {
  const sim = new D13Simulator({ humidity: 40, targetHumidity: 60, tankLiters: 0 })
  sim.command({ power: true, mode: MODE.CONTINUOUS })
  sim.tick(5)
  assert.equal(sim.getState().compressor, true)
})

test('full tank trips the 2.3 L alarm and stops extraction', () => {
  const sim = new D13Simulator({ humidity: 80, targetHumidity: 30, tankLiters: 2.29 })
  sim.command({ power: true, mode: MODE.CONTINUOUS, fan: 'high' })
  sim.tick(600)
  const state = sim.getState()
  assert.equal(state.tankFull, true)
  assert.equal(state.compressor, false)
})

test('runtime simulator accepts commands and stays connected', async () => {
  const runtime = new DeviceRuntime({ simulate: true })
  await runtime.start()
  const next = await runtime.command({ power: true, targetHumidity: 45 })
  assert.equal(next.power, true)
  assert.equal(next.targetHumidity, 45)
  assert.equal(next.connected, true)
  assert.equal(next.controls.fan, false)
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
