'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')
const { MODE, FAN, D13, clampTargetHumidity, humidityRatio, mergeDps, availableControls } = require('../plugin/profile')
const { isTransientLanError } = require('../plugin/tuya-lan')
const {
  applyDps,
  commandToDps,
  applyCommandToState,
  emptyState,
  stateToValues,
  decodeFan,
  encodeFan
} = require('../plugin/mapper')

test('target humidity snaps to 5% between 30 and 80', () => {
  assert.equal(clampTargetHumidity(47), 45)
  assert.equal(clampTargetHumidity(30), 30)
  assert.equal(clampTargetHumidity(12), D13.continuousTarget)
  assert.equal(clampTargetHumidity(90), D13.continuousTarget)
})

test('decodes live D13 Traditio DPS into state', () => {
  const state = applyDps(emptyState(), {
    1: true,
    2: 50,
    5: 'Manual',
    6: 67,
    16: false,
    17: '2h',
    19: 8
  })
  assert.equal(state.power, true)
  assert.equal(state.mode, MODE.AUTO)
  assert.equal(state.humidity, 67)
  assert.equal(state.targetHumidity, 50)
  assert.equal(state.tankFull, true)
  assert.equal(state.defrost, false)
  assert.equal(state.timerHours, 2)
  assert.equal(state.compressor, false)
  assert.equal(state.powerWatts, 2)
})

test('derives compressor and watts from humidity vs target', () => {
  const state = applyDps(emptyState(), { 1: true, 2: 40, 5: 'Manual', 6: 57, 19: 0 })
  assert.equal(state.humidity, 57)
  assert.equal(state.compressor, true)
  assert.equal(state.powerWatts, 170)
})

test('target 25 is Continuous (CO) on this firmware', () => {
  const state = applyDps(emptyState(), { 2: 25, 5: 'Manual' })
  assert.equal(state.mode, MODE.CONTINUOUS)
  assert.equal(state.targetHumidity, D13.continuousTarget)
  assert.deepEqual(commandToDps({ mode: 'continuous' }), { 2: 25, 5: 'Manual' })
})

test('encodes commands to Tuya 3.5 DPS', () => {
  const dps = commandToDps({
    power: true,
    mode: 'auto',
    targetHumidity: 0.55,
    timerHours: 3
  })
  assert.deepEqual(dps, {
    1: true,
    5: 'Manual',
    2: 55,
    17: '3h'
  })
})

test('sleep uses the SLeeping mode enum from the AlecoAir app', () => {
  assert.deepEqual(commandToDps({ mode: 'sleep' }), { 5: 'SLeeping' })
  const state = applyDps(emptyState(), { 5: 'SLeeping', 2: 50 })
  assert.equal(state.mode, MODE.SLEEP)
  assert.equal(state.sleep, true)
})

test('fan-only command is a no-op on firmware without a fan DP', () => {
  assert.deepEqual(commandToDps({ fan: 'high' }), {})
})

test('fan encoding matches AlecoAir 0=high 1=low', () => {
  assert.equal(decodeFan('0'), FAN.HIGH)
  assert.equal(decodeFan('1'), FAN.LOW)
  assert.equal(encodeFan(FAN.HIGH), '0')
})

test('Signal K humidity is published as a ratio', () => {
  const values = stateToValues({
    ...emptyState(),
    connected: true,
    humidity: 64,
    targetHumidity: 50,
    powerWatts: 170
  })
  const humidity = values.find((v) => v.path === 'environment.inside.dehumidifier.humidity')
  const cabin = values.find((v) => v.path === 'environment.inside.humidity')
  const watts = values.find((v) => v.path.endsWith('electricalPower'))
  assert.equal(humidity.value, humidityRatio(64))
  assert.equal(cabin.value, humidityRatio(64))
  assert.equal(watts.value, 170)
})

test('rejects empty commands', () => {
  assert.throws(() => commandToDps({ foo: 1 }), /No recognized fields/)
})

test('D13 firmware hides fan and inside dry', () => {
  const controls = availableControls(mergeDps())
  assert.equal(controls.fan, false)
  assert.equal(controls.insideDry, false)
  assert.equal(controls.mode, true)
  assert.equal(controls.timer, true)
  assert.equal(controls.sleep, true)
})

test('status timeouts are transient LAN errors', () => {
  assert.equal(isTransientLanError(new Error('Timeout waiting for status response from device id: x')), true)
  assert.equal(isTransientLanError(new Error('connection timed out')), true)
  assert.equal(isTransientLanError(new Error('bad local key')), false)
})
