'use strict'

/**
 * Plugin options (the Admin-visible configuration) and migration from the
 * flat single-device signalk-alecoair-d13 options.
 *
 * Plugin options are the single source of truth for connection settings
 * (IP, protocol, profile, paths). The side store never overrides them; it only
 * holds secrets and learned facts (see store.js).
 */

const fs = require('fs')
const path = require('path')
const { ROLES, PROFILES, getProfile } = require('./profiles')
const { isLanIp } = require('./scan')
const { slugKey, isValidKey, camelKey } = require('./util')

const PLUGIN_ID = 'signalk-alecoair'
const LEGACY_PLUGIN_ID = 'signalk-alecoair-d13'
const CONFIG_VERSION = 2
const DEFAULT_PREFIX = 'environment.inside.dehumidifier'
const PROTOCOLS = ['auto', '3.3', '3.4', '3.5']
const LEGACY_FIELDS = ['deviceId', 'deviceName', 'ip', 'version', 'pathPrefix', 'publishCabinHumidity', 'cabinHumidityPath', 'electricalPath', 'pollSeconds', 'dps', 'simulate']

function isLegacyOptions(options) {
  if (!options || typeof options !== 'object') return false
  if (Array.isArray(options.devices)) return false
  return LEGACY_FIELDS.some((f) => options[f] !== undefined)
}

/** Read the old plugin's Admin config file (<configPath>/plugin-config-data/signalk-alecoair-d13.json). */
function readLegacyPluginConfig(dataRoot) {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(dataRoot, `${LEGACY_PLUGIN_ID}.json`), 'utf8'))
    return raw && typeof raw.configuration === 'object' && raw.configuration ? raw.configuration : null
  } catch {
    return null
  }
}

function defaultPaths(key) {
  return {
    prefix: `${DEFAULT_PREFIX}.${key}`,
    electrical: `electrical.loads.${camelKey(`dehumidifier ${key}`)}.power`,
    publishCabinHumidity: false,
    cabinHumidity: 'environment.inside.relativeHumidity'
  }
}

/** A new device entry as Admin adds it after the AlecoAir login. */
function newDevice({ key, name, tuyaId, productId = '', ip = '', profile = 'auto', model = '' } = {}) {
  const k = isValidKey(key) ? key : slugKey(name || tuyaId)
  return normalizeDevice({
    key: k,
    enabled: true,
    name: name || k,
    tuyaId,
    productId,
    ip: isLanIp(ip) ? ip : '',
    protocol: 'auto',
    profile,
    model,
    pollSeconds: 8,
    dpOverrides: {},
    paths: defaultPaths(k)
  })
}

/**
 * Convert the old flat options (+ the old store, whose values used to win)
 * into v2 options with one device, key `d13`, keeping the original Signal K
 * paths so dashboards keep working.
 */
function migrateLegacyOptions(legacy = {}, legacyStore = {}) {
  const raw = legacyStore || {}
  const tuyaId = raw.deviceId || legacy.deviceId || ''
  const result = {
    configVersion: CONFIG_VERSION,
    migratedFrom: LEGACY_PLUGIN_ID,
    account: { region: 'eu' },
    discovery: { subnets: [] },
    devices: []
  }
  if (!tuyaId && !legacy.simulate) return result
  const cloud = (raw.smartlifeDevices || []).find((d) => d && d.id === tuyaId) || {}
  // The old plugin let the store win over Plugin Config (store.ip || options.ip).
  // Carry over the value that was actually in use; from now on options win.
  const ip = [raw.ip, legacy.ip].find(isLanIp) || ''
  const protocol = PROTOCOLS.includes(String(raw.version || legacy.version)) ? String(raw.version || legacy.version) : 'auto'
  result.devices.push(normalizeDevice({
    key: 'd13',
    enabled: true,
    name: raw.deviceName || legacy.deviceName || cloud.name || 'AlecoAir D13',
    tuyaId,
    productId: cloud.productId || '',
    ip,
    protocol,
    profile: 'traditio',
    model: 'D13',
    pollSeconds: Number(legacy.pollSeconds) || 8,
    simulate: legacy.simulate === true,
    dpOverrides: legacy.dps && typeof legacy.dps === 'object' ? { ...legacy.dps } : {},
    paths: {
      prefix: legacy.pathPrefix || DEFAULT_PREFIX,
      electrical: legacy.electricalPath === undefined ? 'electrical.loads.alecoairD13.power' : legacy.electricalPath,
      publishCabinHumidity: legacy.publishCabinHumidity !== false,
      cabinHumidity: legacy.cabinHumidityPath || 'environment.inside.humidity'
    }
  }))
  return result
}

function normalizeOverrides(raw) {
  const out = {}
  if (!raw || typeof raw !== 'object') return out
  for (const role of ROLES) {
    if (!Object.prototype.hasOwnProperty.call(raw, role)) continue
    const v = raw[role]
    if (v === null || v === '' || v === undefined) out[role] = null
    else if (Number.isInteger(Number(v)) && Number(v) >= 0) out[role] = Number(v)
  }
  return out
}

function normalizeDevice(d = {}, index = 0) {
  const key = isValidKey(d.key) ? d.key : slugKey(d.key || d.name || d.tuyaId, `device${index + 1}`)
  const paths = { ...defaultPaths(key), ...(d.paths || {}) }
  const profile = d.profile === 'auto' || getProfile(d.profile) ? d.profile : 'auto'
  const prof = profile === 'auto' ? null : PROFILES[profile]
  return {
    key,
    enabled: d.enabled !== false,
    name: String(d.name || key),
    tuyaId: String(d.tuyaId || ''),
    productId: String(d.productId || ''),
    ip: isLanIp(d.ip) ? d.ip : '',
    protocol: PROTOCOLS.includes(String(d.protocol)) ? String(d.protocol) : 'auto',
    profile,
    model: d.model && (!prof || prof.models[d.model]) ? String(d.model) : '',
    pollSeconds: Math.max(5, Number(d.pollSeconds) || 8),
    simulate: d.simulate === true,
    dpOverrides: normalizeOverrides(d.dpOverrides),
    paths: {
      prefix: String(paths.prefix || `${DEFAULT_PREFIX}.${key}`).replace(/\.+$/, ''),
      electrical: paths.electrical ? String(paths.electrical) : '',
      publishCabinHumidity: paths.publishCabinHumidity === true,
      cabinHumidity: String(paths.cabinHumidity || 'environment.inside.relativeHumidity')
    }
  }
}

/**
 * Normalize v2 options and flag conflicts. A device whose key, Tuya id or
 * path prefix collides with an earlier one is not started.
 */
function normalizeOptions(options = {}) {
  const devices = (Array.isArray(options.devices) ? options.devices : []).map((d, i) => normalizeDevice(d, i))
  const seenKeys = new Set()
  const seenIds = new Set()
  const seenPrefixes = new Set()
  for (const d of devices) {
    const issues = []
    if (seenKeys.has(d.key)) issues.push(`duplicate key "${d.key}"`)
    if (d.tuyaId && seenIds.has(d.tuyaId)) issues.push('same Tuya device configured twice')
    if (seenPrefixes.has(d.paths.prefix)) issues.push(`path prefix ${d.paths.prefix} already used`)
    if (!d.tuyaId && !d.simulate) issues.push('no Tuya device id')
    seenKeys.add(d.key)
    if (d.tuyaId) seenIds.add(d.tuyaId)
    seenPrefixes.add(d.paths.prefix)
    d.problems = issues
  }
  const region = options.account && options.account.region
  return {
    configVersion: CONFIG_VERSION,
    ...(options.migratedFrom ? { migratedFrom: options.migratedFrom } : {}),
    account: { region: ['eu', 'us', 'cn', 'in'].includes(region) ? region : 'eu' },
    discovery: {
      subnets: Array.isArray(options.discovery && options.discovery.subnets)
        ? options.discovery.subnets.map(String).filter(Boolean)
        : []
    },
    devices
  }
}

/** Options as saved to disk (drops runtime-only fields). */
function serializeOptions(options) {
  return {
    ...options,
    devices: options.devices.map(({ problems, ...d }) => d)
  }
}

module.exports = {
  PLUGIN_ID,
  LEGACY_PLUGIN_ID,
  CONFIG_VERSION,
  DEFAULT_PREFIX,
  PROTOCOLS,
  isLegacyOptions,
  readLegacyPluginConfig,
  defaultPaths,
  newDevice,
  migrateLegacyOptions,
  normalizeDevice,
  normalizeOptions,
  serializeOptions
}
