'use strict'

const { scanLan, isLanIp } = require('./scan')

/**
 * One shared LAN discovery service for all configured devices.
 * Concurrent callers share the same in-flight scan, and results are cached
 * for `ttlMs`, so N devices never start N UDP listeners or N /24 sweeps.
 */
class DiscoveryService {
  constructor(options = {}) {
    this.scanFn = options.scan || scanLan
    this.ttlMs = options.ttlMs ?? 60000
    this.timeoutMs = options.timeoutMs || 5000
    this.subnets = Array.isArray(options.subnets) ? options.subnets.filter(Boolean) : []
    this.devices = []
    this.lastScanAt = null
    this.lastError = null
    this.inflight = null
    this.scans = 0
  }

  async scan(options = {}) {
    const fresh = this.lastScanAt && Date.now() - this.lastScanAt < this.ttlMs
    if (!options.force && fresh) return this.devices
    if (this.inflight) return this.inflight
    this.scans += 1
    const opts = { timeoutMs: options.timeoutMs || this.timeoutMs }
    if (this.subnets.length) opts.prefixes = this.subnets.map(toPrefix).filter(Boolean)
    this.inflight = Promise.resolve(this.scanFn(opts))
      .then((list) => {
        this.devices = Array.isArray(list) ? list : []
        this.lastScanAt = Date.now()
        this.lastError = null
        return this.devices
      })
      .catch((err) => {
        this.lastError = err.message || String(err)
        this.lastScanAt = Date.now()
        return this.devices
      })
      .finally(() => { this.inflight = null })
    return this.inflight
  }

  /**
   * Find the LAN IP of a Tuya device id. Falls back to the only unidentified
   * TCP 6668 host when exactly one device is still looking for an IP.
   */
  async resolveIp(tuyaId, options = {}) {
    const list = await this.scan(options)
    const byId = list.find((d) => d.id && d.id === tuyaId && isLanIp(d.ip))
    if (byId) return { ip: byId.ip, version: byId.version || null, via: 'udp' }
    if (options.allowSingleTcp) {
      const tcp = list.filter((d) => d.tcp && !d.id && isLanIp(d.ip))
      if (tcp.length === 1) return { ip: tcp[0].ip, version: null, via: 'tcp' }
    }
    return null
  }

  snapshot() {
    return {
      devices: this.devices,
      lastScanAt: this.lastScanAt,
      lastError: this.lastError,
      scanning: Boolean(this.inflight)
    }
  }
}

/** Accept "192.168.1.0/24", "192.168.1." or "192.168.1" and return a /24 prefix. */
function toPrefix(subnet) {
  const m = String(subnet || '').trim().match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})/)
  if (!m) return null
  return `${m[1]}.${m[2]}.${m[3]}.`
}

module.exports = { DiscoveryService, toPrefix }
