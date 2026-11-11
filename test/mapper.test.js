'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')
const { PROFILES } = require('../plugin/profiles')
const {
  createCodec,
  emptyState,
  capabilities,
  applyDps,
  commandToDps,
  decodeFault,
  stateToValues,
  metadata,
  notifications
} = require('../plugin/mapper')
const { MODE, FAN, humidityRatio } = require('../plugin/util')
const { isTransientLanError } = require('../plugin/tuya-lan')
const { D13_DPS } = require('./helpers/fakes')

const d13 = () => createCodec(PROFILES.traditio, {}, 'D13')
const D13_REPORTED = Object.keys(D13_DPS)

test('decodes the live D13 Traditio DPs', () => {
  const state = applyDps(emptyState(), { 1: true, 2: 55, 5: 'Manual', 6: 64, 16: false, 17: '3h', 19: 0 }, d13())
  assert.equal(state.power, true)
  assert.equal(state.targetHumidity, 55)
  assert.equal(state.mode, MODE.AUTO)
  assert.equal(state.humidity, 64)
  assert.equal(state.timerHours, 3)
  assert.equal(state.timerRemainingMin, 180)
})

test('Traditio fault bitmask: 4 = tank full, 8 = defrost', () => {
  const codec = d13()
  assert.deepEqual(decodeFault(4, codec), { faultCode: 4, tankFull: true, defrost: false })
  assert.deepEqual(decodeFault(8, codec), { faultCode: 8, tankFull: false, defrost: true })
})

test('Shinco Home fault bits are the opposite of Traditio', () => {
  const codec = createCodec(PROFILES['shinco-home'])
  assert.equal(decodeFault(8, codec).tankFull, true)
  assert.equal(decodeFault(4, codec).defrost, true)
})

test('target 25 is Continuous (CO) on Traditio', () => {
  const codec = d13()
  const state = applyDps(emptyState(), { 2: 25, 5: 'Manual' }, codec)
  assert.equal(state.mode, MODE.CONTINUOUS)
  assert.equal(state.targetHumidity, 25)
  assert.deepEqual(commandToDps({ mode: 'continuous' }, codec), { 2: 25, 5: 'Manual' })
})

test('a mode-only update keeps Continuous while the target is still 25', () => {
  const codec = d13()
  let state = applyDps(emptyState(), { 2: 25, 5: 'Manual' }, codec)
  state = applyDps(state, { 5: 'Manual' }, codec)
  assert.equal(state.mode, MODE.CONTINUOUS)
})

test('encodes D13 commands to Tuya 3.5 DPs', () => {
  const dps = commandToDps({ power: true, mode: 'auto', targetHumidity: 0.55, timerHours: 3 }, d13())
  assert.deepEqual(dps, { 1: true, 5: 'Manual', 2: 55, 17: '3h' })
})

test('sleep uses the SLeeping enum and learns the spelling the unit reports', () => {
  const codec = d13()
  assert.deepEqual(commandToDps({ mode: 'sleep' }, codec), { 5: 'SLeeping' })
  assert.deepEqual(commandToDps({ sleep: true }, codec), { 5: 'SLeeping' })
  const state = applyDps(emptyState(), { 5: 'Sleeping', 2: 50 }, codec)
  assert.equal(state.mode, MODE.SLEEP)
  assert.equal(state.sleep, true)
  assert.deepEqual(commandToDps({ mode: 'sleep' }, codec), { 5: 'Sleeping' })
})

test('Shinco timer is a plain number and continuous is a mode value', () => {
  const codec = createCodec(PROFILES['shinco-home'])
  assert.deepEqual(commandToDps({ timerHours: 4 }, codec), { 12: '4' })
  assert.deepEqual(commandToDps({ mode: 'continuous' }, codec), { 2: '1' })
  assert.deepEqual(commandToDps({ fan: 'high' }, codec), { 6: '0' })
  const state = applyDps(emptyState(), { 2: '1', 12: '2', 13: 75 }, codec)
  assert.equal(state.mode, MODE.CONTINUOUS)
  assert.equal(state.timerHours, 2)
  assert.equal(state.timerRemainingMin, 75)
})

test('D12 ECO sleep is a separate boolean DP', () => {
  const codec = createCodec(PROFILES['d12-eco'])
  assert.deepEqual(commandToDps({ sleep: true }, codec), { 14: true })
  assert.deepEqual(commandToDps({ mode: 'continuous' }, codec), { 5: 'Continuous' })
  assert.throws(() => commandToDps({ timerHours: 2 }, codec), /Timer is not supported/)
})

test('generic profile refuses every write', () => {
  const codec = createCodec(PROFILES.generic)
  assert.throws(() => commandToDps({ power: true }, codec), /not supported/)
})

test('DP overrides add and remove roles', () => {
  const codec = createCodec(PROFILES.traditio, { fan: null, insideDry: 101 })
  assert.equal(codec.map.fan, undefined)
  assert.equal(codec.map.insideDry, '101')
})

test('rejects empty commands', () => {
  assert.throws(() => commandToDps({ foo: 1 }, d13()), /No recognized fields/)
})

test('D13 capabilities come from the reported DPs: no fan, inside dry or tank volume', () => {
  const caps = capabilities(d13(), D13_REPORTED)
  assert.equal(caps.controls.fan, false)
  assert.equal(caps.controls.insideDry, false)
  assert.equal(caps.controls.mode, true)
  assert.equal(caps.controls.timer, true)
  assert.equal(caps.controls.sleep, true)
  assert.deepEqual(caps.modes.map((m) => m.value), ['auto', 'continuous', 'sleep'])
})

test('a profile DP the device never reported is not a control', () => {
  const caps = capabilities(d13(), ['1', '2', '6'])
  assert.equal(caps.controls.power, true)
  assert.equal(caps.controls.mode, false)
  assert.equal(caps.controls.childLock, false)
  assert.equal(caps.sensors.tankFull, false)
})

test('Signal K values: only paths the D13 has, humidity as a ratio', () => {
  const codec = d13()
  const state = applyDps(emptyState(), D13_DPS, codec)
  const caps = capabilities(codec, D13_REPORTED)
  const values = stateToValues(state, caps, {
    pathPrefix: 'environment.inside.dehumidifier',
    publishCabinHumidity: true,
    cabinHumidityPath: 'environment.inside.humidity',
    electricalPath: 'electrical.loads.alecoairD13.power'
  })
  const byPath = Object.fromEntries(values.map((v) => [v.path, v.value]))
  assert.equal(byPath['environment.inside.dehumidifier.humidity'], humidityRatio(61))
  assert.equal(byPath['environment.inside.humidity'], humidityRatio(61))
  assert.equal(byPath['electrical.loads.alecoairD13.power'], 170)
  assert.equal(byPath['environment.inside.dehumidifier.compressor'], true)
  assert.equal(byPath['environment.inside.dehumidifier.mode'], 'auto')
  for (const absent of ['fanSpeed', 'insideDry', 'tankVolume', 'temperature']) {
    assert.equal(`environment.inside.dehumidifier.${absent}` in byPath, false, absent)
  }
})

test('metadata covers only present paths and gives mode possibleValues', () => {
  const caps = capabilities(d13(), D13_REPORTED)
  const meta = metadata(caps, { pathPrefix: 'environment.inside.dehumidifier', nameplate: PROFILES.traditio.models.D13 })
  const paths = meta.map((m) => m.path)
  assert.equal(paths.includes('environment.inside.dehumidifier.fanSpeed'), false)
  assert.equal(paths.includes('environment.inside.dehumidifier.insideDry'), false)
  const mode = meta.find((m) => m.path === 'environment.inside.dehumidifier.mode')
  assert.equal(mode.value.type, 'multiple')
  assert.deepEqual(mode.value.possibleValues.map((p) => p.value), ['auto', 'continuous', 'sleep'])
  assert.equal(meta.some((m) => m.value.units === 'bool' || m.value.units === 'h'), false)
})

test('tank notification path follows the device prefix', () => {
  const codec = d13()
  const caps = capabilities(codec, D13_REPORTED)
  const state = applyDps(emptyState(), { ...D13_DPS, 19: 4 }, codec)
  const [note] = notifications(state, caps, { pathPrefix: 'environment.inside.dehumidifier.salon', nameplate: codec.nameplate })
  assert.equal(note.path, 'notifications.environment.inside.dehumidifier.salon.tankFull')
  assert.equal(note.value.state, 'alert')
  assert.match(note.value.message, /2\.3 L/)
})

test('no power estimate without a nameplate', () => {
  const codec = createCodec(PROFILES.traditio, {}, 'D25')
  const caps = capabilities(codec, D13_REPORTED)
  assert.equal(caps.sensors.powerWatts, false)
  const state = applyDps(emptyState(), D13_DPS, codec)
  assert.equal(state.powerWatts, null)
})

test('fan decoding per profile', () => {
  const codec = createCodec(PROFILES.traditio)
  const state = applyDps(emptyState(), { 4: 'high' }, codec)
  assert.equal(state.fan, FAN.HIGH)
})

test('status timeouts are transient LAN errors', () => {
  assert.equal(isTransientLanError(new Error('Timeout waiting for status response from device id: x')), true)
  assert.equal(isTransientLanError(new Error('connection timed out')), true)
  assert.equal(isTransientLanError(new Error('bad local key')), false)
})
