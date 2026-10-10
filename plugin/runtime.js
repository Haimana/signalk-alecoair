'use strict'

const { EventEmitter } = require('events')
const { D13, mergeDps } = require('./profile')
const {
  emptyState,
  applyDps,
  commandToDps,
  applyCommandToState,
  publicState
} = require('./mapper')
const { D13Simulator } = require('./simulator')
const { TuyaLanDevice } = require('./tuya-lan')

class DeviceRuntime extends EventEmitter {
  constructor(options = {}, deps = {}) {
    super()
    this.options = options
    this.deps = deps
    this.dpsMap = mergeDps(options.dps || {})
    this.simulate = options.simulate !== false
    this.pollMs = Math.max(2000, Number(options.pollIntervalMs) || 5000)
    this.simTickMs = 1000
    this.device = null
    this.simulator = null
    this.timers = []
    this.state = emptyState()
    this.started = false
  }

  getPublicState() {
    return publicState(this.state)
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

    const Lan = this.deps.TuyaLanDevice || TuyaLanDevice
    try {
      this.device = new Lan({
        deviceId: this.options.deviceId,
        localKey: this.options.localKey,
        ip: this.options.ip,
        version: this.options.version || D13.protocolDefault
      }, this.deps.TuyAPI)

      this.device.onData((dps) => {
        this.state = applyDps({ ...this.state, connected: true, lastError: null }, dps, this.dpsMap)
        this.emit('state', this.getPublicState())
      })
      this.device.onError((err) => {
        this.state.lastError = err.message || String(err)
        this.state.connected = false
        this.emit('fault', err)
        this.emit('state', this.getPublicState())
      })
      this.device.onDisconnect(() => {
        this.state.connected = false
        this.emit('state', this.getPublicState())
      })

      await this.device.connect()
      this.state.connected = true
      const dps = await this.device.get()
      this.state = applyDps({ ...this.state, connected: true }, dps, this.dpsMap)
      this.emit('state', this.getPublicState())
    } catch (err) {
      this.state.connected = false
      this.state.lastError = err.message || String(err)
      this.emit('fault', err)
      this.emit('state', this.getPublicState())
    }

    this.timers.push(setInterval(() => {
      if (!this.device) return
      this.device.get().then((dps) => {
        this.state = applyDps({ ...this.state, connected: true, lastError: null }, dps, this.dpsMap)
        this.emit('state', this.getPublicState())
      }).catch((err) => {
        this.state.connected = false
        this.state.lastError = err.message || String(err)
        this.emit('state', this.getPublicState())
      })
    }, this.pollMs))
  }

  async command(command) {
    if (this.simulate) {
      this.state = this.simulator.command(command)
      this.emit('state', this.getPublicState())
      return this.getPublicState()
    }
    if (!this.device) throw new Error('Aparatul Tuya nu este conectat.')
    const dps = commandToDps(command, this.dpsMap)
    await this.device.setDps(dps)
    this.state = applyCommandToState({ ...this.state, connected: true }, command)
    this.emit('state', this.getPublicState())
    return this.getPublicState()
  }

  emptyTank() {
    if (this.simulate && this.simulator) {
      this.state = this.simulator.emptyTank()
      this.emit('state', this.getPublicState())
    }
    return this.getPublicState()
  }

  async stop() {
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
