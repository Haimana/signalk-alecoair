'use strict'

const {
  D13,
  MODE,
  FAN,
  FAULT,
  mergeDps,
  clampTargetHumidity,
  humidityRatio,
  humidityPercent,
  asBool,
  asEnumString
} = require('./profile')

function emptyState() {
  return {
    connected: false,
    power: false,
    mode: MODE.AUTO,
    humidity: 55,
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

function decodeMode(raw) {
  const v = asEnumString(raw)
  if (v === '1') return MODE.CONTINUOUS
  return MODE.AUTO
}

function encodeMode(mode) {
  return mode === MODE.CONTINUOUS ? '1' : '0'
}

function decodeFan(raw) {
  const v = asEnumString(raw)
  // AlecoAir / Shinco: "0" high, "1" low
  if (v === '0') return FAN.HIGH
  return FAN.LOW
}

function encodeFan(fan) {
  return fan === FAN.HIGH ? '0' : '1'
}

function decodeFault(code) {
  const n = Number(code) || 0
  return {
    faultCode: n,
    tankFull: (n & FAULT.TANK_FULL) === FAULT.TANK_FULL,
    defrost: (n & FAULT.DEFROST) === FAULT.DEFROST
  }
}

function applyDps(state, dps, dpsMap = DEFAULT_MAP) {
  const next = { ...state, rawDps: { ...state.rawDps, ...dps } }
  const map = dpsMap

  if (dps[map.power] !== undefined) next.power = asBool(dps[map.power])
  if (dps[map.mode] !== undefined) next.mode = decodeMode(dps[map.mode])
  if (dps[map.humidity] !== undefined) {
    const h = Number(dps[map.humidity])
    if (Number.isFinite(h)) next.humidity = h
  }
  if (dps[map.targetHumidity] !== undefined) {
    next.targetHumidity = clampTargetHumidity(dps[map.targetHumidity])
  }
  if (dps[map.fan] !== undefined) next.fan = decodeFan(dps[map.fan])
  if (dps[map.childLock] !== undefined) next.childLock = asBool(dps[map.childLock])
  if (dps[map.fault] !== undefined) Object.assign(next, decodeFault(dps[map.fault]))
  if (dps[map.timer] !== undefined) next.timerHours = Number(dps[map.timer]) || 0
  if (dps[map.timerLeft] !== undefined) next.timerRemainingMin = Number(dps[map.timerLeft]) || 0
  if (dps[map.insideDry] !== undefined) next.insideDry = asBool(dps[map.insideDry])

  if (next.mode === MODE.CONTINUOUS) next.sleep = false
  if (next.fan === FAN.HIGH) next.sleep = false
  return next
}

const DEFAULT_MAP = mergeDps()

function commandToDps(command, dpsMap = DEFAULT_MAP) {
  const data = {}
  if (!command || typeof command !== 'object') {
    throw new Error('Comanda trebuie să fie un obiect.')
  }

  if (command.power !== undefined) data[dpsMap.power] = asBool(command.power)
  if (command.mode !== undefined) {
    const mode = String(command.mode)
    if (mode === MODE.SLEEP) {
      data[dpsMap.fan] = encodeFan(FAN.LOW)
    } else if (mode === MODE.AUTO || mode === MODE.CONTINUOUS) {
      data[dpsMap.mode] = encodeMode(mode)
    } else {
      throw new Error(`Mod necunoscut: ${mode}`)
    }
  }
  if (command.targetHumidity !== undefined) {
    data[dpsMap.targetHumidity] = clampTargetHumidity(humidityPercent(command.targetHumidity) ?? command.targetHumidity)
  }
  if (command.fan !== undefined) {
    const fan = String(command.fan)
    if (fan !== FAN.LOW && fan !== FAN.HIGH) throw new Error(`Ventilator necunoscut: ${fan}`)
    data[dpsMap.fan] = encodeFan(fan)
  }
  if (command.childLock !== undefined) data[dpsMap.childLock] = asBool(command.childLock)
  if (command.timerHours !== undefined) {
    const hours = Math.min(D13.timerMaxHours, Math.max(0, Math.round(Number(command.timerHours) || 0)))
    data[dpsMap.timer] = String(hours)
  }
  if (command.insideDry !== undefined) data[dpsMap.insideDry] = asBool(command.insideDry)
  if (command.sleep !== undefined) {
    if (asBool(command.sleep)) data[dpsMap.fan] = encodeFan(FAN.LOW)
  }

  if (Object.keys(data).length === 0) {
    throw new Error('Niciun câmp recunoscut în comandă.')
  }
  return data
}

function applyCommandToState(state, command) {
  const next = { ...state }
  if (command.power !== undefined) next.power = asBool(command.power)
  if (command.mode === MODE.SLEEP || command.sleep === true) {
    next.sleep = true
    next.fan = FAN.LOW
  } else if (command.mode === MODE.AUTO || command.mode === MODE.CONTINUOUS) {
    next.mode = command.mode
    next.sleep = false
  }
  if (command.targetHumidity !== undefined) {
    next.targetHumidity = clampTargetHumidity(humidityPercent(command.targetHumidity) ?? command.targetHumidity)
  }
  if (command.fan !== undefined) {
    next.fan = String(command.fan)
    if (next.fan === FAN.HIGH) next.sleep = false
  }
  if (command.childLock !== undefined) next.childLock = asBool(command.childLock)
  if (command.timerHours !== undefined) {
    next.timerHours = Math.min(D13.timerMaxHours, Math.max(0, Math.round(Number(command.timerHours) || 0)))
    next.timerRemainingMin = next.timerHours * 60
  }
  if (command.insideDry !== undefined) next.insideDry = asBool(command.insideDry)
  if (command.sleep === false) next.sleep = false
  return next
}

function skPaths(prefix) {
  const root = prefix.replace(/\.$/, '')
  return {
    connected: `${root}.connected`,
    power: `${root}.power`,
    mode: `${root}.mode`,
    humidity: `${root}.humidity`,
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
    tankLiters: `${root}.tankVolume`
  }
}

function stateToValues(state, options = {}) {
  const prefix = options.pathPrefix || 'environment.inside.dehumidifier'
  const paths = skPaths(prefix)
  const values = [
    { path: paths.connected, value: Boolean(state.connected) },
    { path: paths.power, value: Boolean(state.power) },
    { path: paths.mode, value: state.mode },
    { path: paths.humidity, value: humidityRatio(state.humidity) },
    { path: paths.targetHumidity, value: humidityRatio(state.targetHumidity) },
    { path: paths.fan, value: state.fan },
    { path: paths.childLock, value: Boolean(state.childLock) },
    { path: paths.tankFull, value: Boolean(state.tankFull) },
    { path: paths.defrost, value: Boolean(state.defrost) },
    { path: paths.faultCode, value: Number(state.faultCode) || 0 },
    { path: paths.timerHours, value: Number(state.timerHours) || 0 },
    { path: paths.timerRemaining, value: (Number(state.timerRemainingMin) || 0) * 60 },
    { path: paths.sleep, value: Boolean(state.sleep) },
    { path: paths.insideDry, value: Boolean(state.insideDry) },
    { path: paths.compressor, value: Boolean(state.compressor) },
    { path: paths.powerWatts, value: Number(state.powerWatts) || 0 },
    { path: paths.tankLiters, value: Number(state.tankLiters) || 0 }
  ]

  if (options.publishCabinHumidity !== false) {
    values.push({
      path: options.cabinHumidityPath || 'environment.inside.humidity',
      value: humidityRatio(state.humidity)
    })
  }

  if (options.electricalPath) {
    values.push({ path: options.electricalPath, value: Number(state.powerWatts) || 0 })
  }

  return values
}

function metadata(options = {}) {
  const prefix = options.pathPrefix || 'environment.inside.dehumidifier'
  const paths = skPaths(prefix)
  const meta = [
    { path: paths.humidity, value: { units: 'ratio', description: 'Umiditate relativă măsurată de D13', displayName: 'Umiditate cabină' } },
    { path: paths.targetHumidity, value: { units: 'ratio', description: 'Umiditate țintă higrostat (30–80%)', displayName: 'Umiditate țintă' } },
    { path: paths.power, value: { units: 'bool', description: 'Alimentare dezumidificator', displayName: 'Pornit', supportsPut: true } },
    { path: paths.mode, value: { description: 'auto | continuous | sleep', displayName: 'Mod', supportsPut: true } },
    { path: paths.fan, value: { description: 'low | high', displayName: 'Ventilator', supportsPut: true } },
    { path: paths.targetHumidity, value: { units: 'ratio', supportsPut: true, description: 'Umiditate țintă' } },
    { path: paths.childLock, value: { units: 'bool', supportsPut: true, displayName: 'Child lock' } },
    { path: paths.timerHours, value: { units: 'h', supportsPut: true, displayName: 'Timer' } },
    { path: paths.sleep, value: { units: 'bool', supportsPut: true, displayName: 'Sleep' } },
    { path: paths.insideDry, value: { units: 'bool', supportsPut: true, displayName: 'Uscare internă' } },
    { path: paths.tankFull, value: { units: 'bool', description: 'Rezervor 2.3 L plin' } },
    { path: paths.defrost, value: { units: 'bool', description: 'Dejivrare automată' } },
    { path: paths.powerWatts, value: { units: 'W', description: 'Putere estimată (170 W la 30°C / 80% RH)' } },
    { path: paths.timerRemaining, value: { units: 's' } },
    { path: paths.tankLiters, value: { units: 'L' } }
  ]
  return meta
}

function notifications(state, options = {}) {
  const path = options.notificationPath || 'notifications.environment.inside.dehumidifier.tankFull'
  if (state.tankFull) {
    return [{
      path,
      value: {
        state: 'alert',
        method: ['visual', 'sound'],
        message: 'ALECOAIR D13: rezervorul de 2,3 L este plin. Golește-l ca aparatul să repornească.'
      }
    }]
  }
  return [{
    path,
    value: { state: 'normal', message: 'Rezervor OK' }
  }]
}

function publicState(state) {
  return {
    model: D13.model,
    brand: D13.brand,
    connected: Boolean(state.connected),
    power: Boolean(state.power),
    mode: state.mode,
    humidity: state.humidity,
    humidityRatio: humidityRatio(state.humidity),
    targetHumidity: state.targetHumidity,
    fan: state.fan,
    childLock: Boolean(state.childLock),
    tankFull: Boolean(state.tankFull),
    defrost: Boolean(state.defrost),
    faultCode: Number(state.faultCode) || 0,
    timerHours: Number(state.timerHours) || 0,
    timerRemainingMin: Number(state.timerRemainingMin) || 0,
    sleep: Boolean(state.sleep),
    insideDry: Boolean(state.insideDry),
    compressor: Boolean(state.compressor),
    powerWatts: Number(state.powerWatts) || 0,
    tankLiters: Number(Number(state.tankLiters || 0).toFixed(2)),
    tankLitersMax: D13.tankLiters,
    ratedWatts: D13.ratedWatts,
    capacityLitersPerDay: D13.capacityLitersPerDay,
    lastError: state.lastError || null,
    rawDps: state.rawDps || {}
  }
}

module.exports = {
  emptyState,
  applyDps,
  commandToDps,
  applyCommandToState,
  decodeMode,
  encodeMode,
  decodeFan,
  encodeFan,
  decodeFault,
  stateToValues,
  metadata,
  notifications,
  publicState,
  skPaths
}
