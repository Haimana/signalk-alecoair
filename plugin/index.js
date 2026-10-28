'use strict'

const fs = require('fs')
const path = require('path')
const { D13, mergeDps, availableControls } = require('./profile')
const { DeviceRuntime } = require('./runtime')
const { metadata, notifications, stateToValues, skPaths } = require('./mapper')
const { scanLan, isLanIp } = require('./scan')
const smartlife = require('./smartlife')
const alecoair = require('./alecoair')
const {
  loadStore,
  saveStore,
  findStoredDevice,
  pickDehumidifier,
  mergeSettings,
  setupStatus
} = require('./setup')

const PLUGIN_ID = 'signalk-alecoair-d13'
const OPENAPI = path.join(__dirname, '..', 'openapi.json')

function loadOpenApi() {
  try {
    return JSON.parse(fs.readFileSync(OPENAPI, 'utf8'))
  } catch {
    return { openapi: '3.0.0', info: { title: 'ALECOAIR D13', version: '1.0.0' } }
  }
}

module.exports = function factory(app) {
  let runtime = null
  let onState = null
  let settings = {}
  let restartPlugin = null
  let qrSession = null

  const plugin = {
    id: PLUGIN_ID,
    name: 'ALECOAIR D13 Traditio',
    start,
    stop,
    schema,
    uiSchema
  }

  plugin.registerWithRouter = function registerWithRouter(router) {
    const read = typeof router.access === 'function' ? router.access('readonly') : router
    const write = typeof router.access === 'function' ? router.access('readwrite') : router

    read.get('/state', (_req, res) => {
      if (!runtime) return res.status(503).json({ error: 'Plugin is not running.' })
      res.json({ ...runtime.getPublicState(), setup: setupStatus(settings) })
    })

    read.get('/health', (_req, res) => {
      const state = runtime ? runtime.getPublicState() : { connected: false }
      res.json({
        ok: Boolean(runtime),
        model: D13.model,
        connected: Boolean(state.connected),
        lastError: state.lastError || null,
        setup: setupStatus(settings)
      })
    })

    read.get('/setup', (_req, res) => {
      res.json({
        ok: true,
        qrPending: Boolean(qrSession),
        ...setupStatus(settings)
      })
    })

    write.post('/alecoair/login', async (req, res) => {
      try {
        const listed = await alecoair.login(req.body || {})
        if (!listed.ok) return res.status(400).json(listed)
        persist({
          smartlifeSession: { source: 'alecoair', token_info: { access_token: 'oem' } },
          smartlifeDevices: listed.devices || []
        })
        const chosen = pickDehumidifier(listed.devices || [])
        if (chosen && chosen.localKey) {
          await adoptFromStore(chosen.id, { restart: false })
          res.json({ ok: true, adopted: true, ...setupStatus(settings) })
          if (typeof restartPlugin === 'function') setTimeout(() => restartPlugin(), 400)
          return
        }
        res.json({ ok: true, adopted: false, ...setupStatus(settings) })
      } catch (err) {
        res.status(500).json({ error: err.message || String(err) })
      }
    })

    write.post('/smartlife/qr', async (req, res) => {
      try {
        const userCode = (req.body && req.body.userCode) || ''
        const started = await smartlife.startQr(userCode)
        if (!started.ok) return res.status(400).json(started)
        qrSession = { userCode: String(userCode).trim(), token: started.token }
        res.json({
          ok: true,
          qrText: started.qrTexts && started.qrTexts.alecoair ? started.qrTexts.alecoair : started.qrText,
          qrTexts: started.qrTexts || { smartlife: started.qrText }
        })
      } catch (err) {
        res.status(500).json({ error: err.message || String(err) })
      }
    })

    write.post('/smartlife/poll', async (_req, res) => {
      if (!qrSession) {
        const current = setupStatus(settings)
        if (current.linked) return res.json({ ok: true, pending: false, ...current })
        return res.json({ ok: false, pending: true })
      }
      try {
        const polled = await smartlife.pollQr(qrSession.token, qrSession.userCode)
        if (polled.error && polled.pending === false) return res.status(500).json(polled)
        if (!polled.ok) return res.json({ ok: false, pending: true })

        const session = polled.session
        persist({ smartlifeSession: session, smartlifeDevices: [] })
        qrSession = null
        await refreshFromSession(session)
        const chosen = pickDehumidifier(settings.smartlifeDevices || [])
        if (chosen && chosen.localKey) {
          await adoptFromStore(chosen.id)
          return res.json({ ok: true, pending: false, adopted: true, ...setupStatus(settings) })
        }
        res.json({ ok: true, pending: false, adopted: false, ...setupStatus(settings) })
      } catch (err) {
        res.status(500).json({ error: err.message || String(err) })
      }
    })

    write.post('/smartlife/unlink', async (_req, res) => {
      try {
        persist({
          smartlifeSession: null,
          smartlifeDevices: [],
          deviceId: '',
          localKey: '',
          deviceName: ''
        })
        qrSession = null
        res.json({ ok: true, ...setupStatus(settings) })
      } catch (err) {
        res.status(500).json({ error: err.message || String(err) })
      }
    })

    write.post('/smartlife/refresh', async (_req, res) => {
      try {
        if (!settings.smartlifeSession) {
          return res.status(400).json({ error: 'Smart Life is not linked yet. Generate the QR first.' })
        }
        await refreshFromSession(settings.smartlifeSession)
        const chosen = pickDehumidifier(settings.smartlifeDevices || [])
        if (chosen && chosen.localKey && !settings.localKey) {
          await adoptFromStore(chosen.id)
        }
        res.json({ ok: true, ...setupStatus(settings) })
      } catch (err) {
        res.status(500).json({ error: err.message || String(err) })
      }
    })

    write.post('/adopt', async (req, res) => {
      try {
        const id = (req.body && (req.body.id || req.body.deviceId)) || ''
        await adoptFromStore(id)
        res.json({ ok: true, ...setupStatus(settings) })
      } catch (err) {
        res.status(400).json({ error: err.message || String(err) })
      }
    })

    write.post('/command', async (req, res) => {
      if (!runtime) return res.status(503).json({ error: 'Plugin is not running.' })
      try {
        const next = await runtime.command(req.body || {})
        res.json({ ...next, setup: setupStatus(settings) })
      } catch (err) {
        res.status(400).json({ error: err.message || String(err) })
      }
    })
  }

  plugin.getOpenApi = () => loadOpenApi()

  async function resolveIp(device) {
    const hinted = [device && device.ip, settings.ip].find(isLanIp)
    if (hinted) return hinted
    try {
      const found = await scanLan({ timeoutMs: 4000 })
      const byId = found.find((d) => d.id && d.id === device.id && isLanIp(d.ip))
      if (byId) return byId.ip
      const tcp = found.filter((d) => d.tcp && isLanIp(d.ip))
      if (tcp.length === 1) return tcp[0].ip
    } catch {
      // IP stays empty; tuyapi can still try UDP find
    }
    return ''
  }

  async function refreshFromSession(session) {
    let last = { ok: false, devices: [], error: 'Smart Life returned no devices.' }
    for (let i = 0; i < 5; i++) {
      last = await smartlife.listDevices(session)
      if (last.ok && last.devices && last.devices.length) {
        persist({ smartlifeSession: session, smartlifeDevices: last.devices })
        return last
      }
      await new Promise((resolve) => setTimeout(resolve, 2000))
    }
    persist({ smartlifeSession: session, smartlifeDevices: last.devices || [] })
    return last
  }

  function persist(partial) {
    const store = saveStore(partial)
    settings = mergeSettings(settings, store)
    return store
  }

  async function adoptFromStore(id, options = {}) {
    const store = loadStore()
    const device = findStoredDevice({ ...store, smartlifeDevices: settings.smartlifeDevices }, id)
    if (!device || !device.id) throw new Error('Choose a device from the AlecoAir list.')
    if (!device.localKey) throw new Error('AlecoAir did not return a local key for that device.')
    const ip = await resolveIp(device)
    persist({
      deviceId: device.id,
      localKey: device.localKey,
      ip,
      version: settings.version || D13.protocolDefault,
      deviceName: device.name || device.productName || device.id
    })
    if (typeof app.savePluginOptions === 'function') {
      const configuration = {
        deviceId: settings.deviceId,
        ip: settings.ip,
        version: settings.version,
        deviceName: settings.deviceName,
        pathPrefix: settings.pathPrefix,
        publishCabinHumidity: settings.publishCabinHumidity,
        cabinHumidityPath: settings.cabinHumidityPath,
        electricalPath: settings.electricalPath,
        pollSeconds: settings.pollSeconds
      }
      await new Promise((resolve, reject) => {
        app.savePluginOptions(configuration, (err) => err ? reject(err) : resolve())
      })
    }
    if (options.restart !== false && typeof restartPlugin === 'function') restartPlugin()
  }

  function start(options, restart) {
    restartPlugin = restart
    settings = mergeSettings(options || {}, loadStore())
    const pathPrefix = settings.pathPrefix || 'environment.inside.dehumidifier'
    runtime = new DeviceRuntime({
      deviceId: settings.deviceId,
      localKey: settings.localKey,
      ip: settings.ip,
      version: settings.version || D13.protocolDefault,
      pollIntervalMs: (Number(settings.pollSeconds) || 8) * 1000,
      dps: settings.dps,
      autoScan: !isLanIp(settings.ip)
    })

    app.handleMessage(plugin.id, { updates: [{ meta: metadata({ pathPrefix }) }] })

    const paths = skPaths(pathPrefix)
    const controls = availableControls(mergeDps(settings.dps || {}))
    const puts = {
      [paths.power]: (value) => ({ power: value }),
      [paths.mode]: (value) => ({ mode: value }),
      [paths.targetHumidity]: (value) => ({ targetHumidity: value }),
      [paths.childLock]: (value) => ({ childLock: value }),
      [paths.timerHours]: (value) => ({ timerHours: value }),
      [paths.sleep]: (value) => ({ sleep: value })
    }
    if (controls.fan) puts[paths.fan] = (value) => ({ fan: value })
    if (controls.insideDry) puts[paths.insideDry] = (value) => ({ insideDry: value })

    for (const [skPath, toCommand] of Object.entries(puts)) {
      app.registerPutHandler('vessels.self', skPath, (context, p, value, cb) => {
        runtime.command(toCommand(value)).then(() => {
          cb({ state: 'COMPLETED', statusCode: 200 })
        }).catch((err) => {
          cb({ state: 'COMPLETED', statusCode: 400, message: err.message })
        })
        return { state: 'PENDING' }
      })
    }

    onState = (state) => {
      const values = stateToValues(state, {
        pathPrefix,
        publishCabinHumidity: settings.publishCabinHumidity !== false,
        cabinHumidityPath: settings.cabinHumidityPath || 'environment.inside.humidity',
        electricalPath: settings.electricalPath || 'electrical.loads.alecoairD13.power'
      })
      app.handleMessage(plugin.id, {
        updates: [{ values: values.concat(notifications(state)) }]
      })
      const status = settings.deviceId
        ? (state.connected
          ? `${state.power ? 'ON' : 'OFF'} · ${state.humidity}% RH · ${state.powerWatts} W`
          : `disconnected${state.lastError ? ': ' + state.lastError : ''}`)
        : 'Link Smart Life in the WebApp'
      if (typeof app.setPluginStatus === 'function') app.setPluginStatus(status)
    }

    runtime.on('protocol', (version) => {
      if (version && version !== settings.version) persist({ version })
    })

    runtime.on('discovered', (device) => {
      if (!device || !device.ip || settings.ip) return
      const extra = { ip: device.ip }
      if (device.id && !settings.deviceId) extra.deviceId = device.id
      if (device.version && !settings.version) extra.version = device.version
      persist(extra)
    })

    runtime.on('state', onState)
    runtime.on('warn', (err) => {
      if (typeof app.debug === 'function') app.debug(err.message || String(err))
    })
    runtime.on('fault', (err) => {
      app.error(err.message || String(err))
      if (typeof app.setPluginError === 'function') app.setPluginError(err.message || String(err))
    })

    runtime.start().then(() => {
      app.debug(`ALECOAIR D13 started (${settings.deviceId ? 'Tuya LAN' : 'waiting for setup'})`)
    }).catch((err) => {
      app.error(err.message || String(err))
    })
  }

  function stop() {
    if (runtime && onState) runtime.off('state', onState)
    if (runtime) return runtime.stop()
    return Promise.resolve()
  }

  function schema() {
    return {
      type: 'object',
      properties: {
        deviceName: {
          type: 'string',
          title: 'Device name (set from the WebApp)'
        },
        deviceId: {
          type: 'string',
          title: 'Tuya device ID (set from the WebApp)'
        },
        ip: {
          type: 'string',
          title: 'LAN IP'
        },
        version: {
          type: 'string',
          title: 'Tuya protocol version',
          default: '3.5',
          enum: ['3.3', '3.4', '3.5']
        },
        pathPrefix: {
          type: 'string',
          title: 'Signal K path prefix',
          default: 'environment.inside.dehumidifier'
        },
        publishCabinHumidity: {
          type: 'boolean',
          title: 'Publish environment.inside.humidity',
          default: true
        },
        cabinHumidityPath: {
          type: 'string',
          title: 'Cabin humidity path',
          default: 'environment.inside.humidity'
        },
        electricalPath: {
          type: 'string',
          title: 'Electrical power path',
          default: 'electrical.loads.alecoairD13.power'
        },
        pollSeconds: {
          type: 'number',
          title: 'Poll interval (s)',
          default: 8
        }
      }
    }
  }

  function uiSchema() {
    return {
      deviceId: { 'ui:readonly': true }
    }
  }

  return plugin
}
