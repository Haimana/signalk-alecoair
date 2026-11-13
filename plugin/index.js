'use strict'

const fs = require('fs')
const path = require('path')
const { DeviceRuntime } = require('./runtime')
const { DiscoveryService } = require('./discovery')
const { ROLES, PROFILES, resolveProfile, suggestProfile, listProfiles, profileForProductId } = require('./profiles')
const { buildDeviceReport, assertSanitized } = require('./report')
const pkg = require('../package.json')
const { createCodec, metadata, notifications, stateToValues, skPaths } = require('./mapper')
const { isLanIp } = require('./scan')
const alecoair = require('./alecoair')
const storeLib = require('./store')
const config = require('./config')
const { ExternalController, controlStrategy, toPercent, toCelsius } = require('./control')

const { PLUGIN_ID, PROTOCOLS } = config
const OPENAPI = path.join(__dirname, '..', 'openapi.json')
const CONTROL_TICK_MS = 5000
const TEST_SENSOR_FILE = 'signalk-alecoair.test-sensor.json'
const TEST_SENSOR_SOURCE = 'signalk-alecoair-test'
const EXTERNAL_MODE = 'external'
const EXTERNAL_LABEL = 'Auto / external sensor'
const TEST_PATH_RE = /^environment\.inside\.test\.[A-Za-z0-9_.]+$/

function loadOpenApi() {
  try {
    return JSON.parse(fs.readFileSync(OPENAPI, 'utf8'))
  } catch {
    return { openapi: '3.0.0', info: { title: 'AlecoAir', version: pkg.version } }
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
  let storeLoaded = false
  let discovery = null
  let migration = null
  const devices = new Map()
  const putPaths = new Set()
  const sensorSeen = new Map()
  let testSensorTimer = null
  let running = false

  const plugin = {
    id: PLUGIN_ID,
    name: 'AlecoAir dehumidifiers',
    description: 'AlecoAir Wi-Fi dehumidifiers over Tuya LAN: several units, model profiles, Node.js only, no cloud or Node-RED in the control path. Setup lives here in Plugin Config; the WebApp is for operating the units. Signal K paths follow each unit\'s Key.',
    start,
    stop,
    schema,
    uiSchema
  }

  function debug(msg) {
    if (typeof app.debug === 'function') app.debug(msg)
  }

  /**
   * Signal K Admin calls the setup routes even when the plugin is disabled or
   * unconfigured, i.e. before start() has run. Resolve the data root lazily
   * (same rule as start) so those routes never see a null path.
   */
  function ensureDataRoot() {
    if (!dataRoot) dataRoot = resolveDataRoot(app, deps.dataRoot)
    return dataRoot
  }

  /**
   * Before start(), read whatever store is already on disk (read-only: no
   * migration is written, no file is created) so the Admin panel and a
   * sign-in do not work on, or overwrite, an empty in-memory copy.
   */
  function ensureStore() {
    ensureDataRoot()
    if (storeLoaded) return store
    try {
      store = storeLib.loadStore(dataRoot).store
    } catch (err) {
      app.error(`AlecoAir: could not read the store: ${err.message}`)
    }
    storeLoaded = true
    return store
  }

  function persistStore() {
    ensureStore()
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

  /**
   * Runtime state plus the name and the external-control status. When
   * external control is allowed for the unit, "Auto / external sensor" is one
   * more working mode; while it is on, `mode` is `external` (the unit itself
   * is in its continuous mode, kept in `unitMode`).
   */
  function publicDeviceState(entry) {
    const s = entry.runtime.getPublicState()
    const control = controlState(entry, s)
    const out = { ...s, name: entry.cfg.name, control, unitMode: s.mode }
    if (control.configured && control.available && s.controls && s.controls.mode) {
      const modes = (s.modes || []).slice()
      modes.splice(Math.min(1, modes.length), 0, { value: EXTERNAL_MODE, label: EXTERNAL_LABEL })
      out.modes = modes
      if (control.mode === 'external') out.mode = EXTERNAL_MODE
    }
    return out
  }

  /**
   * Every unit command goes through here (REST, WebApp, Signal K PUT).
   * mode `external` switches external control on; any other mode while it is
   * on leaves it and sets that mode (with the remembered target, power on).
   */
  async function deviceCommand(entry, body) {
    const cmd = { ...(body || {}) }
    const ext = entry.cfg.externalControl || {}
    const ctl = ext.enabled ? entry.control : null
    if (cmd.mode === EXTERNAL_MODE) {
      delete cmd.mode
      await setControl(entry, { mode: 'external' })
    } else if (ctl && cmd.mode !== undefined && ctl.mode === 'external') {
      for (let i = 0; i < 50 && entry.controlBusy; i++) await new Promise((r) => setTimeout(r, 100))
      const unit = entry.runtime.getPublicState()
      const leave = ctl.leaveTo(unit, String(cmd.mode))
      delete cmd.mode
      controlLog(entry, { request: { mode: leave.mode } })
      if (ctl.takeDirty()) saveControl(entry)
      const ok = await sendControlCommands(entry, [leave], `mode ${leave.mode} picked`)
      publishControl(entry)
      if (!ok) throw new Error(`Could not set ${leave.mode} on the unit; see the plugin log.`)
    }
    if (Object.keys(cmd).length) await entry.runtime.command(cmd)
    return publicDeviceState(entry)
  }

  function controlState(entry, unitState) {
    const ext = entry.cfg.externalControl || {}
    if (!ext.enabled || !entry.control) return { configured: false, available: false, mode: 'internal' }
    return {
      configured: true,
      ...entry.control.publicStatus(unitState || entry.runtime.getPublicState()),
      humidityPath: ext.humidityPath || null,
      temperaturePath: ext.temperaturePath || null,
      minTemperature: ext.minTemperature,
      onSensorLoss: ext.onSensorLoss,
      log: (entry.controlLog || []).slice(-20)
    }
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
      if (entry) res.json(publicDeviceState(entry))
    })

    write.post('/devices/:key/command', async (req, res) => {
      const entry = withDevice(req, res)
      if (!entry) return
      try {
        res.json(await deviceCommand(entry, req.body || {}))
      } catch (err) {
        res.status(400).json({ error: err.message || String(err) })
      }
    })

    write.post('/devices/:key/control', async (req, res) => {
      const entry = withDevice(req, res)
      if (!entry) return
      try {
        await setControl(entry, req.body || {})
        res.json(publicDeviceState(entry))
      } catch (err) {
        res.status(400).json({ error: err.message || String(err) })
      }
    })

    // Backwards-compatible aliases for the first device.
    read.get('/state', (req, res) => {
      const entry = getEntry()
      if (!entry) return res.status(503).json({ error: 'No device is configured.', devices: [] })
      res.json(publicDeviceState(entry))
    })

    write.post('/command', async (req, res) => {
      const entry = getEntry()
      if (!entry) return res.status(503).json({ error: 'No device is configured.' })
      try {
        res.json(await deviceCommand(entry, req.body || {}))
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

    router.get('/setup/paths', (_req, res) => {
      res.json(sensorPaths())
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
        ensureStore()
        storeLib.setAccount(store, { source: 'alecoair', region, user: body.account || body.email || null, devices: listed.devices || [] })
        persistStore()
        res.json({ ok: true, ...setupStatus() })
      } catch (err) {
        res.status(500).json({ error: err.message || String(err) })
      }
    })

    router.post('/setup/unlink', (_req, res) => {
      ensureStore()
      storeLib.clearAccount(store, options.devices.map((d) => d.tuyaId).filter(Boolean))
      persistStore()
      res.json({ ok: true, ...setupStatus() })
    })

    router.post('/setup/discover', async (_req, res) => {
      if (!discovery) return res.status(409).json({ error: 'The plugin is not running yet. Save the configuration to enable it, then scan.' })
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

    router.get('/setup/devices/:key/report', (req, res) => {
      const cfg = options.devices.find((d) => d.key === req.params.key)
      if (!cfg) return res.status(404).json({ error: `Device ${req.params.key} is not in the configuration.` })
      ensureStore()
      const entry = devices.get(req.params.key)
      const diag = entry ? entry.runtime.getDiagnostics() : {}
      const resolution = entry ? entry.resolution : resolveProfile(cfg)
      const report = buildDeviceReport({
        device: cfg,
        profile: resolution.profile,
        source: resolution.source,
        suggestion: suggestProfile(diag.rawDps || {}),
        rawDps: diag.rawDps,
        reportedDps: diag.reportedDps,
        map: diag.map,
        protocol: diag.protocol || null,
        connected: diag.connected,
        lastError: diag.lastError,
        pluginVersion: pkg.version,
        signalkVersion: (app.config && app.config.version) || 'unknown',
        nodeVersion: process.version
      })
      const forbidden = [
        cfg.tuyaId,
        cfg.ip,
        cfg.paths && cfg.paths.prefix,
        cfg.paths && cfg.paths.electrical,
        storeLib.getLocalKey(store, cfg.tuyaId),
        store && store.account && store.account.user,
        diag.ip
      ]
      try {
        assertSanitized(report, forbidden)
      } catch {
        return res.status(500).json({ error: 'The report could not be built without leaking a secret. Nothing was sent.' })
      }
      res.json(report)
    })
  }

  plugin.getOpenApi = () => loadOpenApi()

  function setupStatus() {
    ensureStore()
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
          profileByProductId: (profileForProductId(d.productId) || {}).id || null,
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
          control: entry ? controlState(entry) : null,
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

  // ---------- External-sensor control ----------

  /**
   * Latest value of a self path from any source except this plugin (so a
   * unit's own humidity, published as cabin humidity, never feeds back).
   * `at` is the Signal K timestamp; without one, the time the value last changed.
   */
  function readSensor(skPath) {
    if (!skPath || typeof app.getSelfPath !== 'function') return null
    let node
    try {
      node = app.getSelfPath(skPath)
    } catch {
      return null
    }
    if (!node || typeof node !== 'object') return null
    const cands = []
    if (node.values && typeof node.values === 'object') {
      for (const [source, v] of Object.entries(node.values)) {
        if (v && typeof v === 'object') cands.push({ source, value: v.value, timestamp: v.timestamp })
      }
    }
    if (!cands.length) cands.push({ source: node.$source, value: node.value, timestamp: node.timestamp })
    const ok = cands.filter((c) => c.source !== plugin.id && typeof c.value === 'number' && Number.isFinite(c.value))
    if (!ok.length) return null
    const ts = (c) => { const t = Date.parse(c.timestamp); return Number.isFinite(t) ? t : 0 }
    ok.sort((a, b) => ts(b) - ts(a))
    const best = ok[0]
    let at = ts(best)
    if (!at) {
      const key = `${skPath}|${best.source}`
      const seen = sensorSeen.get(key)
      if (!seen || seen.value !== best.value) sensorSeen.set(key, { value: best.value, at: Date.now() })
      at = sensorSeen.get(key).at
    }
    return { value: best.value, at, source: best.source || null }
  }

  /** Humidity and temperature paths for the Admin picklists (this plugin's own unit paths left out). */
  function sensorPaths() {
    let all = []
    try {
      if (app.streambundle && typeof app.streambundle.getAvailablePaths === 'function') all = app.streambundle.getAvailablePaths() || []
    } catch {
      all = []
    }
    const own = options.devices.map((d) => d.paths.prefix)
    const rows = [...new Set(all.map(String))].filter((p) => !own.some((pre) => p === pre || p.startsWith(`${pre}.`))).sort()
    const describe = (p) => {
      const r = readSensor(p)
      return { path: p, value: r ? r.value : null, source: r ? r.source : null }
    }
    return {
      humidity: rows.filter((p) => /humidity/i.test(p)).map(describe),
      temperature: rows.filter((p) => /^environment\..*temperature$/i.test(p)).map(describe)
    }
  }

  function controlLog(entry, item) {
    entry.controlLog = entry.controlLog || []
    entry.controlLog.push({ at: new Date().toISOString(), ...item })
    if (entry.controlLog.length > 40) entry.controlLog.splice(0, entry.controlLog.length - 40)
  }

  function saveControl(entry) {
    ensureStore()
    store.control = { ...(store.control || {}), [entry.cfg.key]: entry.control.persisted() }
    persistStore()
  }

  function readings(entry) {
    const ext = entry.cfg.externalControl
    const h = ext.humidityPath ? readSensor(ext.humidityPath) : null
    const humidity = h ? { path: ext.humidityPath, value: toPercent(h.value), at: h.at } : null
    let temperature = null
    if (ext.temperaturePath) {
      const r = readSensor(ext.temperaturePath)
      temperature = r ? { path: ext.temperaturePath, value: toCelsius(r.value), at: r.at } : null
    }
    return { humidity, temperature }
  }

  async function sendControlCommands(entry, commands, why) {
    for (const cmd of commands) {
      try {
        await entry.runtime.command(cmd)
        controlLog(entry, { command: cmd, why, ok: true })
        debug(`${entry.cfg.key}: external control sent ${JSON.stringify(cmd)} (${why})`)
      } catch (err) {
        controlLog(entry, { command: cmd, why, ok: false, error: err.message || String(err) })
        app.error(`${entry.cfg.key}: external control could not send ${JSON.stringify(cmd)}: ${err.message || String(err)}`)
        if (entry.control) entry.control.commandFailed(Date.now())
        return false
      }
    }
    return true
  }

  async function runControl(entry) {
    if (!entry.control || entry.controlBusy || devices.get(entry.cfg.key) !== entry) return
    entry.controlBusy = true
    try {
      const ctl = entry.control
      const unit = entry.runtime.getPublicState()
      const before = ctl.status.state
      const { commands, status } = ctl.tick(Date.now(), unit, readings(entry))
      if (commands.length) await sendControlCommands(entry, commands, status.state)
      else if (status.state !== before) controlLog(entry, { state: status.state, reason: status.reason })
      if (ctl.takeDirty()) saveControl(entry)
      publishControl(entry)
    } catch (err) {
      app.error(`${entry.cfg.key}: external control: ${err.message || String(err)}`)
    } finally {
      entry.controlBusy = false
    }
  }

  async function setControl(entry, body) {
    const ext = entry.cfg.externalControl || {}
    if (!ext.enabled || !entry.control) {
      throw new Error('External control is not set up for this unit. Enable it in Signal K Admin → Plugin Config → AlecoAir → External control.')
    }
    if (!ext.humidityPath && (body.mode === 'external' || body.enabled === true)) {
      throw new Error('No external humidity path is configured for this unit.')
    }
    const unit = entry.runtime.getPublicState()
    const mode = body.mode !== undefined ? String(body.mode) : (body.enabled !== undefined ? (body.enabled ? 'external' : 'internal') : undefined)
    if (mode !== undefined && mode !== 'external' && mode !== 'internal') throw new Error('mode must be internal or external.')
    if (mode === 'external') {
      const strat = controlStrategy(unit)
      if (unit.connected && !strat.strategy) throw new Error(strat.reason)
    }
    // Wait for a running tick so the two never send at the same time.
    for (let i = 0; i < 50 && entry.controlBusy; i++) await new Promise((r) => setTimeout(r, 100))
    if (body.target !== undefined) entry.control.setTarget(body.target, unit)
    if (mode === 'external') entry.control.enable(unit)
    else if (mode === 'internal') entry.control.disable()
    controlLog(entry, { request: { mode, target: body.target } })
    if (entry.control.takeDirty()) saveControl(entry)
    await runControl(entry)
  }

  function controlPaths(prefix) {
    const root = `${prefix}.control`
    return {
      mode: `${root}.mode`,
      target: `${root}.target`,
      state: `${root}.state`,
      reason: `${root}.reason`,
      sourceHumidity: `${root}.sourceHumidity`,
      sourceTemperature: `${root}.sourceTemperature`
    }
  }

  function publishControl(entry) {
    if (!entry.cfg.externalControl.enabled || !entry.control) return
    const st = entry.control.publicStatus(entry.runtime.getPublicState())
    const p = controlPaths(entry.cfg.paths.prefix)
    const values = [
      { path: p.mode, value: st.mode },
      { path: p.target, value: st.target === null ? null : Number((st.target / 100).toFixed(4)) },
      { path: p.state, value: st.state },
      { path: p.reason, value: st.reason },
      { path: p.sourceHumidity, value: st.sourceHumidity === null ? null : Number((st.sourceHumidity / 100).toFixed(4)) }
    ]
    if (entry.cfg.externalControl.temperaturePath) {
      values.push({ path: p.sourceTemperature, value: st.sourceTemperature === null ? null : Number((st.sourceTemperature + 273.15).toFixed(2)) })
    }
    const sig = JSON.stringify(values)
    const now = Date.now()
    if (sig === entry.controlSig && now - (entry.controlSigAt || 0) < 60000) return
    entry.controlSig = sig
    entry.controlSigAt = now
    app.handleMessage(plugin.id, { updates: [{ values }] })
    updateStatus()
  }

  function publishControlMeta(entry) {
    const p = controlPaths(entry.cfg.paths.prefix)
    const name = entry.cfg.name
    const meta = [
      { path: p.mode, value: { description: `${name}: internal (unit hygrostat) | external (external humidity sensor)`, displayName: 'Control mode', type: 'multiple', possibleValues: [{ title: 'Unit hygrostat', value: 'internal' }, { title: 'External sensor', value: 'external' }] } },
      { path: p.target, value: { units: 'ratio', description: `${name}: target for the external humidity`, displayName: 'External target' } },
      { path: p.state, value: { description: `${name}: external control state`, displayName: 'Control state' } },
      { path: p.reason, value: { description: `${name}: why the external control is in this state`, displayName: 'Control reason' } },
      { path: p.sourceHumidity, value: { units: 'ratio', description: `${name}: external humidity used for control`, displayName: 'External humidity' } }
    ]
    if (entry.cfg.externalControl.temperaturePath) {
      meta.push({ path: p.sourceTemperature, value: { units: 'K', description: `${name}: external temperature used for control`, displayName: 'External temperature' } })
    }
    app.handleMessage(plugin.id, { updates: [{ meta }] })
  }

  function registerControlPuts(entry) {
    if (typeof app.registerPutHandler !== 'function') return
    const p = controlPaths(entry.cfg.paths.prefix)
    const key = entry.cfg.key
    const handlers = { [p.mode]: (v) => ({ mode: v }), [p.target]: (v) => ({ target: v }) }
    for (const [skPath, toBody] of Object.entries(handlers)) {
      if (putPaths.has(skPath)) continue
      putPaths.add(skPath)
      app.registerPutHandler('vessels.self', skPath, (_context, _p, value, cb) => {
        const current = devices.get(key)
        if (!current) return { state: 'COMPLETED', statusCode: 503, message: 'Device is not running.' }
        setControl(current, toBody(value)).then(() => cb({ state: 'COMPLETED', statusCode: 200 }))
          .catch((err) => cb({ state: 'COMPLETED', statusCode: 400, message: err.message }))
        return { state: 'PENDING' }
      })
    }
  }

  function startControl(entry) {
    const ext = entry.cfg.externalControl
    const persisted = (store.control || {})[entry.cfg.key] || null
    const leftover = persisted && (persisted.mode === 'external' || persisted.saved)
    if (!ext.enabled && !leftover) return
    entry.control = new ExternalController(ext, persisted || {})
    // External control switched off in Admin while it was on: give the unit its hygrostat back once.
    if (!ext.enabled) entry.control.disable()
    if (ext.enabled) {
      publishControlMeta(entry)
      registerControlPuts(entry)
    }
    entry.controlTimer = setInterval(() => { runControl(entry) }, CONTROL_TICK_MS)
    if (entry.controlTimer.unref) entry.controlTimer.unref()
  }

  async function stopControl(entry) {
    if (entry.controlTimer) clearInterval(entry.controlTimer)
    entry.controlTimer = null
    if (!entry.control) return
    for (let i = 0; i < 30 && entry.controlBusy; i++) await new Promise((r) => setTimeout(r, 100))
    const commands = entry.control.stopCommands(entry.runtime.getPublicState())
    if (!commands.length) return
    const timeout = new Promise((r) => { const t = setTimeout(r, 4000); if (t.unref) t.unref() })
    await Promise.race([sendControlCommands(entry, commands, 'plugin stop'), timeout])
  }

  /**
   * Test hook for a simulated external sensor: while
   * <configPath>/plugin-config-data/signalk-alecoair.test-sensor.json exists,
   * its numeric values for environment.inside.test.* paths are published
   * every 2 s (source signalk-alecoair-test). Delete the file to stop; the
   * values then go stale like a dead sensor.
   */
  function startTestSensor() {
    const file = path.join(ensureDataRoot(), TEST_SENSOR_FILE)
    testSensorTimer = setInterval(() => {
      let raw
      try {
        raw = JSON.parse(fs.readFileSync(file, 'utf8'))
      } catch {
        return
      }
      const values = Object.entries(raw || {})
        .filter(([p, v]) => TEST_PATH_RE.test(p) && typeof v === 'number' && Number.isFinite(v))
        .map(([p, v]) => ({ path: p, value: v }))
      if (values.length) app.handleMessage(TEST_SENSOR_SOURCE, { updates: [{ $source: TEST_SENSOR_SOURCE, timestamp: new Date().toISOString(), values }] })
    }, 2000)
    if (testSensorTimer.unref) testSensorTimer.unref()
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
        deviceCommand(current, toCommand(value)).then(() => {
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
      let ext = ''
      if (entry.control && d.externalControl.enabled && entry.control.mode === 'external') {
        const st = entry.control.publicStatus(s)
        ext = ` · external ${st.state}${st.sourceHumidity === null ? '' : ` ${st.sourceHumidity}%`}→${st.target}%`
      }
      return `${d.key}: ${s.power ? 'ON' : 'OFF'}${rh}${w}${ext}`
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
    startControl(entry)
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
    storeLoaded = true
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
    startTestSensor()
    updateStatus()
  }

  async function stop() {
    running = false
    if (testSensorTimer) clearInterval(testSensorTimer)
    testSensorTimer = null
    const all = [...devices.values()]
    await Promise.all(all.map((e) => stopControl(e).catch(() => {})))
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
              },
              externalControl: {
                type: 'object',
                title: 'External control (humidity from another Signal K sensor)',
                properties: {
                  enabled: { type: 'boolean', title: 'Allow external control (switch it on in the WebApp)', default: false },
                  humidityPath: { type: 'string', title: 'Humidity path (one sensor; ratio 0–1 or %). Several units may share it.' },
                  temperaturePath: { type: 'string', title: 'Temperature path (optional, K)' },
                  minTemperature: { type: 'number', title: 'Do not start below (°C)', default: 5 },
                  hysteresisOn: { type: 'number', title: 'On at target + (% RH)', default: 3 },
                  hysteresisOff: { type: 'number', title: 'Off at target − (% RH)', default: 2 },
                  minOnMinutes: { type: 'number', title: 'Minimum on time (min)', default: 10 },
                  minOffMinutes: { type: 'number', title: 'Minimum off time (min)', default: 10 },
                  staleMinutes: { type: 'number', title: 'Sensor counts as lost after (min)', default: 5 },
                  onSensorLoss: { type: 'string', title: 'When the sensor is lost', enum: ['internal', 'off'], default: 'internal' }
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
