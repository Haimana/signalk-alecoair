'use strict'

const { ROLES, PROFILES, modelInfo } = require('./profiles')
const {
  MODE,
  FAN,
  humidityRatio,
  humidityPercent,
  asBool,
  asEnumString
} = require('./util')

/**
 * Build the per-device codec: the profile DP map merged with the user's
 * overrides from the Admin DP inspector. An override of null / '' / 0
 * removes a role.
 */
function createCodec(profile = PROFILES.generic, overrides = {}, model = null) {
  const map = {}
  for (const role of ROLES) {
    let dp = profile.dps ? profile.dps[role] : undefined
    if (overrides && Object.prototype.hasOwnProperty.call(overrides, role)) {
      const raw = overrides[role]
      dp = raw === null || raw === '' || Number(raw) === 0 || raw === undefined ? undefined : Number(raw)
    }
    if (dp !== undefined && Number.isInteger(Number(dp)) && Number(dp) > 0) map[role] = String(Number(dp))
  }
  return {
    profile,
    map,
    modes: (profile.modes || []).map((m) => ({ ...m })),
    continuous: profile.continuous || null,
    humidity: { min: 30, max: 80, step: 5, ...(profile.humidity || {}) },
    timer: profile.timer || null,
    fan: profile.fan || { low: 'low', high: 'high' },
    fault: profile.fault || {},
    nameplate: modelInfo(profile, model),
    learnedRaw: {}
  }
}

function emptyState() {
  return {
    connected: false,
    power: false,
    mode: MODE.AUTO,
    modeRaw: null,
    humidity: null,
    temperature: null,
    targetHumidity: 50,
    fan: FAN.LOW,
    childLock: false,
    tankFull: false,
    defrost: false,
    faultCode: 0,
    timerHours: 0,
    timerRemainingMin: 0,
    sleep: false,
    insideDry: false,
    compressor: false,
    powerWatts: 0,
    tankLiters: 0,
    lastError: null,
    rawDps: {}
  }
}

function sameRaw(a, b) {
  return String(a).toLowerCase() === String(b).toLowerCase()
}

function findModeByRaw(codec, raw) {
  for (const entry of codec.modes) {
    const candidates = [entry.raw, ...(entry.aliases || [])]
    if (candidates.some((c) => sameRaw(c, raw))) return entry
  }
  return null
}

function isContinuousTarget(value, codec) {
  if (!codec.continuous || codec.continuous.via !== 'target') return false
  const n = Number(value)
  if (!Number.isFinite(n)) return false
  return n < codec.humidity.min || n > codec.humidity.max
}

function clampTargetHumidity(value, codec) {
  const { min, max, step } = codec.humidity
  const n = Number(value)
  if (!Number.isFinite(n)) return min
  if (isContinuousTarget(n, codec)) return codec.continuous.target
  const stepped = Math.round(n / step) * step
  return Math.min(max, Math.max(min, stepped))
}

function decodeTimer(raw, codec) {
  if (raw === undefined || raw === null || raw === false) return 0
  if (raw === 'cancel') return 0
  if (codec && codec.timer && codec.timer.format === 'number') return Math.max(0, Number(raw) || 0)
  const match = String(raw).match(/(\d+)/)
  return match ? Number(match[1]) : 0
}

function encodeTimer(hours, codec) {
  const max = (codec.timer && codec.timer.max) || 24
  const n = Math.min(max, Math.max(0, Math.round(Number(hours) || 0)))
  if (codec.timer && codec.timer.format === 'number') return String(n)
  return n <= 0 ? 'cancel' : `${n}h`
}

function decodeFan(raw, codec) {
  const v = asEnumString(raw)
  if (v !== null && sameRaw(v, codec.fan.high)) return FAN.HIGH
  return FAN.LOW
}

function encodeFan(fan, codec) {
  return fan === FAN.HIGH ? codec.fan.high : codec.fan.low
}

function decodeFault(code, codec) {
  const n = Number(code) || 0
  const bits = codec.fault || {}
  return {
    faultCode: n,
    tankFull: bits.tankFull ? (n & bits.tankFull) === bits.tankFull : false,
    defrost: bits.defrost ? (n & bits.defrost) === bits.defrost : false
  }
}

/** Which controls and sensors this device has: mapped by the profile AND reported by the device. */
function capabilities(codec, reported) {
  const seen = reported instanceof Set ? reported : new Set((reported || []).map(String))
  const has = (role) => codec.map[role] != null && seen.has(codec.map[role])
  const modes = []
  if (has('mode')) {
    for (const m of codec.modes) modes.push({ value: m.value, label: m.label || m.value })
  }
  if (codec.continuous) {
    const ok = codec.continuous.via === 'target' ? has('targetHumidity') && has('mode') : has('mode')
    if (ok) modes.splice(Math.min(1, modes.length), 0, { value: MODE.CONTINUOUS, label: codec.continuous.label || 'Continuous' })
  }
  const sleepMode = modes.some((m) => m.value === MODE.SLEEP)
  const controls = {
    power: has('power'),
    mode: modes.length > 0,
    targetHumidity: has('targetHumidity'),
    fan: has('fan'),
    childLock: has('childLock'),
    timer: has('timer') && Boolean(codec.timer),
    insideDry: has('insideDry'),
    sleep: has('sleep') || sleepMode
  }
  const sensors = {
    humidity: has('humidity'),
    temperature: has('temperature'),
    fault: has('fault'),
    tankFull: has('fault') && Boolean(codec.fault.tankFull),
    defrost: has('fault') && Boolean(codec.fault.defrost),
    timerLeft: has('timerLeft'),
    compressor: has('power') && has('humidity') && has('targetHumidity'),
    powerWatts: Boolean(codec.nameplate && codec.nameplate.ratedWatts) && has('power')
  }
  return { controls, sensors, modes }
}

function applyDps(state, dps, codec) {
  const next = { ...state, rawDps: { ...state.rawDps, ...dps } }
  const map = codec.map
  const val = (role) => (map[role] != null ? dps[map[role]] : undefined)

  if (val('power') !== undefined) next.power = asBool(val('power'))
  if (val('mode') !== undefined) {
    const raw = val('mode')
    next.modeRaw = asEnumString(raw)
    const entry = findModeByRaw(codec, raw)
    if (entry) {
      next.mode = entry.value
      codec.learnedRaw[entry.value] = String(raw)
    } else if (codec.continuous && codec.continuous.via === 'mode' && sameRaw(codec.continuous.raw, raw)) {
      next.mode = MODE.CONTINUOUS
    } else {
      next.mode = 'unknown'
    }
  }
  if (val('humidity') !== undefined) {
    const h = Number(val('humidity'))
    if (Number.isFinite(h)) next.humidity = h
  }
  if (val('temperature') !== undefined) {
    const t = Number(val('temperature'))
    if (Number.isFinite(t)) next.temperature = t
  }
  if (val('targetHumidity') !== undefined) {
    const raw = val('targetHumidity')
    if (isContinuousTarget(raw, codec)) next.targetHumidity = codec.continuous.target
    else next.targetHumidity = clampTargetHumidity(raw, codec)
  }
  // Continuous expressed as a target sentinel (Traditio CO = 25).
  if (codec.continuous && codec.continuous.via === 'target') {
    const autoEntry = codec.modes[0]
    if (isContinuousTarget(next.targetHumidity, codec)) {
      if (!autoEntry || next.mode === autoEntry.value || next.mode === MODE.CONTINUOUS) next.mode = MODE.CONTINUOUS
    } else if (next.mode === MODE.CONTINUOUS) {
      next.mode = autoEntry ? autoEntry.value : MODE.AUTO
    }
  }
  if (val('fan') !== undefined) next.fan = decodeFan(val('fan'), codec)
  if (val('childLock') !== undefined) next.childLock = asBool(val('childLock'))
  if (val('fault') !== undefined) Object.assign(next, decodeFault(val('fault'), codec))
  if (val('timer') !== undefined) {
    next.timerHours = decodeTimer(val('timer'), codec)
    if (map.timerLeft == null || dps[map.timerLeft] === undefined) next.timerRemainingMin = next.timerHours * 60
  }
  if (val('timerLeft') !== undefined) next.timerRemainingMin = Number(val('timerLeft')) || 0
  if (val('insideDry') !== undefined) next.insideDry = asBool(val('insideDry'))
  if (map.sleep != null) {
    if (val('sleep') !== undefined) next.sleep = asBool(val('sleep'))
  } else {
    next.sleep = next.mode === MODE.SLEEP
  }
  return refreshDerived(next, codec)
}

function modeRaw(codec, value) {
  const entry = codec.modes.find((m) => m.value === value)
  if (!entry) return undefined
  return codec.learnedRaw[entry.value] || entry.raw
}

/** Encode a command into DPs. Throws on unknown fields and on controls the profile has no DP for. */
function commandToDps(command, codec) {
  if (!command || typeof command !== 'object') throw new Error('Command must be an object.')
  const map = codec.map
  const data = {}
  const need = (role, label) => {
    if (map[role] == null) throw new Error(`${label} is not supported by this device profile.`)
    return map[role]
  }
  let recognized = false

  if (command.power !== undefined) {
    recognized = true
    data[need('power', 'Power')] = asBool(command.power)
  }
  if (command.mode !== undefined) {
    recognized = true
    const mode = String(command.mode)
    if (mode === MODE.CONTINUOUS) {
      if (!codec.continuous) throw new Error('Continuous mode is not supported by this device profile.')
      if (codec.continuous.via === 'target') {
        data[need('targetHumidity', 'Target humidity')] = codec.continuous.target
        const autoRaw = codec.modes[0] ? modeRaw(codec, codec.modes[0].value) : undefined
        if (autoRaw !== undefined) data[need('mode', 'Mode')] = autoRaw
      } else {
        data[need('mode', 'Mode')] = codec.continuous.raw
      }
    } else if (mode === MODE.SLEEP && !codec.modes.some((m) => m.value === MODE.SLEEP) && map.sleep != null) {
      data[map.sleep] = true
    } else {
      const raw = modeRaw(codec, mode)
      if (raw === undefined) throw new Error(`Unknown mode: ${mode}`)
      data[need('mode', 'Mode')] = raw
    }
  }
  if (command.targetHumidity !== undefined) {
    recognized = true
    const pct = humidityPercent(command.targetHumidity)
    data[need('targetHumidity', 'Target humidity')] = clampTargetHumidity(pct ?? command.targetHumidity, codec)
  }
  if (command.fan !== undefined) {
    recognized = true
    const fan = String(command.fan)
    if (fan !== FAN.LOW && fan !== FAN.HIGH) throw new Error(`Unknown fan: ${fan}`)
    data[need('fan', 'Fan speed')] = encodeFan(fan, codec)
  }
  if (command.childLock !== undefined) {
    recognized = true
    data[need('childLock', 'Child lock')] = asBool(command.childLock)
  }
  if (command.timerHours !== undefined) {
    recognized = true
    if (!codec.timer) throw new Error('Timer is not supported by this device profile.')
    data[need('timer', 'Timer')] = encodeTimer(command.timerHours, codec)
  }
  if (command.insideDry !== undefined) {
    recognized = true
    data[need('insideDry', 'Inside dry')] = asBool(command.insideDry)
  }
  if (command.sleep !== undefined) {
    recognized = true
    const on = asBool(command.sleep)
    if (map.sleep != null) {
      data[map.sleep] = on
    } else if (codec.modes.some((m) => m.value === MODE.SLEEP)) {
      const target = on ? MODE.SLEEP : codec.modes[0].value
      data[need('mode', 'Mode')] = modeRaw(codec, target)
    } else {
      throw new Error('Sleep is not supported by this device profile.')
    }
  }
  if (!recognized) throw new Error('No recognized fields in command.')
  return data
}

function applyCommandToState(state, command, codec) {
  const next = { ...state }
  if (command.power !== undefined) next.power = asBool(command.power)
  if (command.mode !== undefined) {
    next.mode = String(command.mode)
    if (codec.map.sleep == null) next.sleep = next.mode === MODE.SLEEP
    else if (next.mode === MODE.SLEEP) next.sleep = true
    if (next.mode === MODE.CONTINUOUS && codec.continuous && codec.continuous.via === 'target') {
      next.targetHumidity = codec.continuous.target
    }
  }
  if (command.sleep !== undefined) {
    next.sleep = asBool(command.sleep)
    if (codec.map.sleep == null) next.mode = next.sleep ? MODE.SLEEP : (codec.modes[0] ? codec.modes[0].value : MODE.AUTO)
  }
  if (command.targetHumidity !== undefined) {
    const raw = humidityPercent(command.targetHumidity) ?? command.targetHumidity
    if (isContinuousTarget(raw, codec)) {
      next.mode = MODE.CONTINUOUS
      next.targetHumidity = codec.continuous.target
    } else {
      next.targetHumidity = clampTargetHumidity(raw, codec)
      if (next.mode === MODE.CONTINUOUS && codec.continuous && codec.continuous.via === 'target') {
        next.mode = codec.modes[0] ? codec.modes[0].value : MODE.AUTO
      }
    }
  }
  if (command.fan !== undefined) next.fan = String(command.fan)
  if (command.childLock !== undefined) next.childLock = asBool(command.childLock)
  if (command.timerHours !== undefined) {
    const max = (codec.timer && codec.timer.max) || 24
    next.timerHours = Math.min(max, Math.max(0, Math.round(Number(command.timerHours) || 0)))
    next.timerRemainingMin = next.timerHours * 60
  }
  if (command.insideDry !== undefined) next.insideDry = asBool(command.insideDry)
  return refreshDerived(next, codec)
}

function refreshDerived(state, codec) {
  const next = { ...state }
  if (!next.power || next.tankFull || next.defrost) {
    next.compressor = false
  } else if (next.mode === MODE.CONTINUOUS) {
    next.compressor = true
  } else if (next.humidity === null || next.humidity === undefined) {
    next.compressor = false
  } else {
    next.compressor = Number(next.humidity) > Number(next.targetHumidity) + 1
  }
  const plate = codec && codec.nameplate
  if (!plate || !plate.ratedWatts) {
    next.powerWatts = null
  } else if (!next.power) next.powerWatts = 0
  else if (next.tankFull) next.powerWatts = plate.tankFullWatts ?? 2
  else if (next.defrost) next.powerWatts = plate.defrostWatts ?? 28
  else if (next.compressor) next.powerWatts = next.sleep ? (plate.sleepWatts ?? plate.ratedWatts) : plate.ratedWatts
  else next.powerWatts = plate.idleWatts ?? 0
  next.updatedAt = Date.now()
  return next
}

function skPaths(prefix) {
  const root = String(prefix || 'environment.inside.dehumidifier').replace(/\.$/, '')
  return {
    connected: `${root}.connected`,
    power: `${root}.power`,
    mode: `${root}.mode`,
    humidity: `${root}.humidity`,
    temperature: `${root}.temperature`,
    targetHumidity: `${root}.targetHumidity`,
    fan: `${root}.fanSpeed`,
    childLock: `${root}.childLock`,
    tankFull: `${root}.tankFull`,
    defrost: `${root}.defrost`,
    faultCode: `${root}.faultCode`,
    timerHours: `${root}.timerHours`,
    timerRemaining: `${root}.timerRemaining`,
    sleep: `${root}.sleep`,
    insideDry: `${root}.insideDry`,
    compressor: `${root}.compressor`,
    powerWatts: `${root}.electricalPower`,
    tankLiters: `${root}.tankVolume`,
    notificationTankFull: `notifications.${root}.tankFull`
  }
}

/** Signal K values for one device. Only paths the device actually has are published. */
function stateToValues(state, caps, options = {}) {
  const paths = skPaths(options.pathPrefix)
  const { controls, sensors } = caps
  const values = [{ path: paths.connected, value: Boolean(state.connected) }]
  const push = (ok, path, value) => { if (ok) values.push({ path, value }) }
  const hasHumidity = sensors.humidity && Number.isFinite(Number(state.humidity)) && state.humidity !== null

  push(controls.power, paths.power, Boolean(state.power))
  push(controls.mode, paths.mode, state.mode)
  push(hasHumidity, paths.humidity, humidityRatio(state.humidity))
  push(sensors.temperature && state.temperature !== null, paths.temperature, Number((Number(state.temperature) + 273.15).toFixed(2)))
  push(controls.targetHumidity, paths.targetHumidity, humidityRatio(state.targetHumidity))
  push(controls.fan, paths.fan, state.fan)
  push(controls.childLock, paths.childLock, Boolean(state.childLock))
  push(sensors.tankFull, paths.tankFull, Boolean(state.tankFull))
  push(sensors.defrost, paths.defrost, Boolean(state.defrost))
  push(sensors.fault, paths.faultCode, Number(state.faultCode) || 0)
  push(controls.timer, paths.timerHours, Number(state.timerHours) || 0)
  push(controls.timer || sensors.timerLeft, paths.timerRemaining, (Number(state.timerRemainingMin) || 0) * 60)
  push(controls.sleep, paths.sleep, Boolean(state.sleep))
  push(controls.insideDry, paths.insideDry, Boolean(state.insideDry))
  push(sensors.compressor, paths.compressor, Boolean(state.compressor))
  push(sensors.powerWatts, paths.powerWatts, Number(state.powerWatts) || 0)
  push(Boolean(options.simulate), paths.tankLiters, Number(state.tankLiters) || 0)

  if (options.publishCabinHumidity && options.cabinHumidityPath && hasHumidity) {
    values.push({ path: options.cabinHumidityPath, value: humidityRatio(state.humidity) })
  }
  if (options.electricalPath && sensors.powerWatts) {
    values.push({ path: options.electricalPath, value: Number(state.powerWatts) || 0 })
  }
  return values
}

function metadata(caps, options = {}) {
  const paths = skPaths(options.pathPrefix)
  const name = options.displayName || 'Dehumidifier'
  const { controls, sensors, modes } = caps
  const range = options.humidityRange || { min: 30, max: 80 }
  const plate = options.nameplate || null
  const meta = [
    { path: paths.connected, value: { description: `${name}: LAN connection`, displayName: 'Connected' } }
  ]
  const add = (ok, path, value) => { if (ok) meta.push({ path, value }) }
  add(controls.power, paths.power, { description: `${name}: power`, displayName: 'Power' })
  add(controls.mode, paths.mode, {
    description: `${name}: ${modes.map((m) => m.value).join(' | ')}`,
    displayName: 'Mode',
    type: 'multiple',
    possibleValues: modes.map((m) => ({ title: m.label, value: m.value }))
  })
  add(sensors.humidity, paths.humidity, { units: 'ratio', description: `${name}: relative humidity measured by the unit`, displayName: 'Humidity' })
  add(sensors.temperature, paths.temperature, { units: 'K', description: `${name}: temperature measured by the unit`, displayName: 'Temperature' })
  add(controls.targetHumidity, paths.targetHumidity, {
    units: 'ratio',
    description: `${name}: hygrostat target (${range.min}–${range.max}%)`,
    displayName: 'Target humidity',
    displayScale: { lower: range.min / 100, upper: range.max / 100 }
  })
  add(controls.fan, paths.fan, { description: `${name}: low | high`, displayName: 'Fan' })
  add(controls.childLock, paths.childLock, { description: `${name}: child lock`, displayName: 'Child lock' })
  add(controls.timer, paths.timerHours, { description: `${name}: off timer in hours (0 = off)`, displayName: 'Timer' })
  add(controls.timer || sensors.timerLeft, paths.timerRemaining, { units: 's', description: `${name}: timer remaining`, displayName: 'Timer remaining' })
  add(controls.sleep, paths.sleep, { description: `${name}: sleep`, displayName: 'Sleep' })
  add(controls.insideDry, paths.insideDry, { description: `${name}: inside dry`, displayName: 'Inside dry' })
  add(sensors.tankFull, paths.tankFull, {
    description: plate && plate.tankLiters ? `${name}: the ${plate.tankLiters} L tank is full` : `${name}: tank full`,
    displayName: 'Tank full'
  })
  add(sensors.defrost, paths.defrost, { description: `${name}: automatic defrost`, displayName: 'Defrost' })
  add(sensors.fault, paths.faultCode, { description: `${name}: raw fault bitmask`, displayName: 'Fault code' })
  add(sensors.compressor, paths.compressor, { description: `${name}: compressor running (estimated)`, displayName: 'Compressor' })
  add(sensors.powerWatts, paths.powerWatts, {
    units: 'W',
    description: `${name}: estimated power (${plate && plate.ratedWatts} W rated)`,
    displayName: 'Power draw'
  })
  add(Boolean(options.simulate), paths.tankLiters, { description: `${name}: simulated tank level in litres (simulator only)` })
  return meta
}

function notifications(state, caps, options = {}) {
  if (!caps.sensors.tankFull) return []
  const path = skPaths(options.pathPrefix).notificationTankFull
  const name = options.displayName || 'Dehumidifier'
  const plate = options.nameplate
  if (state.tankFull) {
    const tank = plate && plate.tankLiters ? `the ${plate.tankLiters} L tank` : 'the tank'
    return [{
      path,
      value: {
        state: 'alert',
        method: ['visual', 'sound'],
        message: `${name}: ${tank} is full. Empty it so the unit can restart.`
      }
    }]
  }
  return [{ path, value: { state: 'normal', method: [], message: `${name}: tank OK` } }]
}

function publicState(state, codec, caps) {
  const plate = codec.nameplate || {}
  return {
    connected: Boolean(state.connected),
    power: Boolean(state.power),
    mode: state.mode,
    modeRaw: state.modeRaw,
    humidity: state.humidity === null || state.humidity === undefined ? null : Math.round(Number(state.humidity) || 0),
    humidityRatio: state.humidity === null || state.humidity === undefined ? null : humidityRatio(state.humidity),
    temperature: state.temperature,
    targetHumidity: state.targetHumidity,
    fan: state.fan,
    childLock: Boolean(state.childLock),
    tankFull: Boolean(state.tankFull),
    defrost: Boolean(state.defrost),
    faultCode: Number(state.faultCode) || 0,
    timerHours: Number(state.timerHours) || 0,
    timerRemainingMin: Math.max(0, Math.round(Number(state.timerRemainingMin) || 0)),
    sleep: Boolean(state.sleep),
    insideDry: Boolean(state.insideDry),
    compressor: Boolean(state.compressor),
    powerWatts: state.powerWatts === null || state.powerWatts === undefined ? null : Number(state.powerWatts) || 0,
    tankLiters: Number(Number(state.tankLiters || 0).toFixed(2)),
    tankLitersMax: plate.tankLiters || null,
    ratedWatts: plate.ratedWatts || null,
    capacityLitersPerDay: plate.capacityLitersPerDay || null,
    model: plate.name || null,
    controls: caps.controls,
    sensors: caps.sensors,
    modes: caps.modes,
    humidityRange: { ...codec.humidity },
    timerMaxHours: codec.timer ? codec.timer.max : 0,
    continuousTarget: codec.continuous && codec.continuous.via === 'target' ? codec.continuous.target : null,
    lastError: state.lastError || null,
    updatedAt: state.updatedAt || null
  }
}

module.exports = {
  createCodec,
  emptyState,
  capabilities,
  applyDps,
  commandToDps,
  applyCommandToState,
  isContinuousTarget,
  clampTargetHumidity,
  decodeTimer,
  encodeTimer,
  decodeFan,
  encodeFan,
  decodeFault,
  refreshDerived,
  stateToValues,
  metadata,
  notifications,
  publicState,
  skPaths
}
