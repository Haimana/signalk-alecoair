'use strict'

/**
 * Thin LAN adapter around tuyapi. Control stays on the boat network
 * (TCP 6668). Cloud is never used after the one-time localKey extract.
 */
class TuyaLanDevice {
  constructor(options, TuyapiCtor) {
    if (!options.deviceId || !options.localKey) {
      throw new Error('Tuya deviceId and localKey are missing.')
    }
    const TuyAPI = TuyapiCtor || require('tuyapi')
    this.version = String(options.version || 3.5)
    this.device = new TuyAPI({
      id: options.deviceId,
      key: options.localKey,
      ip: options.ip || undefined,
      version: Number(this.version),
      issueGetOnConnect: false,
      issueRefreshOnConnect: false
    })
    this.listeners = []
  }

  onData(handler) {
    const wrapped = (data) => {
      const dps = (data && data.dps) || data || {}
      handler(dps)
    }
    this.device.on('data', wrapped)
    this.listeners.push(['data', wrapped])
  }

  onError(handler) {
    this.device.on('error', handler)
    this.listeners.push(['error', handler])
  }

  onDisconnect(handler) {
    this.device.on('disconnected', handler)
    this.listeners.push(['disconnected', handler])
  }

  async connect(timeoutMs = 8000) {
    const open = async () => {
      if (!this.device.device.ip && typeof this.device.find === 'function') {
        await this.device.find({ timeout: 8 })
      }
      await this.device.connect()
    }
    await Promise.race([
      open(),
      new Promise((_, reject) => setTimeout(() => reject(new Error('LAN connect timeout')), timeoutMs))
    ])
  }

  async get(timeoutMs = 6000) {
    const data = await Promise.race([
      this.device.get({ schema: true }),
      new Promise((_, reject) => setTimeout(() => reject(new Error('LAN read timeout')), timeoutMs))
    ])
    if (data && data.dps && typeof data.dps === 'object') return data.dps
    if (data && typeof data === 'object' && !Array.isArray(data)) return data
    return {}
  }

  async setDps(dps) {
    const data = {}
    for (const [key, value] of Object.entries(dps)) data[String(key)] = value
    const keys = Object.keys(data)
    const options = keys.length === 1
      ? { dps: keys[0], set: data[keys[0]], shouldWaitForResponse: false }
      : { multiple: true, data, shouldWaitForResponse: false }
    try {
      await this.device.set(options)
    } catch (err) {
      if (!isTransientLanError(err)) throw err
    }
  }

  disconnect() {
    try {
      this.device.disconnect()
    } catch {
      // already closed
    }
    for (const [event, fn] of this.listeners) {
      this.device.removeListener(event, fn)
    }
    this.listeners = []
  }
}

function isTransientLanError(err) {
  const msg = (err && err.message) || String(err || '')
  return /timeout|timed out|ECONNRESET|EPIPE|ECONNREFUSED/i.test(msg)
}

function versionCandidates(preferred) {
  const first = String(preferred || '3.5')
  return [first, ...['3.5', '3.4', '3.3'].filter((v) => v !== first)]
}

module.exports = { TuyaLanDevice, versionCandidates, isTransientLanError }
