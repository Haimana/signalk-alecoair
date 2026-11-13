'use strict'

/**
 * External-sensor humidity control for one unit.
 *
 * Pure decision logic: no timers, no I/O. The plugin calls tick() with the
 * current time, the unit's public state and the external sensor readings;
 * tick() returns the commands to send (in order) and a status. The caller
 * sends the commands through the runtime and reports failures with
 * commandFailed(). Everything time-based uses the injected `now`, so tests
 * drive it with a fake clock.
 *
 * How it controls the unit:
 * - The unit is put in the profile's continuous mode (Traditio: target 25 =
 *   CO), so its own hygrostat never stops it, and the controller switches
 *   power on and off from the external humidity with a hysteresis
 *   (on at target + hysteresisOn, off at target − hysteresisOff) and minimum
 *   on / off times.
 * - A profile without a continuous mode falls back to the lowest hygrostat
 *   target the unit accepts plus power on/off. This works as long as the
 *   external target is above that minimum.
 * - Power-off is never sent during defrost (the manual says not to switch
 *   off then); the controller waits until the defrost ends. A full tank is
 *   left to the firmware.
 * - A change on the unit that the controller did not make (app, buttons,
 *   WebApp power/target, Signal K PUT) ends external control at once: the
 *   mode goes back to internal and the unit is left exactly as it is (no
 *   restore, no command). Picking the external mode again resumes it.
 * - When the sensor goes stale, the chosen fallback is applied once:
 *   'internal' restores the unit's own hygrostat (previous mode and target,
 *   power on), 'off' switches the unit off.
 */

const MIN = 60 * 1000
const GRACE_MS = 30 * 1000
const RETRY_MS = 30 * 1000

const DEFAULTS = {
  enabled: false,
  humidityPath: '',
  temperaturePath: '',
  minTemperature: 5,
  hysteresisOn: 3,
  hysteresisOff: 2,
  minOnMinutes: 10,
  minOffMinutes: 10,
  staleMinutes: 5,
  onSensorLoss: 'internal'
}

function num(v, def, lo, hi) {
  const n = Number(v)
  if (v === '' || v === null || v === undefined || !Number.isFinite(n)) return def
  return Math.min(hi, Math.max(lo, n))
}

function cleanPath(p) {
  return String(p || '').trim().replace(/^vessels\.self\./, '').replace(/\.+$/, '')
}

/** Normalize the per-device "External control" options. */
function normalizeControlConfig(raw) {
  const c = raw && typeof raw === 'object' ? raw : {}
  // One sensor per unit. Older 0.1.0 drafts kept a list (humidityPaths): keep its first path.
  let humidityPath = cleanPath(c.humidityPath)
  if (!humidityPath) {
    const list = Array.isArray(c.humidityPaths) ? c.humidityPaths : String(c.humidityPaths || '').split(',')
    humidityPath = list.map(cleanPath).find(Boolean) || ''
  }
  return {
    enabled: c.enabled === true,
    humidityPath,
    temperaturePath: cleanPath(c.temperaturePath),
    minTemperature: num(c.minTemperature, DEFAULTS.minTemperature, -20, 40),
    hysteresisOn: num(c.hysteresisOn, DEFAULTS.hysteresisOn, 0, 20),
    hysteresisOff: num(c.hysteresisOff, DEFAULTS.hysteresisOff, 0, 20),
    minOnMinutes: num(c.minOnMinutes, DEFAULTS.minOnMinutes, 0, 240),
    minOffMinutes: num(c.minOffMinutes, DEFAULTS.minOffMinutes, 0, 240),
    staleMinutes: num(c.staleMinutes, DEFAULTS.staleMinutes, 0.5, 240),
    onSensorLoss: c.onSensorLoss === 'off' ? 'off' : 'internal'
  }
}

/** Signal K relative humidity is a ratio (0–1); accept a percentage too (anything above 1.5). */
function toPercent(value) {
  const n = Number(value)
  if (value === null || value === undefined || value === '' || !Number.isFinite(n)) return null
  return n > 1.5 ? n : n * 100
}

/** Signal K temperature is Kelvin; accept Celsius too (anything below 150). */
function toCelsius(value) {
  const n = Number(value)
  if (value === null || value === undefined || value === '' || !Number.isFinite(n)) return null
  return n >= 150 ? n - 273.15 : n
}

function round1(n) {
  return n === null || n === undefined ? null : Math.round(n * 10) / 10
}

function fmtMin(ms) {
  const m = Math.ceil(ms / MIN)
  return m <= 1 ? '1 min' : `${m} min`
}

/**
 * How this profile is driven: 'continuous' (profile has a continuous mode),
 * 'min-target' (no continuous mode: lowest hygrostat target), or null with
 * a reason when the unit cannot be controlled.
 */
function controlStrategy(unit) {
  const c = (unit && unit.controls) || {}
  if (!c.power) return { strategy: null, reason: 'The unit has no power control.' }
  const modes = (unit && unit.modes) || []
  if (modes.some((m) => m.value === 'continuous')) return { strategy: 'continuous' }
  if (c.targetHumidity) return { strategy: 'min-target' }
  return { strategy: null, reason: 'The unit has neither a continuous mode nor a hygrostat target.' }
}

class ExternalController {
  /**
   * @param {object} config   normalized external-control options
   * @param {object} persisted { mode: 'internal'|'external', target, saved }
   */
  constructor(config, persisted = {}) {
    this.config = normalizeControlConfig({ ...config, enabled: true })
    const p = persisted || {}
    this.mode = p.mode === 'external' ? 'external' : 'internal'
    this.target = Number.isFinite(Number(p.target)) ? Number(p.target) : null
    this.saved = p.saved && typeof p.saved === 'object' ? { ...p.saved } : null
    this.inControl = false
    this.expectedPower = null
    // After a restart: the power the controller had chosen and when it last switched.
    this.resumePower = typeof p.power === 'boolean' ? p.power : null
    this.lastSwitchAt = Number.isFinite(Number(p.lastSwitchAt)) && p.lastSwitchAt !== null ? Number(p.lastSwitchAt) : null
    this.graceUntil = 0
    this.retryAt = 0
    this.lossApplied = false
    this.coldLatched = false
    this.restorePending = false
    this.dirty = false
    this.range = null
    this.status = { state: this.mode === 'external' ? 'starting' : 'internal', reason: '' }
    this.last = { humidity: null, temperature: null }
  }

  persisted() {
    const out = { mode: this.mode, target: this.target, saved: this.saved }
    if (this.mode === 'external' && typeof this.expectedPower === 'boolean') out.power = this.expectedPower
    if (this.mode === 'external' && this.lastSwitchAt !== null) out.lastSwitchAt = this.lastSwitchAt
    return out
  }

  markDirty() {
    this.dirty = true
  }

  takeDirty() {
    const d = this.dirty
    this.dirty = false
    return d
  }

  /** Turn external control on. The controller target defaults to the unit's own hygrostat target. */
  enable(unit, target) {
    if (this.mode !== 'external') {
      this.mode = 'external'
      this.inControl = false
        this.lossApplied = false
      this.markDirty()
    }
    if (target !== undefined) this.setTarget(target, unit)
    else if (this.target === null) this.setTarget(this.defaultTarget(unit), unit)
    else this.snapTarget(unit)
  }

  /**
   * Leave external control because a working mode was picked (WebApp mode
   * menu, Signal K PUT on .mode). Returns the one command that sets that
   * mode, with the remembered hygrostat target and power on, instead of the
   * usual restore.
   */
  leaveTo(unit, mode) {
    const cmd = mode === 'continuous' ? { mode: 'continuous', power: true } : { ...this.restoreCommand(unit, true), mode }
    if (cmd.mode !== 'continuous' && !(unit && unit.controls && unit.controls.targetHumidity)) delete cmd.targetHumidity
    this.mode = 'internal'
    this.inControl = false
    this.restorePending = false
    this.saved = null
    this.markDirty()
    this.setStatus('internal', 'The unit runs on its own hygrostat.')
    return cmd
  }

  /** Turn external control off; the next tick restores the unit's own hygrostat. */
  disable() {
    if (this.mode === 'internal' && !this.restorePending) return
    this.mode = 'internal'
    this.inControl = false
    this.restorePending = true
    this.markDirty()
  }

  defaultTarget(unit) {
    const u = unit || {}
    const t = Number(u.targetHumidity)
    const r = u.humidityRange || { min: 30, max: 80 }
    if (Number.isFinite(t) && t >= r.min && t <= r.max && u.mode !== 'continuous') return t
    if (this.saved && Number.isFinite(Number(this.saved.targetHumidity))) return Number(this.saved.targetHumidity)
    return 50
  }

  /** The unit's hygrostat range and step (Traditio 30–80 step 5); the controller target uses the same. */
  targetRange(unit) {
    const r = (unit && unit.humidityRange) || this.range
    if (r && Number.isFinite(Number(r.min)) && Number.isFinite(Number(r.max))) {
      this.range = { min: Number(r.min), max: Number(r.max), step: Number(r.step) > 0 ? Number(r.step) : 5 }
    }
    return this.range || { min: 30, max: 80, step: 5 }
  }

  snapValue(pct, unit) {
    const r = this.targetRange(unit)
    const stepped = r.min + Math.round((pct - r.min) / r.step) * r.step
    return Math.min(r.max, Math.max(r.min, stepped))
  }

  /** Accepts a percentage or a Signal K ratio; snapped to the unit's hygrostat step and range. */
  setTarget(value, unit) {
    const pct = toPercent(value)
    if (pct === null) throw new Error('Target must be a number (ratio 0–1 or percent).')
    const next = this.snapValue(pct, unit)
    if (next !== this.target) {
      this.target = next
      this.markDirty()
    }
    return this.target
  }

  /** Keep a persisted target on the unit's step and range (e.g. one saved by 0.1.0 before snapping). */
  snapTarget(unit) {
    if (this.target === null) return
    const next = this.snapValue(this.target, unit)
    if (next !== this.target) {
      this.target = next
      this.markDirty()
    }
  }

  /** External change on the unit: back to internal, adopt the unit as it is (no restore, no command). */
  exitExternal() {
    this.mode = 'internal'
    this.inControl = false
    this.restorePending = false
    this.saved = null
    this.expectedPower = null
    this.lastSwitchAt = null
    this.markDirty()
  }

  /** A command the caller sent failed: forget control and retry later. */
  commandFailed(now) {
    this.inControl = false
    this.retryAt = now + RETRY_MS
  }

  /** The reading's value if it is still fresh, else null. */
  fresh(reading, now) {
    const r = reading
    if (!r || r.value === null || r.value === undefined || !Number.isFinite(r.value) || !Number.isFinite(r.at)) return null
    return now - r.at <= this.config.staleMinutes * MIN ? r.value : null
  }

  enterCommand(unit) {
    const { strategy } = controlStrategy(unit)
    if (strategy === 'continuous') return { mode: 'continuous' }
    return { targetHumidity: ((unit && unit.humidityRange) || { min: 30 }).min }
  }

  inControlMode(unit) {
    const { strategy } = controlStrategy(unit)
    if (strategy === 'continuous') return unit.mode === 'continuous'
    return Number(unit.targetHumidity) === Number(((unit && unit.humidityRange) || { min: 30 }).min)
  }

  restoreCommand(unit, power) {
    const s = this.saved || {}
    const modes = ((unit && unit.modes) || []).map((m) => m.value)
    const cmd = {}
    const { strategy } = controlStrategy(unit)
    if (strategy === 'continuous' || (unit && unit.controls && unit.controls.mode)) {
      const mode = s.mode && modes.includes(s.mode) ? s.mode : modes.find((m) => m !== 'continuous')
      if (mode) cmd.mode = mode
    }
    if (cmd.mode !== 'continuous' && unit && unit.controls && unit.controls.targetHumidity) {
      const r = unit.humidityRange || { min: 30, max: 80 }
      const t = Number(s.targetHumidity)
      cmd.targetHumidity = Number.isFinite(t) && t >= r.min && t <= r.max ? t : 50
    }
    if (power !== undefined) cmd.power = power
    return cmd
  }

  setStatus(state, reason) {
    this.status = { state, reason: reason || '' }
    return this.status
  }

  /**
   * One control step.
   * @param {number} now
   * @param {object} unit       the runtime's public state
   * @param {object} readings   { humidity: { path, value (percent), at (ms) } | null, temperature: { path, value (°C), at } | null }
   * @returns {{ commands: object[], status: { state, reason } }}
   */
  tick(now, unit, readings = {}) {
    const commands = []
    const u = unit || {}
    const cfg = this.config
    const hum = { value: this.fresh(readings.humidity, now) }
    const temp = this.fresh(readings.temperature, now)
    this.last = { humidity: round1(hum.value), temperature: round1(temp) }
    const done = (state, reason) => ({ commands, status: this.setStatus(state, reason) })

    if (this.mode !== 'external') {
      if (this.restorePending) {
        if (!u.connected) return done('internal', 'Waiting for the unit to restore its own hygrostat.')
        if (now < this.retryAt) return done('internal', 'Retrying the restore shortly.')
        commands.push(this.restoreCommand(u, true))
        this.restorePending = false
        this.saved = null
        this.markDirty()
      }
      return done('internal', 'The unit runs on its own hygrostat.')
    }

    const strat = controlStrategy(u)
    if (u.connected && !strat.strategy) return done('unsupported', strat.reason)
    if (u.humidityRange) this.snapTarget(u)
    if (!u.connected) {
      this.inControl = false
      return done('offline', 'The unit is not connected.')
    }
    if (now < this.retryAt) return done('error', 'A command failed; retrying shortly.')

    // Sensor loss: apply the fallback once, then wait for the sensor.
    if (hum.value === null) {
      this.inControl = false
      if (!this.lossApplied) {
        if (cfg.onSensorLoss === 'off') {
          if (u.power && u.defrost) return done('sensor-missing', 'No fresh external humidity. Switching off after the defrost.')
          if (u.power) commands.push({ power: false })
        } else if (this.inControlMode(u) || !u.power) {
          commands.push(this.restoreCommand(u, true))
        }
        this.lossApplied = true
        this.expectedPower = null
      }
      const what = cfg.onSensorLoss === 'off' ? 'the unit is off' : 'the unit runs on its own hygrostat'
      return done('sensor-missing', `No fresh external humidity for ${cfg.staleMinutes} min: ${what}.`)
    }
    this.lossApplied = false

    // A change the controller did not make ends external control; the unit is left as it is.
    if (this.inControl && now >= this.graceUntil) {
      const powerChanged = this.expectedPower !== null && Boolean(u.power) !== this.expectedPower
      if (powerChanged || !this.inControlMode(u)) {
        this.exitExternal()
        return done('internal', 'The unit was changed outside the controller, so external control was switched off. Pick the external mode again to resume.')
      }
    }

    // Take control: continuous mode (or the lowest target), remembering how the unit was set.
    if (!this.inControl) {
      if (!this.inControlMode(u)) {
        if (!this.saved) {
          this.saved = { mode: u.mode, targetHumidity: u.targetHumidity }
          this.markDirty()
        }
        commands.push(this.enterCommand(u))
      } else if (!this.saved) {
        // Already in CO (e.g. after a restart): restore to the normal hygrostat later.
        const first = ((u.modes || []).find((m) => m.value !== 'continuous') || {}).value
        this.saved = { mode: first || u.mode, targetHumidity: 50 }
        this.markDirty()
      }
      this.inControl = true
      this.expectedPower = Boolean(u.power)
      this.graceUntil = now + GRACE_MS
      // First take-over after a restart: put the unit back to the power the
      // controller had chosen (a plugin stop may have restored the hygrostat).
      if (this.resumePower !== null) {
        const want = this.resumePower
        this.resumePower = null
        if (want !== Boolean(u.power) && !(want === false && u.defrost) && !u.tankFull) {
          commands.push({ power: want })
          this.expectedPower = want
        }
      }
    }

    if (u.tankFull) return done('tank-full', 'The tank is full; the unit waits until it is emptied.')

    const h = hum.value
    const target = this.target === null ? 50 : this.target
    const cold = cfg.temperaturePath && temp !== null && (temp < cfg.minTemperature || (this.coldLatched && temp < cfg.minTemperature + 1))
    this.coldLatched = Boolean(cold)
    let want = this.expectedPower
    if (cold) want = false
    else if (h >= target + cfg.hysteresisOn) want = true
    else if (h <= target - cfg.hysteresisOff) want = false

    if (want !== this.expectedPower) {
      const minMs = (this.expectedPower ? cfg.minOnMinutes : cfg.minOffMinutes) * MIN
      const elapsed = this.lastSwitchAt === null ? Infinity : now - this.lastSwitchAt
      if (elapsed < minMs) {
        const left = fmtMin(minMs - elapsed)
        return done('waiting', want ? `Humidity ${round1(h)}% is above the target; starting in ${left} (minimum off time).` : `Humidity ${round1(h)}% is below the target; stopping in ${left} (minimum on time).`)
      }
      if (!want && u.defrost) return done('defrost', 'Defrost in progress; the unit is switched off once it ends.')
      commands.push({ power: want })
      this.expectedPower = want
      this.lastSwitchAt = now
      this.graceUntil = now + GRACE_MS
      this.markDirty()
    }

    if (cold) return done('too-cold', `${round1(temp)} °C is below ${cfg.minTemperature} °C; the unit stays off.`)
    if (this.expectedPower) {
      if (u.defrost) return done('defrost', `Defrost in progress (humidity ${round1(h)}%, target ${target}%).`)
      return done('running', `Humidity ${round1(h)}% ≥ ${target + cfg.hysteresisOn}% switched it on; off at ${target - cfg.hysteresisOff}%.`)
    }
    return done('idle', `Humidity ${round1(h)}%; on again at ${target + cfg.hysteresisOn}%.`)
  }

  /** Commands to apply when the plugin stops while external control is on. */
  stopCommands(unit) {
    if (this.mode !== 'external' || !unit || !unit.connected) return []
    if (!controlStrategy(unit).strategy) return []
    if (this.config.onSensorLoss === 'off') return unit.power && !unit.defrost ? [{ power: false }] : []
    return this.inControlMode(unit) || !unit.power ? [this.restoreCommand(unit, true)] : []
  }

  publicStatus(unit) {
    const strat = controlStrategy(unit || {})
    return {
      available: Boolean(strat.strategy),
      strategy: strat.strategy,
      mode: this.mode,
      target: this.target,
      state: this.status.state,
      reason: this.status.reason || strat.reason || '',
      sourceHumidity: this.last.humidity,
      sourceTemperature: this.config.temperaturePath ? this.last.temperature : null,
      hysteresisOn: this.config.hysteresisOn,
      hysteresisOff: this.config.hysteresisOff
    }
  }
}

module.exports = {
  DEFAULTS,
  ExternalController,
  normalizeControlConfig,
  controlStrategy,
  toPercent,
  toCelsius
}
