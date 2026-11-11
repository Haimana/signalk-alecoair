'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const path = require('path')
const {
  isLegacyOptions,
  migrateLegacyOptions,
  normalizeOptions,
  newDevice,
  readLegacyPluginConfig,
  serializeOptions
} = require('../plugin/config')
const { tmpDir } = require('./helpers/fakes')

const LEGACY_OPTIONS = {
  deviceName: 'Dezumidificator',
  deviceId: 'bfTESTDEVICE0001',
  ip: '172.22.22.200',
  version: '3.5',
  pathPrefix: 'environment.inside.dehumidifier',
  publishCabinHumidity: true,
  cabinHumidityPath: 'environment.inside.humidity',
  electricalPath: 'electrical.loads.alecoairD13.power',
  pollSeconds: 8
}

const LEGACY_STORE = {
  deviceId: 'bfTESTDEVICE0001',
  localKey: 'not-a-real-key',
  ip: '172.22.22.224',
  version: '3.5',
  deviceName: 'Dezumidificator',
  smartlifeSession: { source: 'alecoair', token_info: { access_token: 'oem' } },
  smartlifeDevices: [{ id: 'bfTESTDEVICE0001', name: 'Dezumidificator', localKey: 'not-a-real-key', productId: 'testproduct00001' }]
}

test('detects the flat single-device options', () => {
  assert.equal(isLegacyOptions(LEGACY_OPTIONS), true)
  assert.equal(isLegacyOptions({ devices: [] }), false)
  assert.equal(isLegacyOptions({}), false)
})

test('migrates the D13 into devices[0] with key d13 and the original paths', () => {
  const v2 = migrateLegacyOptions(LEGACY_OPTIONS, LEGACY_STORE)
  assert.equal(v2.configVersion, 2)
  assert.equal(v2.devices.length, 1)
  const d = v2.devices[0]
  assert.equal(d.key, 'd13')
  assert.equal(d.tuyaId, 'bfTESTDEVICE0001')
  assert.equal(d.profile, 'traditio')
  assert.equal(d.model, 'D13')
  assert.equal(d.productId, 'testproduct00001')
  assert.equal(d.protocol, '3.5')
  assert.equal(d.paths.prefix, 'environment.inside.dehumidifier')
  assert.equal(d.paths.electrical, 'electrical.loads.alecoairD13.power')
  assert.equal(d.paths.publishCabinHumidity, true)
  assert.equal(d.paths.cabinHumidity, 'environment.inside.humidity')
  assert.equal(JSON.stringify(v2).includes('not-a-real-key'), false, 'no local key in Admin options')
})

test('migration carries over the IP that was actually in use (the old store won)', () => {
  assert.equal(migrateLegacyOptions(LEGACY_OPTIONS, LEGACY_STORE).devices[0].ip, '172.22.22.224')
  assert.equal(migrateLegacyOptions(LEGACY_OPTIONS, {}).devices[0].ip, '172.22.22.200')
})

test('migration from the store alone (empty options) still adopts the device', () => {
  const v2 = migrateLegacyOptions({}, LEGACY_STORE)
  assert.equal(v2.devices[0].tuyaId, 'bfTESTDEVICE0001')
  assert.equal(v2.devices[0].paths.prefix, 'environment.inside.dehumidifier')
})

test('migration without an adopted device yields an empty device list', () => {
  assert.deepEqual(migrateLegacyOptions({ pathPrefix: 'x' }, {}).devices, [])
})

test('reads the old plugin config file', () => {
  const dir = tmpDir()
  fs.writeFileSync(path.join(dir, 'signalk-alecoair-d13.json'), JSON.stringify({ enabled: true, configuration: LEGACY_OPTIONS }))
  assert.equal(readLegacyPluginConfig(dir).deviceId, 'bfTESTDEVICE0001')
  assert.equal(readLegacyPluginConfig(tmpDir()), null)
})

test('new devices get their own prefix and no cabin humidity by default', () => {
  const d = newDevice({ name: 'Salon Aleco', tuyaId: 'bf2' })
  assert.equal(d.key, 'salon_aleco')
  assert.equal(d.paths.prefix, 'environment.inside.dehumidifier.salon_aleco')
  assert.equal(d.paths.electrical, 'electrical.loads.dehumidifierSalonAleco.power')
  assert.equal(d.paths.publishCabinHumidity, false)
  assert.equal(d.profile, 'auto')
})

test('flags duplicate keys, Tuya ids and prefixes', () => {
  const opts = normalizeOptions({
    devices: [
      { key: 'a', tuyaId: 'x', paths: { prefix: 'p.a' } },
      { key: 'a', tuyaId: 'y', paths: { prefix: 'p.b' } },
      { key: 'c', tuyaId: 'x', paths: { prefix: 'p.c' } },
      { key: 'd', tuyaId: 'z', paths: { prefix: 'p.a' } }
    ]
  })
  assert.deepEqual(opts.devices.map((d) => d.problems.length > 0), [false, true, true, true])
  assert.equal('problems' in serializeOptions(opts).devices[0], false)
})

test('normalizes protocol, profile and overrides', () => {
  const [d] = normalizeOptions({ devices: [{ key: 'Bad Key!', tuyaId: 'x', protocol: '9', profile: 'nope', ip: '8.8.8.8', dpOverrides: { fan: null, power: '1', bogus: 3 } }] }).devices
  assert.equal(d.key, 'bad_key')
  assert.equal(d.protocol, 'auto')
  assert.equal(d.profile, 'auto')
  assert.equal(d.ip, '')
  assert.deepEqual(d.dpOverrides, { power: 1, fan: null })
})
