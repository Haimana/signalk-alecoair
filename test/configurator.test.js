'use strict'

// Renders the Admin configurator (public/remoteEntry.js) with a tiny React
// stand-in and a fake setup API, to check the login-first flow.

const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const path = require('path')
const vm = require('vm')
const { createMiniReact, text, button, inputByLabel, settle } = require('./helpers/mini-react')

const SRC = fs.readFileSync(path.join(__dirname, '..', 'public', 'remoteEntry.js'), 'utf8')

const CLOUD = [{ id: 'cloudunit0001', name: 'Dezumidificator', productId: 'testproduct00001', productName: 'D13', hasKey: true, dehumidifier: true, profileByProductId: 'traditio' }]

function baseStatus(over = {}) {
  return Object.assign({
    pluginId: 'signalk-alecoair',
    storeFile: '/tmp/store.json',
    webappPath: '/signalk-alecoair/',
    account: { linked: false, devices: [] },
    discovery: { devices: [], scanning: false },
    devices: [],
    profiles: [{ id: 'traditio', name: 'Traditio', verified: true, dps: {}, models: [{ id: 'D13', name: 'D13' }] }],
    roles: [],
    protocols: ['auto', '3.3', '3.4', '3.5']
  }, over)
}

async function mountPanel({ status, configuration = {} }) {
  const calls = []
  const state = { status }
  const fetch = (url, opts = {}) => {
    const method = opts.method || 'GET'
    calls.push({ url, method, body: opts.body ? JSON.parse(opts.body) : undefined })
    let body = {}
    if (url.endsWith('/setup/status')) body = state.status
    else if (url.endsWith('/setup/login')) {
      state.status = Object.assign({}, state.status, { account: { linked: true, source: 'alecoair', region: 'eu', user: 'user@example.com', devices: CLOUD } })
      body = state.status
    } else if (url.endsWith('/setup/discover')) body = {}
    return Promise.resolve({ ok: true, status: 200, text: () => Promise.resolve(JSON.stringify(body)) })
  }
  const mini = createMiniReact()
  const win = { __SK_REACT__: mini.React, open: () => {} }
  vm.runInNewContext(SRC, { window: win, fetch, setInterval: () => 0, clearInterval: () => {}, setTimeout: () => 0 })
  const factory = await win.signalk_alecoair.get('./PluginConfigurationPanel')
  const Panel = factory().default
  const saved = []
  const props = { configuration, save: (c) => saved.push(c) }
  mini.mount(mini.React.createElement(Panel, props))
  await settle()
  return { mini, calls, saved, get tree() { return mini.tree } }
}

function has(tree, s) { return text(tree).includes(s) }

test('fresh, not signed in: only the login form (plus simulator), no account table, LAN scan or Save', async () => {
  const p = await mountPanel({ status: baseStatus() })
  const t = p.tree
  assert.equal(t.props['data-aa-stage'], 'login')
  assert.ok(has(t, 'AlecoAir account'))
  assert.ok(inputByLabel(t, 'Email or phone'))
  assert.ok(inputByLabel(t, 'Password'))
  assert.ok(button(t, 'Sign in'))
  assert.ok(has(t, 'needed once, to fetch each unit\u2019s local key'), 'explains why login is needed')
  assert.ok(has(t, 'only operates the units'), 'intro line stays')
  assert.equal(button(t, 'Scan LAN'), null)
  assert.equal(has(t, 'LAN discovery'), false)
  assert.equal(has(t, 'Extra subnets'), false)
  assert.equal(button(t, 'Add'), null, 'no account device table')
  assert.equal(button(t, 'Save configuration'), null, 'nothing to save yet')
  assert.equal(has(t, 'Diagnostics'), false)
  assert.ok(button(t, 'Add simulator'), 'simulator needs no account')
  assert.equal(p.calls.some((c) => c.url.endsWith('/setup/discover')), false)
})

test('a simulator can be added without signing in, and then Save appears', async () => {
  const p = await mountPanel({ status: baseStatus() })
  button(p.tree, 'Add simulator').props.onClick()
  await settle()
  const t = p.tree
  assert.equal(t.props['data-aa-stage'], 'login', 'a simulator alone does not open the LAN/account setup')
  assert.ok(has(t, 'Simulator'))
  assert.equal(button(t, 'Scan LAN'), null)
  const save = button(t, 'Save configuration')
  assert.ok(save)
  save.props.onClick()
  assert.equal(p.saved.length, 1)
  assert.equal(p.saved[0].devices.length, 1)
  assert.equal(p.saved[0].devices[0].simulate, true)
})

test('after Sign in: account table, LAN discovery, Dehumidifiers and Save appear; Add needs no scan', async () => {
  const p = await mountPanel({ status: baseStatus() })
  inputByLabel(p.tree, 'Email or phone').props.onChange({ target: { value: 'user@example.com' } })
  await settle()
  inputByLabel(p.tree, 'Password').props.onChange({ target: { value: 'pw' } })
  await settle()
  const form = require('./helpers/mini-react').findAll(p.tree, (n) => n.type === 'form')[0]
  form.props.onSubmit({ preventDefault() {} })
  await settle()
  let t = p.tree
  assert.equal(t.props['data-aa-stage'], 'setup')
  assert.ok(button(t, 'Scan LAN'))
  assert.ok(has(t, 'LAN discovery'))
  assert.ok(button(t, 'Forget account'))
  assert.ok(button(t, 'Sign in'), 'login form stays for re-sign-in')
  assert.ok(button(t, 'Save configuration'))
  const login = p.calls.find((c) => c.url.endsWith('/setup/login'))
  assert.equal(login.method, 'POST')

  button(t, 'Add').props.onClick()
  await settle()
  t = p.tree
  assert.equal(p.calls.some((c) => c.url.endsWith('/setup/discover')), false, 'Add did not need a LAN scan')
  assert.ok(has(t, 'added as'))
  button(t, 'Save configuration').props.onClick()
  const dev = p.saved[0].devices[0]
  assert.equal(dev.tuyaId, 'cloudunit0001')
  assert.equal(dev.ip, '', 'empty IP = find it on the LAN at start')
  assert.equal(dev.productId, 'testproduct00001')
})

test('account already linked when the panel opens: full setup shows', async () => {
  const p = await mountPanel({ status: baseStatus({ account: { linked: true, user: 'user@example.com', region: 'eu', devices: CLOUD } }) })
  const t = p.tree
  assert.equal(t.props['data-aa-stage'], 'setup')
  assert.ok(button(t, 'Scan LAN'))
  assert.ok(button(t, 'Add'))
  assert.ok(has(t, 'Sign in again to refresh local keys'))
})

test('configured unit but account forgotten: full setup shows, with the missing-key warning', async () => {
  const configuration = { configVersion: 2, devices: [{ key: 'd13', name: 'D13', tuyaId: 'cloudunit0001', enabled: true, profile: 'auto', protocol: 'auto', paths: { prefix: 'environment.inside.dehumidifier.d13' } }] }
  const p = await mountPanel({ status: baseStatus({ devices: [{ key: 'd13', running: false, hasLocalKey: false }] }), configuration })
  const t = p.tree
  assert.equal(t.props['data-aa-stage'], 'setup')
  assert.ok(button(t, 'Scan LAN'))
  assert.ok(has(t, 'LAN discovery'))
  assert.ok(button(t, 'Save configuration'))
  assert.ok(has(t, 'No local key stored for this device. Sign in to AlecoAir above.'))
  assert.ok(button(t, 'Sign in'))
})

test('External control: off by default; allowing it shows the sensor fields and is saved with the unit', async () => {
  const configuration = { configVersion: 2, devices: [{ key: 'd13', name: 'D13', tuyaId: 'cloudunit0001', enabled: true, profile: 'traditio', protocol: 'auto', paths: { prefix: 'environment.inside.dehumidifier.d13' } }] }
  const p = await mountPanel({ status: baseStatus({ account: { linked: true, devices: CLOUD }, devices: [{ key: 'd13', running: true, hasLocalKey: true, state: { connected: true } }] }), configuration })
  let t = p.tree
  assert.ok(has(t, 'External control'))
  const allow = inputByLabel(t, 'Allow external control')
  assert.ok(allow)
  assert.equal(allow.props.checked, false)
  assert.equal(inputByLabel(t, 'Humidity path'), null, 'no sensor fields until allowed')
  assert.ok(p.calls.some((c) => c.url.endsWith('/setup/paths')), 'asks the server for path suggestions')
  allow.props.onChange({ target: { checked: true } })
  await settle()
  t = p.tree
  const hum = inputByLabel(t, 'Humidity path')
  assert.ok(hum)
  assert.equal(hum.props.list, 'aa-hum-d13', 'humidity field offers the Signal K path list')
  hum.props.onChange({ target: { value: 'environment.inside.relativeHumidity' } })
  await settle()
  inputByLabel(p.tree, 'Minimum on time (min)').props.onChange({ target: { value: '2' } })
  await settle()
  button(p.tree, 'Save configuration').props.onClick()
  const ext = p.saved[0].devices[0].externalControl
  assert.equal(ext.enabled, true)
  assert.equal(ext.humidityPath, 'environment.inside.relativeHumidity')
  assert.equal('humidityPaths' in ext, false)
  assert.equal('combine' in ext, false)
  assert.equal(button(p.tree, 'Add another humidity sensor'), null, 'one sensor per unit')
  assert.equal(ext.minOnMinutes, 2)
  assert.equal(ext.hysteresisOn, 3)
  assert.equal(ext.onSensorLoss, 'internal')
})

test('WebApp checkboxes: child lock and timer hidden by default, saved per unit when checked', async () => {
  const configuration = { configVersion: 2, devices: [{ key: 'd13', name: 'D13', tuyaId: 'cloudunit0001', enabled: true, profile: 'traditio', protocol: 'auto', paths: { prefix: 'environment.inside.dehumidifier.d13' } }] }
  const p = await mountPanel({ status: baseStatus({ account: { linked: true, devices: CLOUD }, devices: [{ key: 'd13', running: true, hasLocalKey: true, state: { connected: true } }] }), configuration })
  const lock = inputByLabel(p.tree, 'Show child lock in UI')
  const timer = inputByLabel(p.tree, 'Show timer in UI')
  assert.ok(lock && timer)
  assert.equal(lock.props.checked, false)
  assert.equal(timer.props.checked, false)
  timer.props.onChange({ target: { checked: true } })
  await settle()
  assert.equal(inputByLabel(p.tree, 'Show timer in UI').props.checked, true)
  button(p.tree, 'Save configuration').props.onClick()
  assert.deepEqual(JSON.parse(JSON.stringify(p.saved[0].devices[0].ui)), { showChildLock: false, showTimer: true })
})
