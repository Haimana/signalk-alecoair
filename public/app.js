'use strict'

/*
 * AlecoAir usage WebApp: operate the configured dehumidifiers.
 * Setup (account, discovery, adopting devices, DP inspector) lives only in
 * Signal K Admin → Plugin Config → AlecoAir.
 */

const PLUGIN_ID = 'signalk-alecoair'
const API = `/plugins/${PLUGIN_ID}`
const $ = (id) => document.getElementById(id)

const ui = {
  title: $('title'),
  subtitle: $('subtitle'),
  switcher: $('switcher'),
  rh: $('rh'),
  arc: $('arc'),
  watts: $('watts'),
  tank: $('tank'),
  tankLabel: $('tankLabel'),
  comp: $('comp'),
  conn: $('connPill'),
  modePill: $('modePill'),
  profilePill: $('profilePill'),
  banner: $('banner'),
  power: $('powerBtn'),
  powerLabel: $('powerLabel'),
  modeSeg: $('modeSeg'),
  target: $('target'),
  targetLabel: $('targetLabel'),
  timer: $('timerValue'),
  timerTitle: $('timerTitle'),
  lock: $('lockBtn'),
  sleep: $('sleepBtn'),
  dry: $('dryBtn'),
  tankAlert: $('tankAlert'),
  tankAlertText: $('tankAlertText'),
  defrostAlert: $('defrostAlert')
}

let devices = []
let currentKey = null
let state = null
let busy = false
let pendingCommand = null
let hold = null
let modeSig = ''

function show(id, visible) {
  const el = typeof id === 'string' ? $(id) : id
  if (el) el.hidden = !visible
}

function setBanner(text, kind) {
  ui.banner.textContent = text || ''
  ui.banner.classList.toggle('show', Boolean(text))
  ui.banner.classList.toggle('error', kind === 'error')
}

function beginHold(body) {
  hold = { until: Date.now() + 8000, fields: { ...(hold && hold.fields), ...body } }
}

function applyHold(next) {
  if (!hold || Date.now() > hold.until) {
    hold = null
    return next
  }
  const out = { ...next }
  for (const [key, want] of Object.entries(hold.fields)) {
    const have = key === 'targetHumidity' || key === 'timerHours' ? Number(out[key]) === Number(want) : out[key] === want
    if (have) delete hold.fields[key]
    else out[key] = want
  }
  if (hold.fields.targetHumidity !== undefined && out.mode === 'continuous') out.mode = ((out.modes || [])[0] || {}).value || 'auto'
  if (!Object.keys(hold.fields).length) hold = null
  return out
}

async function apiFetch(path, options = {}) {
  return fetch(`${API}${path}`, { credentials: 'include', cache: 'no-store', ...options })
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
    return 'Signal K needs you to log in with write access. Log in on this server, then reload this page.'
  }
  return data.error || 'Request failed'
}

function attr(value) {
  return String(value ?? '').replace(/[&<>"']/g, (ch) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[ch]))
}

function modeLabel(next) {
  const m = (next.modes || []).find((x) => x.value === next.mode)
  if (m) return m.label
  return next.mode || '—'
}

function renderSwitcher() {
  show(ui.switcher, devices.length > 1)
  if (devices.length <= 1) return
  ui.switcher.innerHTML = devices.map((d) => `
    <button type="button" class="${d.key === currentKey ? 'active' : ''}" data-key="${attr(d.key)}">
      <b>${attr(d.name)}</b>
      <small>${d.connected ? (d.humidity === null || d.humidity === undefined ? 'connected' : `${d.humidity}% RH`) : 'offline'}${d.power ? ' · ON' : ''}</small>
    </button>`).join('')
  ui.switcher.querySelectorAll('[data-key]').forEach((btn) => {
    btn.addEventListener('click', () => selectDevice(btn.dataset.key))
  })
}

function renderModes(next) {
  const modes = next.modes || []
  const sig = modes.map((m) => m.value).join('|')
  if (sig !== modeSig) {
    modeSig = sig
    ui.modeSeg.innerHTML = modes.map((m) => `<button type="button" data-mode="${attr(m.value)}">${attr(m.label)}</button>`).join('')
    ui.modeSeg.querySelectorAll('[data-mode]').forEach((btn) => {
      btn.addEventListener('click', () => command({ mode: btn.dataset.mode }))
    })
  }
  ui.modeSeg.querySelectorAll('[data-mode]').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.mode === next.mode)
  })
}

function render(raw) {
  const next = applyHold(raw)
  state = next
  const c = next.controls || {}
  const s = next.sensors || {}
  const connected = Boolean(next.connected)

  ui.title.textContent = next.name || 'AlecoAir'
  const plate = []
  if (next.model) plate.push(next.model)
  if (next.capacityLitersPerDay) plate.push(`${next.capacityLitersPerDay} L/day`)
  if (next.ratedWatts) plate.push(`${next.ratedWatts} W`)
  plate.push('local Tuya LAN')
  ui.subtitle.textContent = plate.join(' · ')

  ui.conn.textContent = next.simulate ? 'simulator' : (connected ? 'connected' : 'disconnected')
  ui.conn.className = `pill ${connected ? 'ok' : 'alert'}`
  ui.modePill.textContent = c.mode ? modeLabel(next) : '—'
  ui.profilePill.textContent = next.profile ? `${next.profile.name}${next.profile.verified ? '' : ' (unverified)'}` : '—'
  ui.profilePill.className = `pill ${next.profile && next.profile.verified ? '' : 'warn'}`

  const rh = Number(next.humidity)
  const hasRh = s.humidity && next.humidity !== null && Number.isFinite(rh)
  ui.rh.textContent = hasRh ? `${Math.round(rh)}%` : '—'
  const circ = 2 * Math.PI * 78
  const span = 240 / 360
  const pct = hasRh ? Math.min(1, Math.max(0, (rh - 20) / 75)) : 0
  ui.arc.setAttribute('stroke-dasharray', String(circ * span))
  ui.arc.setAttribute('stroke-dashoffset', String(circ * span * (1 - pct)))
  ui.arc.setAttribute('stroke', next.tankFull ? '#ff6b6b' : rh >= (next.targetHumidity || 50) + 1 ? '#3ee0c3' : '#7fd4ff')

  show('wattsStat', s.powerWatts)
  ui.watts.textContent = `${Math.round(next.powerWatts || 0)} W`
  show('tankStat', s.tankFull)
  ui.tank.textContent = next.tankFull ? 'FULL' : 'OK'
  ui.tankLabel.textContent = next.tankLitersMax ? `${next.tankLitersMax} L tank` : 'tank'
  show('compStat', s.compressor)
  ui.comp.textContent = next.compressor ? 'ON' : 'OFF'

  show('powerRow', c.power)
  ui.power.classList.toggle('on', Boolean(next.power))
  ui.power.textContent = next.power ? 'ON' : 'OFF'
  ui.powerLabel.textContent = next.power
    ? (next.compressor ? 'Compressor running' : 'On, waiting for the hygrostat')
    : 'Off'

  show('modeBlock', c.mode)
  if (c.mode) renderModes(next)

  show('targetBlock', c.targetHumidity)
  const range = next.humidityRange || { min: 30, max: 80, step: 5 }
  ui.target.min = String(range.min)
  ui.target.max = String(range.max)
  ui.target.step = String(range.step)
  const scrubbing = document.activeElement === ui.target
  if (next.mode === 'continuous' && next.continuousTarget !== null && !(hold && hold.fields && hold.fields.targetHumidity !== undefined)) {
    if (!scrubbing) ui.target.value = String(range.min)
    ui.targetLabel.textContent = 'CO'
  } else if (!scrubbing) {
    ui.target.value = String(next.targetHumidity || 50)
    ui.targetLabel.textContent = `${next.targetHumidity || 50}%`
  } else {
    ui.targetLabel.textContent = `${ui.target.value}%`
  }

  show('fanRow', c.fan)
  document.querySelectorAll('#fanSeg [data-fan]').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.fan === next.fan)
  })

  show('timerRow', c.timer)
  ui.timerTitle.textContent = `Timer 0–${next.timerMaxHours || 24} h`
  ui.timer.textContent = `${next.timerHours || 0} h`
  const left = Math.round(Number(next.timerRemainingMin) || 0)
  if (left > 0) ui.timer.textContent = `${next.timerHours || 0} h · ${left} min`

  const sleepIsMode = (next.modes || []).some((m) => m.value === 'sleep')
  show('lockBtn', c.childLock)
  show('sleepBtn', c.sleep && !sleepIsMode)
  show('dryBtn', c.insideDry)
  show('toggleRow', c.childLock || (c.sleep && !sleepIsMode) || c.insideDry)
  ui.lock.textContent = next.childLock ? 'Child lock ON' : 'Child lock'
  ui.sleep.textContent = next.sleep ? 'Sleep ON' : 'Sleep'
  ui.dry.textContent = next.insideDry ? 'Inside dry ON' : 'Inside dry'

  ui.tankAlertText.textContent = `${next.tankLitersMax ? `The ${next.tankLitersMax} L tank` : 'The tank'} is full. The unit has stopped.`
  ui.tankAlert.classList.toggle('show', Boolean(next.tankFull))
  ui.defrostAlert.classList.toggle('show', Boolean(next.defrost))

  if (next.lastError && !connected) setBanner(next.lastError, 'error')
  else if (!connected) setBanner('The unit is not answering on the LAN yet.', 'error')
  else if (next.profile && next.profile.id === 'generic') setBanner('This unit has no model profile yet, so it is read-only. Pick a profile in Signal K Admin → Plugin Config → AlecoAir.', '')
  else setBanner('')
}

async function command(body) {
  if (!currentKey) return
  beginHold(body)
  if (state) render({ ...state })
  if (busy) {
    pendingCommand = { ...(pendingCommand || {}), ...body }
    return
  }
  busy = true
  const key = currentKey
  try {
    let payload = body
    while (payload) {
      pendingCommand = null
      const res = await apiFetch(`/devices/${encodeURIComponent(key)}/command`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      })
      const data = await readJson(res)
      if (!res.ok) throw new Error(authError(res, data))
      if (key === currentKey) render(data)
      payload = pendingCommand
    }
  } catch (err) {
    hold = null
    setBanner(err.message, 'error')
  } finally {
    busy = false
  }
}

async function loadDevices() {
  const res = await apiFetch('/devices')
  const data = await readJson(res)
  if (!res.ok) throw new Error(authError(res, data))
  devices = data.devices || []
  return devices
}

async function refreshState() {
  if (!currentKey) return
  const res = await apiFetch(`/devices/${encodeURIComponent(currentKey)}/state`)
  if (res.ok) render(await res.json())
  else if (res.status === 404 && !booting) await boot()
}

function selectDevice(key) {
  currentKey = key
  state = null
  hold = null
  pendingCommand = null
  modeSig = ''
  try { localStorage.setItem(`${PLUGIN_ID}.device`, key) } catch { /* private mode */ }
  const url = new URL(window.location.href)
  url.searchParams.set('device', key)
  window.history.replaceState(null, '', url)
  renderSwitcher()
  refreshState().catch((err) => setBanner(err.message, 'error'))
}

function bind() {
  ui.power.addEventListener('click', () => command({ power: !(state && state.power) }))
  document.querySelectorAll('#fanSeg [data-fan]').forEach((btn) => {
    btn.addEventListener('click', () => command({ fan: btn.dataset.fan }))
  })
  ui.target.addEventListener('pointerdown', () => beginHold({ targetHumidity: Number(ui.target.value) }))
  ui.target.addEventListener('input', () => {
    const targetHumidity = Number(ui.target.value)
    ui.targetLabel.textContent = `${targetHumidity}%`
    beginHold({ targetHumidity })
  })
  ui.target.addEventListener('change', () => command({ targetHumidity: Number(ui.target.value) }))
  $('timerMinus').addEventListener('click', () => command({ timerHours: Math.max(0, (state?.timerHours || 0) - 1) }))
  $('timerPlus').addEventListener('click', () => command({ timerHours: Math.min(state?.timerMaxHours || 24, (state?.timerHours || 0) + 1) }))
  ui.lock.addEventListener('click', () => command({ childLock: !(state && state.childLock) }))
  ui.sleep.addEventListener('click', () => command({ sleep: !(state && state.sleep) }))
  ui.dry.addEventListener('click', () => command({ insideDry: !(state && state.insideDry) }))
}

let liveTimer = null
let listTimer = null

function live() {
  if (liveTimer) return
  liveTimer = setInterval(() => {
    if (document.hidden) return
    refreshState().catch(() => setBanner('Lost the connection to the plugin.', 'error'))
  }, 2000)
  listTimer = setInterval(() => {
    if (document.hidden || devices.length < 2) return
    loadDevices().then(renderSwitcher).catch(() => {})
  }, 10000)
}

let booting = false

async function boot() {
  booting = true
  try {
    await loadDevices()
  } catch (err) {
    booting = false
    setBanner(err.message || 'Signal K plugin API not found. Is the AlecoAir plugin enabled?', 'error')
    ui.conn.textContent = 'error'
    ui.conn.className = 'pill alert'
    return
  }
  show('emptyCard', devices.length === 0)
  show('deviceView', devices.length > 0)
  if (!devices.length) {
    booting = false
    setBanner('')
    renderSwitcher()
    return
  }
  const wanted = new URL(window.location.href).searchParams.get('device')
  let saved = null
  try { saved = localStorage.getItem(`${PLUGIN_ID}.device`) } catch { /* ignore */ }
  const pick = [wanted, currentKey, saved].find((k) => k && devices.some((d) => d.key === k)) || devices[0].key
  booting = false
  selectDevice(pick)
  live()
}

bind()
boot()
