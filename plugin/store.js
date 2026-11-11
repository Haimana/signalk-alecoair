'use strict'

/**
 * Side store for secrets and learned facts, kept out of the Admin-visible
 * plugin options: local keys, the AlecoAir account device list (with keys),
 * the protocol each device answered on, and the DPs it reported.
 *
 * File: <configPath>/plugin-config-data/signalk-alecoair.store.json (mode 0600).
 * The legacy signalk-alecoair-d13.store.json is read once and migrated; it
 * is left in place untouched as a backup.
 */

const fs = require('fs')
const os = require('os')
const path = require('path')
const { isLanIp } = require('./scan')

const STORE_NAME = 'signalk-alecoair.store.json'
const LEGACY_STORE_NAME = 'signalk-alecoair-d13.store.json'
const STORE_VERSION = 2

function defaultDataRoot() {
  return path.join(os.homedir(), '.signalk', 'plugin-config-data')
}

/** A usable data root: null, undefined, '' or a non-string fall back to the default. */
function rootOrDefault(dataRoot) {
  return typeof dataRoot === 'string' && dataRoot ? dataRoot : defaultDataRoot()
}

function storePath(dataRoot) {
  return path.join(rootOrDefault(dataRoot), STORE_NAME)
}

function legacyStorePath(dataRoot) {
  return path.join(rootOrDefault(dataRoot), LEGACY_STORE_NAME)
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return null
  }
}

function emptyStore() {
  return {
    storeVersion: STORE_VERSION,
    account: { linked: false, source: null, region: null, user: null, linkedAt: null, devices: [] },
    devices: {}
  }
}

function cloudDevice(d) {
  return {
    id: String(d.id || ''),
    name: d.name || '',
    localKey: d.localKey || '',
    ip: d.ip || '',
    productName: d.productName || '',
    productId: d.productId || '',
    category: d.category || '',
    online: Boolean(d.online),
    uuid: d.uuid || ''
  }
}

/** Convert the flat single-device D13 store into the v2 multi-device store. */
function migrateLegacyStore(raw = {}) {
  const store = emptyStore()
  const cloud = Array.isArray(raw.smartlifeDevices) ? raw.smartlifeDevices.filter((d) => d && d.id).map(cloudDevice) : []
  const session = raw.smartlifeSession || null
  store.account = {
    linked: Boolean(session),
    source: session ? (session.source || 'smartlife') : null,
    region: null,
    user: null, // the legacy store never recorded which login was used
    linkedAt: raw.updatedAt || null,
    devices: cloud
  }
  for (const d of cloud) {
    if (d.localKey) store.devices[d.id] = { localKey: d.localKey, productId: d.productId || '' }
  }
  if (raw.deviceId) {
    const entry = store.devices[raw.deviceId] || {}
    store.devices[raw.deviceId] = {
      ...entry,
      localKey: raw.localKey || entry.localKey || '',
      productId: entry.productId || '',
      protocol: raw.version || entry.protocol || null,
      lastIp: isLanIp(raw.ip) ? raw.ip : (entry.lastIp || null)
    }
  }
  store.migratedFrom = LEGACY_STORE_NAME
  store.migratedAt = Date.now()
  return store
}

/**
 * Load the v2 store, migrating from the legacy file when the new one does
 * not exist yet. `legacyRaw` is the legacy file content (if any) so the
 * plugin options migration can use the adopted device it records.
 */
function loadStore(dataRoot) {
  const current = readJson(storePath(dataRoot))
  const legacyRaw = readJson(legacyStorePath(dataRoot))
  if (current && typeof current === 'object') {
    return { store: { ...emptyStore(), ...current }, migrated: false, legacyRaw }
  }
  if (legacyRaw && typeof legacyRaw === 'object') {
    return { store: migrateLegacyStore(legacyRaw), migrated: true, legacyRaw }
  }
  return { store: emptyStore(), migrated: false, legacyRaw: null }
}

function saveStore(store, dataRoot) {
  const file = storePath(dataRoot)
  const next = { ...store, storeVersion: STORE_VERSION, updatedAt: Date.now() }
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const tmp = `${file}.${process.pid}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(next, null, 2), { mode: 0o600 })
  fs.renameSync(tmp, file)
  return next
}

function getLocalKey(store, tuyaId) {
  if (!tuyaId) return ''
  const entry = store.devices && store.devices[tuyaId]
  if (entry && entry.localKey) return entry.localKey
  const cloud = ((store.account && store.account.devices) || []).find((d) => d.id === tuyaId)
  return (cloud && cloud.localKey) || ''
}

function updateDevice(store, tuyaId, partial) {
  if (!tuyaId) return store
  store.devices = store.devices || {}
  store.devices[tuyaId] = { ...(store.devices[tuyaId] || {}), ...partial, updatedAt: Date.now() }
  return store
}

/**
 * Record a successful AlecoAir login: the device list and the fresh local keys.
 * `user` is the email or phone typed at sign-in, kept only so Admin can show
 * which account is linked. The password is never passed here or stored.
 */
function setAccount(store, { source = 'alecoair', region = 'eu', user = null, devices = [] } = {}) {
  const cloud = devices.filter((d) => d && d.id).map(cloudDevice)
  const label = String(user || '').trim().slice(0, 128) || null
  store.account = { linked: true, source, region, user: label, linkedAt: Date.now(), devices: cloud }
  for (const d of cloud) {
    if (d.localKey) updateDevice(store, d.id, { localKey: d.localKey, productId: d.productId || '' })
  }
  return store
}

/** Forget the account list. Keys of devices that are still configured are kept so they keep working. */
function clearAccount(store, keepTuyaIds = []) {
  const keep = new Set(keepTuyaIds)
  store.account = { linked: false, source: null, region: null, user: null, linkedAt: null, devices: [] }
  for (const id of Object.keys(store.devices || {})) {
    if (!keep.has(id)) delete store.devices[id]
  }
  return store
}

/** Cloud device without its local key, safe to send to a browser. */
function publicCloudDevice(d) {
  return {
    id: d.id,
    name: d.name || d.productName || 'Tuya device',
    productName: d.productName || '',
    productId: d.productId || '',
    category: d.category || '',
    ip: isLanIp(d.ip) ? d.ip : '',
    online: Boolean(d.online),
    hasKey: Boolean(d.localKey)
  }
}

function looksLikeDehumidifier(d) {
  return /aleco|dehumid|\bcs\b|traditio/i.test(`${d.name || ''} ${d.productName || ''} ${d.category || ''}`) || d.category === 'cs'
}

module.exports = {
  STORE_NAME,
  LEGACY_STORE_NAME,
  STORE_VERSION,
  defaultDataRoot,
  storePath,
  legacyStorePath,
  emptyStore,
  migrateLegacyStore,
  loadStore,
  saveStore,
  getLocalKey,
  updateDevice,
  setAccount,
  clearAccount,
  publicCloudDevice,
  looksLikeDehumidifier
}
