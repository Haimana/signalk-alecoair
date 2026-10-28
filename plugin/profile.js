'use strict'

/** Factory defaults for ALECOAIR D13 Traditio (manual + AlecoAir Tuya family). */
const D13 = {
  brand: 'ALECOAIR',
  model: 'D13 Traditio',
  capacityLitersPerDay: 13,
  ratedWatts: 170,
  maxWatts: 195,
  idleWatts: 18,
  tankLiters: 2.3,
  airflowLowM3h: 70,
  airflowHighM3h: 95,
  humidityMin: 30,
  humidityMax: 80,
  humidityStep: 5,
  continuousTarget: 25,
  timerMaxHours: 24,
  protocolDefault: '3.5',
  protocolVersions: ['3.5', '3.4', '3.3']
}

/**
 * Live D13 Traditio LAN map (Tuya 3.5). Older Shinco-style IDs wrote fan
 * onto the humidity DP and never completed a 3.5 session.
 */
const DEFAULT_DPS = {
  power: 1,
  targetHumidity: 2,
  mode: 5,
  humidity: 6,
  childLock: 16,
  timer: 17,
  fault: 19
}

const MODE = {
  AUTO: 'auto',
  CONTINUOUS: 'continuous',
  SLEEP: 'sleep'
}

const FAN = {
  HIGH: 'high',
  LOW: 'low'
}

const FAULT = {
  DEFROST: 4,
  TANK_FULL: 8
}

function mergeDps(overrides = {}) {
  return { ...DEFAULT_DPS, ...overrides }
}

function availableControls(dpsMap = DEFAULT_DPS) {
  return {
    power: dpsMap.power != null,
    mode: dpsMap.mode != null,
    targetHumidity: dpsMap.targetHumidity != null,
    fan: dpsMap.fan != null,
    childLock: dpsMap.childLock != null,
    timer: dpsMap.timer != null,
    insideDry: dpsMap.insideDry != null,
    sleep: dpsMap.sleep != null || dpsMap.mode != null
  }
}

function isContinuousTarget(value) {
  const n = Number(value)
  if (!Number.isFinite(n)) return false
  return n < D13.humidityMin || n > D13.humidityMax
}

function clampTargetHumidity(value) {
  const n = Number(value)
  if (!Number.isFinite(n)) return D13.humidityMin
  if (isContinuousTarget(n)) return D13.continuousTarget
  const stepped = Math.round(n / D13.humidityStep) * D13.humidityStep
  return Math.min(D13.humidityMax, Math.max(D13.humidityMin, stepped))
}

function humidityRatio(percent) {
  return Number((Number(percent) / 100).toFixed(4))
}

function humidityPercent(ratioOrPercent) {
  const n = Number(ratioOrPercent)
  if (!Number.isFinite(n)) return null
  if (n > 0 && n <= 1) return Math.round(n * 100)
  return Math.round(n)
}

function asBool(value) {
  if (value === true || value === 1 || value === '1' || value === 'true' || value === 'on') {
    return true
  }
  return false
}

function asEnumString(value) {
  if (value === undefined || value === null) return null
  return String(value)
}

module.exports = {
  D13,
  DEFAULT_DPS,
  MODE,
  FAN,
  FAULT,
  mergeDps,
  availableControls,
  isContinuousTarget,
  clampTargetHumidity,
  humidityRatio,
  humidityPercent,
  asBool,
  asEnumString
}
