'use strict'

const { EventEmitter } = require('events')
const { PROFILES } = require('./profiles')
const { MODE } = require('./util')
const {
  createCodec,
  emptyState,
  capabilities,
  applyDps,
  commandToDps,
  applyCommandToState,
  isContinuousTarget,
  publicState
} = require('./mapper')
const { Simulator } = require('./simulator')
const { TuyaLanDevice, versionCandidates, isTransientLanError } = require('./tuya-lan')
const { missingKeyMessage, isLanIp } = require('./scan')

/**
 * One LAN connection to one Tuya dehumidifier.
 *
 * The runtime only writes DPs the device has reported (live, or cached from
 * an earlier session of the same device), and only exposes controls that the
 * profile maps AND the device reports.
 */
class DeviceRuntime extends EventEmitter {
  constructor(options = {}, deps = {}) {
    super()
    this.options = { ...options }
    this.deps = deps
    this.key = options.key || 'device'
    this.codec = options.codec || createCodec(options.profile || PROFILES.generic, options.dpOverrides || {}, options.model)
    this.simulate = options.simulate === true
    this.pollMs = Math.max(5000, Number(options.pollIntervalMs) || 8000)
    this.pollBusy = false
    this.pollFails = 0
    this.reconnectTimer = null
    this.reconnecting = false
    this.lastHygrostat = 50
    this.simTickMs = 1000
    this.device = null
    this.simulator = null
    this.timers = []
    this.state = emptyState()
    this.started = false
    if (this.options.ip && !isLanIp(this.options.ip)) this.options.ip = ''
    this.commandEcho = null
    this.reported = new Set((options.reportedDps || []).map(String))
    if (this.simulate) {
      for (const dp of Object.values(this.codec.map)) this.reported.add(String(dp))
    }
  }

  get caps() {
    return capabilities(this.codec, this.reported)
  }

  noteReported(dps) {
    let added = false
    for (const id of Object.keys(dps || {})) {
      if (!this.reported.has(String(id))) {
        this.reported.add(String(id))
        added = true
      }
    }
    if (added) this.emit('capabilities', { reportedDps: [...this.reported], caps: this.caps })
  }

  rememberCommand(command, dps) {
    this.commandEcho = {
      until: Date.now() + 10000,
      command: { ...command },
      dps: { ...dps }
    }
  }

  applyPolledDps(dps) {
    this.noteReported(dps)
    const incoming = { ...dps }
    const echo = this.commandEcho
    const base = { ...this.state, connected: true, lastError: null }
    if (echo && Date.now() <= echo.until) {
      let pending = false
      for (const [key, expected] of Object.entries(echo.dps || {})) {
        if (incoming[key] === undefined || incoming[key] !== expected) {
          delete incoming[key]
          pending = true
        }
      }
      let next = applyDps(base, incoming, this.codec)
      if (pending) next = applyCommandToState(next, echo.command, this.codec)
      else this.commandEcho = null
      return next
    }
    this.commandEcho = null
    return applyDps(base, incoming, this.codec)
  }

  getPublicState() {
    return {
      key: this.key,
      ...publicState(this.state, this.codec, this.caps),
      simulate: this.simulate,
      profile: {
        id: this.codec.profile.id,
        name: this.codec.profile.name,
        verified: Boolean(this.codec.profile.verified)
      },
      adopted: {
        tuyaId: this.options.tuyaId || null,
        ip: this.options.ip || null,
        protocol: this.options.activeProtocol || null,
        hasLocalKey: Boolean(this.options.localKey)
      }
    }
  }

  /** Raw view for the Admin DP inspector. Never includes the local key. */
  getDiagnostics() {
    return {
      key: this.key,
      connected: Boolean(this.state.connected),
      lastError: this.state.lastError || null,
      rawDps: { ...this.state.rawDps },
      reportedDps: [...this.reported].sort((a, b) => Number(a) - Number(b)),
      map: { ...this.codec.map },
      profile: this.codec.profile.id,
      protocol: this.options.activeProtocol || null,
      ip: this.options.ip || null,
      updatedAt: this.state.updatedAt || null
    }
  }

  async start() {
    if (this.started) return
    this.started = true

    if (this.simulate) {
      this.simulator = this.deps.simulator || new Simulator({ codec: this.codec })
      this.state = this.simulator.getState()
      this.emit('state', this.getPublicState())
      this.timers.push(setInterval(() => {
        this.state = this.simulator.tick(this.simTickMs / 1000)
        this.emit('state', this.getPublicState())
      }, this.simTickMs))
      return
    }

    if (!this.options.tuyaId || !this.options.localKey) {
      this.state.connected = false
      this.state.lastError = missingKeyMessage([])
      this.emit('state', this.getPublicState())
      return
    }

    if (!this.options.ip && typeof this.deps.resolveIp === 'function') {
      try {
        const found = await this.deps.resolveIp(this.options.tuyaId)
        if (found && isLanIp(found.ip)) {
          this.options.ip = found.ip
          this.emit('ip', found.ip)
        }
      } catch (err) {
        this.emit('warn', err)
      }
    }
    if (!this.started) return

    const Lan = this.deps.TuyaLanDevice || TuyaLanDevice
    try {
      const opened = await this.openLan(Lan)
      if (!this.started) {
        opened.device.disconnect()
        return
      }
      this.device = opened.device
      this.bindDevice()
      this.noteReported(opened.dps)
      this.state = applyDps({ ...this.state, connected: true, lastError: null }, opened.dps, this.codec)
      this.emit('state', this.getPublicState())
    } catch (err) {
      this.state.connected = false
      this.state.lastError = err.message || String(err)
      this.emit('fault', err)
      this.emit('state', this.getPublicState())
      this.scheduleReconnect(15000)
    }

    this.timers.push(setInterval(() => {
      this.poll().catch(() => {})
    }, this.pollMs))
  }

  async poll() {
    if (!this.device || this.pollBusy || this.simulate) return
    this.pollBusy = true
    try {
      const dps = await this.device.get()
      this.pollFails = 0
      this.state = this.applyPolledDps(dps)
      this.emit('state', this.getPublicState())
    } catch (err) {
      this.pollFails += 1
      this.emit('warn', err)
      if (this.pollFails >= 5) this.scheduleReconnect()
    } finally {
      this.pollBusy = false
    }
  }

  /** Refuse to write any DP the device has not reported. */
  assertReported(dps) {
    const missing = Object.keys(dps).filter((id) => !this.reported.has(String(id)))
    if (missing.length) {
      throw new Error(`Refusing to write DP ${missing.join(', ')}: this device has not reported it.`)
    }
  }

  async command(command) {
    const nextCommand = { ...command }
    const viaTarget = this.codec.continuous && this.codec.continuous.via === 'target'
    if (viaTarget && nextCommand.mode === MODE.CONTINUOUS) {
      if (!isContinuousTarget(this.state.targetHumidity, this.codec)) this.lastHygrostat = this.state.targetHumidity
    } else if (
      viaTarget &&
      nextCommand.mode !== undefined &&
      nextCommand.mode !== MODE.CONTINUOUS &&
      isContinuousTarget(this.state.targetHumidity, this.codec) &&
      nextCommand.targetHumidity === undefined &&
      this.codec.map.targetHumidity != null
    ) {
      nextCommand.targetHumidity = this.lastHygrostat || 50
    }

    const dps = commandToDps(nextCommand, this.codec)
    this.assertReported(dps)

    if (this.simulate) {
      this.state = this.simulator.command(nextCommand)
      this.emit('state', this.getPublicState())
      return this.getPublicState()
    }
    if (!this.device) throw new Error('The dehumidifier is not connected.')
    await this.device.setDps(dps)
    this.rememberCommand(nextCommand, dps)
    this.state = applyCommandToState({ ...this.state, connected: true, lastError: null }, nextCommand, this.codec)
    this.emit('state', this.getPublicState())
    const t = setTimeout(() => { this.poll().catch(() => {}) }, 1200)
    if (t.unref) t.unref()
    return this.getPublicState()
  }

  bindDevice() {
    this.device.onData((dps) => {
      this.state = this.applyPolledDps(dps)
      this.emit('state', this.getPublicState())
    })
    this.device.onError((err) => {
      this.emit('warn', err)
      if (isTransientLanError(err)) return
      this.state.lastError = err.message || String(err)
      this.emit('fault', err)
      this.emit('state', this.getPublicState())
    })
    this.device.onDisconnect(() => {
      if (this.reconnecting || !this.started) return
      this.state.connected = false
      this.scheduleReconnect()
    })
  }

  scheduleReconnect(delayMs = 1500) {
    if (this.simulate || !this.started || this.reconnectTimer || this.reconnecting) return
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      this.reconnect().catch((err) => this.emit('warn', err))
    }, delayMs)
  }

  async reconnect() {
    if (!this.started || this.simulate || this.reconnecting) return
    this.reconnecting = true
    const Lan = this.deps.TuyaLanDevice || TuyaLanDevice
    if (this.device) {
      this.device.disconnect()
      this.device = null
    }
    let failed = false
    try {
      if (!this.options.ip && typeof this.deps.resolveIp === 'function') {
        const found = await this.deps.resolveIp(this.options.tuyaId)
        if (found && isLanIp(found.ip)) {
          this.options.ip = found.ip
          this.emit('ip', found.ip)
        }
      }
      const opened = await this.openLan(Lan)
      this.device = opened.device
      this.bindDevice()
      this.pollFails = 0
      this.noteReported(opened.dps)
      this.state = applyDps({ ...this.state, connected: true, lastError: null }, opened.dps, this.codec)
      this.emit('state', this.getPublicState())
    } catch (err) {
      failed = true
      this.state.connected = false
      this.state.lastError = err.message || String(err)
      this.emit('state', this.getPublicState())
    } finally {
      this.reconnecting = false
    }
    if (failed) this.scheduleReconnect(15000)
  }

  protocolOrder() {
    const wanted = this.options.protocol && this.options.protocol !== 'auto'
      ? this.options.protocol
      : (this.options.protocolHint || '3.5')
    return versionCandidates(wanted)
  }

  async openLan(Lan) {
    if (!isLanIp(this.options.ip)) {
      // No per-device UDP find: discovery is shared (see discovery.js).
      throw new Error('Not found on the LAN yet. Set its IP in Plugin Config, or check that it is powered and on the boat Wi-Fi.')
    }
    let lastErr = new Error('LAN connect failed.')
    for (const version of this.protocolOrder()) {
      if (!this.started) break
      const device = new Lan({
        deviceId: this.options.tuyaId,
        localKey: this.options.localKey,
        ip: this.options.ip,
        version
      }, this.deps.TuyAPI)
      try {
        await device.connect()
        const dps = await device.get()
        this.options.activeProtocol = version
        this.emit('protocol', version)
        return { device, dps, version }
      } catch (err) {
        lastErr = err
        device.disconnect()
      }
    }
    throw lastErr
  }

  emptyTank() {
    if (this.simulate && this.simulator) {
      this.state = this.simulator.emptyTank()
      this.emit('state', this.getPublicState())
    }
    return this.getPublicState()
  }

  async stop() {
    this.started = false
    this.reconnecting = true
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer)
    this.reconnectTimer = null
    for (const t of this.timers) clearInterval(t)
    this.timers = []
    if (this.device) {
      this.device.disconnect()
      this.device = null
    }
    this.simulator = null
    this.state.connected = false
  }
}

module.exports = { DeviceRuntime }
