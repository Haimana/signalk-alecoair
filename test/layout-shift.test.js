'use strict'

/*
 * Layout-shift check in a real browser: the WebApp is served with a fake
 * plugin API (two units), then the gauge, −/+, mode and status positions are
 * measured with and without card messages and the page banner, on a desktop
 * and a phone viewport. They must not move.
 *
 * Uses a local Chrome/Chromium over the DevTools pipe (no npm dependency).
 * Skipped when no browser is found (set CHROME=/path/to/chrome to choose one).
 */

const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const os = require('os')
const path = require('path')
const http = require('http')
const { spawn } = require('child_process')

const PUB = path.join(__dirname, '..', 'public')
const CHROME = [process.env.CHROME, '/usr/bin/google-chrome-stable', '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'].find((p) => p && fs.existsSync(p))

function units() {
  const base = {
    connected: true, power: true, humidity: 57, compressor: true, defrost: false, tankFull: false, childLock: false,
    timerHours: 2, timerMaxHours: 24, humidityRange: { min: 30, max: 80, step: 5 }, profile: { id: 'traditio', name: 'Traditio' },
    sensors: { humidity: true, compressor: true, defrost: true, tankFull: true }
  }
  return {
    d13: {
      ...base, key: 'd13', name: 'D13', mode: 'auto', targetHumidity: 45, ui: { showChildLock: true, showTimer: true },
      controls: { power: true, mode: true, targetHumidity: true, fan: false, childLock: true, timer: true },
      modes: [{ value: 'auto', label: 'Auto / hygrostat' }, { value: 'external', label: 'Auto / external sensor' }, { value: 'continuous', label: 'Continuous (CO)' }, { value: 'sleep', label: 'Sleep' }],
      control: { configured: true, available: true, mode: 'internal', target: 50, state: 'internal' }
    },
    d16: {
      ...base, key: 'd16', name: 'D16', mode: 'external', targetHumidity: 50, fan: 'high', timerHours: 0,
      controls: { power: true, mode: true, targetHumidity: true, fan: true, childLock: true, timer: true },
      modes: [{ value: 'auto', label: 'Normal' }, { value: 'laundry', label: 'Laundry' }, { value: 'purify', label: 'Purify' }, { value: 'sleep', label: 'Sleep' }, { value: 'external', label: 'Auto / external sensor' }],
      control: { configured: true, available: true, mode: 'external', target: 50, state: 'running', reason: '', sourceHumidity: 62 }
    }
  }
}

function fakeServer() {
  const st = { D: units(), fail: false }
  const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' }
  const server = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x')
    if (u.pathname === '/plugins/signalk-alecoair/devices') {
      return res.end(JSON.stringify({ devices: Object.values(st.D).map((d) => ({ key: d.key, name: d.name })) }))
    }
    const m = u.pathname.match(/devices\/(\w+)\/state$/)
    if (m) {
      if (st.fail) { res.statusCode = 500; return res.end('{"error":"boom"}') }
      return res.end(JSON.stringify(st.D[m[1]]))
    }
    const f = path.join(PUB, u.pathname.replace(/^\/signalk-alecoair\/?/, '') || 'index.html')
    if (!f.startsWith(PUB) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.statusCode = 404; return res.end() }
    res.setHeader('Content-Type', types[path.extname(f)] || 'application/octet-stream')
    res.end(fs.readFileSync(f))
  })
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ st, server, port: server.address().port })))
}

/** Minimal DevTools-protocol client over --remote-debugging-pipe (fd 3 in, fd 4 out). */
function launch() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'alecoair-chrome-'))
  const proc = spawn(CHROME, ['--headless=new', '--remote-debugging-pipe', '--no-first-run', '--no-default-browser-check',
    '--disable-gpu', '--disable-dev-shm-usage', '--no-sandbox', '--hide-scrollbars', `--user-data-dir=${dir}`, 'about:blank'],
  { stdio: ['ignore', 'ignore', 'ignore', 'pipe', 'pipe'] })
  const out = proc.stdio[3]
  const inp = proc.stdio[4]
  let id = 0
  let buf = ''
  const waiting = new Map()
  inp.on('data', (chunk) => {
    buf += chunk.toString('utf8')
    let i
    while ((i = buf.indexOf('\0')) >= 0) {
      const msg = JSON.parse(buf.slice(0, i))
      buf = buf.slice(i + 1)
      if (msg.id && waiting.has(msg.id)) {
        const { resolve, reject } = waiting.get(msg.id)
        waiting.delete(msg.id)
        if (msg.error) reject(new Error(msg.error.message))
        else resolve(msg.result)
      }
    }
  })
  const send = (method, params = {}, sessionId) => new Promise((resolve, reject) => {
    const msg = { id: ++id, method, params }
    if (sessionId) msg.sessionId = sessionId
    waiting.set(msg.id, { resolve, reject })
    out.write(JSON.stringify(msg) + '\0')
  })
  const close = () => {
    try { proc.kill('SIGKILL') } catch {}
    try { fs.rmSync(dir, { recursive: true, force: true }) } catch {}
  }
  return { send, close }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const MEASURE = `(() => {
  const r = (el) => { if (!el) return null; const b = el.getBoundingClientRect(); return [Math.round(b.left), Math.round(b.top + scrollY), Math.round(b.width), Math.round(b.height)] }
  const out = {}
  for (const p of document.querySelectorAll('.panel[data-key]')) {
    const q = (s) => p.querySelector(s)
    out[p.dataset.key] = {
      card: r(p), ring: r(q('.ring')), plus: r(q('.step-plus')), minus: r(q('.step-minus')),
      mode1: r(q('.mode')), modeN: r([...p.querySelectorAll('.mode')].pop()), stat1: r(q('.stat:not([hidden])')),
      extStat: r(q('[data-r=extStat]'))
    }
  }
  return JSON.stringify(out)
})()`

test('messages and the page banner never move the gauge, -/+, modes or status icons (desktop 1280 + 1024 and phone)', { skip: !CHROME && 'no Chrome/Chromium found', timeout: 90000 }, async () => {
  const { st, server, port } = await fakeServer()
  const cdp = launch()
  try {
    const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' })
    const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true })
    const s = (m, p) => cdp.send(m, p, sessionId)
    const evaluate = async (expression) => {
      const res = await s('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
      if (res.exceptionDetails) throw new Error(res.exceptionDetails.exception ? res.exceptionDetails.exception.description : res.exceptionDetails.text)
      return res.result.value
    }
    const until = async (expression, what) => {
      for (let i = 0; i < 100; i++) {
        if (await evaluate(expression)) return
        await sleep(100)
      }
      throw new Error(`timed out waiting for ${what}`)
    }
    const measure = async () => JSON.parse(await evaluate(MEASURE))
    const refresh = (key) => evaluate(`views.get('${key}').refresh().then(() => true)`)
    const msg = (key) => evaluate(`(() => { const m = document.querySelector('#device-${key} .msg'); return { show: m.classList.contains('show'), text: m.textContent, title: m.title } })()`)

    for (const [name, width, height, mobile] of [['desktop', 1280, 800, false], ['desktop 1024', 1024, 768, false], ['phone', 390, 844, true]]) {
      st.D = units()
      st.fail = false
      await s('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile })
      await s('Page.navigate', { url: `http://127.0.0.1:${port}/signalk-alecoair/` })
      await until("document.querySelectorAll('.panel[data-key] .mode').length === 9", `${name}: cards rendered`)
      const base = await measure()

      // Card messages: offline with a long error (d13), tank full (d16).
      st.D.d13.connected = false
      st.D.d13.lastError = 'connect EHOSTUNREACH 172.22.22.224:6668: the unit is not answering on the LAN, check that it is powered and on the boat Wi-Fi'
      st.D.d16.tankFull = true
      await refresh('d13')
      await refresh('d16')
      const m13 = await msg('d13')
      assert.equal(m13.show, true, `${name}: offline message shown`)
      assert.match(m13.title, /EHOSTUNREACH/, `${name}: full text in the tooltip`)
      assert.equal((await msg('d16')).text, 'Tank full. The unit has stopped.')
      assert.deepEqual(await measure(), base, `${name}: card messages do not move anything`)

      // External-control warning with a long reason.
      st.D.d16.tankFull = false
      st.D.d16.control = { ...st.D.d16.control, state: 'sensor-missing', reason: 'No fresh external humidity for 5 min: the unit runs on its own hygrostat.' }
      await refresh('d16')
      assert.match((await msg('d16')).text, /sensor missing/)
      assert.deepEqual(await measure(), base, `${name}: external-sensor warning does not move anything`)

      // Page banner on an HTTP error (500), as a toast over the cards.
      st.fail = true
      await until("refreshAll().then(() => document.getElementById('banner').classList.contains('show'))", `${name}: banner on HTTP 500`)
      assert.equal(await evaluate("document.getElementById('banner').textContent"), 'Lost the connection to the plugin.')
      assert.equal(await evaluate("getComputedStyle(document.getElementById('banner')).position"), 'fixed')
      assert.deepEqual(await measure(), base, `${name}: the banner does not move anything`)

      // Back to normal: messages hide, still nothing moves.
      st.fail = false
      st.D = units()
      await until("refreshAll().then(() => !document.getElementById('banner').classList.contains('show'))", `${name}: banner hidden`)
      await refresh('d13')
      assert.equal((await msg('d13')).show, false)
      assert.deepEqual(await measure(), base, `${name}: hiding messages does not move anything`)
    }
  } finally {
    cdp.close()
    server.close()
  }
})

const BALANCE = `(() => {
  const out = {}
  for (const p of document.querySelectorAll('.panel[data-key]')) {
    const pr = p.getBoundingClientRect()
    const ms = [...p.querySelectorAll('.mode')].map((e) => e.getBoundingClientRect())
    const innerRight = pr.right - parseFloat(getComputedStyle(p).paddingRight)
    const b = (s) => p.querySelector(s).getBoundingClientRect()
    const m = b('.msg')
    const st = [...p.querySelectorAll('.stat')].filter((e) => !e.closest('[hidden]')).map((e) => e.getBoundingClientRect())
    out[p.dataset.key] = {
      gaugeX: Math.round(b('.ring').left - pr.left),
      gaugeToStep: Math.round(b('.step-plus').left - b('.ring').right),
      modesLeft: Math.round(Math.min(...ms.map((x) => x.left)) - b('.step-plus').right),
      modesRight: Math.round(innerRight - Math.max(...ms.map((x) => x.right))),
      modeRows: new Set(ms.map((x) => Math.round(x.top))).size,
      msgInside: m.left >= pr.left && m.right <= pr.right,
      statRows: new Set(st.map((x) => Math.round(x.top))).size,
      statLeft: Math.round(Math.min(...st.map((x) => x.left)) - pr.left),
      statRight: Math.round(pr.right - Math.max(...st.map((x) => x.right))),
      statBelow: Math.round(Math.min(...st.map((x) => x.top)) - Math.max(b('.ring').bottom, b('.side').bottom))
    }
  }
  return JSON.stringify(out)
})()`

test('desktop: gauge at the same x on every card, modes centred in the rest, status row centred', { skip: !CHROME && 'no Chrome/Chromium found', timeout: 90000 }, async () => {
  const { st, server, port } = await fakeServer()
  const cdp = launch()
  try {
    const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' })
    const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true })
    const s = (m, p) => cdp.send(m, p, sessionId)
    const evaluate = async (expression) => {
      const res = await s('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
      if (res.exceptionDetails) throw new Error(res.exceptionDetails.exception ? res.exceptionDetails.exception.description : res.exceptionDetails.text)
      return res.result.value
    }
    st.D = units()
    st.D.d16.control = { ...st.D.d16.control, state: 'sensor-missing', reason: 'No fresh external humidity for 5 min: the unit runs on its own hygrostat.' }
    for (const width of [1024, 1100, 1280, 1600]) {
      await s('Emulation.setDeviceMetricsOverride', { width, height: 800, deviceScaleFactor: 1, mobile: false })
      await s('Page.navigate', { url: `http://127.0.0.1:${port}/signalk-alecoair/` })
      for (let i = 0; i < 100 && !(await evaluate("document.querySelectorAll('.panel[data-key] .mode').length === 9 && document.querySelector('#device-d16 .msg.show') !== null")); i++) await sleep(100)
      const got = JSON.parse(await evaluate(BALANCE))
      const xs = new Set(Object.values(got).map((g) => g.gaugeX))
      assert.equal(xs.size, 1, `gauge at the same x on every card whatever the mode count (${width} px: ${JSON.stringify(got)})`)
      if (width >= 1280) assert.equal([...xs][0], 100, 'gauge 100 px from the card edge on wide screens')
      for (const [key, g] of Object.entries(got)) {
        const at = `${width} px, ${key}: ${JSON.stringify(g)}`
        assert.equal(g.gaugeToStep, 64, `gauge -> -/+ (${at})`)
        assert.ok(Math.abs(g.modesLeft - g.modesRight) <= 1, `modes centred between the -/+ and the card's right padding (${at})`)
        assert.ok(g.modesLeft >= 16, `room between the -/+ and the modes (${at})`)
        assert.equal(g.modeRows, 1, `modes on one row (${at})`)
        assert.ok(g.msgInside, `message stays inside the card (${at})`)
        assert.equal(g.statRows, 1, `status labels on one row (${at})`)
        assert.ok(Math.abs(g.statLeft - g.statRight) <= 1, `status row centred (${at})`)
        assert.ok(g.statBelow >= 0, `status row below the gauge and modes (${at})`)
      }
    }
  } finally {
    cdp.close()
    server.close()
  }
})
