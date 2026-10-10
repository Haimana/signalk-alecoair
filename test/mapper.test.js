'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')
const { MODE, FAN, clampTargetHumidity, humidityRatio } = require('../plugin/profile')
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
  assert.equal(clampTargetHumidity(12), 30)
  assert.equal(clampTargetHumidity(99), 80)
})

test('decodes AlecoAir / Shinco DPS into D13 state', () => {
  const state = applyDps(emptyState(), {
    1: true,
    2: '1',
    3: 67,
    4: 50,
    6: '0',
    7: false,
    11: 8,
    12: '2',
    13: 110
  })
  assert.equal(state.power, true)
  assert.equal(state.mode, MODE.CONTINUOUS)
  assert.equal(state.humidity, 67)
  assert.equal(state.fan, FAN.HIGH)
  assert.equal(state.tankFull, true)
  assert.equal(state.defrost, false)
  assert.equal(state.timerHours, 2)
})

test('encodes commands to Tuya DPS strings', () => {
  const dps = commandToDps({
    power: true,
    mode: 'auto',
    fan: 'low',
    targetHumidity: 0.55,
    timerHours: 3
  })
  assert.deepEqual(dps, {
    1: true,
    2: '0',
    6: '1',
    4: 55,
    12: '3'
  })
})

test('sleep command forces low fan', () => {
  const dps = commandToDps({ mode: 'sleep' })
  assert.equal(dps[6], encodeFan(FAN.LOW))
  const state = applyCommandToState(emptyState(), { mode: 'sleep' })
  assert.equal(state.sleep, true)
  assert.equal(state.fan, FAN.LOW)
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
  assert.throws(() => commandToDps({ foo: 1 }), /Niciun câmp/)
})
