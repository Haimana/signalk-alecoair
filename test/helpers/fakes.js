'use strict'

const fs = require('fs')
const os = require('os')
const path = require('path')

/** DPs reported by the live D13 Traditio (Tuya LAN 3.5). */
const D13_DPS = { 1: true, 2: 50, 5: 'Manual', 6: 61, 16: false, 17: 'cancel', 19: 0 }

function makeFakeLan(dps = D13_DPS) {
  class FakeLan {
    constructor(options) {
      this.options = options
      this.writes = []
      FakeLan.instances.push(this)
    }

    async connect() {
      if (FakeLan.failVersions.includes(this.options.version)) throw new Error('bad version')
    }

    async get() { return { ...FakeLan.dps } }
    async setDps(data) { this.writes.push(data); FakeLan.writes.push(data) }
    onData() {}
    onError() {}
    onDisconnect() {}
    disconnect() {}
  }
  FakeLan.instances = []
  FakeLan.writes = []
  FakeLan.failVersions = []
  FakeLan.dps = { ...dps }
  return FakeLan
}

function tmpDir(prefix = 'alecoair-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix))
}

function fakeApp(dataRoot) {
  const app = {
    messages: [],
    puts: {},
    saved: [],
    statuses: [],
    errors: [],
    config: { configPath: path.dirname(dataRoot) },
    debug() {},
    error(msg) { app.errors.push(msg) },
    handleMessage(id, delta) { app.messages.push(delta) },
    registerPutHandler(context, p, cb) { app.puts[p] = cb },
    savePluginOptions(configuration, cb) { app.saved.push(configuration); cb(null) },
    setPluginStatus(s) { app.statuses.push(s) },
    setPluginError(s) { app.errors.push(s) }
  }
  return app
}

function fakeRouter() {
  const routes = {}
  const add = (scope) => (method) => (p, handler) => { routes[`${method} ${p}`] = { handler, scope } }
  const make = (scope) => ({ get: add(scope)('GET'), post: add(scope)('POST') })
  const router = make('admin')
  router.access = (level) => make(level)
  router.routes = routes
  router.call = async (method, p, { params = {}, body = {} } = {}) => {
    const route = routes[`${method} ${p}`]
    if (!route) throw new Error(`no route ${method} ${p}`)
    let statusCode = 200
    let payload
    const res = {
      status(code) { statusCode = code; return res },
      json(data) { payload = data; return res }
    }
    await route.handler({ params, body }, res)
    return { status: statusCode, body: payload, scope: route.scope }
  }
  return router
}

function lastValues(app) {
  const values = {}
  for (const delta of app.messages) {
    for (const u of delta.updates || []) {
      for (const v of u.values || []) values[v.path] = v.value
    }
  }
  return values
}

function metaPaths(app) {
  const paths = new Set()
  for (const delta of app.messages) {
    for (const u of delta.updates || []) {
      for (const m of u.meta || []) paths.add(m.path)
    }
  }
  return paths
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms))

module.exports = { D13_DPS, makeFakeLan, tmpDir, fakeApp, fakeRouter, lastValues, metaPaths, wait }
