'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const os = require('os')
const path = require('path')
const {
  loadStore,
  saveStore,
  pickDehumidifier,
  publicDevice,
  setupStatus,
  mergeSettings
} = require('../plugin/setup')

test('picks a dehumidifier from mixed Smart Life devices', () => {
  const devices = [
    { id: 'plug1', name: 'Charger', category: 'cz' },
    { id: 'd13', name: 'ALECOAIR D13', category: 'cs', localKey: 'abc' }
  ]
  assert.equal(pickDehumidifier(devices).id, 'd13')
  assert.equal(pickDehumidifier([devices[0]]).id, 'plug1')
  assert.equal(pickDehumidifier([{ id: 'aaa', name: 'lamp' }, { id: 'bbb', name: 'plug' }]), null)
})

test('public device never includes the local key', () => {
  const pub = publicDevice({ id: 'bf1', name: 'D13', localKey: 'secret', ip: '172.22.22.224' })
  assert.equal(pub.hasKey, true)
  assert.equal(pub.localKey, undefined)
})

test('store survives reload and marks setup ready', () => {
  const file = path.join(os.tmpdir(), `aleco-store-${Date.now()}.json`)
  saveStore({
    deviceId: 'bf1',
    localKey: 'k',
    ip: '172.22.22.224',
    deviceName: 'D13',
    smartlifeSession: { token_info: { access_token: 't' } },
    smartlifeDevices: [{ id: 'bf1', name: 'D13', localKey: 'k' }]
  }, file)
  const store = loadStore(file)
  const settings = mergeSettings({}, store)
  const status = setupStatus(settings)
  assert.equal(status.ready, true)
  assert.equal(status.linked, true)
  assert.equal(status.userCode, '')
  assert.equal(status.devices[0].hasKey, true)
  assert.equal(status.devices[0].localKey, undefined)
  fs.unlinkSync(file)
})
