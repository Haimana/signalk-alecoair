'use strict'

// AlecoAir cloud login (plugin/alecoair.js), against a local fake of the Tuya
// mobile API. No real cloud calls, no real credentials. The golden values were
// produced by the former Python helper (plugin/alecoair-helper.py) with the
// same fake inputs, so these tests pin the Node port to its wire format.

const { test } = require('node:test')
const assert = require('node:assert/strict')
const http = require('http')
const fs = require('fs')
const path = require('path')
const { login, _internal } = require('../plugin/alecoair')
const { sign, mobileHash, pyJson, formEncode, rsaEncrypt, md5Hex, CLIENT_ID, UA } = _internal

const FAKE_PASSWORD = 'fake-password'
const FAKE_MODULUS = '3' + '1'.repeat(615)
const GOLDEN = {
  pd1: '{"countryCode":"","email":"skipper@example.com"}',
  mh1: '53bc67fb39ef2055bfdb929843ccbb00',
  sign1: '196064f0d86a5f87419a71f0e067fb0d2ff9f719473f146285ad63bad33c06aa',
  sign2: '001b8fbac74dfceede7bceb0103c6a430a0cc04ff30bff0c31f14a13251ba2b3',
  pd3: '{"countryCode":"40","mobile":"40712345678","name":"\\u0218alup\\u0103 \\u00fc \\u20ac"}',
  sign3: '13020f950271272264062399704c86514853b5af239b421fd21648da4af2ecf9',
  rsa: '11c9a4d4b6b30adfbbe5c7445be657fc1d17e47b00ab1d74b10c8f1949bda21413da41fc193a5b8f1970ec2cd81fac90d10dddc061a7daf6e88d2afe1aab30e390eb7564bde2c2c413d1dd9ffca38bc20f120671c65c22f6bf1e39c7159a16eebc1051e8c0a8cbde8b4b2702db2dbf316a7d29f37aed17a49166261153d0d5484a6efe3305de26c9f6c21feb249d8e9655ee0b6d235b221de7d5f9dc580e718a27c6fe7b17978a3e555ba2ecc61e3be12144322c6e1c27e9090cad45ef3107af53a59a797aeb5ef837200b5935bc1602708b5517020efe56a341db316159daea8e8f3b1b9003759c5754a777ebc427e8dc4006e3c6c0316e6b256b1bcc10b7ba',
  pd4: '{"countryCode":"","email":"skipper@example.com","ifencrypt":1,"options":"{\\"group\\": 1}","passwd":"ab","token":"t"}',
  form: 'x=a+b~%2A%21%27%28%29%C3%A9%2F%E2%82%AC%40%2B%26%3D&n=12345'
}

// ---- signing and encoding match the Python helper ----

test('postData JSON matches Python json.dumps (compact, non-ASCII escaped)', () => {
  assert.equal(pyJson({ countryCode: '', email: 'skipper@example.com' }), GOLDEN.pd1)
  assert.equal(pyJson({ countryCode: '40', mobile: '40712345678', name: 'Șalupă ü €' }), GOLDEN.pd3)
  assert.equal(pyJson({ countryCode: '', email: 'skipper@example.com', ifencrypt: 1, options: '{"group": 1}', passwd: 'ab', token: 't' }), GOLDEN.pd4)
})

test('mobile hash and HMAC signature match the Python helper', () => {
  assert.equal(mobileHash(GOLDEN.pd1), GOLDEN.mh1)
  assert.equal(sign({ a: 'tuya.m.user.email.token.create', clientId: CLIENT_ID, v: '1.0', time: '1700000000', postData: GOLDEN.pd1 }), GOLDEN.sign1)
  assert.equal(sign({ a: 'tuya.m.my.group.device.list', clientId: CLIENT_ID, v: '1.0', time: '1700000001', gid: 12345, sid: 'fake-sid' }), GOLDEN.sign2, 'gid is not signed')
  assert.equal(sign({ a: 'tuya.m.user.mobile.token.create', clientId: CLIENT_ID, v: '1.0', time: '1700000002', postData: GOLDEN.pd3 }), GOLDEN.sign3)
})

test('raw RSA of the password MD5 matches the Python helper', () => {
  const md = Buffer.from(md5Hex(FAKE_PASSWORD), 'utf8')
  assert.equal(rsaEncrypt(FAKE_MODULUS, '65537', md).toString('hex'), GOLDEN.rsa)
  assert.equal(rsaEncrypt(FAKE_MODULUS, 65537, md).toString('hex'), GOLDEN.rsa, 'numeric exponent')
  assert.equal(rsaEncrypt(FAKE_MODULUS, '65537', md).length, 256)
  assert.throws(() => rsaEncrypt('not-a-number', '65537', md), /invalid public key/)
})

test('form encoding matches Python urlencode / quote_plus', () => {
  assert.equal(formEncode({ x: "a b~*!'()é/€@+&=", n: 12345 }), GOLDEN.form)
})

// ---- fake Tuya mobile API ----

function fakeCloud(handler) {
  const calls = []
  const server = http.createServer((req, res) => {
    let raw = ''
    req.setEncoding('utf8')
    req.on('data', (c) => { raw += c })
    req.on('end', () => {
      const url = new URL(req.url, 'http://x')
      const query = Object.fromEntries(url.searchParams)
      const form = Object.fromEntries(new URLSearchParams(raw))
      const call = { method: req.method, path: url.pathname, query, form, raw, rawUrl: req.url, headers: req.headers }
      calls.push(call)
      const reply = handler(call)
      if (reply === undefined) return // never answer
      if (typeof reply === 'string') {
        res.writeHead(502, { 'Content-Type': 'text/html' })
        return res.end(reply)
      }
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(reply))
    })
  })
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({ calls, endpoint: `http://127.0.0.1:${server.address().port}/api.json`, close: () => new Promise((r) => { server.closeAllConnections && server.closeAllConnections(); server.close(r) }) })
    })
  })
}

const GROUPS = [{ groupId: 111 }, { groupId: 222 }]
const DEVICES = {
  111: [{ devId: 'bfFAKE1', name: 'Cabin', localKey: 'fake-local-key-1', ip: '1.2.3.4', productName: 'D13', productId: 'pid1', category: 'cs', isOnline: true, uuid: 'u1' }],
  222: [{ devId: 'bfFAKE2', name: 'Saloon', localKey: 'fake-local-key-2', online: false }]
}

function happyCloud(kind) {
  return ({ query }) => {
    switch (query.a) {
      case `tuya.m.user.${kind}.token.create`: return { success: true, result: { token: 'fake-token', publicKey: FAKE_MODULUS, exponent: '65537' } }
      case `tuya.m.user.${kind}.password.login`: return { success: true, result: { sid: 'fake-sid' } }
      case 'tuya.m.location.list': return { success: true, result: GROUPS }
      case 'tuya.m.my.group.device.list': return { success: true, result: DEVICES[query.gid] }
      default: return { success: false, errorCode: 'UNKNOWN_API' }
    }
  }
}

const NOW = () => 1700000000123

function assertSigned(call) {
  const { sign: sig, ...rest } = call.query
  assert.equal(sig, sign({ ...rest, ...call.form }), `signature of ${call.query.a}`)
  assert.equal(call.query.clientId, CLIENT_ID)
  assert.equal(call.query.v, '1.0')
  assert.equal(call.query.time, '1700000000')
  assert.equal(call.headers['user-agent'], UA)
  assert.equal(call.method, 'POST')
}

test('email login: token, encrypted password, session, then devices of every group', async () => {
  const cloud = await fakeCloud(happyCloud('email'))
  try {
    const result = await login({ account: '  skipper@example.com ', password: FAKE_PASSWORD, region: 'eu' }, { endpoint: cloud.endpoint, now: NOW })
    assert.deepEqual(result, {
      ok: true,
      devices: [
        { id: 'bfFAKE1', name: 'Cabin', localKey: 'fake-local-key-1', ip: '1.2.3.4', productName: 'D13', productId: 'pid1', category: 'cs', online: true, uuid: 'u1' },
        { id: 'bfFAKE2', name: 'Saloon', localKey: 'fake-local-key-2', ip: '', productName: '', productId: '', category: '', online: false, uuid: '' }
      ]
    })
    assert.deepEqual(cloud.calls.map((c) => c.query.a), [
      'tuya.m.user.email.token.create',
      'tuya.m.user.email.password.login',
      'tuya.m.location.list',
      'tuya.m.my.group.device.list',
      'tuya.m.my.group.device.list'
    ])
    cloud.calls.forEach(assertSigned)
    const [token, pw, list, dev1, dev2] = cloud.calls
    assert.equal(token.form.postData, GOLDEN.pd1)
    assert.equal(token.headers['content-type'], 'application/x-www-form-urlencoded')
    assert.equal(token.query.sid, undefined, 'no session before login')
    assert.equal(pw.form.postData, pyJson({ countryCode: '', email: 'skipper@example.com', ifencrypt: 1, options: '{"group": 1}', passwd: GOLDEN.rsa, token: 'fake-token' }))
    assert.equal(pw.query.sid, undefined)
    assert.equal(list.query.sid, 'fake-sid')
    assert.equal(list.raw, '', 'no body without a payload')
    assert.equal(list.headers['content-length'], '0')
    assert.equal(dev1.query.gid, '111')
    assert.equal(dev2.query.gid, '222')
    for (const c of cloud.calls) {
      assert.ok(!c.rawUrl.includes(FAKE_PASSWORD) && !c.raw.includes(FAKE_PASSWORD), 'plain password never sent')
      assert.ok(!c.raw.includes(md5Hex(FAKE_PASSWORD)), 'password hash never sent unencrypted')
    }
  } finally {
    await cloud.close()
  }
})

test('phone login: strips +, default country 40, custom country code', async () => {
  const cloud = await fakeCloud(happyCloud('mobile'))
  try {
    const r1 = await login({ account: '+40712345678', password: FAKE_PASSWORD }, { endpoint: cloud.endpoint, now: NOW })
    assert.equal(r1.ok, true)
    assert.equal(r1.devices.length, 2)
    const [token, pw] = cloud.calls
    assert.equal(token.query.a, 'tuya.m.user.mobile.token.create')
    assert.equal(token.form.postData, pyJson({ countryCode: '40', mobile: '40712345678' }))
    assert.equal(pw.query.a, 'tuya.m.user.mobile.password.login')
    assert.equal(pw.form.postData, pyJson({ countryCode: '40', mobile: '40712345678', ifencrypt: 1, options: '{"group": 1}', passwd: GOLDEN.rsa, token: 'fake-token' }))
    cloud.calls.forEach(assertSigned)

    cloud.calls.length = 0
    const r2 = await login({ account: '7700900123', password: FAKE_PASSWORD, countryCode: '44' }, { endpoint: cloud.endpoint, now: NOW })
    assert.equal(r2.ok, true)
    assert.equal(cloud.calls[0].form.postData, pyJson({ countryCode: '44', mobile: '7700900123' }))
  } finally {
    await cloud.close()
  }
})

test('missing account or password fails without any request', async () => {
  const cloud = await fakeCloud(() => ({ success: true }))
  try {
    for (const body of [{}, { account: 'a@b.c' }, { password: 'x' }, { account: '   ', password: 'x' }, null]) {
      const r = await login(body, { endpoint: cloud.endpoint })
      assert.deepEqual(r, { ok: false, error: 'AlecoAir email/phone and password are required.' })
    }
    assert.equal(cloud.calls.length, 0)
  } finally {
    await cloud.close()
  }
})

test('cloud errors are reported like the Python helper and never echo the password', async () => {
  const cases = [
    [{ success: false, errorMsg: 'Incorrect account or password', errorCode: 'USER_PASSWD_WRONG' }, 'Incorrect account or password'],
    [{ success: false, errorCode: 'ILLEGAL_CLIENT_ID' }, 'ILLEGAL_CLIENT_ID'],
    [{ success: false }, 'AlecoAir login failed.'],
    ['<html>Bad gateway</html>', 'AlecoAir cloud returned an unexpected response (HTTP 502).']
  ]
  for (const [reply, error] of cases) {
    const cloud = await fakeCloud(() => reply)
    try {
      const r = await login({ account: 'a@b.c', password: FAKE_PASSWORD }, { endpoint: cloud.endpoint })
      assert.deepEqual(r, { ok: false, error })
    } finally {
      await cloud.close()
    }
  }
})

test('failure after the token step (bad public key, missing session)', async () => {
  let cloud = await fakeCloud(({ query }) => query.a.endsWith('token.create') ? { success: true, result: { token: 't', publicKey: 'zz', exponent: '3' } } : { success: true, result: {} })
  try {
    const r = await login({ account: 'a@b.c', password: FAKE_PASSWORD }, { endpoint: cloud.endpoint })
    assert.deepEqual(r, { ok: false, error: 'AlecoAir cloud sent an invalid public key.' })
  } finally {
    await cloud.close()
  }
  cloud = await fakeCloud(({ query }) => query.a.endsWith('token.create') ? { success: true, result: { token: 't', publicKey: FAKE_MODULUS, exponent: '65537' } } : { success: true, result: {} })
  try {
    const r = await login({ account: 'a@b.c', password: FAKE_PASSWORD }, { endpoint: cloud.endpoint })
    assert.deepEqual(r, { ok: false, error: 'AlecoAir cloud sent no session.' })
  } finally {
    await cloud.close()
  }
})

test('unreachable cloud and slow cloud fail cleanly', async () => {
  const dead = await fakeCloud(() => ({}))
  const endpoint = dead.endpoint
  await dead.close()
  const r1 = await login({ account: 'a@b.c', password: FAKE_PASSWORD }, { endpoint })
  assert.equal(r1.ok, false)
  assert.match(r1.error, /ECONNREFUSED|connect/i)

  const slow = await fakeCloud(() => undefined)
  try {
    const r2 = await login({ account: 'a@b.c', password: FAKE_PASSWORD }, { endpoint: slow.endpoint, requestTimeoutMs: 100 })
    assert.deepEqual(r2, { ok: false, error: 'AlecoAir cloud did not answer in time.' })
    await assert.rejects(login({ account: 'a@b.c', password: FAKE_PASSWORD }, { endpoint: slow.endpoint, timeoutMs: 100 }), /AlecoAir login timed out\./)
  } finally {
    await slow.close()
  }
})

test('region goes into the cloud host name and is validated', async () => {
  const r = await login({ account: 'a@b.c', password: 'x', region: 'evil.example/x?' })
  assert.deepEqual(r, { ok: false, error: 'Unknown AlecoAir region "evil.example/x?".' })
  const { AlecoAirCloud } = require('../plugin/alecoair')
  assert.equal(new AlecoAirCloud('eu').endpoint.href, 'https://a1.tuyaeu.com/api.json')
  assert.equal(new AlecoAirCloud('us').endpoint.href, 'https://a1.tuyaus.com/api.json')
})

test('no Python: the plugin ships no helper script and spawns nothing for login', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'plugin', 'alecoair.js'), 'utf8')
  assert.ok(!/child_process|python/i.test(src.replace(/\/\/.*|\/\*[\s\S]*?\*\//g, '')))
  assert.ok(!fs.existsSync(path.join(__dirname, '..', 'plugin', 'alecoair-helper.py')))
  const pkg = require('../package.json')
  assert.ok(!pkg.files.includes('requirements.txt'))
  assert.deepEqual(Object.keys(pkg.dependencies), ['tuyapi'])
})
