'use strict'

const $ = (id) => document.getElementById(id)

const ui = {
  rh: $('rh'),
  arc: $('arc'),
  watts: $('watts'),
  tank: $('tank'),
  comp: $('comp'),
  conn: $('connPill'),
  modePill: $('modePill'),
  sim: $('simPill'),
  banner: $('banner'),
  power: $('powerBtn'),
  powerLabel: $('powerLabel'),
  target: $('target'),
  targetLabel: $('targetLabel'),
  timer: $('timerValue'),
  lock: $('lockBtn'),
  dry: $('dryBtn'),
  tankAlert: $('tankAlert'),
  defrostAlert: $('defrostAlert'),
  raw: $('raw')
}

let apiBase = '/plugins/signalk-alecoair-d13'
let state = null
let busy = false
let pollTimer = null
let picking = false
let qrWaiting = false

async function apiFetch(path, options = {}) {
  return fetch(path, { credentials: 'include', cache: 'no-store', ...options })
}

async function resolveApi() {
  const candidates = ['/plugins/signalk-alecoair-d13', '/api']
  for (const base of candidates) {
    try {
      const res = await apiFetch(`${base}/health`)
      if (res.ok) {
        apiBase = base
        return res.json()
      }
    } catch {
      // try next
    }
  }
  throw new Error('Signal K plugin API not found.')
}

function setBanner(text, kind) {
  ui.banner.textContent = text || ''
  ui.banner.classList.toggle('show', Boolean(text))
  ui.banner.classList.toggle('error', kind === 'error')
}

function labelMode(mode, sleep) {
  if (sleep) return 'Sleep'
  if (mode === 'continuous') return 'Continuous'
  return 'Auto'
}

function attr(value) {
  return String(value || '').replace(/[&<>"']/g, (ch) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[ch]))
}

function show(id, visible) {
  const el = $(id)
  if (el) el.hidden = !visible
}

function renderSetup(setup) {
  if (!setup) return
  ui.sim.textContent = setup.ready && !picking ? 'Tuya LAN' : 'setup'
  ui.sim.classList.toggle('ok', Boolean(setup.ready) && !picking)
  ui.sim.classList.toggle('warn', !setup.ready || picking)

  if (setup.ready && !picking && !setup.forcePick) {
    show('setupReady', true)
    show('setupLink', false)
    show('setupDevices', false)
    $('setupReadyText').textContent = `${setup.deviceName || setup.deviceId} · ${setup.ip || 'LAN'}`
    return
  }

  show('setupReady', false)
  if (setup.linked) {
    show('setupLink', false)
    show('setupDevices', true)
    const hint = $('deviceHint')
    if (!setup.devices || !setup.devices.length) {
      hint.textContent = 'AlecoAir login succeeded, but no devices came back. Use Different account and the email/phone from the app that shows the D13.'
    } else {
      hint.textContent = 'The key is stored on the Signal K server. You never type it.'
    }
    renderDevices(setup.devices || [])
    return
  }
  show('setupLink', true)
  show('setupDevices', false)
}

function renderDevices(devices) {
  const list = $('deviceList')
  if (!devices || !devices.length) {
    list.innerHTML = '<p style="color:var(--muted);margin:0">No devices in the Smart Life share list yet.</p>'
    return
  }
  list.innerHTML = devices.map((d) => `
    <div class="scan-item">
      <div>
        <b>${attr(d.name)}</b>
        <small>${attr(d.ip || 'IP from LAN')} · ${d.online ? 'online' : 'offline'}${d.productName ? ' · ' + attr(d.productName) : ''}</small>
      </div>
      <button type="button" class="ghost" data-use="${attr(d.id)}">Use this device</button>
    </div>
  `).join('')
  list.querySelectorAll('[data-use]').forEach((btn) => {
    btn.addEventListener('click', () => adoptDevice(btn.dataset.use))
  })
}

function render(next) {
  state = next
  const connected = Boolean(next.connected)
  ui.conn.textContent = connected ? 'connected' : 'disconnected'
  ui.conn.className = `pill ${connected ? 'ok' : 'alert'}`
  ui.modePill.textContent = labelMode(next.mode, next.sleep)

  const rh = Number(next.humidity)
  ui.rh.textContent = Number.isFinite(rh) ? `${Math.round(rh)}%` : '—'
  const circ = 2 * Math.PI * 78
  const span = 240 / 360
  const pct = Math.min(1, Math.max(0, (rh - 20) / 75))
  ui.arc.setAttribute('stroke-dasharray', String(circ * span))
  ui.arc.setAttribute('stroke-dashoffset', String(circ * span * (1 - pct)))
  ui.arc.setAttribute('stroke', next.tankFull ? '#ff6b6b' : rh >= (next.targetHumidity || 50) + 1 ? '#3ee0c3' : '#7fd4ff')

  ui.watts.textContent = `${Math.round(next.powerWatts || 0)} W`
  ui.tank.textContent = next.tankFull ? 'FULL' : 'OK'
  ui.comp.textContent = next.compressor ? 'ON' : 'OFF'

  ui.power.classList.toggle('on', Boolean(next.power))
  ui.power.textContent = next.power ? 'ON' : 'OFF'
  ui.powerLabel.textContent = next.power
    ? (next.compressor ? 'Compressor running, 13 L/day' : 'On, waiting for the hygrostat')
    : 'Off'

  if (next.mode === 'continuous') {
    ui.target.value = '30'
    ui.targetLabel.textContent = 'CO'
  } else {
    ui.target.value = String(next.targetHumidity || 50)
    ui.targetLabel.textContent = `${next.targetHumidity || 50}%`
  }
  ui.timer.textContent = `${next.timerHours || 0} h`
  const left = Math.round(Number(next.timerRemainingMin) || 0)
  if (left > 0) ui.timer.textContent = `${next.timerHours || 0} h · ${left} min`

  document.querySelectorAll('#modeSeg [data-mode]').forEach((btn) => {
    btn.classList.toggle('active', next.sleep ? btn.dataset.mode === 'sleep' : btn.dataset.mode === next.mode)
  })
  const controls = next.controls || {}
  show('fanRow', Boolean(controls.fan))
  show('dryBtn', Boolean(controls.insideDry))
  document.querySelectorAll('#modeSeg [data-mode="sleep"]').forEach((btn) => {
    btn.hidden = !controls.sleep
  })
  if (controls.fan) {
    document.querySelectorAll('#fanSeg [data-fan]').forEach((btn) => {
      btn.classList.toggle('active', btn.dataset.fan === next.fan)
    })
  }
  ui.lock.textContent = next.childLock ? 'Child lock ON' : 'Child lock'
  ui.dry.textContent = next.insideDry ? 'Inside dry ON' : 'Inside dry'
  ui.tankAlert.classList.toggle('show', Boolean(next.tankFull))
  ui.defrostAlert.classList.toggle('show', Boolean(next.defrost))
  ui.raw.textContent = JSON.stringify(next.rawDps && Object.keys(next.rawDps).length ? next.rawDps : next, null, 2)

  if (next.setup) renderSetup(picking ? { ...next.setup, forcePick: true } : next.setup)

  const ready = Boolean(next.setup && next.setup.ready)
  const linked = Boolean(next.setup && next.setup.linked)
  if (qrWaiting) return
  if (!ready && linked) {
    setBanner((next.setup.devices && next.setup.devices.length)
      ? 'AlecoAir is linked. Choose the dehumidifier.'
      : 'AlecoAir is linked, but that account has no devices.', 'error')
  } else if (!ready) setBanner('Sign in with the AlecoAir account that already shows the D13.', '')
  else if (next.lastError && !connected) setBanner(next.lastError, 'error')
  else if (!connected) {
    const age = next.updatedAt ? Date.now() - Number(next.updatedAt) : Infinity
    if (age < 60000 && next.rawDps && Object.keys(next.rawDps).length) setBanner('')
    else setBanner('Device is not answering on the LAN yet.', 'error')
  } else setBanner('')
}

async function readJson(res) {
  const text = await res.text()
  try {
    return text ? JSON.parse(text) : {}
  } catch {
    return { error: text.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim() }
  }
}

function authError(res, data) {
  if (res.status === 401 || res.status === 403) {
    return 'Signal K rejected the request (401). Open this page from the same host you used to log in, e.g. http://haimana.local:3000/signalk-alecoair-d13/'
  }
  return data.error || 'Request failed'
}

async function command(body) {
  if (busy) return
  busy = true
  try {
    const res = await apiFetch(`${apiBase}/command`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    })
    const data = await readJson(res)
    if (!res.ok) throw new Error(authError(res, data))
    render(data)
  } catch (err) {
    setBanner(err.message, 'error')
  } finally {
    busy = false
  }
}

async function unlinkAccount() {
  try {
    const res = await apiFetch(`${apiBase}/smartlife/unlink`, { method: 'POST' })
    const data = await readJson(res)
    if (!res.ok) throw new Error(authError(res, data))
    picking = false
    qrWaiting = false
    renderSetup(data)
    setBanner('Previous account cleared. Sign in with the AlecoAir email or phone that already shows the D13.', '')
  } catch (err) {
    setBanner(err.message, 'error')
  }
}

async function refreshDevices() {
  $('deviceHint').textContent = 'Asking Smart Life for devices…'
  try {
    const res = await apiFetch(`${apiBase}/smartlife/refresh`, { method: 'POST' })
    const data = await readJson(res)
    if (!res.ok) throw new Error(authError(res, data))
    picking = !data.ready
    renderSetup(data)
    setBanner(data.ready
      ? 'Device saved. The plugin is connecting on the LAN.'
      : (data.devices && data.devices.length
        ? 'Smart Life is linked. Choose the dehumidifier.'
        : 'Still no devices. Sign in with the AlecoAir account that shows the D13.'),
    data.ready || (data.devices && data.devices.length) ? '' : 'error')
  } catch (err) {
    setBanner(err.message, 'error')
  }
}

async function loadSetup() {
  const res = await apiFetch(`${apiBase}/setup`)
  const data = await readJson(res)
  if (res.ok) renderSetup(data)
  return data
}

async function adoptDevice(id) {
  try {
    const res = await apiFetch(`${apiBase}/adopt`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id })
    })
    const data = await readJson(res)
    if (!res.ok) throw new Error(authError(res, data))
    picking = false
    renderSetup(data)
    setBanner('Device saved. The plugin is connecting on the LAN.', '')
  } catch (err) {
    setBanner(err.message, 'error')
  }
}

async function alecoLogin() {
  const account = $('alecoAccount').value.trim()
  const password = $('alecoPassword').value
  if (!account || !password) {
    setBanner('Enter the AlecoAir email/phone and password.', 'error')
    return
  }
  setBanner('Signing in to AlecoAir…', '')
  try {
    const res = await apiFetch(`${apiBase}/alecoair/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ account, password, region: 'eu' })
    })
    const data = await readJson(res)
    if (!res.ok || !data.ok) throw new Error(authError(res, data))
    picking = !data.ready
    $('alecoPassword').value = ''
    renderSetup(data)
    setBanner(data.ready
      ? 'D13 saved. The plugin is connecting on the LAN.'
      : (data.devices && data.devices.length
        ? 'AlecoAir is linked. Choose the dehumidifier.'
        : 'AlecoAir login worked, but no devices were returned.'),
    data.ready || (data.devices && data.devices.length) ? '' : 'error')
  } catch (err) {
    setBanner(err.message, 'error')
  }
}

async function pollSmartLife() {
  if (pollTimer) clearTimeout(pollTimer)
  for (let i = 0; i < 50; i++) {
    try {
      const res = await apiFetch(`${apiBase}/smartlife/poll`, { method: 'POST' })
      const data = await readJson(res)
      if (res.status === 401 || res.status === 403) throw new Error(authError(res, data))
      if (res.status >= 500) throw new Error(data.error || 'Smart Life poll failed.')
      if (data.ok && (data.linked || data.ready)) {
        qrWaiting = false
        picking = !data.ready
        $('qrBox').innerHTML = data.ready
          ? '<p>Smart Life linked. Device saved.</p>'
          : '<p>Smart Life linked.</p>'
        renderSetup(data)
        setBanner(data.ready
          ? 'Device saved. The plugin is connecting on the LAN.'
          : (data.devices && data.devices.length
            ? 'Smart Life is linked. Choose the dehumidifier.'
            : 'Smart Life is linked, but that account shared no devices.'),
        data.ready || (data.devices && data.devices.length) ? '' : 'error')
        return
      }
    } catch (err) {
      qrWaiting = false
      setBanner(err.message, 'error')
      return
    }
    await new Promise((r) => { pollTimer = setTimeout(r, 2000) })
  }
  qrWaiting = false
  setBanner('The QR code expired. Generate a new one and scan it immediately.', 'error')
}

function bind() {
  ui.power.addEventListener('click', () => command({ power: !(state && state.power) }))
  document.querySelectorAll('#modeSeg [data-mode]').forEach((btn) => {
    btn.addEventListener('click', () => command({ mode: btn.dataset.mode }))
  })
  document.querySelectorAll('#fanSeg [data-fan]').forEach((btn) => {
    btn.addEventListener('click', () => {
      if (!(state && state.controls && state.controls.fan)) return
      command({ fan: btn.dataset.fan })
    })
  })
  ui.target.addEventListener('change', () => command({ targetHumidity: Number(ui.target.value) }))
  ui.target.addEventListener('input', () => {
    ui.targetLabel.textContent = `${ui.target.value}%`
  })
  $('timerMinus').addEventListener('click', () => command({ timerHours: Math.max(0, (state?.timerHours || 0) - 1) }))
  $('timerPlus').addEventListener('click', () => command({ timerHours: Math.min(24, (state?.timerHours || 0) + 1) }))
  ui.lock.addEventListener('click', () => command({ childLock: !(state && state.childLock) }))
  ui.dry.addEventListener('click', () => {
    if (!(state && state.controls && state.controls.insideDry)) return
    command({ insideDry: !(state && state.insideDry) })
  })
  if ($('alecoLoginBtn')) $('alecoLoginBtn').addEventListener('click', alecoLogin)
  $('refreshDevicesBtn').addEventListener('click', refreshDevices)
  if ($('unlinkBtn')) $('unlinkBtn').addEventListener('click', unlinkAccount)
  if ($('unlinkBtn2')) $('unlinkBtn2').addEventListener('click', unlinkAccount)
  $('changeDeviceBtn').addEventListener('click', async () => {
    picking = true
    const setup = await loadSetup()
    renderSetup({ ...setup, forcePick: true, linked: true })
  })
}

async function live() {
  setInterval(async () => {
    if (document.hidden) return
    try {
      const res = await apiFetch(`${apiBase}/state`)
      if (res.ok) render(await res.json())
    } catch {
      setBanner('Lost the connection to the plugin.', 'error')
    }
  }, 2000)
}

async function boot() {
  bind()
  try {
    const health = await resolveApi()
    renderSetup(health.setup)
    const res = await apiFetch(`${apiBase}/state`)
    if (!res.ok) throw new Error('Device state is not available.')
    render(await res.json())
    live()
  } catch (err) {
    setBanner(err.message, 'error')
    ui.conn.textContent = 'error'
    ui.conn.className = 'pill alert'
    ui.powerLabel.textContent = 'Cannot read state'
  }
}

boot()
