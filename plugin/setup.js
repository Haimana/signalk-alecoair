'use strict'

const fs = require('fs')
const os = require('os')
const path = require('path')

const STORE_NAME = 'signalk-alecoair-d13.store.json'

function defaultStorePath() {
  return path.join(os.homedir(), '.signalk', 'plugin-config-data', STORE_NAME)
}

function loadStore(filePath = defaultStorePath()) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'))
  } catch {
    return {}
  }
}

function saveStore(partial, filePath = defaultStorePath()) {
  const next = { ...loadStore(filePath), ...partial, updatedAt: Date.now() }
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  fs.writeFileSync(filePath, JSON.stringify(next, null, 2))
  return next
}

function publicDevice(device) {
  return {
    id: device.id,
    name: device.name || device.productName || 'Tuya device',
    productName: device.productName || '',
    ip: device.ip || '',
    online: Boolean(device.online),
    category: device.category || '',
    hasKey: Boolean(device.localKey)
  }
}

function findStoredDevice(store, id) {
  return (store.smartlifeDevices || []).find((d) => d && d.id === id) || null
}

function pickDehumidifier(devices) {
  const list = Array.isArray(devices) ? devices.filter((d) => d && d.id) : []
  if (!list.length) return null
  const hit = list.find((d) => /d13|aleco|dehumid|\bcs\b/i.test(
    `${d.name || ''} ${d.productName || ''} ${d.category || ''} ${d.id}`
  ))
  if (hit) return hit
  if (list.length === 1) return list[0]
  return null
}

function mergeSettings(options = {}, store = {}) {
  return {
    ...options,
    deviceId: store.deviceId || options.deviceId || '',
    localKey: store.localKey || options.localKey || '',
    ip: store.ip || options.ip || '',
    version: store.version || options.version || '3.5',
    deviceName: store.deviceName || options.deviceName || '',
    smartlifeSession: store.smartlifeSession || null,
    smartlifeDevices: store.smartlifeDevices || []
  }
}

function setupStatus(settings = {}) {
  const devices = (settings.smartlifeDevices || []).map(publicDevice)
  const session = settings.smartlifeSession || {}
  return {
    ready: Boolean(settings.deviceId && settings.localKey),
    linked: Boolean(session && session.token_info && (session.source === 'alecoair' || (settings.smartlifeDevices || []).length)),
    userCode: session.user_code || '',
    deviceName: settings.deviceName || '',
    deviceId: settings.deviceId || '',
    ip: settings.ip || '',
    version: settings.version || '3.5',
    devices
  }
}

module.exports = {
  defaultStorePath,
  loadStore,
  saveStore,
  publicDevice,
  findStoredDevice,
  pickDehumidifier,
  mergeSettings,
  setupStatus
}
