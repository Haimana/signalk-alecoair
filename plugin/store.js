'use strict'

/**
 * Side store for secrets and learned facts, kept out of the Admin-visible
 * plugin options: local keys, the AlecoAir account device list (with keys),
 * the protocol each device answered on, and the DPs it reported.
 *
 * File: <configPath>/plugin-config-data/signalk-alecoair.store.json (mode 0600).
 * The legacy signalk-alecoair-d13.store.json is read once and migrated; it
 * is left in place untouched as a backup.
 *
 * Writes are crash-safe: a temp file in the same directory is written and
 * fsynced, the previous good store is kept as <store>.bak, the temp file is
 * renamed over the store and the directory is fsynced. A store that cannot be
 * parsed (for example empty after a power cut) is copied to
 * <store>.corrupt-<timestamp>, the .bak is used instead, and a store that has
 * local keys is never overwritten by one with none unless asked to.
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

function backupPath(file) {
  return `${file}.bak`
}

/**
 * Read a store file without ever hiding a problem:
 * - `missing`: no file (ENOENT);
 * - `ok`: a JSON object (`data`, `raw`);
 * - `corrupt`: empty, not JSON, or not an object (`raw`, `error`);
 * - `unreadable`: any other read error (EACCES, EIO, ...) (`error`).
 */
function readStoreFile(file) {
  let raw
  try {
    raw = fs.readFileSync(file)
  } catch (err) {
    if (err && err.code === 'ENOENT') return { status: 'missing' }
    return { status: 'unreadable', error: err }
  }
  if (!raw.toString('utf8').trim()) return { status: 'corrupt', raw, error: new Error(`empty file (${raw.length} bytes)`) }
  try {
    const data = JSON.parse(raw.toString('utf8'))
    if (!data || typeof data !== 'object' || Array.isArray(data)) {
      return { status: 'corrupt', raw, error: new Error('not a JSON object') }
    }
    return { status: 'ok', data, raw }
  } catch (err) {
    return { status: 'corrupt', raw, error: new Error(`invalid JSON (${raw.length} bytes)`) }
  }
}

/** Number of local keys a store holds (per-device entries and the account list). */
function countKeys(s) {
  if (!s || typeof s !== 'object') return 0
  const ids = new Set()
  for (const [id, entry] of Object.entries(s.devices || {})) if (entry && entry.localKey) ids.add(id)
  for (const d of ((s.account && s.account.devices) || [])) if (d && d.id && d.localKey) ids.add(d.id)
  return ids.size
}

/**
 * Keep a copy of an unreadable store next to it as <store>.corrupt-<ts>.
 * An identical copy that is already there is reused, so repeated reads of
 * the same bad file do not pile up copies. Returns the copy's path.
 */
function preserveCorrupt(file, raw) {
  const dir = path.dirname(file)
  const base = path.basename(file)
  try {
    for (const name of fs.readdirSync(dir)) {
      if (!name.startsWith(`${base}.corrupt-`)) continue
      const other = path.join(dir, name)
      try {
        if (fs.readFileSync(other).equals(raw)) return other
      } catch {
        // unreadable copy: ignore it
      }
    }
  } catch {
    // directory listing failed: still try to write a copy
  }
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const copy = `${file}.corrupt-${stamp}`
  writeFileAtomic(copy, raw)
  return copy
}

function fsyncDir(dir) {
  let fd = null
  try {
    fd = fs.openSync(dir, 'r')
    fs.fsyncSync(fd)
  } catch {
    // not supported everywhere (e.g. Windows): the file itself is fsynced
  } finally {
    if (fd !== null) try { fs.closeSync(fd) } catch {}
  }
}

/** Write a file so that a crash leaves either the old or the new content, never a mix. */
function writeFileAtomic(file, data) {
  const dir = path.dirname(file)
  const tmp = `${file}.${process.pid}.tmp`
  try { fs.unlinkSync(tmp) } catch {}
  const fd = fs.openSync(tmp, 'w', 0o600)
  try {
    fs.writeSync(fd, data)
    fs.fsyncSync(fd)
  } finally {
    fs.closeSync(fd)
  }
  try {
    fs.renameSync(tmp, file)
  } catch (err) {
    try { fs.unlinkSync(tmp) } catch {}
    throw err
  }
  fsyncDir(dir)
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

function describe(file, read) {
  return `${path.basename(file)}: ${read.status === 'unreadable' ? 'could not be read' : 'is damaged'} (${(read.error && (read.error.code || read.error.message)) || 'unknown error'})`
}

/**
 * Load the v2 store, migrating from the legacy file when the new one does
 * not exist yet. `legacyRaw` is the legacy file content (if any) so the
 * plugin options migration can use the adopted device it records.
 *
 * A damaged or unreadable store is never treated as "no store": `problem`
 * then says what happened (`kind`, `message`, `corruptCopy`, `recoveredFrom`),
 * a damaged file is copied to <store>.corrupt-<ts>, and the last good
 * <store>.bak is used when there is one.
 */
function loadStore(dataRoot) {
  const file = storePath(dataRoot)
  const read = readStoreFile(file)
  const legacyRaw = readJson(legacyStorePath(dataRoot))
  if (read.status === 'ok') {
    return { store: { ...emptyStore(), ...read.data }, migrated: false, legacyRaw, problem: null }
  }
  if (read.status === 'missing') {
    if (legacyRaw && typeof legacyRaw === 'object') {
      return { store: migrateLegacyStore(legacyRaw), migrated: true, legacyRaw, problem: null }
    }
    return { store: emptyStore(), migrated: false, legacyRaw: null, problem: null }
  }

  const problem = { kind: read.status, file, message: describe(file, read), corruptCopy: null, recoveredFrom: null }
  if (read.status === 'corrupt') {
    try {
      problem.corruptCopy = preserveCorrupt(file, read.raw)
    } catch (err) {
      problem.message += `; could not keep a copy (${err.code || err.message})`
    }
  }
  const bak = readStoreFile(backupPath(file))
  if (bak.status === 'ok') {
    problem.recoveredFrom = backupPath(file)
    problem.message += `. Using the last good copy ${path.basename(backupPath(file))} (${countKeys(bak.data)} local key(s)).`
    return { store: { ...emptyStore(), ...bak.data }, migrated: false, legacyRaw, problem }
  }
  problem.message += problem.corruptCopy
    ? `. No usable backup: local keys are missing until you sign in to AlecoAir again. The damaged file was kept as ${path.basename(problem.corruptCopy)}.`
    : '. No usable backup: local keys are missing until the file can be read again.'
  return { store: emptyStore(), migrated: false, legacyRaw, problem }
}

/**
 * Write the store. Crash-safe (see the header). Refuses, with an error:
 * - to replace a store file that exists but cannot be read (EACCES, EIO, ...);
 * - to replace a store that holds local keys with one that holds none,
 *   unless `allowKeyLoss` is set (forgetting the account on purpose).
 * A damaged store file is copied to <store>.corrupt-<ts> before it is replaced.
 */
function saveStore(store, dataRoot, { allowKeyLoss = false } = {}) {
  const file = storePath(dataRoot)
  const next = { ...store, storeVersion: STORE_VERSION, updatedAt: Date.now() }
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const current = readStoreFile(file)
  if (current.status === 'unreadable') {
    throw new Error(`not saving: ${describe(file, current)}`)
  }
  if (current.status === 'ok' && !allowKeyLoss && countKeys(current.data) > 0 && countKeys(next) === 0) {
    throw new Error(`not saving: ${path.basename(file)} holds ${countKeys(current.data)} local key(s) and the copy in memory holds none`)
  }
  if (current.status === 'corrupt') preserveCorrupt(file, current.raw)
  if (current.status === 'ok') {
    try {
      writeFileAtomic(backupPath(file), current.raw)
    } catch {
      // a missing backup must not block saving the store itself
    }
  }
  writeFileAtomic(file, JSON.stringify(next, null, 2))
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
  backupPath,
  readStoreFile,
  countKeys,
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
