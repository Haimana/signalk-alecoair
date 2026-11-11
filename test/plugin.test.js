'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const path = require('path')
const factory = require('../plugin')
const { DiscoveryService } = require('../plugin/discovery')
const { makeFakeLan, tmpDir, fakeApp, fakeRouter, lastValues, metaPaths, wait } = require('./helpers/fakes')
const pkg = require('../package.json')

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

function legacyInstall() {
  const root = tmpDir('alecoair-sk-')
  const dataRoot = path.join(root, 'plugin-config-data')
  fs.mkdirSync(dataRoot)
  fs.writeFileSync(path.join(dataRoot, 'signalk-alecoair-d13.json'), JSON.stringify({ enabled: true, configuration: LEGACY_OPTIONS }))
  fs.writeFileSync(path.join(dataRoot, 'signalk-alecoair-d13.store.json'), JSON.stringify(LEGACY_STORE))
  return dataRoot
}

function boot(dataRoot, extra = {}) {
  const app = fakeApp(dataRoot)
  const FakeLan = extra.FakeLan || makeFakeLan()
  const discovery = new DiscoveryService({ scan: async () => [] })
  const plugin = factory(app, { dataRoot, TuyaLanDevice: FakeLan, discovery, ...extra.deps })
  const router = fakeRouter()
  plugin.registerWithRouter(router)
  return { app, plugin, router, FakeLan }
}

test('package is renamed to signalk-alecoair with an Admin configurator', () => {
  assert.equal(pkg.name, 'signalk-alecoair')
  assert.ok(pkg.keywords.includes('signalk-plugin-configurator'))
  assert.ok(pkg.keywords.includes('signalk-webapp'))
  assert.equal(pkg.license, 'Apache-2.0')
  assert.ok(fs.existsSync(path.join(__dirname, '..', 'public', 'remoteEntry.js')))
  const { plugin } = boot(tmpDir())
  assert.equal(plugin.id, 'signalk-alecoair')
})

test('first start migrates the old plugin config and store without losing the adopted D13', async () => {
  const dataRoot = legacyInstall()
  const { app, plugin, FakeLan } = boot(dataRoot)
  await plugin.start({})
  await wait(20)

  assert.equal(app.saved.length, 1)
  const saved = app.saved[0]
  assert.equal(saved.devices[0].key, 'd13')
  assert.equal(saved.devices[0].ip, '172.22.22.224')
  assert.equal(saved.devices[0].paths.prefix, 'environment.inside.dehumidifier')
  assert.equal(JSON.stringify(saved).includes('not-a-real-key'), false)

  const newStore = JSON.parse(fs.readFileSync(path.join(dataRoot, 'signalk-alecoair.store.json'), 'utf8'))
  assert.equal(newStore.devices.bfTESTDEVICE0001.localKey, 'not-a-real-key')
  assert.equal(JSON.parse(fs.readFileSync(path.join(dataRoot, 'signalk-alecoair-d13.store.json'), 'utf8')).localKey, 'not-a-real-key')

  assert.equal(FakeLan.instances[0].options.localKey, 'not-a-real-key')
  const values = lastValues(app)
  assert.equal(values['environment.inside.dehumidifier.connected'], true)
  assert.equal(typeof values['environment.inside.dehumidifier.humidity'], 'number')
  assert.equal('environment.inside.humidity' in values, true)
  await plugin.stop()
})

test('flat options handed over directly (copied config file) are migrated too', async () => {
  const dataRoot = legacyInstall()
  fs.unlinkSync(path.join(dataRoot, 'signalk-alecoair-d13.json'))
  const { app, plugin } = boot(dataRoot)
  await plugin.start({ ...LEGACY_OPTIONS })
  assert.equal(app.saved[0].devices[0].tuyaId, 'bfTESTDEVICE0001')
  await plugin.stop()
})

test('absent D13 controls are neither published nor PUT-able', async () => {
  const dataRoot = legacyInstall()
  const { app, plugin } = boot(dataRoot)
  await plugin.start({})
  await wait(20)
  const values = lastValues(app)
  const meta = metaPaths(app)
  for (const absent of ['fanSpeed', 'insideDry', 'tankVolume']) {
    const p = `environment.inside.dehumidifier.${absent}`
    assert.equal(p in values, false, `${p} value`)
    assert.equal(meta.has(p), false, `${p} meta`)
    assert.equal(p in app.puts, false, `${p} PUT`)
  }
  assert.ok('environment.inside.dehumidifier.power' in app.puts)
  assert.ok('environment.inside.dehumidifier.targetHumidity' in app.puts)
  assert.ok('environment.inside.dehumidifier.sleep' in app.puts, 'sleep stays PUT-able as a mode alias')
  await plugin.stop()
})

test('Plugin Config is the single source of truth: the store IP does not override it', async () => {
  const dataRoot = legacyInstall()
  const first = boot(dataRoot)
  await first.plugin.start({})
  await first.plugin.stop()
  const options = JSON.parse(JSON.stringify(first.app.saved[0]))
  options.devices[0].ip = '172.22.22.150'

  const second = boot(dataRoot)
  await second.plugin.start(options)
  assert.equal(second.FakeLan.instances[0].options.ip, '172.22.22.150')
  assert.equal(second.app.saved.length, 0, 'v2 options are not rewritten')
  await second.plugin.stop()
})

test('several devices: one connection each, separate paths, REST by key', async () => {
  const dataRoot = legacyInstall()
  const first = boot(dataRoot)
  await first.plugin.start({})
  await first.plugin.stop()
  const options = JSON.parse(JSON.stringify(first.app.saved[0]))
  options.devices.push({ key: 'sim', name: 'Simulator', simulate: true, profile: 'traditio', model: 'D13', paths: { prefix: 'environment.inside.dehumidifier.sim', electrical: '' } })

  const { app, plugin, router, FakeLan } = boot(dataRoot)
  await plugin.start(options)
  await wait(20)
  assert.equal(FakeLan.instances.length, 1)
  const list = await router.call('GET', '/devices')
  assert.deepEqual(list.body.devices.map((d) => d.key), ['d13', 'sim'])
  assert.equal(list.scope, 'readonly')
  const sim = await router.call('POST', '/devices/:key/command', { params: { key: 'sim' }, body: { power: true } })
  assert.equal(sim.status, 200)
  assert.equal(sim.body.power, true)
  const missing = await router.call('GET', '/devices/:key/state', { params: { key: 'nope' } })
  assert.equal(missing.status, 404)
  const legacy = await router.call('GET', '/state')
  assert.equal(legacy.body.key, 'd13')
  const values = lastValues(app)
  assert.equal(values['environment.inside.dehumidifier.sim.power'], true)
  await plugin.stop()
})

test('setup routes are admin-only and never leak local keys', async () => {
  const dataRoot = legacyInstall()
  const login = async () => ({ ok: true, devices: [{ id: 'bfNEW', name: 'D25', localKey: 'another-fake-key', productId: 'b9oyi2yofflroq1g', category: 'cs' }] })
  const { plugin, router } = boot(dataRoot, { deps: { login } })
  await plugin.start({})
  const status = await router.call('GET', '/setup/status')
  assert.equal(status.scope, 'admin')
  assert.equal(status.body.devices[0].key, 'd13')
  assert.equal(status.body.devices[0].hasLocalKey, true)
  const res = await router.call('POST', '/setup/login', { body: { account: 'a@b.c', password: 'pw' } })
  assert.equal(res.scope, 'admin')
  assert.equal(res.status, 200)
  const cloud = res.body.account.devices.find((d) => d.id === 'bfNEW')
  assert.equal(cloud.profileByProductId, 'traditio')
  assert.equal(JSON.stringify(res.body).includes('another-fake-key'), false)
  assert.equal(JSON.stringify(res.body).includes('not-a-real-key'), false)
  assert.equal(JSON.stringify(res.body).includes('pw'), false)
  const dps = await router.call('GET', '/setup/devices/:key/dps', { params: { key: 'd13' } })
  assert.equal(dps.body.suggestion, 'traditio')
  await plugin.stop()
})

test('a fresh install with nothing to migrate starts with no devices', async () => {
  const dataRoot = tmpDir()
  const { app, plugin, router } = boot(dataRoot)
  await plugin.start({})
  assert.equal(app.saved.length, 0)
  const list = await router.call('GET', '/devices')
  assert.deepEqual(list.body.devices, [])
  assert.match(app.statuses.at(-1), /No device yet/)
  await plugin.stop()
})
