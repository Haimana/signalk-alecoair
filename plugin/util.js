'use strict'

/** Mode values used in the plugin state, the REST API and Signal K paths. */
const MODE = {
  AUTO: 'auto',
  CONTINUOUS: 'continuous',
  SLEEP: 'sleep',
  LAUNDRY: 'laundry',
  PURIFY: 'purify',
  ECO: 'eco'
}

const FAN = {
  HIGH: 'high',
  LOW: 'low'
}

function humidityRatio(percent) {
  return Number((Number(percent) / 100).toFixed(4))
}

/** Accepts a Signal K ratio (0–1) or a percentage and returns a whole percentage. */
function humidityPercent(ratioOrPercent) {
  const n = Number(ratioOrPercent)
  if (!Number.isFinite(n)) return null
  if (n > 0 && n <= 1) return Math.round(n * 100)
  return Math.round(n)
}

function asBool(value) {
  return value === true || value === 1 || value === '1' || value === 'true' || value === 'on'
}

function asEnumString(value) {
  if (value === undefined || value === null) return null
  return String(value)
}

/** Stable device key used in Signal K paths and REST routes. */
function slugKey(value, fallback = 'device') {
  const slug = String(value || '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 32)
  return slug || fallback
}

function isValidKey(value) {
  return typeof value === 'string' && /^[a-z0-9][a-z0-9_]{0,31}$/.test(value)
}

function camelKey(value) {
  return String(value || '')
    .split(/[^a-zA-Z0-9]+/)
    .filter(Boolean)
    .map((part, i) => (i === 0 ? part.toLowerCase() : part[0].toUpperCase() + part.slice(1).toLowerCase()))
    .join('')
}

module.exports = {
  MODE,
  FAN,
  humidityRatio,
  humidityPercent,
  asBool,
  asEnumString,
  slugKey,
  isValidKey,
  camelKey
}
