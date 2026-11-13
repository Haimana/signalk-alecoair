'use strict'

/*
 * AlecoAir usage WebApp: operate the configured dehumidifiers.
 * Setup (account, discovery, adopting devices, DP inspector) lives only in
 * Signal K Admin → Plugin Config → AlecoAir.
 *
 * Dead-front glass panel per unit, stacked: name, LAN dot and power on top;
 * on the left a 270° gauge (thin dim arc; a thicker bright arc = current
 * humidity; knob = target), − and + next to the mode buttons and the values in its centre (big target or CO, current
 * humidity small with a droplet or the external antenna); on the right the
 * working-mode icon buttons, the fan speed under them, then a centred line of
 * status text labels in the same column (compressor, defrost, tank full in
 * red, child lock, timer, sleep, inside dry) and the message slot.
 * Lit = active, dim = inactive. Everything comes from the live state and the
 * profile: the modes (plus "External" when external control is allowed for
 * the unit), which controls exist, the humidity range and step.
 *
 * Each card is built once; the 2-second refresh only changes classes and
 * text, so it never flickers or moves the focus. A tap shows at once (an
 * optimistic hold), −/+ and the slider send one command once the taps stop.
 */

const PLUGIN_ID = 'signalk-alecoair'
const API = `/plugins/${PLUGIN_ID}`
const $ = (id) => document.getElementById(id)
const TARGET_DEBOUNCE_MS = 700
const TIMER_DEBOUNCE_MS = 700
const ERROR_SHOW_MS = 8000
// Arc geometry (viewBox 200×200): 270° clockwise from bottom-left, gap at the bottom.
const ARC = { cx: 100, cy: 100, r: 86, start: 135, sweep: 270 }
const EXT_STATE = {
  starting: 'Starting',
  running: 'Running',
  idle: 'Idle, below target',
  waiting: 'Waiting (minimum time)',
  defrost: 'Defrost',
  'sensor-missing': 'Sensor missing',
  'too-cold': 'Too cold',
  'tank-full': 'Tank full',
  offline: 'Unit offline',
  unsupported: 'Not supported on this unit',
  error: 'Command failed, retrying',
  internal: 'Off'
}
// External-control states worth one line on the card (the rest are in the label tooltip).
const EXT_WARN = new Set(['sensor-missing', 'too-cold', 'error', 'unsupported'])

const page = {
  banner: $('banner'),
  list: $('deviceList'),
  template: $('deviceTemplate')
}

let devices = []
const views = new Map()

function show(el, visible) {
  if (el) el.hidden = !visible
}

/**
 * Message slot: always in the layout (or an overlay), so showing a message
 * never moves anything. It fades; the last text stays during the fade-out.
 * Long text is cut with an ellipsis; the full text is in the tooltip.
 */
function setMsg(el, text, kind) {
  const t = text || ''
  if (t) {
    if (el.textContent !== t) el.textContent = t
    el.title = t
    el.classList.toggle('alert', kind === 'alert')
    el.removeAttribute('aria-hidden')
  } else {
    el.removeAttribute('title')
    el.setAttribute('aria-hidden', 'true')
  }
  el.classList.toggle('show', Boolean(t))
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

function clamp(v, lo, hi) {
  return Math.min(hi, Math.max(lo, v))
}

function num(v) {
  return v === null || v === undefined || v === '' ? NaN : Number(v)
}

/** Icon for a plugin mode value; unknown values get a neutral dial. */
function modeIcon(m) {
  if (m.value === 'auto') return /normal/i.test(m.label || '') ? 'i-droplet' : 'i-auto'
  return {
    continuous: 'i-co', sleep: 'i-sleep', laundry: 'i-laundry', purify: 'i-purify',
    eco: 'i-eco', external: 'i-external', normal: 'i-droplet'
  }[m.value] || 'i-mode'
}

/** Short label under a mode icon: "Auto / hygrostat" → Auto, "Continuous (CO)" → CO. */
function modeShort(m) {
  if (m.value === 'external') return 'External'
  const label = String(m.label || m.value || '')
  const paren = label.match(/\(([^)]{1,4})\)/)
  if (paren) return paren[1]
  return label.split(/\s*[/(·]\s*/)[0] || label
}

function arcPoint(frac) {
  const a = (ARC.start + ARC.sweep * frac) * Math.PI / 180
  return { x: ARC.cx + ARC.r * Math.cos(a), y: ARC.cy + ARC.r * Math.sin(a) }
}

function sectionId(key) {
  return `device-${key}`
}

/** One unit's panel: its own state, pending command queue and optimistic hold. */
class DeviceView {
  constructor(summary) {
    this.key = summary.key
    this.summary = summary
    this.state = null
    this.busy = false
    this.pendingCommand = null
    this.hold = null
    this.targetTimer = null
    this.timerTimer = null
    this.extHold = null
    this.extBusy = false
    this.modesSig = ''
    this.rangeSig = ''
    this.error = null
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
    e.power.addEventListener('click', () => this.command({ power: !(this.state && this.state.power) }))
    e.minus.addEventListener('click', () => this.stepTarget(-1))
    e.plus.addEventListener('click', () => this.stepTarget(1))
    e.lock.addEventListener('click', () => this.toggle('childLock'))
    e.sleepToggle.addEventListener('click', () => this.toggle('sleep'))
    e.dryToggle.addEventListener('click', () => this.toggle('insideDry'))
    e.fan.querySelectorAll('[data-fan]').forEach((b) => b.addEventListener('click', () => this.command({ fan: b.dataset.fan })))

    // Mode row: one tap sends the mode; arrow keys move between the icons (one tab stop).
    e.modes.addEventListener('click', (ev) => {
      const b = ev.target.closest('[data-mode]')
      if (b && !b.disabled) this.pickMode(b.dataset.mode)
    })
    e.modes.addEventListener('keydown', (ev) => {
      const keys = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }
      if (!(ev.key in keys)) return
      const btns = [...e.modes.querySelectorAll('[data-mode]')]
      const i = btns.indexOf(document.activeElement)
      if (i < 0) return
      ev.preventDefault()
      const nextBtn = btns[(i + keys[ev.key] + btns.length) % btns.length]
      btns.forEach((b) => { b.tabIndex = b === nextBtn ? 0 : -1 })
      nextBtn.focus()
    })

    // Arc: tap or drag on the arc (not the centre); the value snaps to the profile step.
    const track = e.track
    let dragging = false
    const fromPoint = (x, y, strict) => {
      const svg = track.querySelector('svg').getBoundingClientRect()
      const scale = 200 / Math.max(1, svg.width)
      const dx = (x - svg.left) * scale - ARC.cx
      const dy = (y - svg.top) * scale - ARC.cy
      if (strict && Math.hypot(dx, dy) < ARC.r * 0.62) return null
      let deg = Math.atan2(dy, dx) * 180 / Math.PI - ARC.start
      deg = ((deg % 360) + 360) % 360
      if (deg > ARC.sweep) deg = deg > ARC.sweep + (360 - ARC.sweep) / 2 ? 0 : ARC.sweep
      const r = this.range()
      return r.min + (deg / ARC.sweep) * (r.max - r.min)
    }
    track.addEventListener('pointerdown', (ev) => {
      if (track.getAttribute('aria-disabled') === 'true') return
      const v = fromPoint(ev.clientX, ev.clientY, true)
      if (v === null) return
      ev.preventDefault()
      dragging = true
      try { track.setPointerCapture(ev.pointerId) } catch {}
      track.focus({ preventScroll: true })
      this.setTarget(v)
    })
    track.addEventListener('pointermove', (ev) => { if (dragging) this.setTarget(fromPoint(ev.clientX, ev.clientY, false)) })
    const stop = () => { dragging = false }
    track.addEventListener('pointerup', stop)
    track.addEventListener('pointercancel', stop)
    track.addEventListener('keydown', (ev) => {
      if (track.getAttribute('aria-disabled') === 'true') return
      const r = this.range()
      const dir = { ArrowRight: 1, ArrowUp: 1, PageUp: 2, ArrowLeft: -1, ArrowDown: -1, PageDown: -2 }[ev.key]
      if (dir) { ev.preventDefault(); this.stepTarget(dir > 0 ? 1 : -1, Math.abs(dir)) }
      else if (ev.key === 'Home') { ev.preventDefault(); this.setTarget(r.min) }
      else if (ev.key === 'End') { ev.preventDefault(); this.setTarget(r.max) }
    })

    // Timer: a tap opens a small − h + stepper under the icon.
    e.timer.addEventListener('click', () => this.timerOpen(e.timerPop.hidden))
    e.timerMinus.addEventListener('click', () => this.stepTimer(-1))
    e.timerPlus.addEventListener('click', () => this.stepTimer(1))
    e.timerWrap.addEventListener('keydown', (ev) => {
      if (ev.key === 'Escape' && !e.timerPop.hidden) { ev.stopPropagation(); this.timerOpen(false); e.timer.focus() }
    })
    document.addEventListener('pointerdown', (ev) => {
      if (!e.timerPop.hidden && !e.timerWrap.contains(ev.target)) this.timerOpen(false)
    })
  }

  range() {
    const r = (this.state && this.state.humidityRange) || {}
    const min = Number.isFinite(Number(r.min)) ? Number(r.min) : 30
    const max = Number.isFinite(Number(r.max)) ? Number(r.max) : 80
    const step = Number(r.step) > 0 ? Number(r.step) : 5
    return { min, max: Math.max(max, min + step), step }
  }

  snap(v) {
    const r = this.range()
    return clamp(r.min + Math.round((v - r.min) / r.step) * r.step, r.min, r.max)
  }

  /** External control state, with a pending target shown at once. */
  ext(next) {
    const ctl = { ...((next || this.state || {}).control || {}) }
    const hold = this.extHold
    if (hold && Date.now() < hold.until) {
      if (hold.target !== undefined) {
        if (Number(ctl.target) === hold.target) delete hold.target
        else ctl.target = hold.target
      }
      if (hold.target === undefined) this.extHold = null
    } else this.extHold = null
    // A pending pick in the mode row shows at once (the hold on `mode`).
    const mode = (next || this.state || {}).mode
    ctl.active = Boolean(ctl.configured && (mode === 'external' || (mode === undefined && ctl.mode === 'external')))
    return ctl
  }

  showError(message) {
    this.error = { message, until: Date.now() + ERROR_SHOW_MS }
    if (this.state) this.render({ ...this.state })
  }

  /** Controller target (POST /control; nothing is sent to the unit directly). */
  async setControl(body) {
    this.extHold = { until: Date.now() + 8000, ...(this.extHold || {}), ...body }
    if (this.state) this.render({ ...this.state })
    if (this.extBusy) return
    this.extBusy = true
    try {
      const res = await apiFetch(`/devices/${encodeURIComponent(this.key)}/control`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      })
      const data = await readJson(res)
      if (!res.ok) throw new Error(authError(res, data))
      this.render(data)
    } catch (err) {
      this.extHold = null
      this.showError(err.message)
    } finally {
      this.extBusy = false
    }
  }

  /** Current shown target (controller target in external mode), or null in CO. */
  shownTarget() {
    const ctl = this.ext()
    if (ctl.active) return Number(ctl.target || 50)
    const continuous = this.state.mode === 'continuous' && !(this.hold && this.hold.fields.targetHumidity !== undefined)
    return continuous ? null : Number(this.state.targetHumidity || 50)
  }

  /** Slider / keyboard: show the value at once, send one command once it stops moving. */
  setTarget(value) {
    if (!this.state) return
    const target = this.snap(value)
    if (this.ext().active) {
      this.extHold = { ...(this.extHold || {}), until: Date.now() + 8000, target }
      this.render({ ...this.state })
      clearTimeout(this.targetTimer)
      this.targetTimer = setTimeout(() => this.setControl({ target }), TARGET_DEBOUNCE_MS)
      return
    }
    this.beginHold({ targetHumidity: target })
    this.render({ ...this.state })
    clearTimeout(this.targetTimer)
    this.targetTimer = setTimeout(() => this.command({ targetHumidity: target }), TARGET_DEBOUNCE_MS)
  }

  /** −/+ move the target by the profile step (from CO: − starts at the top, + at the bottom). */
  stepTarget(dir, steps = 1) {
    if (!this.state) return
    const r = this.range()
    const ctl = this.ext()
    if (ctl.active) {
      this.setTarget(Number(ctl.target || 50) + dir * r.step * steps)
      return
    }
    const cur = this.shownTarget()
    const base = cur === null ? (dir > 0 ? r.min - r.step : r.max + r.step) : cur
    this.setTarget(base + dir * r.step * steps)
  }

  toggle(key) {
    if (!this.state) return
    this.command({ [key]: !this.state[key] })
  }

  timerOpen(open) {
    const e = this.el
    e.timerPop.hidden = !open
    e.timer.setAttribute('aria-expanded', String(Boolean(open)))
    if (open) e.timerPlus.focus({ preventScroll: true })
  }

  stepTimer(dir) {
    if (!this.state) return
    const max = this.state.timerMaxHours || 24
    const h = clamp((Number(this.state.timerHours) || 0) + dir, 0, max)
    this.beginHold({ timerHours: h })
    this.render({ ...this.state })
    clearTimeout(this.timerTimer)
    this.timerTimer = setTimeout(() => this.command({ timerHours: h }), TIMER_DEBOUNCE_MS)
  }

  /** Mode row: "External" = external control on; any other mode = control off + that mode. */
  pickMode(value) {
    if (this.state && value !== this.state.mode) this.command({ mode: value })
  }

  /** Mode buttons, rebuilt only when the list of modes changes (keeps the focus on refresh). */
  buildModes(modes) {
    const sig = JSON.stringify(modes.map((m) => [m.value, m.label]))
    if (sig === this.modesSig) return
    const hadFocus = this.el.modes.contains(document.activeElement) ? document.activeElement.dataset.mode : null
    this.modesSig = sig
    this.el.modes.innerHTML = modes.map((m) => `<button type="button" class="mode" role="radio" aria-checked="false" data-mode="${attr(m.value)}" aria-label="${attr(m.label)}" title="${attr(m.label)}" tabindex="-1">
        <svg aria-hidden="true"><use href="#${modeIcon(m)}"></use></svg><span class="lbl">${attr(modeShort(m))}</span></button>`).join('')
    if (hadFocus) {
      const b = this.el.modes.querySelector(`[data-mode="${CSS.escape(hadFocus)}"]`)
      if (b) b.focus({ preventScroll: true })
    }
  }

  /** Range labels and slider bounds, set only when the range changes. */
  buildRange(r) {
    const sig = `${r.min}|${r.max}|${r.step}`
    if (sig === this.rangeSig) return
    this.rangeSig = sig
    this.el.rangeMin.textContent = String(r.min)
    this.el.rangeMax.textContent = String(r.max)
    this.el.track.setAttribute('aria-valuemin', String(r.min))
    this.el.track.setAttribute('aria-valuemax', String(r.max))
  }

  render(raw) {
    const e = this.el
    const next = this.applyHold(raw)
    this.state = next
    const c = next.controls || {}
    const s = next.sensors || {}
    const connected = Boolean(next.connected)
    const on = Boolean(next.power)
    const ctl = this.ext(next)
    const extOn = ctl.active
    const r = this.range()

    e.name.textContent = next.name || this.summary.name || this.key
    this.root.classList.toggle('is-off', !on)
    this.root.classList.toggle('is-offline', !connected)
    this.root.setAttribute('aria-label', `${next.name || this.key}: ${!connected ? 'offline' : on ? 'on' : 'off'}`)

    // Top: LAN dot and power.
    e.lan.classList.toggle('lit', connected)
    e.lan.classList.toggle('down', !connected)
    e.lan.setAttribute('aria-label', next.simulate ? 'Simulated unit' : connected ? 'LAN connected' : 'LAN offline')
    e.lan.title = next.simulate ? 'Simulated' : connected ? 'Connected on the LAN' : 'Offline'
    show(e.power, c.power)
    e.power.classList.toggle('lit', on)
    e.power.setAttribute('aria-pressed', String(on))
    e.power.setAttribute('aria-label', on ? 'Power: on. Switch off' : 'Power: off. Switch on')
    e.power.disabled = !connected

    // Readout: big target (or CO), current humidity small: droplet = unit, antenna = external sensor.
    const unitRh = num(next.humidity)
    const hasUnitRh = s.humidity && Number.isFinite(unitRh)
    const rh = extOn ? num(ctl.sourceHumidity) : unitRh
    const hasRh = extOn ? Number.isFinite(rh) : hasUnitRh
    const continuous = !extOn && next.mode === 'continuous'
    const canTarget = Boolean(extOn || c.targetHumidity)
    const target = extOn ? Number(ctl.target || 50) : Number(next.targetHumidity || 50)
    let big
    let unitShown = true
    if (continuous && c.targetHumidity) { big = 'CO'; unitShown = false }
    else if (canTarget) big = String(Math.round(target))
    else if (hasRh) big = String(Math.round(rh))
    else { big = '—'; unitShown = false }
    if (e.target.textContent !== big) e.target.textContent = big
    show(e.targetUnit, unitShown)
    e.targetBox.setAttribute('aria-label', big === 'CO' ? 'Continuous dehumidifying' : canTarget ? `Target ${big} percent` : `Humidity ${big} percent`)
    const showCurrent = canTarget || continuous
    show(e.current, showCurrent)
    e.currentIcon.setAttribute('href', extOn ? '#i-external' : '#i-droplet')
    const curText = hasRh ? `${Math.round(rh)}%` : '—'
    if (e.currentValue.textContent !== curText) e.currentValue.textContent = curText
    e.current.title = extOn
      ? `External sensor ${curText} · unit ${hasUnitRh ? `${Math.round(unitRh)}%` : '—'}`
      : `Humidity at the unit ${curText}`
    e.current.setAttribute('aria-label', e.current.title)

    // Gauge: thin background arc, thicker bright arc up to the current humidity, knob on the target.
    e.minus.style.visibility = canTarget ? '' : 'hidden'
    e.plus.style.visibility = canTarget ? '' : 'hidden'
    this.buildRange(r)
    const frac = (v) => clamp((v - r.min) / (r.max - r.min), 0, 1)
    const showKnob = canTarget && !continuous
    const arcLen = 2 * Math.PI * ARC.r
    e.arcBg.setAttribute('stroke-dasharray', `${(arcLen * ARC.sweep / 360).toFixed(2)} ${arcLen.toFixed(2)}`)
    const fill = hasRh ? frac(rh) * arcLen * ARC.sweep / 360 : 0
    e.arcFill.setAttribute('stroke-dasharray', `${fill.toFixed(2)} ${arcLen.toFixed(2)}`)
    e.arcFill.setAttribute('visibility', fill > 0 ? 'visible' : 'hidden')
    const kp = arcPoint(frac(target))
    e.knob.setAttribute('cx', kp.x.toFixed(2))
    e.knob.setAttribute('cy', kp.y.toFixed(2))
    e.knob.setAttribute('visibility', showKnob ? 'visible' : 'hidden')
    e.track.setAttribute('aria-valuenow', String(Math.round(target)))
    e.track.setAttribute('aria-valuetext', continuous ? 'Continuous' : `Target ${Math.round(target)} percent`)
    e.track.setAttribute('aria-label', extOn ? 'External sensor target humidity' : 'Target humidity')
    e.track.setAttribute('aria-disabled', String(!connected || !canTarget))
    e.track.tabIndex = canTarget ? 0 : -1
    e.minus.setAttribute('aria-label', extOn ? 'Lower external target' : 'Lower target humidity')
    e.plus.setAttribute('aria-label', extOn ? 'Raise external target' : 'Raise target humidity')
    e.minus.disabled = !connected || (!continuous && target <= r.min)
    e.plus.disabled = !connected || (!continuous && target >= r.max)

    // Mode row: plugin modes from the state; "External" last.
    const modes = c.mode ? (next.modes || []).slice() : []
    const xi = modes.findIndex((m) => m.value === 'external')
    if (xi >= 0) modes.push(modes.splice(xi, 1)[0])
    this.buildModes(modes)
    const btns = [...e.modes.querySelectorAll('[data-mode]')]
    const focusIn = e.modes.contains(document.activeElement)
    btns.forEach((b) => {
      const sel = b.dataset.mode === next.mode
      b.classList.toggle('lit', sel)
      b.setAttribute('aria-checked', String(sel))
      b.disabled = !connected
      if (!focusIn) b.tabIndex = sel ? 0 : -1
    })
    if (!focusIn && btns.length && !btns.some((b) => b.tabIndex === 0)) btns[0].tabIndex = 0

    // Fan, only when the unit has one.
    show(e.fan, c.fan)
    e.fan.querySelectorAll('[data-fan]').forEach((b) => {
      const sel = b.dataset.fan === next.fan
      b.classList.toggle('lit', sel)
      b.setAttribute('aria-checked', String(sel))
      b.disabled = !connected
    })

    // Status labels (bottom row).
    const lit = (el, v) => el.classList.toggle('lit', Boolean(v))
    show(e.compressor, s.compressor)
    lit(e.compressor, on && next.compressor)
    e.compressor.title = !on ? 'Compressor: unit off' : next.compressor ? 'Compressor running' : 'Compressor idle (hygrostat)'
    e.compressor.setAttribute('aria-label', e.compressor.title)
    show(e.defrost, s.defrost)
    lit(e.defrost, next.defrost)
    e.defrost.title = next.defrost ? 'Defrost in progress' : 'Defrost: no'
    e.defrost.setAttribute('aria-label', e.defrost.title)
    show(e.tank, s.tankFull)
    lit(e.tank, next.tankFull)
    e.tank.title = next.tankFull ? 'Tank full' : 'Tank: not full'
    e.tank.setAttribute('aria-label', e.tank.title)
    // Child lock and timer: only when the unit has them AND Admin says to show them (off by default).
    const ui = next.ui || {}
    show(e.lock, c.childLock && ui.showChildLock === true)
    lit(e.lock, next.childLock)
    e.lock.setAttribute('aria-pressed', String(Boolean(next.childLock)))
    e.lock.title = next.childLock ? 'Child lock on (tap to unlock the unit buttons)' : 'Child lock off (tap to lock the unit buttons)'
    e.lock.disabled = !connected
    const sleepIsMode = (next.modes || []).some((m) => m.value === 'sleep')
    show(e.sleepToggle, c.sleep && !sleepIsMode)
    lit(e.sleepToggle, next.sleep)
    e.sleepToggle.setAttribute('aria-pressed', String(Boolean(next.sleep)))
    e.sleepToggle.disabled = !connected
    show(e.dryToggle, c.insideDry)
    lit(e.dryToggle, next.insideDry)
    e.dryToggle.setAttribute('aria-pressed', String(Boolean(next.insideDry)))
    e.dryToggle.disabled = !connected

    const showTimer = Boolean(c.timer && ui.showTimer === true)
    show(e.timerWrap, showTimer)
    if (!showTimer && !e.timerPop.hidden) this.timerOpen(false)
    if (showTimer) {
      const h = Number(next.timerHours) || 0
      const max = next.timerMaxHours || 24
      const left = Math.round(Number(next.timerRemainingMin) || 0)
      lit(e.timer, h > 0)
      e.timerMeta.textContent = h > 0 ? `${h}h` : ''
      e.timerValue.textContent = h > 0 ? `${h} h` : 'Off'
      e.timer.title = h > 0 ? `Timer: off after ${h} h${left > 0 ? `, ${left} min left` : ''}` : 'Timer: none (tap to set)'
      e.timer.setAttribute('aria-label', e.timer.title)
      e.timer.disabled = !connected
      e.timerMinus.disabled = !connected || h <= 0
      e.timerPlus.disabled = !connected || h >= max
      if (!connected && !e.timerPop.hidden) this.timerOpen(false)
    }

    // External sensor: no status label any more; its state is in the External
    // mode button's tooltip, and warnings go to the message line below.
    const extLabel = EXT_STATE[ctl.state] || ctl.state || '—'
    const temp = Number.isFinite(num(ctl.sourceTemperature)) ? ` · ${Number(ctl.sourceTemperature).toFixed(1)} °C` : ''
    const extBtn = e.modes.querySelector('[data-mode="external"]')
    if (extBtn) {
      const tip = extOn ? `External sensor: ${extLabel}${temp}${ctl.reason ? `\n${ctl.reason}` : ''}` : 'Auto / external sensor (off)'
      if (extBtn.title !== tip) extBtn.title = tip
    }

    // One restrained line: errors first, then offline, read-only, tank, defrost, controller warnings.
    if (this.error && Date.now() > this.error.until) this.error = null
    if (this.error) setMsg(e.msg, this.error.message, 'alert')
    else if (!connected) setMsg(e.msg, next.lastError || 'The unit is not answering on the LAN yet.', 'alert')
    else if (next.profile && next.profile.id === 'generic') setMsg(e.msg, 'No model profile yet, so this unit is read-only. Pick one in Signal K Admin → Plugin Config → AlecoAir.')
    else if (next.tankFull) setMsg(e.msg, 'Tank full. The unit has stopped.', 'alert')
    else if (next.defrost) setMsg(e.msg, 'Defrost. The compressor is paused.')
    else if (extOn && EXT_WARN.has(ctl.state)) setMsg(e.msg, `External sensor: ${extLabel.toLowerCase()}. ${ctl.reason || ''}`.trim())
    else setMsg(e.msg, '')

    this.summary = { ...this.summary, name: next.name || this.summary.name, connected, power: on }
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
      this.showError(err.message)
    } finally {
      this.busy = false
    }
  }

  async refresh() {
    const res = await apiFetch(`/devices/${encodeURIComponent(this.key)}/state`)
    if (res.ok) this.render(await res.json())
    else if (res.status === 404) return 'gone'
    else {
      // Any other HTTP error (500, 502, 401…) counts as a failed refresh, like a network error.
      const err = new Error(authError(res, await readJson(res)))
      err.status = res.status
      throw err
    }
    return 'ok'
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
  if (same) return false
  views.clear()
  page.list.replaceChildren()
  for (const d of next) {
    const v = new DeviceView(d)
    views.set(d.key, v)
    page.list.appendChild(v.root)
  }
  return true
}

let refreshing = false

async function refreshAll() {
  if (refreshing) return
  refreshing = true
  try {
    const results = await Promise.all([...views.values()].map((v) => v.refresh().catch((err) => err)))
    if (results.includes('gone')) await boot()
    const lost = results.length > 0 && results.every((r) => r instanceof Error)
    const auth = lost && results.find((r) => r.status === 401 || r.status === 403)
    setMsg(page.banner, !lost ? '' : auth ? auth.message : 'Lost the connection to the plugin.', 'alert')
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
    setMsg(page.banner, err.message || 'Signal K plugin API not found. Is the AlecoAir plugin enabled?', 'alert')
    return
  }
  show($('emptyCard'), list.length === 0)
  setMsg(page.banner, '')
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
