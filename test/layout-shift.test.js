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
      control: { configured: true, available: true, mode: 'external', target: 50, state: 'running', reason: '', sourceHumidity: 62 },
      sensorTemperature: { path: 'environment.inside.mainCabin.temperature', value: -12.4, unit: '°F' }
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
      statBelow: Math.round(Math.min(...st.map((x) => x.top)) - Math.max(...ms.map((x) => x.bottom), p.querySelector('.fan').hidden ? 0 : b('.fan').bottom)),
      statVsModes: Math.round((Math.min(...st.map((x) => x.left)) + Math.max(...st.map((x) => x.right))) / 2 - (Math.min(...ms.map((x) => x.left)) + Math.max(...ms.map((x) => x.right))) / 2),
      msgBelowStat: Math.round(m.top - Math.max(...st.map((x) => x.bottom))),
      statTextVsGauge: (() => {
        // bottom of the last status line's text vs the bottom of the gauge's 30 / 80 labels
        const last = [...p.querySelectorAll('.stat')].filter((e) => !e.closest('[hidden]')).pop()
        const rg = document.createRange(); rg.selectNodeContents(last.firstChild)
        const rg2 = document.createRange(); rg2.selectNodeContents(p.querySelector('.end').firstChild)
        return Math.round(rg.getBoundingClientRect().bottom - rg2.getBoundingClientRect().bottom)
      })(),
      modesCentred: (() => {
        const fan = p.querySelector('.fan')
        const grp = ms.concat(fan.hidden ? [] : [fan.getBoundingClientRect()])
        const side = b('.side'), pad = parseFloat(getComputedStyle(p.querySelector('.side')).paddingTop)
        const gap = parseFloat(getComputedStyle(p.querySelector('.side')).rowGap) || 0
        const above = Math.min(...grp.map((x) => x.top)) - (side.top + pad)
        const below = Math.min(...st.map((x) => x.top)) - gap - Math.max(...grp.map((x) => x.bottom))
        return Math.round(above - below)
      })(),
      cardH: Math.round(pr.height)
    }
  }
  return JSON.stringify(out)
})()`

test('desktop: gauge at the same x on every card, modes centred in the rest, status labels centred under them', { skip: !CHROME && 'no Chrome/Chromium found', timeout: 90000 }, async () => {
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
      assert.equal(new Set(Object.values(got).map((g) => g.cardH)).size, 1, `same card height on every unit (${width} px: ${JSON.stringify(got)})`)
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
        assert.ok(g.statRows <= 2, `status labels on at most two lines (${at})`)
        assert.ok(Math.abs(g.statVsModes) <= 2, `status labels centred under the modes (${at})`)
        assert.ok(g.statBelow >= 0, `status labels below the modes and fan (${at})`)
        assert.ok(g.msgBelowStat >= 0, `message slot below the status labels (${at})`)
        assert.ok(Math.abs(g.statTextVsGauge) <= 1, `status text bottom level with the gauge's 30 / 80 labels (${at})`)
        assert.ok(Math.abs(g.modesCentred) <= 2, `modes (and fan) centred in the space above the status labels (${at})`)
        assert.ok(g.msgInside, `message inside the card (${at})`)
      }
    }
  } finally {
    cdp.close()
    server.close()
  }
})

const TEMP = `(() => {
  const out = {}
  const r = (el) => { const b = el.getBoundingClientRect(); return [Math.round(b.left), Math.round(b.top), Math.round(b.width), Math.round(b.height)] }
  for (const p of document.querySelectorAll('.panel[data-key]')) {
    const t = p.querySelector('.ext-temp')
    const fixed = { target: r(p.querySelector('.target')), current: r(p.querySelector('.current')), ring: r(p.querySelector('.ring')), ends: r(p.querySelector('.end-max')) }
    if (t.hidden) { out[p.dataset.key] = { shown: false, fixed }; continue }
    const b = (el) => el.getBoundingClientRect()
    const tb = b(t), cur = b(p.querySelector('.current')), rg = b(p.querySelector('.ring'))
    const ends = [...p.querySelectorAll('.end')].map(b)
    const cx = rg.left + rg.width / 2, cy = rg.top + rg.height / 2
    const sw = parseFloat(getComputedStyle(p.querySelector('.arc-fill')).strokeWidth) || 4
    const inner = (rg.width / 2) * 86 / 100 - sw * rg.width / 400
    const far = Math.max(...[[tb.left, tb.top], [tb.right, tb.top], [tb.left, tb.bottom], [tb.right, tb.bottom]].map(([x, y]) => Math.hypot(x - cx, y - cy)))
    out[p.dataset.key] = {
      shown: true,
      fixed,
      text: t.textContent.trim(),
      oneLine: tb.height < 22,
      belowCurrent: Math.round(tb.top - cur.bottom),
      centred: Math.round((tb.left + tb.right) / 2 - cx),
      insideArc: Math.round(inner - far),
      clearOfEnds: ends.every((e) => e.right <= tb.left || e.left >= tb.right || e.bottom <= tb.top || e.top >= tb.bottom),
      fontPx: parseFloat(getComputedStyle(t).fontSize),
      currentPx: parseFloat(getComputedStyle(p.querySelector('.current')).fontSize)
    }
  }
  return JSON.stringify(out)
})()`
test('external temperature: under the current humidity in the gauge centre; moves nothing; a click there shows no focus ring (desktop and phone)', { skip: !CHROME && 'no Chrome/Chromium found', timeout: 90000 }, async () => {
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
    for (const [width, mobile] of [[1024, false], [1280, false], [1600, false], [390, true], [360, true]]) {
      await s('Emulation.setDeviceMetricsOverride', { width, height: 800, deviceScaleFactor: 1, mobile })
      await s('Page.navigate', { url: `http://127.0.0.1:${port}/signalk-alecoair/` })
      for (let i = 0; i < 100 && !(await evaluate("document.querySelectorAll('.panel[data-key] .mode').length === 9")); i++) await sleep(100)
      for (let i = 0; i < 50 && (await evaluate("document.querySelector('#device-d16 .ext-temp').hidden")); i++) await sleep(100)
      const before = JSON.parse(await evaluate(MEASURE))
      const got = JSON.parse(await evaluate(TEMP))
      assert.equal(got.d13.shown, false, `no temperature without sensorTemperature (${width} px)`)
      const g = got.d16
      const at = `${width} px: ${JSON.stringify(g)}`
      assert.ok(g.shown && g.text === '-12.4 °F', `value with one decimal and the unit from the state (${at})`)
      assert.ok(g.oneLine && g.belowCurrent >= 2 && Math.abs(g.centred) <= 2, `one line, centred under the humidity (${at})`)
      assert.ok(Math.abs(g.fontPx - g.currentPx) <= 1, `about the size of the humidity line (${at})`)
      assert.ok(g.insideArc >= 2 && g.clearOfEnds, `inside the arc, clear of the 30 / 80 labels (${at})`)
      // A click on the temperature: no focus ring, no selection, the target does not move.
      const pt = JSON.parse(await evaluate("(() => { const b = document.querySelector('#device-d16 .ext-temp').getBoundingClientRect(); return JSON.stringify([b.left + b.width / 2, b.top + b.height / 2]) })()"))
      const tgt = await evaluate("document.querySelector('#device-d16 [data-r=target]').textContent")
      for (const type of ['mousePressed', 'mouseReleased']) await s('Input.dispatchMouseEvent', { type, x: pt[0], y: pt[1], button: 'left', clickCount: 1 })
      await sleep(150)
      const after1 = JSON.parse(await evaluate("(() => { const r = document.querySelector('#device-d16 .ring'); return JSON.stringify({ outline: getComputedStyle(r).outlineStyle, sel: String(getSelection()), target: document.querySelector('#device-d16 [data-r=target]').textContent }) })()"))
      assert.equal(after1.outline, 'none', `no focus ring after a click on the temperature (${width} px)`)
      assert.equal(after1.sel, '', `nothing selected (${width} px)`)
      assert.equal(after1.target, tgt, `the target does not move (${width} px)`)
      st.D.d16.sensorTemperature = null
      for (let i = 0; i < 50 && !(await evaluate("document.querySelector('#device-d16 .ext-temp').hidden")); i++) await sleep(100)
      const after = JSON.parse(await evaluate(MEASURE))
      const gone = JSON.parse(await evaluate(TEMP))
      assert.deepEqual(after, before, `hiding the temperature moves nothing (${width} px)`)
      assert.deepEqual(gone.d16.fixed, g.fixed, `target and humidity line stay put (${width} px)`)
      st.D = units()
    }
  } finally {
    cdp.close()
    server.close()
  }
})
