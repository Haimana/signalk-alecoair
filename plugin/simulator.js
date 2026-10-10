'use strict'

const { D13, MODE, FAN, FAULT } = require('./profile')
const { emptyState, applyCommandToState } = require('./mapper')

/**
 * Cabin-scale model of D13 Traditio: hygrostat +1% RH, 15 min sample cycle,
 * 13 L/day extraction at rated load, 2.3 L tank, 170 W compressor.
 */
class D13Simulator {
  constructor(options = {}) {
    this.state = emptyState()
    this.state.connected = true
    this.state.humidity = options.humidity ?? 64
    this.state.targetHumidity = options.targetHumidity ?? 50
    this.state.tankLiters = options.tankLiters ?? 0.4
    this.sampleTimer = 0
    this.runSeconds = 0
    this.defrostSeconds = 0
  }

  getState() {
    return { ...this.state, rawDps: { ...this.state.rawDps } }
  }

  command(command) {
    this.state = applyCommandToState(this.state, command)
    this.refreshDerived()
    return this.getState()
  }

  tick(seconds = 1) {
    const dt = Math.max(0, Number(seconds) || 0)
    if (dt === 0) return this.getState()

    if (this.state.timerHours > 0 && this.state.power) {
      this.state.timerRemainingMin = Math.max(0, this.state.timerRemainingMin - dt / 60)
      if (this.state.timerRemainingMin <= 0) {
        this.state.power = false
        this.state.timerHours = 0
        this.state.timerRemainingMin = 0
      }
    }

    const shouldRun = this.shouldCompressorRun()
    if (!this.state.power || this.state.tankFull) {
      this.state.compressor = false
      this.sampleTimer = 0
    } else if (shouldRun) {
      this.state.compressor = true
      this.sampleTimer = 0
      this.extract(dt)
      this.runSeconds += dt
      if (this.runSeconds > 2400) {
        this.state.defrost = true
        this.defrostSeconds += dt
        if (this.defrostSeconds > 180) {
          this.state.defrost = false
          this.defrostSeconds = 0
          this.runSeconds = 0
        }
      }
    } else {
      this.state.compressor = false
      this.sampleTimer += dt
      // Manual: after stop, fan samples 1 min every 15 min
      if (this.sampleTimer > 900) this.sampleTimer = 0
      this.ambientDrift(dt)
    }

    if (!this.state.power) this.ambientDrift(dt * 0.35)
    this.refreshDerived()
    return this.getState()
  }

  shouldCompressorRun() {
    if (!this.state.power || this.state.tankFull) return false
    if (this.state.defrost) return false
    if (this.state.mode === MODE.CONTINUOUS) return true
    return this.state.humidity > this.state.targetHumidity + 1
  }

  extract(dt) {
    const fanFactor = this.state.fan === FAN.HIGH ? 1 : 0.74
    const litersPerSecond = (D13.capacityLitersPerDay / 86400) * fanFactor
    const extracted = litersPerSecond * dt
    this.state.tankLiters = Math.min(D13.tankLiters, this.state.tankLiters + extracted)
    const humidityDrop = (extracted / 0.012) * 0.018
    this.state.humidity = Math.max(22, this.state.humidity - humidityDrop)
    if (this.state.tankLiters >= D13.tankLiters - 0.01) {
      this.state.tankFull = true
      this.state.tankLiters = D13.tankLiters
      this.state.compressor = false
    }
  }

  ambientDrift(dt) {
    const ambient = 62
    const k = 0.00035 * dt
    this.state.humidity += (ambient - this.state.humidity) * Math.min(1, k)
  }

  emptyTank() {
    this.state.tankLiters = 0
    this.state.tankFull = false
    this.refreshDerived()
    return this.getState()
  }

  refreshDerived() {
    const faults = (this.state.tankFull ? FAULT.TANK_FULL : 0) | (this.state.defrost ? FAULT.DEFROST : 0)
    this.state.faultCode = faults
    if (!this.state.power) {
      this.state.compressor = false
      this.state.powerWatts = 0
    } else if (this.state.tankFull) {
      this.state.powerWatts = 2
    } else if (this.state.defrost) {
      this.state.powerWatts = 28
    } else if (this.state.compressor) {
      this.state.powerWatts = this.state.fan === FAN.HIGH ? D13.ratedWatts : 145
    } else {
      this.state.powerWatts = this.sampleTimer < 60 ? D13.idleWatts : 3
    }
    this.state.connected = true
    this.state.lastError = null
  }
}

module.exports = { D13Simulator }
