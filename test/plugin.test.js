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
  assert.equal(res.body.account.user, 'a@b.c', 'the linked email/phone is shown in Admin')
  assert.equal(res.body.account.passwordStored, false)
  const onDisk = fs.readFileSync(path.join(dataRoot, 'signalk-alecoair.store.json'), 'utf8')
  assert.equal(onDisk.includes('"pw"'), false, 'the AlecoAir password is never written')
  assert.equal(JSON.parse(onDisk).account.user, 'a@b.c')
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

test('account table falls back to the profile set on the configured device', async () => {
  const dataRoot = legacyInstall()
  const { plugin, app } = boot(dataRoot)
  await plugin.start({})
  const options = JSON.parse(JSON.stringify(app.saved[0]))
  await plugin.stop()
  options.devices[0].profile = 'traditio'
  const second = boot(dataRoot)
  await second.plugin.start(options)
  const status = await second.router.call('GET', '/setup/status')
  const cloud = status.body.account.devices.find((d) => d.id === 'bfTESTDEVICE0001')
  assert.equal(cloud.profileByProductId, null, 'testproduct00001 is not a known product')
  assert.equal(cloud.configuredProfile, 'traditio')
  assert.equal(status.body.account.user, null, 'migrated account has no recorded login')
  await second.plugin.stop()
})

test('LAN discovery rows are tied to configured devices by Tuya id or IP', async () => {
  const dataRoot = legacyInstall()
  const scan = async () => [
    { ip: '172.22.22.224', tcp: true },
    { ip: '172.22.22.99', tcp: true },
    { ip: '172.22.22.50', id: 'bfOTHER', version: '3.3', tcp: false }
  ]
  const discovery = new DiscoveryService({ scan })
  const { plugin, router } = boot(dataRoot, { deps: { discovery } })
  await plugin.start({})
  await wait(20)
  await router.call('POST', '/setup/discover', { body: {} })
  const status = await router.call('GET', '/setup/status')
  const rows = Object.fromEntries(status.body.discovery.devices.map((r) => [r.ip, r]))
  assert.equal(rows['172.22.22.224'].configuredKey, 'd13')
  assert.equal(rows['172.22.22.224'].matchedBy, 'ip')
  assert.equal(rows['172.22.22.224'].knownId, 'bfTESTDEVICE0001')
  assert.equal(rows['172.22.22.224'].knownVersion, '3.5')
  assert.equal(rows['172.22.22.224'].id, undefined, 'the scan result itself is not rewritten')
  assert.equal(rows['172.22.22.99'].configuredKey, null)
  assert.equal(rows['172.22.22.50'].configuredKey, null, 'a different Tuya id at another IP is not claimed')
  await plugin.stop()
})

test('Admin configurator loads and lays out by panel width, not window width', () => {
  const vm = require('vm')
  const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'remoteEntry.js'), 'utf8')
  assert.equal(/col-md-\d/.test(src.replace(/\/\*[\s\S]*?\*\//g, '')), false, 'no viewport breakpoints that squeeze fields in the narrow Admin column')
  const win = {}
  vm.runInNewContext(src, { window: win, fetch: () => {} })
  assert.equal(typeof win.signalk_alecoair.get, 'function')
})

test('unconfigured plugin (start() never ran): Admin setup status works and writes nothing', async () => {
  const root = tmpDir('alecoair-sk-')
  const dataRoot = path.join(root, 'plugin-config-data')
  fs.mkdirSync(dataRoot)
  const app = fakeApp(dataRoot)
  // No deps.dataRoot: the data root must be resolved from app.config.configPath, as on a real server.
  const login = async () => ({ ok: true, devices: [{ id: 'bfNEW', name: 'D13', localKey: 'fresh-fake-key', productId: 'p1', category: 'cs' }] })
  const plugin = factory(app, { TuyaLanDevice: makeFakeLan(), login })
  const router = fakeRouter()
  plugin.registerWithRouter(router)

  const status = await router.call('GET', '/setup/status')
  assert.equal(status.status, 200)
  assert.equal(typeof status.body.storeFile, 'string')
  assert.equal(status.body.storeFile, path.join(dataRoot, 'signalk-alecoair.store.json'))
  assert.equal(status.body.account.linked, false)
  assert.deepEqual(status.body.account.devices, [])
  assert.deepEqual(status.body.devices, [])
  assert.equal(status.body.discovery, null)
  assert.equal(status.body.migration, null)
  assert.deepEqual(fs.readdirSync(dataRoot), [], 'opening the status page creates no files')
  assert.equal(app.saved.length, 0, 'the plugin is not auto-enabled or configured')

  const scan = await router.call('POST', '/setup/discover')
  assert.equal(scan.status, 409)

  const res = await router.call('POST', '/setup/login', { body: { account: 'a@b.c', password: 'pw' } })
  assert.equal(res.status, 200)
  assert.equal(res.body.account.linked, true)
  assert.equal(JSON.stringify(res.body).includes('fresh-fake-key'), false)
  const onDisk = JSON.parse(fs.readFileSync(path.join(dataRoot, 'signalk-alecoair.store.json'), 'utf8'))
  assert.equal(onDisk.devices.bfNEW.localKey, 'fresh-fake-key')
  assert.equal(app.saved.length, 0)
  assert.deepEqual(app.errors, [])
})

test('unconfigured plugin reads an existing store before start() instead of overwriting it', async () => {
  const root = tmpDir('alecoair-sk-')
  const dataRoot = path.join(root, 'plugin-config-data')
  fs.mkdirSync(dataRoot)
  const file = path.join(dataRoot, 'signalk-alecoair.store.json')
  fs.writeFileSync(file, JSON.stringify({ storeVersion: 2, account: { linked: true, source: 'alecoair', region: 'eu', user: 'x@y.z', devices: [{ id: 'bfKEEP', name: 'Kept', productId: 'p1' }] }, devices: { bfKEEP: { localKey: 'kept-fake-key' } } }))
  const plugin = factory(fakeApp(dataRoot), { TuyaLanDevice: makeFakeLan() })
  const router = fakeRouter()
  plugin.registerWithRouter(router)
  const status = await router.call('GET', '/setup/status')
  assert.equal(status.body.account.linked, true)
  assert.equal(status.body.account.devices[0].id, 'bfKEEP')
  await router.call('POST', '/setup/unlink')
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).account.linked, false)
})
