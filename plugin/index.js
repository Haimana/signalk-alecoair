'use strict'

const fs = require('fs')
const path = require('path')
const { DeviceRuntime } = require('./runtime')
const { DiscoveryService } = require('./discovery')
const { ROLES, PROFILES, resolveProfile, suggestProfile, listProfiles } = require('./profiles')
const { createCodec, metadata, notifications, stateToValues, skPaths } = require('./mapper')
const { isLanIp } = require('./scan')
const alecoair = require('./alecoair')
const storeLib = require('./store')
const config = require('./config')

const { PLUGIN_ID, PROTOCOLS } = config
const OPENAPI = path.join(__dirname, '..', 'openapi.json')

function loadOpenApi() {
  try {
    return JSON.parse(fs.readFileSync(OPENAPI, 'utf8'))
  } catch {
    return { openapi: '3.0.0', info: { title: 'AlecoAir', version: '0.0.3' } }
  }
}

/** <configPath>/plugin-config-data, where Signal K keeps plugin options. */
function resolveDataRoot(app, override) {
  if (override) return override
  if (app && app.config && app.config.configPath) return path.join(app.config.configPath, 'plugin-config-data')
  if (app && typeof app.getDataDirPath === 'function') {
    try {
      return path.dirname(app.getDataDirPath())
    } catch {
      // fall through
    }
  }
  return storeLib.defaultDataRoot()
}

module.exports = function factory(app, injected = {}) {
  const deps = injected || {}
  let options = config.normalizeOptions({})
  let store = storeLib.emptyStore()
  let dataRoot = null
  let discovery = null
  let migration = null
  const devices = new Map()
  const putPaths = new Set()
  let running = false

  const plugin = {
    id: PLUGIN_ID,
    name: 'AlecoAir dehumidifiers',
    description: 'AlecoAir Wi-Fi dehumidifiers over Tuya LAN: several units, model profiles, no cloud or Node-RED in the control path. Setup lives here in Plugin Config; the WebApp is for operating the units.',
    start,
    stop,
    schema,
    uiSchema
  }

  function debug(msg) {
    if (typeof app.debug === 'function') app.debug(msg)
  }

  function persistStore() {
    try {
      store = storeLib.saveStore(store, dataRoot)
    } catch (err) {
      app.error(`AlecoAir: could not write the store: ${err.message}`)
    }
  }

  function savePluginOptions(next) {
    return new Promise((resolve, reject) => {
      if (typeof app.savePluginOptions !== 'function') return resolve()
      app.savePluginOptions(next, (err) => (err ? reject(err) : resolve()))
    })
  }

  function getEntry(key) {
    if (key) return devices.get(key) || null
    return devices.values().next().value || null
  }

  function deviceSummary(entry) {
    const s = entry.runtime.getPublicState()
    return {
      key: entry.cfg.key,
      name: entry.cfg.name,
      connected: s.connected,
      power: s.power,
      humidity: s.humidity,
      profile: s.profile,
      model: s.model,
      pathPrefix: entry.cfg.paths.prefix,
      lastError: s.lastError
    }
  }

  function withDevice(req, res) {
    const entry = getEntry(req.params && req.params.key)
    if (!entry) {
      res.status(404).json({ error: devices.size ? `Unknown device: ${req.params.key}` : 'No device is configured. Set it up in Signal K Admin → Plugin Config → AlecoAir.' })
      return null
    }
    return entry
  }

  plugin.registerWithRouter = function registerWithRouter(router) {
    const read = typeof router.access === 'function' ? router.access('readonly') : router
    const write = typeof router.access === 'function' ? router.access('readwrite') : router

    // ---- Usage API (WebApp, dashboards) ----
    read.get('/devices', (_req, res) => {
      res.json({ devices: [...devices.values()].map(deviceSummary) })
    })

    read.get('/devices/:key/state', (req, res) => {
      const entry = withDevice(req, res)
      if (entry) res.json({ ...entry.runtime.getPublicState(), name: entry.cfg.name })
    })

    write.post('/devices/:key/command', async (req, res) => {
      const entry = withDevice(req, res)
      if (!entry) return
      try {
        const next = await entry.runtime.command(req.body || {})
        res.json({ ...next, name: entry.cfg.name })
      } catch (err) {
        res.status(400).json({ error: err.message || String(err) })
      }
    })

    // Backwards-compatible aliases for the first device.
    read.get('/state', (req, res) => {
      const entry = getEntry()
      if (!entry) return res.status(503).json({ error: 'No device is configured.', devices: [] })
      res.json({ ...entry.runtime.getPublicState(), name: entry.cfg.name })
    })

    write.post('/command', async (req, res) => {
      const entry = getEntry()
      if (!entry) return res.status(503).json({ error: 'No device is configured.' })
      try {
        res.json(await entry.runtime.command(req.body || {}))
      } catch (err) {
        res.status(400).json({ error: err.message || String(err) })
      }
    })

    read.get('/health', (_req, res) => {
      res.json({
        ok: running,
        plugin: PLUGIN_ID,
        configured: options.devices.length,
        devices: [...devices.values()].map(deviceSummary)
      })
    })

    // ---- Setup API: admin only (registered without access(), so Signal K keeps its admin-only default) ----
    router.get('/setup/status', (_req, res) => {
      res.json(setupStatus())
    })

    router.get('/setup/profiles', (_req, res) => {
      res.json({ profiles: listProfiles(), roles: ROLES })
    })

    router.post('/setup/login', async (req, res) => {
      const body = req.body || {}
      const region = body.region || options.account.region || 'eu'
      try {
        const login = deps.login || alecoair.login
        const listed = await login({ ...body, region })
        if (!listed || !listed.ok) return res.status(400).json({ error: (listed && listed.error) || 'AlecoAir login failed.' })
        storeLib.setAccount(store, { source: 'alecoair', region, user: body.account || body.email || null, devices: listed.devices || [] })
        persistStore()
        res.json({ ok: true, ...setupStatus() })
      } catch (err) {
        res.status(500).json({ error: err.message || String(err) })
      }
    })

    router.post('/setup/unlink', (_req, res) => {
      storeLib.clearAccount(store, options.devices.map((d) => d.tuyaId).filter(Boolean))
      persistStore()
      res.json({ ok: true, ...setupStatus() })
    })

    router.post('/setup/discover', async (_req, res) => {
      try {
        await discovery.scan({ force: true })
        res.json({ ok: true, discovery: discovery.snapshot() })
      } catch (err) {
        res.status(500).json({ error: err.message || String(err) })
      }
    })

    router.get('/setup/devices/:key/dps', (req, res) => {
      const entry = devices.get(req.params.key)
      if (!entry) return res.status(404).json({ error: `Device ${req.params.key} is not running. Save the configuration first.` })
      const diag = entry.runtime.getDiagnostics()
      res.json({ ...diag, suggestion: suggestProfile(diag.rawDps) })
    })
  }

  plugin.getOpenApi = () => loadOpenApi()

  function setupStatus() {
    const configuredById = new Map(options.devices.filter((d) => d.tuyaId).map((d) => [d.tuyaId, d.key]))
    const configuredProfileById = new Map(options.devices.filter((d) => d.tuyaId && d.profile && d.profile !== 'auto').map((d) => [d.tuyaId, d.profile]))
    const account = store.account || {}
    return {
      pluginId: PLUGIN_ID,
      webappPath: `/${PLUGIN_ID}/`,
      storeFile: storeLib.storePath(dataRoot),
      migration,
      account: {
        linked: Boolean(account.linked),
        source: account.source || null,
        region: account.region || options.account.region,
        user: account.user || null,
        passwordStored: false,
        linkedAt: account.linkedAt || null,
        devices: (account.devices || []).map((d) => ({
          ...storeLib.publicCloudDevice(d),
          dehumidifier: storeLib.looksLikeDehumidifier(d),
          configuredKey: configuredById.get(d.id) || null,
          profileByProductId: (Object.values(PROFILES).find((p) => p.productIds.includes(d.productId)) || {}).id || null,
          configuredProfile: configuredProfileById.get(d.id) || null
        }))
      },
      discovery: discovery ? annotateDiscovery(discovery.snapshot()) : null,
      profiles: listProfiles(),
      roles: ROLES,
      protocols: PROTOCOLS,
      devices: options.devices.map((d) => {
        const entry = devices.get(d.key)
        const learned = (store.devices || {})[d.tuyaId] || {}
        const diag = entry ? entry.runtime.getDiagnostics() : null
        return {
          key: d.key,
          name: d.name,
          running: Boolean(entry),
          problems: d.problems || [],
          hasLocalKey: Boolean(storeLib.getLocalKey(store, d.tuyaId)),
          profile: entry ? { id: entry.resolution.profile.id, source: entry.resolution.source, requested: entry.resolution.requested } : null,
          suggestion: diag ? suggestProfile(diag.rawDps) : null,
          learned: {
            protocol: learned.protocol || null,
            lastIp: learned.lastIp || null,
            reportedDps: learned.reportedDps || []
          },
          state: entry ? entry.runtime.getPublicState() : null,
          diagnostics: diag
        }
      })
    }
  }

  /**
   * Tie LAN discovery rows to configured devices. A row matches by Tuya id
   * (UDP broadcast) or, for hosts seen only on TCP 6668, by the IP the device
   * is configured with, connected on, or last answered from. Known fields are
   * filled from the configured device and marked as such (`known`).
   */
  function annotateDiscovery(snap) {
    const known = options.devices.map((d) => {
      const entry = devices.get(d.key)
      const st = entry ? entry.runtime.getPublicState() : null
      const learned = (store.devices || {})[d.tuyaId] || {}
      const adopted = (st && st.adopted) || {}
      const ips = [d.ip, adopted.ip, learned.lastIp].filter(isLanIp)
      const protocol = adopted.protocol || learned.protocol || (d.protocol && d.protocol !== 'auto' ? d.protocol : null)
      return { key: d.key, tuyaId: d.tuyaId || null, ips, protocol }
    })
    return {
      ...snap,
      devices: (snap.devices || []).map((x) => {
        let match = x.id ? known.find((k) => k.tuyaId && k.tuyaId === x.id) : null
        let via = match ? 'id' : null
        if (!match) {
          match = known.find((k) => k.ips.includes(x.ip) && (!x.id || !k.tuyaId))
          via = match ? 'ip' : null
        }
        if (!match) return { ...x, configuredKey: null }
        return {
          ...x,
          configuredKey: match.key,
          matchedBy: via,
          knownId: x.id ? null : match.tuyaId,
          knownVersion: x.version ? null : match.protocol
        }
      })
    }
  }

  function publishMeta(entry) {
    const caps = entry.runtime.caps
    const sig = JSON.stringify(caps)
    if (sig === entry.metaSig) return
    entry.metaSig = sig
    const meta = metadata(caps, metaOptions(entry))
    app.handleMessage(plugin.id, { updates: [{ meta }] })
  }

  function metaOptions(entry) {
    return {
      pathPrefix: entry.cfg.paths.prefix,
      displayName: entry.cfg.name,
      humidityRange: entry.codec.humidity,
      nameplate: entry.codec.nameplate,
      simulate: entry.cfg.simulate
    }
  }

  const PUT_COMMANDS = {
    power: (v) => ({ power: v }),
    mode: (v) => ({ mode: v }),
    targetHumidity: (v) => ({ targetHumidity: v }),
    fan: (v) => ({ fan: v }),
    childLock: (v) => ({ childLock: v }),
    timerHours: (v) => ({ timerHours: v }),
    sleep: (v) => ({ sleep: v }),
    insideDry: (v) => ({ insideDry: v })
  }
  const PUT_CONTROL = { power: 'power', mode: 'mode', targetHumidity: 'targetHumidity', fan: 'fan', childLock: 'childLock', timerHours: 'timer', sleep: 'sleep', insideDry: 'insideDry' }

  function registerPuts(entry) {
    if (typeof app.registerPutHandler !== 'function') return
    const { controls } = entry.runtime.caps
    const paths = skPaths(entry.cfg.paths.prefix)
    for (const [name, toCommand] of Object.entries(PUT_COMMANDS)) {
      if (!controls[PUT_CONTROL[name]]) continue
      const skPath = paths[name]
      if (putPaths.has(skPath)) continue
      putPaths.add(skPath)
      const key = entry.cfg.key
      app.registerPutHandler('vessels.self', skPath, (_context, _p, value, cb) => {
        const current = devices.get(key)
        if (!current) {
          return { state: 'COMPLETED', statusCode: 503, message: 'Device is not running.' }
        }
        current.runtime.command(toCommand(value)).then(() => {
          cb({ state: 'COMPLETED', statusCode: 200 })
        }).catch((err) => {
          cb({ state: 'COMPLETED', statusCode: 400, message: err.message })
        })
        return { state: 'PENDING' }
      })
    }
  }

  function updateStatus() {
    if (typeof app.setPluginStatus !== 'function') return
    if (!options.devices.length) {
      app.setPluginStatus('No device yet: sign in to AlecoAir and add one in this plugin\'s configuration.')
      return
    }
    const parts = options.devices.map((d) => {
      const entry = devices.get(d.key)
      if (!entry) return `${d.key}: ${d.problems && d.problems.length ? d.problems.join(', ') : 'disabled'}`
      const s = entry.runtime.getPublicState()
      if (!s.connected) return `${d.key}: disconnected${s.lastError ? ` (${s.lastError})` : ''}`
      const rh = s.humidity === null ? '' : ` · ${s.humidity}% RH`
      const w = s.powerWatts === null ? '' : ` · ${s.powerWatts} W`
      return `${d.key}: ${s.power ? 'ON' : 'OFF'}${rh}${w}`
    })
    app.setPluginStatus(parts.join(' | '))
  }

  function startDevice(cfg, noIpCount) {
    const resolution = resolveProfile(cfg)
    const codec = createCodec(resolution.profile, cfg.dpOverrides, cfg.model)
    const learned = (store.devices || {})[cfg.tuyaId] || {}
    const Runtime = deps.DeviceRuntime || DeviceRuntime
    const runtime = new Runtime({
      key: cfg.key,
      tuyaId: cfg.tuyaId,
      localKey: storeLib.getLocalKey(store, cfg.tuyaId),
      ip: cfg.ip,
      protocol: cfg.protocol,
      protocolHint: cfg.protocol === 'auto' ? learned.protocol : null,
      codec,
      reportedDps: learned.reportedDps || [],
      pollIntervalMs: cfg.pollSeconds * 1000,
      simulate: cfg.simulate
    }, {
      TuyaLanDevice: deps.TuyaLanDevice,
      TuyAPI: deps.TuyAPI,
      resolveIp: (tuyaId) => discovery.resolveIp(tuyaId, { allowSingleTcp: noIpCount === 1 })
    })
    const entry = { cfg, runtime, codec, resolution, metaSig: null }
    devices.set(cfg.key, entry)

    runtime.on('protocol', (version) => {
      if (cfg.protocol === 'auto' && version && version !== learned.protocol) {
        learned.protocol = version
        storeLib.updateDevice(store, cfg.tuyaId, { protocol: version })
        persistStore()
      }
    })
    runtime.on('ip', (ip) => {
      if (isLanIp(ip)) {
        storeLib.updateDevice(store, cfg.tuyaId, { lastIp: ip })
        persistStore()
      }
    })
    runtime.on('capabilities', ({ reportedDps }) => {
      if (!cfg.simulate) {
        storeLib.updateDevice(store, cfg.tuyaId, { reportedDps })
        persistStore()
      }
      publishMeta(entry)
      registerPuts(entry)
    })
    runtime.on('state', () => {
      if (devices.get(cfg.key) !== entry) return
      const caps = runtime.caps
      const values = stateToValues(runtime.state, caps, {
        pathPrefix: cfg.paths.prefix,
        publishCabinHumidity: cfg.paths.publishCabinHumidity,
        cabinHumidityPath: cfg.paths.cabinHumidity,
        electricalPath: cfg.paths.electrical,
        simulate: cfg.simulate
      })
      const notes = notifications(runtime.state, caps, metaOptions(entry))
      app.handleMessage(plugin.id, { updates: [{ values: values.concat(notes) }] })
      updateStatus()
    })
    runtime.on('warn', (err) => debug(`${cfg.key}: ${err.message || String(err)}`))
    runtime.on('fault', (err) => {
      app.error(`${cfg.key}: ${err.message || String(err)}`)
    })

    publishMeta(entry)
    registerPuts(entry)
    runtime.start().then(() => {
      debug(`${cfg.key} started (${cfg.simulate ? 'simulator' : 'Tuya LAN'}, profile ${codec.profile.id})`)
    }).catch((err) => app.error(`${cfg.key}: ${err.message || String(err)}`))
  }

  /**
   * Turn whatever Signal K hands us into v2 options:
   * - v2 options are used as is;
   * - flat signalk-alecoair-d13 options (e.g. a copied config file) are migrated;
   * - empty options fall back to the old plugin's config file and store.
   * The migrated options are saved without restarting the plugin.
   */
  async function prepareOptions(raw, legacyStoreRaw) {
    const given = raw && typeof raw === 'object' ? raw : {}
    if (Array.isArray(given.devices)) return { options: given, migrated: null }
    const fromOptions = config.isLegacyOptions(given)
    const legacyOptions = fromOptions ? given : config.readLegacyPluginConfig(dataRoot)
    if (!legacyOptions && !(legacyStoreRaw && legacyStoreRaw.deviceId)) {
      return { options: { ...config.normalizeOptions({}), ...given, devices: [] }, migrated: null }
    }
    const next = config.migrateLegacyOptions(legacyOptions || {}, legacyStoreRaw || {})
    const source = fromOptions ? 'flat options' : (legacyOptions ? `${config.LEGACY_PLUGIN_ID}.json` : `${storeLib.LEGACY_STORE_NAME}`)
    try {
      await savePluginOptions(config.serializeOptions(config.normalizeOptions(next)))
    } catch (err) {
      app.error(`AlecoAir: could not save migrated options: ${err.message}`)
    }
    return { options: next, migrated: { from: source, at: Date.now(), devices: next.devices.map((d) => d.key) } }
  }

  function start(rawOptions) {
    plugin.ready = startAsync(rawOptions).catch((err) => {
      app.error(`AlecoAir failed to start: ${err.message || String(err)}`)
      if (typeof app.setPluginError === 'function') app.setPluginError(err.message || String(err))
    })
    return plugin.ready
  }

  async function startAsync(rawOptions) {
    running = true
    dataRoot = resolveDataRoot(app, deps.dataRoot)
    const loaded = storeLib.loadStore(dataRoot)
    store = loaded.store
    if (loaded.migrated) {
      persistStore()
      debug(`Migrated ${storeLib.LEGACY_STORE_NAME} to ${storeLib.STORE_NAME}`)
    }
    const prepared = await prepareOptions(rawOptions, loaded.legacyRaw)
    if (!running) return
    migration = prepared.migrated || (loaded.migrated ? { from: storeLib.LEGACY_STORE_NAME, at: Date.now(), devices: [] } : null)
    options = config.normalizeOptions(prepared.options)
    discovery = deps.discovery || new DiscoveryService({ subnets: options.discovery.subnets, scan: deps.scan })

    const active = options.devices.filter((d) => d.enabled && !d.problems.length)
    const noIpCount = active.filter((d) => !d.ip && !d.simulate).length
    for (const cfg of active) startDevice(cfg, noIpCount)
    updateStatus()
  }

  async function stop() {
    running = false
    const all = [...devices.values()]
    devices.clear()
    putPaths.clear()
    await Promise.all(all.map((e) => e.runtime.stop()))
  }

  function schema() {
    const profileIds = ['auto', ...Object.keys(PROFILES)]
    const roleProps = {}
    for (const role of ROLES) roleProps[role] = { type: ['integer', 'null'], title: role }
    return {
      type: 'object',
      description: 'Use the AlecoAir setup panel above. This schema is the fallback form for Signal K servers without plugin configurators.',
      properties: {
        configVersion: { type: 'number', title: 'Config version', default: 2 },
        account: {
          type: 'object',
          title: 'AlecoAir account',
          properties: {
            region: { type: 'string', title: 'Tuya region', enum: ['eu', 'us', 'cn', 'in'], default: 'eu' }
          }
        },
        discovery: {
          type: 'object',
          title: 'LAN discovery',
          properties: {
            subnets: { type: 'array', title: 'Subnets to sweep on TCP 6668 (empty = local /24s)', items: { type: 'string' } }
          }
        },
        devices: {
          type: 'array',
          title: 'Dehumidifiers',
          items: {
            type: 'object',
            required: ['key'],
            properties: {
              key: { type: 'string', title: 'Key (a-z, 0-9, _; used in paths and the API)' },
              enabled: { type: 'boolean', title: 'Enabled', default: true },
              name: { type: 'string', title: 'Name' },
              tuyaId: { type: 'string', title: 'Tuya device id' },
              productId: { type: 'string', title: 'Tuya product id (from the AlecoAir login)' },
              ip: { type: 'string', title: 'LAN IP (empty = discover)' },
              protocol: { type: 'string', title: 'Tuya protocol', enum: PROTOCOLS, default: 'auto' },
              profile: { type: 'string', title: 'Model profile', enum: profileIds, default: 'auto' },
              model: { type: 'string', title: 'Model (nameplate for the power estimate, e.g. D13)' },
              pollSeconds: { type: 'number', title: 'Poll interval (s)', default: 8 },
              simulate: { type: 'boolean', title: 'Simulator (no hardware)', default: false },
              dpOverrides: { type: 'object', title: 'DP overrides (role → DP id, null removes)', properties: roleProps },
              paths: {
                type: 'object',
                title: 'Signal K paths',
                properties: {
                  prefix: { type: 'string', title: 'Path prefix' },
                  electrical: { type: 'string', title: 'Estimated power path (empty = off)' },
                  publishCabinHumidity: { type: 'boolean', title: 'Also publish cabin humidity', default: false },
                  cabinHumidity: { type: 'string', title: 'Cabin humidity path' }
                }
              }
            }
          }
        }
      }
    }
  }

  function uiSchema() {
    return {
      configVersion: { 'ui:widget': 'hidden' }
    }
  }

  return plugin
}

module.exports.resolveDataRoot = resolveDataRoot
