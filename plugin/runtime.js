'use strict'

const { EventEmitter } = require('events')
const { D13, MODE, mergeDps, availableControls, isContinuousTarget } = require('./profile')
const {
  emptyState,
  applyDps,
  commandToDps,
  applyCommandToState,
  publicState
} = require('./mapper')
const { D13Simulator } = require('./simulator')
const { TuyaLanDevice, versionCandidates, isTransientLanError } = require('./tuya-lan')
const { scanLan, pickDevice, missingKeyMessage, isLanIp } = require('./scan')

class DeviceRuntime extends EventEmitter {
  constructor(options = {}, deps = {}) {
    super()
    this.options = options
    this.deps = deps
    this.dpsMap = mergeDps(options.dps || {})
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
    this.autoScan = options.autoScan !== false
    if (this.options.ip && !isLanIp(this.options.ip)) this.options.ip = ''
    this.discovered = []
    this.lastScanAt = null
  }

  getPublicState() {
    return {
      ...publicState(this.state),
      simulate: this.simulate,
      discovery: {
        devices: this.discovered,
        lastScanAt: this.lastScanAt,
        autoScan: this.autoScan
      },
      adopted: {
        deviceId: this.options.deviceId || null,
        ip: this.options.ip || null,
        version: this.options.version || null,
        hasLocalKey: Boolean(this.options.localKey)
      },
      controls: availableControls(this.dpsMap)
    }
  }

  async scan(timeoutMs) {
    this.discovered = await scanLan({
      timeoutMs,
      discover: this.deps.discover
    })
    this.lastScanAt = Date.now()
    this.emit('scan', this.discovered)
    return this.discovered
  }

  adoptDiscovery(device) {
    if (!device || !device.id) throw new Error('Dispozitiv invalid.')
    this.options.deviceId = device.id
    if (device.ip) this.options.ip = device.ip
    if (device.version) this.options.version = device.version
    if (device.localKey) this.options.localKey = device.localKey
    return this.getPublicState()
  }

  async start() {
    if (this.started) return
    this.started = true

    if (this.simulate) {
      this.simulator = this.deps.simulator || new D13Simulator()
      this.state = this.simulator.getState()
      this.emit('state', this.getPublicState())
      this.timers.push(setInterval(() => {
        this.state = this.simulator.tick(this.simTickMs / 1000)
        this.emit('state', this.getPublicState())
      }, this.simTickMs))
      return
    }

    if (this.autoScan) {
      try {
        await this.scan(this.options.scanTimeoutMs || 5000)
        const picked = pickDevice(this.discovered, this.options)
        if (picked) {
          if (!this.options.deviceId) this.options.deviceId = picked.id
          if (!this.options.ip && isLanIp(picked.ip)) this.options.ip = picked.ip
          if (!this.options.version && picked.version) this.options.version = picked.version
          this.emit('discovered', picked)
        }
        if (!this.options.ip) {
          const tcp = this.discovered.filter((d) => d.tcp && isLanIp(d.ip))
          if (tcp.length === 1) {
            this.options.ip = tcp[0].ip
            this.emit('discovered', { ...tcp[0], id: this.options.deviceId || tcp[0].id })
          }
        }
      } catch (err) {
        this.state.lastError = err.message || String(err)
      }
    }

    if (!this.options.localKey || !this.options.deviceId) {
      this.state.connected = false
      this.state.lastError = missingKeyMessage(this.discovered)
      this.emit('state', this.getPublicState())
      return
    }

    const Lan = this.deps.TuyaLanDevice || TuyaLanDevice
    try {
      const opened = await this.openLan(Lan)
      this.device = opened.device
      this.bindDevice()
      this.state = applyDps({ ...this.state, connected: true, lastError: null }, opened.dps, this.dpsMap)
      this.emit('state', this.getPublicState())
    } catch (err) {
      this.state.connected = false
      this.state.lastError = err.message || String(err)
      this.emit('fault', err)
      this.emit('state', this.getPublicState())
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
      this.state = applyDps({ ...this.state, connected: true, lastError: null }, dps, this.dpsMap)
      this.emit('state', this.getPublicState())
    } catch (err) {
      this.pollFails += 1
      this.emit('warn', err)
      if (this.pollFails >= 5) this.scheduleReconnect()
    } finally {
      this.pollBusy = false
    }
  }

  async command(command) {
    if (this.simulate) {
      this.state = this.simulator.command(command)
      this.emit('state', this.getPublicState())
      return this.getPublicState()
    }
    if (!this.device) throw new Error('The dehumidifier is not connected.')
    const nextCommand = { ...command }
    if (nextCommand.mode === MODE.CONTINUOUS) {
      if (!isContinuousTarget(this.state.targetHumidity)) {
        this.lastHygrostat = this.state.targetHumidity
      }
      nextCommand.targetHumidity = D13.continuousTarget
    } else if (nextCommand.mode === MODE.AUTO && isContinuousTarget(this.state.targetHumidity) && nextCommand.targetHumidity === undefined) {
      nextCommand.targetHumidity = this.lastHygrostat || 50
    }
    const dps = commandToDps(nextCommand, this.dpsMap)
    if (Object.keys(dps).length) await this.device.setDps(dps)
    this.state = applyCommandToState({ ...this.state, connected: true }, nextCommand)
    this.emit('state', this.getPublicState())
    setTimeout(() => { this.poll().catch(() => {}) }, 800)
    return this.getPublicState()
  }

  bindDevice() {
    this.device.onData((dps) => {
      this.state = applyDps({ ...this.state, connected: true, lastError: null }, dps, this.dpsMap)
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
      this.scheduleReconnect()
    })
  }

  scheduleReconnect() {
    if (this.simulate || !this.started || this.reconnectTimer || this.reconnecting) return
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      this.reconnect().catch((err) => this.emit('warn', err))
    }, 1500)
  }

  async reconnect() {
    if (!this.started || this.simulate || this.reconnecting) return
    this.reconnecting = true
    const Lan = this.deps.TuyaLanDevice || TuyaLanDevice
    if (this.device) {
      this.device.disconnect()
      this.device = null
    }
    try {
      const opened = await this.openLan(Lan)
      this.device = opened.device
      this.bindDevice()
      this.pollFails = 0
      this.state = applyDps({ ...this.state, connected: true, lastError: null }, opened.dps, this.dpsMap)
      this.emit('state', this.getPublicState())
    } catch (err) {
      this.state.connected = false
      this.state.lastError = err.message || String(err)
      this.emit('state', this.getPublicState())
      this.reconnecting = false
      this.scheduleReconnect()
    } finally {
      this.reconnecting = false
    }
  }

  async openLan(Lan) {
    const versions = versionCandidates(this.options.version || D13.protocolDefault)
    let lastErr = new Error('LAN connect failed.')
    for (const version of versions) {
      const device = new Lan({
        deviceId: this.options.deviceId,
        localKey: this.options.localKey,
        ip: this.options.ip,
        version
      }, this.deps.TuyAPI)
      try {
        await device.connect()
        const dps = await device.get()
        this.options.version = version
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
    this.started = false
    this.state.connected = false
  }
}

module.exports = { DeviceRuntime }
