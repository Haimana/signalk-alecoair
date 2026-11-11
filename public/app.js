'use strict'

/*
 * AlecoAir usage WebApp: operate the configured dehumidifiers.
 * Setup (account, discovery, adopting devices, DP inspector) lives only in
 * Signal K Admin → Plugin Config → AlecoAir.
 *
 * Every configured unit gets one compact card (from #deviceTemplate), laid
 * out like the AlecoAir app panel: mode pill, ring with the target humidity
 * and −/+, indoor humidity, and a bottom bar (Power, Mode, Fan, Settings).
 * Mode, Fan and Settings open a bottom sheet. Only the controls the unit
 * reports are shown, and the modes are the plugin's real modes for that
 * profile. Several units stack one under another (two columns on wide
 * screens), each fully operable.
 */

const PLUGIN_ID = 'signalk-alecoair'
const API = `/plugins/${PLUGIN_ID}`
const $ = (id) => document.getElementById(id)
const RING_LEN = 2 * Math.PI * 86
const RING_ARC = RING_LEN * 0.75
const SCALE = { min: 20, max: 90 }
const TARGET_DEBOUNCE_MS = 700

const page = {
  app: document.querySelector('.app'),
  title: $('title'),
  subtitle: $('subtitle'),
  banner: $('banner'),
  list: $('deviceList'),
  template: $('deviceTemplate'),
  sheet: $('sheetBackdrop'),
  sheetTitle: $('sheetTitle'),
  sheetSub: $('sheetSub'),
  sheetBody: $('sheetBody'),
  sheetCancel: $('sheetCancel')
}

let devices = []
const views = new Map()
let openSheet = null // { view, kind }

function show(el, visible) {
  if (el) el.hidden = !visible
}

function setBanner(el, text, kind) {
  el.textContent = text || ''
  el.classList.toggle('show', Boolean(text))
  el.classList.toggle('error', kind === 'error')
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

function sectionId(key) {
  return `device-${key}`
}

function clamp(v, lo, hi) {
  return Math.min(hi, Math.max(lo, v))
}

function ringPoint(pct) {
  const a = (135 + 270 * pct) * Math.PI / 180
  return { x: 100 + 86 * Math.cos(a), y: 100 + 86 * Math.sin(a) }
}

/** One unit's card: its own state, pending command queue and optimistic hold. */
class DeviceView {
  constructor(summary) {
    this.key = summary.key
    this.summary = summary
    this.state = null
    this.busy = false
    this.pendingCommand = null
    this.hold = null
    this.targetTimer = null
    this.root = page.template.content.firstElementChild.cloneNode(true)
    this.root.id = sectionId(this.key)
    this.root.dataset.key = this.key
    this.el = {}
    this.root.querySelectorAll('[data-r]').forEach((node) => { this.el[node.dataset.r] = node })
    this.el.name.textContent = summary.name || summary.key
    this.bind()
  }

  beginHold(body) {
    this.hold = { until: Date.now() + 8000, fields: { ...(this.hold && this.hold.fields), ...body } }
  }

  applyHold(next) {
    const hold = this.hold
    if (!hold || Date.now() > hold.until) {
      this.hold = null
      return next
    }
    const out = { ...next }
    for (const [key, want] of Object.entries(hold.fields)) {
      const have = key === 'targetHumidity' || key === 'timerHours' ? Number(out[key]) === Number(want) : out[key] === want
      if (have) delete hold.fields[key]
      else out[key] = want
    }
    if (hold.fields.targetHumidity !== undefined && out.mode === 'continuous') out.mode = ((out.modes || [])[0] || {}).value || 'auto'
    if (!Object.keys(hold.fields).length) this.hold = null
    return out
  }

  bind() {
    const e = this.el
    e.powerBtn.addEventListener('click', () => this.command({ power: !(this.state && this.state.power) }))
    e.modeBtn.addEventListener('click', () => openSheetFor(this, 'mode'))
    e.modePill.addEventListener('click', () => openSheetFor(this, 'mode'))
    e.fanBtn.addEventListener('click', () => openSheetFor(this, 'fan'))
    e.settingsBtn.addEventListener('click', () => openSheetFor(this, 'settings'))
    e.minus.addEventListener('click', () => this.stepTarget(-1))
    e.plus.addEventListener('click', () => this.stepTarget(1))
  }

  range() {
    return (this.state && this.state.humidityRange) || { min: 30, max: 80, step: 5 }
  }

  /** −/+ move the target right away on screen and send one command once the taps stop. */
  stepTarget(dir) {
    if (!this.state) return
    const r = this.range()
    const continuous = this.state.mode === 'continuous' && !(this.hold && this.hold.fields.targetHumidity !== undefined)
    const base = continuous ? (dir > 0 ? r.min - r.step : r.max + r.step) : Number(this.state.targetHumidity || 50)
    const targetHumidity = clamp(base + dir * r.step, r.min, r.max)
    this.beginHold({ targetHumidity })
    this.render({ ...this.state })
    clearTimeout(this.targetTimer)
    this.targetTimer = setTimeout(() => this.command({ targetHumidity }), TARGET_DEBOUNCE_MS)
  }

  render(raw) {
    const e = this.el
    const next = this.applyHold(raw)
    this.state = next
    const c = next.controls || {}
    const s = next.sensors || {}
    const connected = Boolean(next.connected)
    const on = Boolean(next.power)

    e.name.textContent = next.name || this.summary.name || this.key
    const plate = []
    if (next.model) plate.push(next.model)
    if (next.capacityLitersPerDay) plate.push(`${next.capacityLitersPerDay} L/day`)
    plate.push(next.simulate ? 'simulator' : 'local Tuya LAN')
    e.plate.textContent = plate.join(' · ')

    e.conn.textContent = next.simulate ? 'simulated' : (connected ? 'connected' : 'offline')
    e.conn.className = `status ${!connected ? 'alert' : next.simulate ? 'sim' : 'ok'}`
    this.root.classList.toggle('off', !on || !connected)

    show(e.modePill, c.mode)
    e.modePill.textContent = c.mode ? modeLabel(next) : '—'
    e.modePill.disabled = !connected

    // Ring: arc = indoor humidity, knob and big gold number = target.
    const r = this.range()
    const rh = Number(next.humidity)
    const hasRh = s.humidity && next.humidity !== null && Number.isFinite(rh)
    const continuous = next.mode === 'continuous'
    const target = Number(next.targetHumidity || 50)
    const rhPct = hasRh ? clamp((rh - SCALE.min) / (SCALE.max - SCALE.min), 0, 1) : 0
    e.arc.setAttribute('stroke-dasharray', `${RING_ARC * rhPct} ${RING_LEN}`)
    e.arc.style.stroke = next.tankFull ? 'var(--alert)' : (hasRh && rh > target && !continuous ? 'var(--teal)' : 'var(--blue)')
    const showTarget = c.targetHumidity && !continuous
    const kp = ringPoint(clamp((target - SCALE.min) / (SCALE.max - SCALE.min), 0, 1))
    e.knob.setAttribute('cx', kp.x.toFixed(1))
    e.knob.setAttribute('cy', kp.y.toFixed(1))
    // SVG elements have no .hidden property, so toggle visibility directly.
    e.knob.setAttribute('visibility', showTarget ? 'visible' : 'hidden')
    e.arc.setAttribute('visibility', rhPct > 0 ? 'visible' : 'hidden')
    if (showTarget) e.target.innerHTML = `${Math.round(target)}<sup>%</sup>`
    else if (c.targetHumidity && continuous) e.target.textContent = 'CO'
    else e.target.innerHTML = hasRh ? `${Math.round(rh)}<sup>%</sup>` : '—'
    e.indoor.textContent = showTarget || continuous
      ? `Indoor humidity ${hasRh ? `${Math.round(rh)}%` : '—'}`
      : 'indoor humidity'
    show(e.minus, c.targetHumidity)
    show(e.plus, c.targetHumidity)
    e.minus.disabled = !connected || (showTarget && target <= r.min)
    e.plus.disabled = !connected || (showTarget && target >= r.max)

    const facts = []
    if (on && s.compressor) facts.push(next.compressor ? 'Compressor running' : 'Waiting for the hygrostat')
    if (!on) facts.push('Off')
    if (s.powerWatts && next.powerWatts !== null && next.powerWatts !== undefined) facts.push(`≈${Math.round(next.powerWatts)} W`)
    if (c.timer && next.timerHours > 0) {
      const left = Math.round(Number(next.timerRemainingMin) || 0)
      facts.push(`Timer ${next.timerHours} h${left > 0 ? ` (${left} min left)` : ''}`)
    }
    if (next.childLock) facts.push('Child lock')
    e.facts.textContent = facts.join(' · ')

    e.tankAlert.textContent = `${next.tankLitersMax ? `The ${next.tankLitersMax} L tank` : 'The tank'} is full. The unit has stopped.`
    e.tankAlert.classList.toggle('show', Boolean(next.tankFull))
    e.defrostAlert.classList.toggle('show', Boolean(next.defrost))

    // Bottom bar: only what this unit has.
    show(e.powerBtn, c.power)
    e.powerBtn.classList.toggle('on', on)
    e.powerText.textContent = on ? 'On' : 'Off'
    show(e.modeBtn, c.mode)
    show(e.fanBtn, c.fan)
    show(e.settingsBtn, settingsItems(this).length > 0)
    for (const b of [e.powerBtn, e.modeBtn, e.fanBtn, e.settingsBtn]) b.disabled = !connected

    if (next.lastError && !connected) setBanner(e.banner, next.lastError, 'error')
    else if (!connected) setBanner(e.banner, 'The unit is not answering on the LAN yet.', 'error')
    else if (next.profile && next.profile.id === 'generic') setBanner(e.banner, 'No model profile yet, so this unit is read-only. Pick one in Signal K Admin → Plugin Config → AlecoAir.', '')
    else setBanner(e.banner, '')

    this.summary = { ...this.summary, name: next.name || this.summary.name, connected, power: on }
    if (openSheet && openSheet.view === this) renderSheet()
    renderHeader()
  }

  async command(body) {
    this.beginHold(body)
    if (this.state) this.render({ ...this.state })
    if (this.busy) {
      this.pendingCommand = { ...(this.pendingCommand || {}), ...body }
      return
    }
    this.busy = true
    try {
      let payload = body
      while (payload) {
        this.pendingCommand = null
        const res = await apiFetch(`/devices/${encodeURIComponent(this.key)}/command`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload)
        })
        const data = await readJson(res)
        if (!res.ok) throw new Error(authError(res, data))
        this.render(data)
        payload = this.pendingCommand
      }
    } catch (err) {
      this.hold = null
      setBanner(this.el.banner, err.message, 'error')
    } finally {
      this.busy = false
    }
  }

  async refresh() {
    const res = await apiFetch(`/devices/${encodeURIComponent(this.key)}/state`)
    if (res.ok) this.render(await res.json())
    else if (res.status === 404) return 'gone'
    return 'ok'
  }
}

/** Secondary controls that go in the Settings sheet, only those the unit has. */
function settingsItems(view) {
  const st = view.state || {}
  const c = st.controls || {}
  const sleepIsMode = (st.modes || []).some((m) => m.value === 'sleep')
  const items = []
  if (c.timer) items.push('timer')
  if (c.childLock) items.push('childLock')
  if (c.sleep && !sleepIsMode) items.push('sleep')
  if (c.insideDry) items.push('insideDry')
  return items
}

function openSheetFor(view, kind) {
  if (!view.state) return
  openSheet = { view, kind }
  renderSheet()
  show(page.sheet, true)
  const first = page.sheetBody.querySelector('button')
  if (first) first.focus({ preventScroll: true })
}

function closeSheet() {
  openSheet = null
  show(page.sheet, false)
}

function rowButton(label, selected, onClick, sub) {
  const b = document.createElement('button')
  b.type = 'button'
  b.className = `sheet-row${selected ? ' selected' : ''}`
  b.innerHTML = `<span>${attr(label)}${sub ? `<small>${attr(sub)}</small>` : ''}</span><span class="check">✓</span>`
  b.addEventListener('click', onClick)
  return b
}

function toggleRow(label, on, onClick, sub) {
  const row = document.createElement('div')
  row.className = 'sheet-row'
  row.innerHTML = `<span>${attr(label)}${sub ? `<small>${attr(sub)}</small>` : ''}</span>`
  const sw = document.createElement('button')
  sw.type = 'button'
  sw.className = `switch${on ? ' on' : ''}`
  sw.setAttribute('role', 'switch')
  sw.setAttribute('aria-checked', String(Boolean(on)))
  sw.setAttribute('aria-label', label)
  sw.addEventListener('click', onClick)
  row.appendChild(sw)
  return row
}

function renderSheet() {
  if (!openSheet) return
  const { view, kind } = openSheet
  const st = view.state || {}
  const body = page.sheetBody
  page.sheetSub.textContent = st.name || view.key
  page.sheetCancel.textContent = kind === 'settings' ? 'Close' : 'Cancel'
  body.replaceChildren()
  if (kind === 'mode') {
    page.sheetTitle.textContent = 'Working mode'
    for (const m of st.modes || []) {
      body.appendChild(rowButton(m.label, m.value === st.mode, () => { view.command({ mode: m.value }); closeSheet() }))
    }
  } else if (kind === 'fan') {
    page.sheetTitle.textContent = 'Fan speed'
    for (const f of [{ value: 'low', label: 'Low' }, { value: 'high', label: 'High' }]) {
      body.appendChild(rowButton(f.label, f.value === st.fan, () => { view.command({ fan: f.value }); closeSheet() }))
    }
  } else {
    page.sheetTitle.textContent = 'Settings'
    for (const item of settingsItems(view)) {
      if (item === 'timer') {
        const row = document.createElement('div')
        row.className = 'sheet-row'
        const h = Number(st.timerHours) || 0
        const left = Math.round(Number(st.timerRemainingMin) || 0)
        row.innerHTML = `<span>Timer off<small>${h > 0 ? `Turns the unit off after ${h} h${left > 0 ? `, ${left} min left` : ''}` : 'No timer set'}</small></span>`
        const stepper = document.createElement('div')
        stepper.className = 'stepper'
        const max = st.timerMaxHours || 24
        const minus = document.createElement('button')
        minus.type = 'button'; minus.textContent = '−'; minus.setAttribute('aria-label', 'Shorter timer')
        minus.disabled = h <= 0
        minus.addEventListener('click', () => view.command({ timerHours: Math.max(0, h - 1) }))
        const value = document.createElement('b')
        value.textContent = h > 0 ? `${h} h` : 'Off'
        const plus = document.createElement('button')
        plus.type = 'button'; plus.textContent = '+'; plus.setAttribute('aria-label', 'Longer timer')
        plus.disabled = h >= max
        plus.addEventListener('click', () => view.command({ timerHours: Math.min(max, h + 1) }))
        stepper.append(minus, value, plus)
        row.appendChild(stepper)
        body.appendChild(row)
      } else if (item === 'childLock') {
        body.appendChild(toggleRow('Child lock', st.childLock, () => view.command({ childLock: !st.childLock }), 'Locks the buttons on the unit'))
      } else if (item === 'sleep') {
        body.appendChild(toggleRow('Sleep', st.sleep, () => view.command({ sleep: !st.sleep })))
      } else if (item === 'insideDry') {
        body.appendChild(toggleRow('Inside dry', st.insideDry, () => view.command({ insideDry: !st.insideDry }), 'Dries the unit inside after use'))
      }
    }
    const note = document.createElement('p')
    note.className = 'sheet-note'
    note.textContent = `${st.profile ? `${st.profile.name}${st.profile.verified ? '' : ' (unverified map)'}. ` : ''}Setup is in Signal K Admin → Plugin Config → AlecoAir.`
    body.appendChild(note)
  }
}

page.sheetCancel.addEventListener('click', closeSheet)
page.sheet.addEventListener('click', (ev) => { if (ev.target === page.sheet) closeSheet() })
document.addEventListener('keydown', (ev) => { if (ev.key === 'Escape' && openSheet) closeSheet() })

function renderHeader() {
  const list = devices.map((d) => (views.get(d.key) || {}).summary || d)
  const multi = list.length > 1
  page.app.classList.toggle('multi', multi)
  page.app.classList.toggle('single', !multi)
  page.title.textContent = 'AlecoAir'
  if (!list.length) {
    page.subtitle.textContent = 'Local Tuya LAN · native Signal K'
    return
  }
  const on = list.filter((d) => d.power).length
  const offline = list.filter((d) => !d.connected).length
  page.subtitle.textContent = multi
    ? `${list.length} dehumidifiers · ${on} on${offline ? ` · ${offline} offline` : ''}`
    : `1 dehumidifier · ${on ? 'on' : 'off'}${offline ? ' · offline' : ''}`
}

async function loadDevices() {
  const res = await apiFetch('/devices')
  const data = await readJson(res)
  if (!res.ok) throw new Error(authError(res, data))
  return data.devices || []
}

/** Build (or rebuild) the stack when the set of configured units changes. */
function syncViews(next) {
  const sig = next.map((d) => d.key).join('|')
  const same = sig === devices.map((d) => d.key).join('|') && views.size === next.length
  devices = next
  if (same) {
    renderHeader()
    return false
  }
  if (openSheet) closeSheet()
  views.clear()
  page.list.replaceChildren()
  for (const d of next) {
    const v = new DeviceView(d)
    views.set(d.key, v)
    page.list.appendChild(v.root)
  }
  renderHeader()
  return true
}

let refreshing = false

async function refreshAll() {
  if (refreshing) return
  refreshing = true
  try {
    const results = await Promise.all([...views.values()].map((v) => v.refresh().catch(() => 'error')))
    if (results.includes('gone')) await boot()
    const lost = results.length && results.every((r) => r === 'error')
    setBanner(page.banner, lost ? 'Lost the connection to the plugin.' : '', 'error')
  } finally {
    refreshing = false
  }
}

let liveTimer = null

function live() {
  if (liveTimer) return
  liveTimer = setInterval(() => { if (!document.hidden) refreshAll() }, 2000)
  setInterval(() => {
    if (document.hidden) return
    loadDevices().then((list) => { if (syncViews(list)) refreshAll() }).catch(() => {})
  }, 10000)
}

async function boot() {
  let list
  try {
    list = await loadDevices()
  } catch (err) {
    setBanner(page.banner, err.message || 'Signal K plugin API not found. Is the AlecoAir plugin enabled?', 'error')
    return
  }
  show($('emptyCard'), list.length === 0)
  setBanner(page.banner, '')
  syncViews(list)
  await refreshAll()
  // ?device=<key> (old links) scrolls to that unit.
  const wanted = new URL(window.location.href).searchParams.get('device')
  if (wanted && views.has(wanted) && list.length > 1 && !window.location.hash) {
    views.get(wanted).root.scrollIntoView({ block: 'start' })
  }
  live()
}

boot()
