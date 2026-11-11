'use strict'

/*
 * AlecoAir usage WebApp: operate the configured dehumidifiers.
 * Setup (account, discovery, adopting devices, DP inspector) lives only in
 * Signal K Admin → Plugin Config → AlecoAir.
 *
 * Every configured unit gets its own card (from #deviceTemplate). With one
 * unit the page looks like a single-device app; with several they are stacked
 * one under another on the same page, each fully operable, with a sticky jump
 * bar for a quick status of all units.
 */

const PLUGIN_ID = 'signalk-alecoair'
const API = `/plugins/${PLUGIN_ID}`
const $ = (id) => document.getElementById(id)

const page = {
  app: document.querySelector('.app'),
  title: $('title'),
  subtitle: $('subtitle'),
  pills: document.querySelector('.top .pills'),
  conn: $('connPill'),
  modePill: $('modePill'),
  profilePill: $('profilePill'),
  banner: $('banner'),
  jump: $('jump'),
  list: $('deviceList'),
  template: $('deviceTemplate')
}

let devices = []
const views = new Map()

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

/** One unit's card: its own state, pending command queue and optimistic hold. */
class DeviceView {
  constructor(summary) {
    this.key = summary.key
    this.summary = summary
    this.state = null
    this.busy = false
    this.pendingCommand = null
    this.hold = null
    this.modeSig = ''
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
    const st = () => this.state || {}
    e.power.addEventListener('click', () => this.command({ power: !st().power }))
    e.fanSeg.querySelectorAll('[data-fan]').forEach((btn) => {
      btn.addEventListener('click', () => this.command({ fan: btn.dataset.fan }))
    })
    e.target.addEventListener('pointerdown', () => this.beginHold({ targetHumidity: Number(e.target.value) }))
    e.target.addEventListener('input', () => {
      const targetHumidity = Number(e.target.value)
      e.targetLabel.textContent = `${targetHumidity}%`
      this.beginHold({ targetHumidity })
    })
    e.target.addEventListener('change', () => this.command({ targetHumidity: Number(e.target.value) }))
    e.timerMinus.addEventListener('click', () => this.command({ timerHours: Math.max(0, (st().timerHours || 0) - 1) }))
    e.timerPlus.addEventListener('click', () => this.command({ timerHours: Math.min(st().timerMaxHours || 24, (st().timerHours || 0) + 1) }))
    e.lock.addEventListener('click', () => this.command({ childLock: !st().childLock }))
    e.sleep.addEventListener('click', () => this.command({ sleep: !st().sleep }))
    e.dry.addEventListener('click', () => this.command({ insideDry: !st().insideDry }))
  }

  renderModes(next) {
    const seg = this.el.modeSeg
    const modes = next.modes || []
    const sig = modes.map((m) => m.value).join('|')
    if (sig !== this.modeSig) {
      this.modeSig = sig
      seg.innerHTML = modes.map((m) => `<button type="button" data-mode="${attr(m.value)}">${attr(m.label)}</button>`).join('')
      seg.querySelectorAll('[data-mode]').forEach((btn) => {
        btn.addEventListener('click', () => this.command({ mode: btn.dataset.mode }))
      })
    }
    seg.querySelectorAll('[data-mode]').forEach((btn) => {
      btn.classList.toggle('active', btn.dataset.mode === next.mode)
    })
  }

  render(raw) {
    const e = this.el
    const next = this.applyHold(raw)
    this.state = next
    const c = next.controls || {}
    const s = next.sensors || {}
    const connected = Boolean(next.connected)

    e.name.textContent = next.name || this.summary.name || this.key
    const plate = []
    if (next.model) plate.push(next.model)
    if (next.capacityLitersPerDay) plate.push(`${next.capacityLitersPerDay} L/day`)
    if (next.ratedWatts) plate.push(`${next.ratedWatts} W`)
    plate.push(next.simulate ? 'simulated, no hardware' : 'local Tuya LAN')
    e.plate.textContent = plate.join(' · ')

    e.conn.textContent = next.simulate ? 'simulator' : (connected ? 'connected' : 'disconnected')
    e.conn.className = `pill ${connected ? 'ok' : 'alert'}`
    e.modePill.textContent = c.mode ? modeLabel(next) : '—'
    e.profilePill.textContent = next.profile ? `${next.profile.name}${next.profile.verified ? '' : ' (unverified)'}` : '—'
    e.profilePill.className = `pill ${next.profile && next.profile.verified ? '' : 'warn'}`

    const rh = Number(next.humidity)
    const hasRh = s.humidity && next.humidity !== null && Number.isFinite(rh)
    e.rh.textContent = hasRh ? `${Math.round(rh)}%` : '—'
    const circ = 2 * Math.PI * 78
    const span = 240 / 360
    const pct = hasRh ? Math.min(1, Math.max(0, (rh - 20) / 75)) : 0
    e.arc.setAttribute('stroke-dasharray', String(circ * span))
    e.arc.setAttribute('stroke-dashoffset', String(circ * span * (1 - pct)))
    e.arc.setAttribute('stroke', next.tankFull ? '#ff6b6b' : rh >= (next.targetHumidity || 50) + 1 ? '#3ee0c3' : '#7fd4ff')

    show(e.wattsStat, s.powerWatts)
    e.watts.textContent = `${Math.round(next.powerWatts || 0)} W`
    show(e.tankStat, s.tankFull)
    e.tank.textContent = next.tankFull ? 'FULL' : 'OK'
    e.tankLabel.textContent = next.tankLitersMax ? `${next.tankLitersMax} L tank` : 'tank'
    show(e.compStat, s.compressor)
    e.comp.textContent = next.compressor ? 'ON' : 'OFF'

    show(e.powerRow, c.power)
    e.power.classList.toggle('on', Boolean(next.power))
    e.power.textContent = next.power ? 'ON' : 'OFF'
    e.powerLabel.textContent = next.power
      ? (next.compressor ? 'Compressor running' : 'On, waiting for the hygrostat')
      : 'Off'

    show(e.modeBlock, c.mode)
    if (c.mode) this.renderModes(next)

    show(e.targetBlock, c.targetHumidity)
    const range = next.humidityRange || { min: 30, max: 80, step: 5 }
    e.target.min = String(range.min)
    e.target.max = String(range.max)
    e.target.step = String(range.step)
    const scrubbing = document.activeElement === e.target
    const holdingTarget = this.hold && this.hold.fields && this.hold.fields.targetHumidity !== undefined
    if (next.mode === 'continuous' && next.continuousTarget !== null && !holdingTarget) {
      if (!scrubbing) e.target.value = String(range.min)
      e.targetLabel.textContent = 'CO'
    } else if (!scrubbing) {
      e.target.value = String(next.targetHumidity || 50)
      e.targetLabel.textContent = `${next.targetHumidity || 50}%`
    } else {
      e.targetLabel.textContent = `${e.target.value}%`
    }

    show(e.fanRow, c.fan)
    e.fanSeg.querySelectorAll('[data-fan]').forEach((btn) => {
      btn.classList.toggle('active', btn.dataset.fan === next.fan)
    })

    show(e.timerRow, c.timer)
    e.timerTitle.textContent = `Timer 0–${next.timerMaxHours || 24} h`
    e.timer.textContent = `${next.timerHours || 0} h`
    const left = Math.round(Number(next.timerRemainingMin) || 0)
    if (left > 0) e.timer.textContent = `${next.timerHours || 0} h · ${left} min`

    const sleepIsMode = (next.modes || []).some((m) => m.value === 'sleep')
    show(e.lock, c.childLock)
    show(e.sleep, c.sleep && !sleepIsMode)
    show(e.dry, c.insideDry)
    show(e.toggleRow, c.childLock || (c.sleep && !sleepIsMode) || c.insideDry)
    e.lock.textContent = next.childLock ? 'Child lock ON' : 'Child lock'
    e.sleep.textContent = next.sleep ? 'Sleep ON' : 'Sleep'
    e.dry.textContent = next.insideDry ? 'Inside dry ON' : 'Inside dry'

    e.tankAlertText.textContent = `${next.tankLitersMax ? `The ${next.tankLitersMax} L tank` : 'The tank'} is full. The unit has stopped.`
    e.tankAlert.classList.toggle('show', Boolean(next.tankFull))
    e.defrostAlert.classList.toggle('show', Boolean(next.defrost))

    if (next.lastError && !connected) setBanner(e.banner, next.lastError, 'error')
    else if (!connected) setBanner(e.banner, 'The unit is not answering on the LAN yet.', 'error')
    else if (next.profile && next.profile.id === 'generic') setBanner(e.banner, 'This unit has no model profile yet, so it is read-only. Pick a profile in Signal K Admin → Plugin Config → AlecoAir.', '')
    else setBanner(e.banner, '')

    this.summary = { ...this.summary, name: next.name || this.summary.name, connected, humidity: hasRh ? Math.round(rh) : null, power: Boolean(next.power), simulate: Boolean(next.simulate) }
    renderChrome()
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

/** Page header and jump bar: the unit itself with one device, an overview with several. */
function renderChrome() {
  const list = devices.map((d) => (views.get(d.key) || {}).summary || d)
  const multi = list.length > 1
  page.app.classList.toggle('multi', multi)
  page.app.classList.toggle('single', !multi)
  show(page.jump, multi)
  show(page.pills, !multi)

  if (!list.length) {
    page.title.textContent = 'AlecoAir'
    page.subtitle.textContent = 'Local Tuya LAN · native Signal K'
    return
  }
  if (!multi) {
    const v = views.get(list[0].key)
    const e = v && v.el
    if (!e) return
    page.title.textContent = e.name.textContent
    page.subtitle.textContent = e.plate.textContent
    page.conn.textContent = e.conn.textContent
    page.conn.className = e.conn.className
    page.modePill.textContent = e.modePill.textContent
    page.profilePill.textContent = e.profilePill.textContent
    page.profilePill.className = e.profilePill.className
    return
  }
  const on = list.filter((d) => d.power).length
  const offline = list.filter((d) => !d.connected).length
  page.title.textContent = 'AlecoAir'
  page.subtitle.textContent = `${list.length} dehumidifiers · ${on} on${offline ? ` · ${offline} offline` : ''} · local Tuya LAN`
  const html = list.map((d) => {
    const rh = d.humidity === null || d.humidity === undefined ? '' : `${d.humidity}% RH`
    const status = d.connected ? [rh || 'connected', d.power ? 'ON' : 'off'].filter(Boolean).join(' · ') : 'offline'
    return `<a href="#${attr(sectionId(d.key))}" class="${d.connected ? '' : 'off'}"><b>${attr(d.name || d.key)}</b><small>${attr(status)}</small></a>`
  }).join('')
  if (html !== page.jump.dataset.sig) {
    page.jump.dataset.sig = html
    page.jump.innerHTML = html
  }
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
    for (const d of next) {
      const v = views.get(d.key)
      if (v && !v.state) v.summary = { ...v.summary, ...d }
    }
    renderChrome()
    return false
  }
  views.clear()
  page.list.replaceChildren()
  for (const d of next) {
    const v = new DeviceView(d)
    views.set(d.key, v)
    page.list.appendChild(v.root)
  }
  renderChrome()
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
let listTimer = null

function live() {
  if (liveTimer) return
  liveTimer = setInterval(() => {
    if (!document.hidden) refreshAll()
  }, 2000)
  listTimer = setInterval(() => {
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
    page.conn.textContent = 'error'
    page.conn.className = 'pill alert'
    return
  }
  show($('emptyCard'), list.length === 0)
  setBanner(page.banner, '')
  syncViews(list)
  await refreshAll()
  // ?device=<key> (old switcher links) or #device-<key> scrolls to that unit.
  const wanted = new URL(window.location.href).searchParams.get('device')
  if (wanted && views.has(wanted) && list.length > 1 && !window.location.hash) {
    views.get(wanted).root.scrollIntoView({ block: 'start' })
  }
  live()
}

boot()
