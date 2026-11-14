'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const path = require('path')
const factory = require('../plugin')
const { DiscoveryService } = require('../plugin/discovery')
const { makeFakeLan, tmpDir, fakeApp, fakeRouter, lastValues, metaPaths, wait } = require('./helpers/fakes')

const TUYA_ID = 'bfTESTDEVICE0001'
const SENSOR = 'environment.inside.salon.relativeHumidity'
const PREFIX = 'environment.inside.dehumidifier.d13'

function install(externalControl) {
  const root = tmpDir('alecoair-ext-')
  const dataRoot = path.join(root, 'plugin-config-data')
  fs.mkdirSync(dataRoot)
  fs.writeFileSync(path.join(dataRoot, 'signalk-alecoair.store.json'), JSON.stringify({
    storeVersion: 2,
    account: { linked: false, devices: [] },
    devices: { [TUYA_ID]: { localKey: 'not-a-real-key', reportedDps: ['1', '2', '5', '6', '16', '17', '19'] } }
  }))
  const options = {
    configVersion: 2,
    devices: [{ key: 'd13', name: 'D13', tuyaId: TUYA_ID, ip: '172.22.22.224', profile: 'traditio', model: 'D13', externalControl }]
  }
  return { dataRoot, options }
}

function boot(dataRoot, sensors) {
  const app = fakeApp(dataRoot)
  app.getSelfPath = (p) => sensors[p]
  app.streambundle = { getAvailablePaths: () => Object.keys(sensors).concat([`${PREFIX}.humidity`]) }
  const FakeLan = makeFakeLan()
  const plugin = factory(app, { dataRoot, TuyaLanDevice: FakeLan, discovery: new DiscoveryService({ scan: async () => [] }) })
  const router = fakeRouter()
  plugin.registerWithRouter(router)
  return { app, plugin, router, FakeLan }
}

const fresh = (value, source = 'OpenPlotter.I2C.BME280') => ({ value, $source: source, timestamp: new Date().toISOString() })

test('external control off in Admin: no control paths, the control route refuses', async () => {
  const { dataRoot, options } = install(undefined)
  const { app, plugin, router } = boot(dataRoot, {})
  await plugin.start(options)
  await wait(20)
  const st = await router.call('GET', '/devices/:key/state', { params: { key: 'd13' } })
  assert.equal(st.body.control.configured, false)
  const r = await router.call('POST', '/devices/:key/control', { params: { key: 'd13' }, body: { mode: 'external' } })
  assert.equal(r.status, 400)
  assert.match(r.body.error, /not set up/)
  assert.equal(`${PREFIX}.control.mode` in app.puts, false)
  await plugin.stop()
})

test('WebApp toggle: CO on the unit, power from the external sensor, state persisted, restored on disable', async () => {
  const { dataRoot, options } = install({ enabled: true, humidityPath: SENSOR, minOnMinutes: 0, minOffMinutes: 0 })
  const sensors = { [SENSOR]: fresh(0.62) }
  const { app, plugin, router, FakeLan } = boot(dataRoot, sensors)
  await plugin.start(options)
  await wait(20)
  assert.ok(`${PREFIX}.control.mode` in app.puts, 'control.mode is PUT-able')
  assert.ok(`${PREFIX}.control.target` in app.puts, 'control.target is PUT-able')
  assert.ok(metaPaths(app).has(`${PREFIX}.control.sourceHumidity`))

  const r = await router.call('POST', '/devices/:key/control', { params: { key: 'd13' }, body: { mode: 'external', target: 55 } })
  assert.equal(r.status, 200, JSON.stringify(r.body))
  assert.equal(r.body.control.mode, 'external')
  assert.equal(r.body.control.target, 55)
  assert.equal(r.body.control.sourceHumidity, 62)
  assert.equal(r.body.control.state, 'running')
  assert.deepEqual(FakeLan.writes[0], { 2: 25, 5: 'Manual' }, 'CO = target 25 on DP 2')
  assert.equal(FakeLan.writes.length, 1, 'already on: no power write')

  const values = lastValues(app)
  assert.equal(values[`${PREFIX}.control.mode`], 'external')
  assert.equal(values[`${PREFIX}.control.target`], 0.55)
  assert.equal(values[`${PREFIX}.control.sourceHumidity`], 0.62)

  const store = JSON.parse(fs.readFileSync(path.join(dataRoot, 'signalk-alecoair.store.json'), 'utf8'))
  assert.deepEqual(store.control.d13, { mode: 'external', target: 55, saved: { mode: 'auto', targetHumidity: 50 }, power: true })

  // Humidity drops below target − 2 → power off.
  sensors[SENSOR] = fresh(0.52)
  const r2 = await router.call('POST', '/devices/:key/control', { params: { key: 'd13' }, body: { target: 55 } })
  assert.equal(r2.body.control.state, 'idle')
  assert.deepEqual(FakeLan.writes[1], { 1: false })

  // Toggle off: hygrostat restored and the unit switched on.
  const r3 = await router.call('POST', '/devices/:key/control', { params: { key: 'd13' }, body: { mode: 'internal' } })
  assert.equal(r3.body.control.mode, 'internal')
  assert.deepEqual(FakeLan.writes[2], { 1: true, 2: 50, 5: 'Manual' })
  await plugin.stop()
})

test('the plugin\'s own values never feed the controller (cabin humidity feedback)', async () => {
  const { dataRoot, options } = install({ enabled: true, humidityPath: SENSOR })
  const sensors = { [SENSOR]: { value: 0.7, $source: 'signalk-alecoair', timestamp: new Date().toISOString() } }
  const { plugin, router } = boot(dataRoot, sensors)
  await plugin.start(options)
  await wait(20)
  const r = await router.call('POST', '/devices/:key/control', { params: { key: 'd13' }, body: { mode: 'external' } })
  assert.equal(r.body.control.state, 'sensor-missing')
  assert.equal(r.body.control.sourceHumidity, null)
  await plugin.stop()
})

test('Admin picklist lists humidity and temperature paths but not the unit\'s own', async () => {
  const { dataRoot, options } = install({ enabled: true, humidityPath: SENSOR })
  const sensors = { [SENSOR]: fresh(0.5), 'environment.inside.mainCabin.temperature': fresh(291.65), 'environment.rpi.cpu.temperature': fresh(318) }
  const { plugin, router } = boot(dataRoot, sensors)
  await plugin.start(options)
  const r = await router.call('GET', '/setup/paths')
  assert.equal(r.scope, 'admin')
  assert.deepEqual(r.body.humidity.map((x) => x.path), [SENSOR])
  assert.deepEqual(r.body.temperature.map((x) => x.path), ['environment.inside.mainCabin.temperature', 'environment.rpi.cpu.temperature'])
  assert.equal(r.body.humidity[0].source, 'OpenPlotter.I2C.BME280')
  await plugin.stop()
})

test('external mode survives a restart; plugin stop gives the unit its hygrostat back', async () => {
  const { dataRoot, options } = install({ enabled: true, humidityPath: SENSOR, minOnMinutes: 0 })
  const sensors = { [SENSOR]: fresh(0.62) }
  const first = boot(dataRoot, sensors)
  await first.plugin.start(options)
  await wait(20)
  await first.router.call('POST', '/devices/:key/control', { params: { key: 'd13' }, body: { mode: 'external', target: 50 } })
  await first.plugin.stop()
  assert.deepEqual(first.FakeLan.writes.at(-1), { 1: true, 2: 50, 5: 'Manual' }, 'restored on stop (fallback internal)')

  const second = boot(dataRoot, sensors)
  await second.plugin.start(options)
  await wait(20)
  const st = await second.router.call('GET', '/devices/:key/state', { params: { key: 'd13' } })
  assert.equal(st.body.control.mode, 'external')
  assert.equal(st.body.control.target, 50)
  await second.plugin.stop()
})

test('external control switched off in Admin while it was on: hygrostat restored once', async () => {
  const { dataRoot, options } = install({ enabled: false, humidityPath: SENSOR })
  const storeFile = path.join(dataRoot, 'signalk-alecoair.store.json')
  const store = JSON.parse(fs.readFileSync(storeFile, 'utf8'))
  store.control = { d13: { mode: 'external', target: 50, saved: { mode: 'auto', targetHumidity: 45 } } }
  fs.writeFileSync(storeFile, JSON.stringify(store))
  const { plugin, FakeLan } = boot(dataRoot, {})
  await plugin.start(options)
  await wait(5600)
  assert.deepEqual(FakeLan.writes[0], { 1: true, 2: 45, 5: 'Manual' })
  const after = JSON.parse(fs.readFileSync(storeFile, 'utf8'))
  assert.equal(after.control.d13.mode, 'internal')
  await plugin.stop()
})

test('simulated sensor file publishes only environment.inside.test.* values', async () => {
  const { dataRoot, options } = install(undefined)
  const { app, plugin } = boot(dataRoot, {})
  fs.writeFileSync(path.join(dataRoot, 'signalk-alecoair.test-sensor.json'), JSON.stringify({ 'environment.inside.test.relativeHumidity': 0.66, 'navigation.speedOverGround': 9 }))
  await plugin.start(options)
  await wait(2200)
  const delta = app.messages.find((m) => m.updates[0].$source === 'signalk-alecoair-test')
  assert.ok(delta)
  assert.deepEqual(delta.updates[0].values, [{ path: 'environment.inside.test.relativeHumidity', value: 0.66 }])
  await plugin.stop()
})

test('mode menu: "Auto / external sensor" only when allowed; picking it or another mode switches external control', async () => {
  const off = install(undefined)
  const a = boot(off.dataRoot, {})
  await a.plugin.start(off.options)
  await wait(20)
  const plain = await a.router.call('GET', '/devices/:key/state', { params: { key: 'd13' } })
  assert.equal(plain.body.modes.some((m) => m.value === 'external'), false, 'hidden when not allowed')
  await a.plugin.stop()

  const { dataRoot, options } = install({ enabled: true, humidityPath: SENSOR, minOnMinutes: 0, minOffMinutes: 0 })
  const sensors = { [SENSOR]: fresh(0.62) }
  const { app, plugin, router, FakeLan } = boot(dataRoot, sensors)
  await plugin.start(options)
  await wait(20)
  let st = await router.call('GET', '/devices/:key/state', { params: { key: 'd13' } })
  assert.deepEqual(st.body.modes.map((m) => m.value), ['auto', 'external', 'continuous', 'sleep'])
  assert.equal(st.body.modes[1].label, 'Auto / external sensor')
  assert.equal(st.body.mode, 'auto')

  st = await router.call('POST', '/devices/:key/command', { params: { key: 'd13' }, body: { mode: 'external' } })
  assert.equal(st.status, 200, JSON.stringify(st.body))
  assert.equal(st.body.mode, 'external', 'the menu shows the external entry, not CO')
  assert.equal(st.body.unitMode, 'continuous')
  assert.equal(st.body.control.mode, 'external')
  assert.equal(st.body.control.target, 50)
  assert.deepEqual(FakeLan.writes[0], { 2: 25, 5: 'Manual' })

  // The target steps like the unit's hygrostat (5 %, 30–80).
  st = await router.call('POST', '/devices/:key/control', { params: { key: 'd13' }, body: { target: 0.47 } })
  assert.equal(st.body.control.target, 45)
  st = await router.call('POST', '/devices/:key/control', { params: { key: 'd13' }, body: { target: 12 } })
  assert.equal(st.body.control.target, 30)

  // Signal K PUT on .mode = sleep leaves external control with one write.
  const n = FakeLan.writes.length
  await new Promise((resolve) => app.puts[`${PREFIX}.mode`]('vessels.self', `${PREFIX}.mode`, 'sleep', resolve))
  assert.deepEqual(FakeLan.writes.slice(n), [{ 1: true, 2: 50, 5: 'SLeeping' }])
  st = await router.call('GET', '/devices/:key/state', { params: { key: 'd13' } })
  assert.equal(st.body.control.mode, 'internal')
  assert.equal(st.body.mode, 'sleep')
  const store = JSON.parse(fs.readFileSync(path.join(dataRoot, 'signalk-alecoair.store.json'), 'utf8'))
  assert.equal(store.control.d13.mode, 'internal')
  await plugin.stop()
})

test('one sensor path may drive several units', async () => {
  const { dataRoot, options } = install({ enabled: true, humidityPath: SENSOR, minOnMinutes: 0, minOffMinutes: 0 })
  options.devices.push({ key: 'sim', name: 'Simulator', simulate: true, profile: 'traditio', model: 'D13', externalControl: { enabled: true, humidityPath: SENSOR } })
  const sensors = { [SENSOR]: fresh(0.62) }
  const { app, plugin, router } = boot(dataRoot, sensors)
  await plugin.start(options)
  await wait(20)
  const status = await router.call('GET', '/setup/status')
  for (const d of status.body.devices) assert.deepEqual(d.problems, [], `${d.key} starts`)
  for (const key of ['d13', 'sim']) {
    const r = await router.call('POST', '/devices/:key/control', { params: { key }, body: { mode: 'external', target: 50 } })
    assert.equal(r.status, 200, JSON.stringify(r.body))
    assert.equal(r.body.control.humidityPath, SENSOR)
    assert.equal(r.body.control.sourceHumidity, 62)
    assert.equal(r.body.control.state, 'running')
  }
  const values = lastValues(app)
  assert.equal(values[`${PREFIX}.control.sourceHumidity`], 0.62)
  assert.equal(values['environment.inside.dehumidifier.sim.control.sourceHumidity'], 0.62)
  await plugin.stop()
})

test('a change made on the unit ends external control in the plugin: mode internal persisted, no writes, menu shows the real mode', async () => {
  const { dataRoot, options } = install({ enabled: true, humidityPath: SENSOR, minOnMinutes: 0, minOffMinutes: 0 })
  const sensors = { [SENSOR]: fresh(0.62) }
  const { plugin, router, FakeLan } = boot(dataRoot, sensors)
  await plugin.start(options)
  await wait(20)
  await router.call('POST', '/devices/:key/command', { params: { key: 'd13' }, body: { mode: 'external' } })
  const before = await router.call('GET', '/devices/:key/state', { params: { key: 'd13' } })
  assert.equal(before.body.control.mode, 'external')
  const writes = FakeLan.writes.length
  // The unit now reports Manual / 45 / on (changed with its buttons), past the grace time.
  FakeLan.dps = { ...FakeLan.dps, 1: true, 2: 45, 5: 'Manual' }
  const realNow = Date.now
  Date.now = () => realNow() + 60000
  try {
    // Let the poll read the new DPs, then a control tick run.
    await new Promise((r) => setTimeout(r, 5600))
  } finally {
    Date.now = realNow
  }
  const st = await router.call('GET', '/devices/:key/state', { params: { key: 'd13' } })
  assert.equal(st.body.control.mode, 'internal')
  assert.equal(st.body.mode, 'auto', 'menu shows the unit\'s real mode')
  assert.equal(st.body.targetHumidity, 45)
  assert.equal(FakeLan.writes.length, writes, 'nothing written to the unit')
  const store = JSON.parse(fs.readFileSync(path.join(dataRoot, 'signalk-alecoair.store.json'), 'utf8'))
  assert.equal(store.control.d13.mode, 'internal')
  await plugin.stop()
  assert.equal(FakeLan.writes.length, writes, 'plugin stop does not restore anything either')
})

test('device state carries the external temperature in every mode while it is fresh', async () => {
  const TEMP = 'environment.inside.mainCabin.temperature'
  const { dataRoot, options } = install({ enabled: true, humidityPath: SENSOR, temperaturePath: TEMP, staleMinutes: 5 })
  const sensors = { [SENSOR]: fresh(0.55), [TEMP]: fresh(291.55) }
  const { plugin, router } = boot(dataRoot, sensors)
  await plugin.start(options)
  await wait(20)
  const state = async () => (await router.call('GET', '/devices/:key/state', { params: { key: 'd13' } })).body
  let st = await state()
  assert.equal(st.control.mode, 'internal', 'external control is not running')
  assert.equal(st.sensorTemperature.value, 18.4, 'Kelvin -> °C, one decimal')
  assert.equal(st.sensorTemperature.path, TEMP)
  sensors[TEMP] = { value: 291.55, $source: 'x', timestamp: new Date(Date.now() - 6 * 60 * 1000).toISOString() }
  st = await state()
  assert.equal(st.sensorTemperature, null, 'stale (older than the sensor-lost time): hidden')
  delete sensors[TEMP]
  st = await state()
  assert.equal(st.sensorTemperature, null, 'no value: hidden')
  await plugin.stop()
})

test('no external temperature without a temperature path or with external control off', async () => {
  const TEMP = 'environment.inside.mainCabin.temperature'
  for (const ext of [{ enabled: true, humidityPath: SENSOR }, { enabled: false, humidityPath: SENSOR, temperaturePath: TEMP }, undefined]) {
    const { dataRoot, options } = install(ext)
    const { plugin, router } = boot(dataRoot, { [SENSOR]: fresh(0.55), [TEMP]: fresh(291.55) })
    await plugin.start(options)
    await wait(20)
    const st = (await router.call('GET', '/devices/:key/state', { params: { key: 'd13' } })).body
    assert.equal(st.sensorTemperature, null, JSON.stringify(ext))
    await plugin.stop()
  }
})
