'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const path = require('path')
const store = require('../plugin/store')
const { tmpDir } = require('./helpers/fakes')

const LEGACY_STORE = {
  deviceId: 'bfTESTDEVICE0001',
  localKey: 'not-a-real-key',
  ip: '172.22.22.224',
  version: '3.4',
  smartlifeSession: { source: 'alecoair', token_info: { access_token: 'oem' } },
  smartlifeDevices: [
    { id: 'bfTESTDEVICE0001', name: 'D13', localKey: 'not-a-real-key', productId: 'p1', ip: '86.1.2.3' },
    { id: 'bfOTHER', name: 'Plug', localKey: 'other-fake-key', category: 'cz' }
  ]
}

test('migrates the legacy D13 store and leaves the old file untouched', () => {
  const dir = tmpDir()
  const legacyFile = path.join(dir, 'signalk-alecoair-d13.store.json')
  fs.writeFileSync(legacyFile, JSON.stringify(LEGACY_STORE))
  const before = fs.readFileSync(legacyFile, 'utf8')
  const loaded = store.loadStore(dir)
  assert.equal(loaded.migrated, true)
  assert.equal(loaded.legacyRaw.deviceId, 'bfTESTDEVICE0001')
  assert.equal(store.getLocalKey(loaded.store, 'bfTESTDEVICE0001'), 'not-a-real-key')
  assert.equal(loaded.store.devices.bfTESTDEVICE0001.protocol, '3.4')
  assert.equal(loaded.store.devices.bfTESTDEVICE0001.lastIp, '172.22.22.224')
  assert.equal(loaded.store.account.linked, true)
  store.saveStore(loaded.store, dir)
  assert.equal(fs.readFileSync(legacyFile, 'utf8'), before)
  assert.ok(fs.existsSync(path.join(dir, 'signalk-alecoair.store.json')))
  assert.equal(store.loadStore(dir).migrated, false, 'second start reads the new store')
})

test('the new store file is private (0600)', { skip: process.platform === 'win32' }, () => {
  const dir = tmpDir()
  store.saveStore(store.emptyStore(), dir)
  const mode = fs.statSync(path.join(dir, 'signalk-alecoair.store.json')).mode & 0o777
  assert.equal(mode, 0o600)
})

test('login stores fresh keys; public view never includes them', () => {
  const s = store.emptyStore()
  store.setAccount(s, { region: 'eu', devices: [{ id: 'bf1', name: 'D13', localKey: 'fake-key-1', ip: '86.1.2.3' }] })
  assert.equal(store.getLocalKey(s, 'bf1'), 'fake-key-1')
  const pub = store.publicCloudDevice(s.account.devices[0])
  assert.equal(pub.hasKey, true)
  assert.equal(pub.localKey, undefined)
  assert.equal(pub.ip, '', 'cloud WAN IPs are dropped')
})

test('forgetting the account keeps keys of configured devices only', () => {
  const s = store.emptyStore()
  store.setAccount(s, { devices: [{ id: 'keep', localKey: 'k1' }, { id: 'drop', localKey: 'k2' }] })
  store.clearAccount(s, ['keep'])
  assert.equal(store.getLocalKey(s, 'keep'), 'k1')
  assert.equal(store.getLocalKey(s, 'drop'), '')
  assert.equal(s.account.linked, false)
})

test('login keeps the account email/phone for display, never a password', () => {
  const s = store.emptyStore()
  store.setAccount(s, { region: 'eu', user: '  sailor@example.com ', devices: [{ id: 'bf1', localKey: 'k1' }] })
  assert.equal(s.account.user, 'sailor@example.com')
  assert.equal(JSON.stringify(s).includes('password'), false)
  store.clearAccount(s, [])
  assert.equal(s.account.user, null)
})

test('the legacy store never recorded the login, so a migrated account has no user', () => {
  const s = store.migrateLegacyStore({ smartlifeSession: { source: 'alecoair', token_info: { access_token: 'x' } }, smartlifeDevices: [] })
  assert.equal(s.account.linked, true)
  assert.equal(s.account.user, null)
})

test('null, undefined or empty data roots fall back to the default instead of throwing', () => {
  const expected = path.join(store.defaultDataRoot(), 'signalk-alecoair.store.json')
  for (const root of [null, undefined, '']) {
    assert.equal(store.storePath(root), expected)
    assert.equal(typeof store.legacyStorePath(root), 'string')
  }
  assert.doesNotThrow(() => store.loadStore(null))
  assert.equal(typeof store.loadStore(null).store, 'object')
})
