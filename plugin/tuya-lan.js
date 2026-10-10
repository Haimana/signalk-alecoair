'use strict'

/**
 * Thin LAN adapter around tuyapi. Control stays on the boat network
 * (TCP 6668). Cloud is never used after the one-time localKey extract.
 */
class TuyaLanDevice {
  constructor(options, TuyapiCtor) {
    if (!options.deviceId || !options.localKey) {
      throw new Error('Lipsesc deviceId și localKey Tuya.')
    }
    const TuyAPI = TuyapiCtor || require('tuyapi')
    this.device = new TuyAPI({
      id: options.deviceId,
      key: options.localKey,
      ip: options.ip || undefined,
      version: Number(options.version || 3.3),
      issueGetOnConnect: true,
      issueRefreshOnConnect: true
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

  async connect() {
    if (!this.device.device.ip && typeof this.device.find === 'function') {
      await this.device.find({ timeout: 8 })
    }
    await this.device.connect()
  }

  async get() {
    const data = await this.device.get({ schema: true })
    return (data && data.dps) || data || {}
  }

  async setDps(dps) {
    await this.device.set({ multiple: true, data: dps })
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

module.exports = { TuyaLanDevice }
