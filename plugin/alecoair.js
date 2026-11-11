'use strict'

/**
 * AlecoAir account login (same OEM Tuya cloud API as the phone app).
 *
 * Logs in with an email or a phone number, then lists the account's devices
 * with their local keys, which the plugin needs for LAN control. Pure Node
 * (built-in https + crypto), CommonJS, Node 18+: no Python, no extra npm
 * packages. Ported from the former plugin/alecoair-helper.py; the wire format
 * (signing, form encoding, JSON payloads) is kept byte-for-byte identical.
 *
 * The password is never stored or logged: it is MD5-hashed, RSA-encrypted
 * with the per-login public key from the cloud, and dropped after the call.
 */

const crypto = require('crypto')
const http = require('http')
const https = require('https')
const zlib = require('zlib')

// Public identifiers of the AlecoAir Android app. If the vendor rotates them,
// login breaks; LAN control keeps working with the keys already stored.
const CLIENT_ID = 'pvufcdrftnfkt4rqkxs5'
const SECRET = 'A_48vafqcmrfx4mvjrph4j4ayfe9hctnkd_jmehruant8ag7nscxn8u47u9yf8h48e7'
const UA = 'TY-UA=APP/Android/1.1.6/SDK/null'

const DEFAULT_REGION = 'eu'
const DEFAULT_COUNTRY = '40'
const REQUEST_TIMEOUT_MS = 20000
const LOGIN_TIMEOUT_MS = 30000
const MAX_RESPONSE_BYTES = 5 * 1024 * 1024
const REGION_RE = /^[a-z0-9-]{1,16}$/i

function md5Hex(text) {
  return crypto.createHash('md5').update(String(text), 'utf8').digest('hex')
}

/** Tuya "mobile" hash of postData: MD5 hex with its four 8-char blocks reordered. */
function mobileHash(data) {
  const h = md5Hex(data)
  return h.slice(8, 16) + h.slice(0, 8) + h.slice(24, 32) + h.slice(16, 24)
}

/** HMAC-SHA256 over the sorted "key=value" pairs joined by "||" (gid excluded). */
function sign(payload) {
  const parts = []
  for (const key of Object.keys(payload).sort()) {
    if (key === 'gid') continue
    const value = key === 'postData' ? mobileHash(payload[key]) : payload[key]
    parts.push(`${key}=${value}`)
  }
  return crypto.createHmac('sha256', SECRET).update(parts.join('||'), 'utf8').digest('hex')
}

/** JSON like Python's json.dumps(obj, separators=(',', ':')): compact, non-ASCII escaped. */
function pyJson(value) {
  return JSON.stringify(value).replace(/[\u0080-\uffff]/g, (c) => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'))
}

/** application/x-www-form-urlencoded exactly like Python's urlencode (quote_plus). */
function formEncode(obj) {
  return Object.keys(obj).map((key) => `${quotePlus(key)}=${quotePlus(obj[key])}`).join('&')
}

function quotePlus(value) {
  return encodeURIComponent(String(value))
    .replace(/[!'()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase())
    .replace(/%20/g, '+')
}

function toBigInt(value, what) {
  const text = String(value == null ? '' : value).trim()
  if (!/^\d+$/.test(text)) throw new Error(`AlecoAir cloud sent an invalid ${what}.`)
  return BigInt(text)
}

function modPow(base, exp, mod) {
  if (mod === 1n) return 0n
  let result = 1n
  base %= mod
  while (exp > 0n) {
    if (exp & 1n) result = (result * base) % mod
    exp >>= 1n
    base = (base * base) % mod
  }
  return result
}

/** Raw (unpadded) RSA, as the app does: message^e mod n, as 256 big-endian bytes. */
function rsaEncrypt(modulus, exponent, message) {
  const n = toBigInt(modulus, 'public key')
  const e = toBigInt(exponent, 'public key exponent')
  const m = BigInt('0x' + (Buffer.from(message).toString('hex') || '0'))
  const hex = modPow(m, e, n).toString(16)
  if (hex.length > 512) throw new Error('AlecoAir cloud sent an invalid public key.')
  return Buffer.from(hex.padStart(512, '0'), 'hex')
}

function encryptPassword(tokenInfo, password) {
  if (!tokenInfo || !tokenInfo.token) throw new Error('AlecoAir cloud sent no login token.')
  return rsaEncrypt(tokenInfo.publicKey, tokenInfo.exponent, Buffer.from(md5Hex(password), 'utf8')).toString('hex')
}

class AlecoAirCloud {
  /**
   * @param {string} region Tuya region (eu, us, ...); selects https://a1.tuya<region>.com
   * @param {object} [opts] { endpoint, requestTimeoutMs, now } (endpoint/now are for tests)
   */
  constructor(region, opts = {}) {
    this.endpoint = new URL(opts.endpoint || `https://a1.tuya${region}.com/api.json`)
    this.requestTimeoutMs = opts.requestTimeoutMs || REQUEST_TIMEOUT_MS
    this.now = opts.now || Date.now
    this.sid = null
    this.active = null
    this.aborted = null
  }

  abort(err) {
    this.aborted = err || new Error('AlecoAir login aborted.')
    if (this.active) this.active.destroy(this.aborted)
  }

  async api(action, payload, extra, needSid = true) {
    const params = {
      a: action,
      clientId: CLIENT_ID,
      v: '1.0',
      time: String(Math.floor(this.now() / 1000))
    }
    if (extra) Object.assign(params, extra)
    if (needSid) {
      if (!this.sid) throw new Error('Not logged in.')
      params.sid = this.sid
    }
    const data = {}
    if (payload != null) data.postData = pyJson(payload)
    params.sign = sign({ ...params, ...data })
    const body = await this.post(formEncode(params), Object.keys(data).length ? formEncode(data) : '')
    if (!body || !body.success) {
      throw new Error((body && (body.errorMsg || body.errorCode)) || 'AlecoAir login failed.')
    }
    return body.result
  }

  post(query, form) {
    if (this.aborted) return Promise.reject(this.aborted)
    const url = this.endpoint
    const lib = url.protocol === 'http:' ? http : https
    const payload = Buffer.from(form, 'utf8')
    const headers = { 'User-Agent': UA, Accept: '*/*', 'Content-Length': payload.length }
    if (payload.length) headers['Content-Type'] = 'application/x-www-form-urlencoded'
    const search = url.search ? `${url.search}&${query}` : `?${query}`
    return new Promise((resolve, reject) => {
      const req = lib.request({
        protocol: url.protocol,
        hostname: url.hostname,
        port: url.port || undefined,
        path: url.pathname + search,
        method: 'POST',
        headers
      }, (res) => {
        let stream = res
        const enc = String(res.headers['content-encoding'] || '').toLowerCase()
        if (enc === 'gzip') stream = res.pipe(zlib.createGunzip())
        else if (enc === 'deflate') stream = res.pipe(zlib.createInflate())
        const chunks = []
        let size = 0
        let ended = false
        const fail = (err) => {
          reject(err)
          req.destroy(err)
        }
        stream.on('data', (chunk) => {
          size += chunk.length
          if (size > MAX_RESPONSE_BYTES) fail(new Error('AlecoAir cloud response is too large.'))
          else chunks.push(chunk)
        })
        res.on('error', fail)
        if (stream !== res) stream.on('error', fail)
        res.on('close', () => {
          if (!ended && !res.complete) reject(new Error('AlecoAir cloud closed the connection.'))
        })
        stream.on('end', () => {
          ended = true
          const text = Buffer.concat(chunks).toString('utf8')
          try {
            resolve(JSON.parse(text))
          } catch {
            reject(new Error(`AlecoAir cloud returned an unexpected response (HTTP ${res.statusCode}).`))
          }
        })
      })
      this.active = req
      req.setTimeout(this.requestTimeoutMs, () => req.destroy(new Error('AlecoAir cloud did not answer in time.')))
      req.on('error', reject)
      req.on('close', () => { if (this.active === req) this.active = null })
      req.end(payload)
    })
  }

  async loginEmail(email, password) {
    const tokenInfo = await this.api('tuya.m.user.email.token.create', { countryCode: '', email }, null, false)
    const info = await this.api('tuya.m.user.email.password.login', {
      countryCode: '',
      email,
      ifencrypt: 1,
      options: '{"group": 1}',
      passwd: encryptPassword(tokenInfo, password),
      token: tokenInfo.token
    }, null, false)
    this.setSid(info)
  }

  async loginMobile(mobile, password, country = DEFAULT_COUNTRY) {
    const tokenInfo = await this.api('tuya.m.user.mobile.token.create', { countryCode: country, mobile }, null, false)
    const info = await this.api('tuya.m.user.mobile.password.login', {
      countryCode: country,
      mobile,
      ifencrypt: 1,
      options: '{"group": 1}',
      passwd: encryptPassword(tokenInfo, password),
      token: tokenInfo.token
    }, null, false)
    this.setSid(info)
  }

  setSid(info) {
    if (!info || !info.sid) throw new Error('AlecoAir cloud sent no session.')
    this.sid = info.sid
  }

  async devices() {
    const found = []
    for (const group of (await this.api('tuya.m.location.list')) || []) {
      for (const dev of (await this.api('tuya.m.my.group.device.list', null, { gid: group.groupId })) || []) {
        found.push({
          id: dev.devId || '',
          name: dev.name || '',
          localKey: dev.localKey || '',
          ip: dev.ip || '',
          productName: dev.productName || '',
          productId: dev.productId || '',
          category: dev.category || '',
          online: Boolean(dev.isOnline || dev.online),
          uuid: dev.uuid || ''
        })
      }
    }
    return found
  }
}

async function run(cloud, body) {
  try {
    const account = String(body.account || body.email || '').trim()
    const password = body.password || ''
    if (!account || !password) return { ok: false, error: 'AlecoAir email/phone and password are required.' }
    if (account.includes('@')) await cloud.loginEmail(account, String(password))
    else await cloud.loginMobile(account.replace(/^\++/, ''), String(password), body.countryCode || DEFAULT_COUNTRY)
    return { ok: true, devices: await cloud.devices() }
  } catch (err) {
    return { ok: false, error: (err && err.message) || String(err) }
  }
}

/**
 * Log in and list devices.
 * @param {object} body { account | email, password, region='eu', countryCode='40' }
 * @param {object} [opts] { endpoint, requestTimeoutMs, timeoutMs, now } (for tests)
 * @returns {Promise<{ok: true, devices: object[]} | {ok: false, error: string}>}
 *   Rejects only if the whole login exceeds the overall timeout.
 */
function login(body, opts = {}) {
  body = body || {}
  const region = String(body.region || DEFAULT_REGION).trim() || DEFAULT_REGION
  if (!opts.endpoint && !REGION_RE.test(region)) return Promise.resolve({ ok: false, error: `Unknown AlecoAir region "${region}".` })
  const cloud = new AlecoAirCloud(region, opts)
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      const err = new Error('AlecoAir login timed out.')
      cloud.abort(err)
      reject(err)
    }, opts.timeoutMs || LOGIN_TIMEOUT_MS)
    run(cloud, body).then((result) => {
      clearTimeout(timer)
      resolve(result)
    })
  })
}

module.exports = {
  login,
  AlecoAirCloud,
  _internal: { sign, mobileHash, pyJson, formEncode, rsaEncrypt, md5Hex, CLIENT_ID, UA }
}
