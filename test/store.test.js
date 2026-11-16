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

// H3 (0.0.6): crash-safe writes and recovery from a damaged store.

const KEYED = () => {
  const s = store.emptyStore()
  store.setAccount(s, { devices: [{ id: 'bf1', name: 'D13', localKey: 'fake-key-1' }] })
  return s
}

function siblings(dir) {
  return fs.readdirSync(dir).sort()
}

test('saving keeps the previous good store as .bak (0600) and leaves no temp file', () => {
  const dir = tmpDir()
  const file = store.storePath(dir)
  store.saveStore(KEYED(), dir)
  assert.equal(fs.existsSync(store.backupPath(file)), false, 'no .bak before there was a previous store')
  const first = fs.readFileSync(file, 'utf8')
  const s = store.loadStore(dir).store
  store.updateDevice(s, 'bf1', { protocol: '3.5' })
  store.saveStore(s, dir)
  assert.equal(fs.readFileSync(store.backupPath(file), 'utf8'), first)
  assert.equal(store.loadStore(dir).store.devices.bf1.protocol, '3.5')
  assert.deepEqual(siblings(dir).filter((n) => n.endsWith('.tmp')), [])
  if (process.platform !== 'win32') assert.equal(fs.statSync(store.backupPath(file)).mode & 0o777, 0o600)
})

test('an empty store file (power cut) is reported, kept as .corrupt-*, and the .bak is used', () => {
  const dir = tmpDir()
  const file = store.storePath(dir)
  store.saveStore(KEYED(), dir)
  store.saveStore(store.loadStore(dir).store, dir) // now a .bak exists
  fs.writeFileSync(file, '')
  const loaded = store.loadStore(dir)
  assert.ok(loaded.problem, 'problem reported')
  assert.equal(loaded.problem.kind, 'corrupt')
  assert.match(loaded.problem.message, /damaged/)
  assert.equal(loaded.problem.recoveredFrom, store.backupPath(file))
  assert.equal(store.getLocalKey(loaded.store, 'bf1'), 'fake-key-1', 'keys come back from the .bak')
  assert.ok(loaded.problem.corruptCopy && fs.existsSync(loaded.problem.corruptCopy))
  assert.equal(JSON.stringify(loaded.problem).includes('fake-key-1'), false, 'no key in the message')
  // reading again does not pile up copies
  store.loadStore(dir)
  assert.equal(siblings(dir).filter((n) => n.includes('.corrupt-')).length, 1)
  // the recovered store is saved; the good .bak is not replaced by the empty file
  store.saveStore(loaded.store, dir)
  assert.equal(store.getLocalKey(store.loadStore(dir).store, 'bf1'), 'fake-key-1')
  assert.equal(store.getLocalKey(JSON.parse(fs.readFileSync(store.backupPath(file), 'utf8')), 'bf1'), 'fake-key-1')
})

test('a garbled store with no .bak: reported, copy kept, empty store, and saving later keeps the copy', () => {
  const dir = tmpDir()
  const file = store.storePath(dir)
  fs.writeFileSync(file, '{"devices":{"bf1":{"localKey":"fake-k')
  const loaded = store.loadStore(dir)
  assert.equal(loaded.problem.kind, 'corrupt')
  assert.equal(loaded.problem.recoveredFrom, null)
  assert.match(loaded.problem.message, /No usable backup/)
  assert.deepEqual(loaded.store.devices, {})
  const copy = loaded.problem.corruptCopy
  const bad = fs.readFileSync(copy, 'utf8')
  store.saveStore(loaded.store, dir)
  assert.equal(fs.readFileSync(copy, 'utf8'), bad, 'the damaged content is still there to recover by hand')
  assert.equal(store.loadStore(dir).problem, null)
})

test('JSON that is not an object counts as damaged', () => {
  for (const content of ['null', '[]', '42']) {
    const dir = tmpDir()
    fs.writeFileSync(store.storePath(dir), content)
    assert.equal(store.loadStore(dir).problem.kind, 'corrupt', content)
  }
})

test('an unreadable store is reported and never overwritten', () => {
  const dir = tmpDir()
  const file = store.storePath(dir)
  fs.mkdirSync(file) // reading a directory fails with EISDIR, like EIO or EACCES would
  const loaded = store.loadStore(dir)
  assert.equal(loaded.problem.kind, 'unreadable')
  assert.match(loaded.problem.message, /could not be read/)
  assert.throws(() => store.saveStore(KEYED(), dir), /not saving/)
  assert.ok(fs.statSync(file).isDirectory())
})

test('a store with keys is never replaced by one without, unless asked (forget account)', () => {
  const dir = tmpDir()
  store.saveStore(KEYED(), dir)
  assert.throws(() => store.saveStore(store.emptyStore(), dir), /holds 1 local key\(s\) and the copy in memory holds none/)
  assert.equal(store.getLocalKey(store.loadStore(dir).store, 'bf1'), 'fake-key-1')
  const s = store.loadStore(dir).store
  store.clearAccount(s, [])
  store.saveStore(s, dir, { allowKeyLoss: true })
  assert.equal(store.countKeys(store.loadStore(dir).store), 0)
})
