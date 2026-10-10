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
  timerMaxHours: 24,
  protocolDefault: '3.3'
}

/**
 * Tuya datapoints shared by AlecoAir compressor dehumidifiers (D12/D16 HOME,
 * Shinco 30D family). D13 Traditio Wi-Fi uses the same Smart Life / Tuya
 * category `cs`. Sleep on the panel is low fan + dimmed display, not a
 * separate documented DP — we treat it as a convenience command.
 */
const DEFAULT_DPS = {
  power: 1,
  mode: 2,
  humidity: 3,
  targetHumidity: 4,
  anion: 5,
  fan: 6,
  childLock: 7,
  fault: 11,
  timer: 12,
  timerLeft: 13,
  insideDry: 101
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

function clampTargetHumidity(value) {
  const n = Number(value)
  if (!Number.isFinite(n)) return D13.humidityMin
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
  clampTargetHumidity,
  humidityRatio,
  humidityPercent,
  asBool,
  asEnumString
}
