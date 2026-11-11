'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')
const { Simulator } = require('../plugin/simulator')
const { DeviceRuntime } = require('../plugin/runtime')
const { PROFILES } = require('../plugin/profiles')
const { createCodec } = require('../plugin/mapper')
const { MODE } = require('../plugin/util')

test('simulator extracts humidity and draws rated power when above target', () => {
  const sim = new Simulator({ humidity: 70, targetHumidity: 50, tankLiters: 0.2 })
  sim.command({ power: true, mode: MODE.AUTO })
  sim.tick(120)
  const state = sim.getState()
  assert.equal(state.compressor, true)
  assert.equal(state.powerWatts, 170)
  assert.ok(state.humidity < 70)
  assert.ok(state.tankLiters > 0.2)
})

test('hygrostat stops compressor at target + 1%', () => {
  const sim = new Simulator({ humidity: 50.4, targetHumidity: 50, tankLiters: 0 })
  sim.command({ power: true, mode: MODE.AUTO })
  sim.tick(2)
  assert.equal(sim.getState().compressor, false)
})

test('continuous mode keeps the compressor on', () => {
  const sim = new Simulator({ humidity: 40, targetHumidity: 60, tankLiters: 0 })
  sim.command({ power: true, mode: MODE.CONTINUOUS })
  sim.tick(5)
  assert.equal(sim.getState().compressor, true)
})

test('full tank trips the 2.3 L alarm and stops extraction', () => {
  const sim = new Simulator({ humidity: 80, targetHumidity: 30, tankLiters: 2.29 })
  sim.command({ power: true, mode: MODE.CONTINUOUS })
  sim.tick(600)
  const state = sim.getState()
  assert.equal(state.tankFull, true)
  assert.equal(state.compressor, false)
  assert.equal(state.faultCode, 4)
})

test('runtime simulator accepts commands and exposes only profile controls', async () => {
  const runtime = new DeviceRuntime({ simulate: true, codec: createCodec(PROFILES.traditio, {}, 'D13') })
  await runtime.start()
  const next = await runtime.command({ power: true, targetHumidity: 45 })
  assert.equal(next.power, true)
  assert.equal(next.targetHumidity, 45)
  assert.equal(next.connected, true)
  assert.equal(next.controls.fan, true) // the Traditio profile maps DP 4; the simulator reports every mapped DP
  assert.equal(next.controls.insideDry, false)
  await runtime.stop()
})
