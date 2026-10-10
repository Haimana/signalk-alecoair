'use strict'

const fs = require('fs')
const path = require('path')
const { D13 } = require('./profile')
const { DeviceRuntime } = require('./runtime')
const { metadata, notifications, stateToValues, skPaths } = require('./mapper')

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
      if (!runtime) return res.status(503).json({ error: 'Pluginul nu este pornit.' })
      res.json(runtime.getPublicState())
    })

    read.get('/health', (_req, res) => {
      const state = runtime ? runtime.getPublicState() : { connected: false }
      res.json({
        ok: Boolean(runtime),
        simulate: settings.simulate !== false,
        model: D13.model,
        connected: Boolean(state.connected),
        lastError: state.lastError || null
      })
    })

    write.post('/command', async (req, res) => {
      if (!runtime) return res.status(503).json({ error: 'Pluginul nu este pornit.' })
      try {
        const next = await runtime.command(req.body || {})
        res.json(next)
      } catch (err) {
        res.status(400).json({ error: err.message || String(err) })
      }
    })

    write.post('/empty-tank', (_req, res) => {
      if (!runtime) return res.status(503).json({ error: 'Pluginul nu este pornit.' })
      res.json(runtime.emptyTank())
    })
  }

  plugin.getOpenApi = () => loadOpenApi()

  function start(options) {
    settings = options || {}
    const pathPrefix = settings.pathPrefix || 'environment.inside.dehumidifier'
    runtime = new DeviceRuntime({
      simulate: settings.simulate !== false,
      deviceId: settings.deviceId,
      localKey: settings.localKey,
      ip: settings.ip,
      version: settings.version || D13.protocolDefault,
      pollIntervalMs: (Number(settings.pollSeconds) || 5) * 1000,
      dps: settings.dps
    })

    app.handleMessage(plugin.id, { updates: [{ meta: metadata({ pathPrefix }) }] })

    const paths = skPaths(pathPrefix)
    const puts = {
      [paths.power]: (value) => ({ power: value }),
      [paths.mode]: (value) => ({ mode: value }),
      [paths.fan]: (value) => ({ fan: value }),
      [paths.targetHumidity]: (value) => ({ targetHumidity: value }),
      [paths.childLock]: (value) => ({ childLock: value }),
      [paths.timerHours]: (value) => ({ timerHours: value }),
      [paths.sleep]: (value) => ({ sleep: value }),
      [paths.insideDry]: (value) => ({ insideDry: value })
    }

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
      const status = state.connected
        ? `${state.power ? 'ON' : 'OFF'} · ${state.humidity}% RH · ${state.powerWatts} W`
        : `deconectat${state.lastError ? ': ' + state.lastError : ''}`
      if (typeof app.setPluginStatus === 'function') app.setPluginStatus(status)
    }

    runtime.on('state', onState)
    runtime.on('fault', (err) => {
      app.error(err.message || String(err))
      if (typeof app.setPluginError === 'function') app.setPluginError(err.message || String(err))
    })

    runtime.start().then(() => {
      app.debug(`ALECOAIR D13 pornit (${settings.simulate !== false ? 'simulator' : 'Tuya LAN'})`)
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
        simulate: {
          type: 'boolean',
          title: 'Mod simulator (fără aparat)',
          default: true
        },
        deviceId: {
          type: 'string',
          title: 'Tuya device ID'
        },
        localKey: {
          type: 'string',
          title: 'Tuya localKey'
        },
        ip: {
          type: 'string',
          title: 'IP LAN (opțional dacă scanarea UDP găsește aparatul)'
        },
        version: {
          type: 'string',
          title: 'Versiune protocol Tuya',
          default: '3.3',
          enum: ['3.3', '3.4', '3.5']
        },
        pathPrefix: {
          type: 'string',
          title: 'Prefix căi Signal K',
          default: 'environment.inside.dehumidifier'
        },
        publishCabinHumidity: {
          type: 'boolean',
          title: 'Publică environment.inside.humidity',
          default: true
        },
        cabinHumidityPath: {
          type: 'string',
          title: 'Cale umiditate cabină',
          default: 'environment.inside.humidity'
        },
        electricalPath: {
          type: 'string',
          title: 'Cale putere electrică',
          default: 'electrical.loads.alecoairD13.power'
        },
        pollSeconds: {
          type: 'number',
          title: 'Interval interogare (s)',
          default: 5
        }
      }
    }
  }

  function uiSchema() {
    return {
      localKey: { 'ui:widget': 'password' }
    }
  }

  return plugin
}
