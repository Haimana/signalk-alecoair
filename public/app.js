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
 *
 * Desktop (>= 960 px): each unit is one wide card, stacked. The ring stays
 * on the left; on the right, Power, a working-mode dropdown with fan speed
 * on the same row, and a fixed two-column settings grid replace the bar and
 * the sheets, so every model gets the same card height.
 *
 * External sensor: when the unit has external control set up in Admin, an
 * "External sensor" switch sits with the settings. While it is on, the ring
 * shows the external humidity (the unit's own reading is shown smaller), −/+
 * change the controller target (kept by the plugin, not sent to the unit) and
 * a status line says what the controller is doing.
 */

const PLUGIN_ID = 'signalk-alecoair'
const API = `/plugins/${PLUGIN_ID}`
const $ = (id) => document.getElementById(id)
const RING_LEN = 2 * Math.PI * 86
const RING_ARC = RING_LEN * 0.75
const SCALE = { min: 20, max: 90 }
const TARGET_DEBOUNCE_MS = 700
// Same breakpoint as styles.css: wide cards with the controls expanded on the right.
const WIDE = window.matchMedia('(min-width: 960px)')
const EXT_STATE = {
  starting: 'Starting',
  running: 'Running',
  idle: 'Idle, below target',
  waiting: 'Waiting (minimum time)',
  defrost: 'Defrost',
  'manual-pause': 'Paused after a manual change',
  'sensor-missing': 'Sensor missing',
  'too-cold': 'Too cold',
  'tank-full': 'Tank full',
  offline: 'Unit offline',
  unsupported: 'Not supported on this unit',
  error: 'Command failed, retrying',
  internal: 'Off'
}
const EXT_RANGE = { min: 20, max: 90 }
const POWER_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3v8"/><path d="M6.3 6.8a8 8 0 1 0 11.4 0"/></svg>'

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
    this.extHold = null
    this.extBusy = false
    this.sideSig = ''
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
    e.modePill.addEventListener('click', () => { if (!WIDE.matches) openSheetFor(this, 'mode') })
    e.fanBtn.addEventListener('click', () => openSheetFor(this, 'fan'))
    e.settingsBtn.addEventListener('click', () => openSheetFor(this, 'settings'))
    e.minus.addEventListener('click', () => this.stepTarget(-1))
    e.plus.addEventListener('click', () => this.stepTarget(1))
  }

  range() {
    return (this.state && this.state.humidityRange) || { min: 30, max: 80, step: 5 }
  }

  /** External control state, with a pending target or switch shown at once. */
  ext(next) {
    const ctl = { ...((next || this.state || {}).control || {}) }
    const hold = this.extHold
    if (hold && Date.now() < hold.until) {
      if (hold.target !== undefined) {
        if (Number(ctl.target) === hold.target) delete hold.target
        else ctl.target = hold.target
      }
      if (hold.mode !== undefined) {
        if (ctl.mode === hold.mode) delete hold.mode
        else ctl.mode = hold.mode
      }
      if (hold.target === undefined && hold.mode === undefined) this.extHold = null
    } else this.extHold = null
    ctl.active = Boolean(ctl.configured && ctl.mode === 'external')
    return ctl
  }

  /** External sensor switch and controller target (POST /control; nothing is sent to the unit directly). */
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
      setBanner(this.el.banner, err.message, 'error')
    } finally {
      this.extBusy = false
    }
  }

  /** −/+ move the target right away on screen and send one command once the taps stop. */
  stepTarget(dir) {
    if (!this.state) return
    const ctl = this.ext()
    if (ctl.active) {
      const target = clamp(Number(ctl.target || 50) + dir, EXT_RANGE.min, EXT_RANGE.max)
      this.extHold = { ...(this.extHold || {}), until: Date.now() + 8000, target }
      this.render({ ...this.state })
      clearTimeout(this.targetTimer)
      this.targetTimer = setTimeout(() => this.setControl({ target }), TARGET_DEBOUNCE_MS)
      return
    }
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
    // External sensor on: arc = external humidity, target = controller target.
    const ctl = this.ext(next)
    const extOn = ctl.active
    const r = extOn ? { ...EXT_RANGE, step: 1 } : this.range()
    const unitRh = Number(next.humidity)
    const hasUnitRh = s.humidity && next.humidity !== null && Number.isFinite(unitRh)
    const rh = extOn ? Number(ctl.sourceHumidity) : unitRh
    const hasRh = extOn ? ctl.sourceHumidity !== null && ctl.sourceHumidity !== undefined && Number.isFinite(rh) : hasUnitRh
    const continuous = !extOn && next.mode === 'continuous'
    const target = extOn ? Number(ctl.target || 50) : Number(next.targetHumidity || 50)
    const rhPct = hasRh ? clamp((rh - SCALE.min) / (SCALE.max - SCALE.min), 0, 1) : 0
    e.arc.setAttribute('stroke-dasharray', `${RING_ARC * rhPct} ${RING_LEN}`)
    e.arc.style.stroke = next.tankFull ? 'var(--alert)' : (hasRh && rh > target && !continuous ? 'var(--teal)' : 'var(--blue)')
    const showTarget = extOn || (c.targetHumidity && !continuous)
    const kp = ringPoint(clamp((target - SCALE.min) / (SCALE.max - SCALE.min), 0, 1))
    e.knob.setAttribute('cx', kp.x.toFixed(1))
    e.knob.setAttribute('cy', kp.y.toFixed(1))
    // SVG elements have no .hidden property, so toggle visibility directly.
    e.knob.setAttribute('visibility', showTarget ? 'visible' : 'hidden')
    e.arc.setAttribute('visibility', rhPct > 0 ? 'visible' : 'hidden')
    if (showTarget) e.target.innerHTML = `${Math.round(target)}<sup>%</sup>`
    else if (c.targetHumidity && continuous) e.target.textContent = 'CO'
    else e.target.innerHTML = hasRh ? `${Math.round(rh)}<sup>%</sup>` : '—'
    if (extOn) {
      e.indoor.textContent = `External ${hasRh ? `${Math.round(rh)}%` : '—'} · unit ${hasUnitRh ? `${Math.round(unitRh)}%` : '—'}`
    } else {
      e.indoor.textContent = showTarget || continuous
        ? `Indoor humidity ${hasRh ? `${Math.round(rh)}%` : '—'}`
        : 'indoor humidity'
    }
    show(e.minus, c.targetHumidity || extOn)
    show(e.plus, c.targetHumidity || extOn)
    e.minus.setAttribute('aria-label', extOn ? 'Lower external target' : 'Lower target humidity')
    e.plus.setAttribute('aria-label', extOn ? 'Raise external target' : 'Raise target humidity')
    e.minus.disabled = !connected || (showTarget && target <= r.min)
    e.plus.disabled = !connected || (showTarget && target >= r.max)

    const facts = []
    if (on && s.compressor && !extOn) facts.push(next.compressor ? 'Compressor running' : 'Waiting for the hygrostat')
    if (on && extOn) facts.push(next.defrost ? 'Defrost' : 'Compressor running')
    if (!on) facts.push('Off')
    if (s.powerWatts && next.powerWatts !== null && next.powerWatts !== undefined) facts.push(`≈${Math.round(next.powerWatts)} W`)
    if (c.timer && next.timerHours > 0) {
      const left = Math.round(Number(next.timerRemainingMin) || 0)
      facts.push(`Timer ${next.timerHours} h${left > 0 ? ` (${left} min left)` : ''}`)
    }
    if (next.childLock) facts.push('Child lock')
    e.facts.textContent = facts.join(' · ')

    show(e.ext, extOn)
    if (extOn) {
      const label = EXT_STATE[ctl.state] || ctl.state || '—'
      const temp = ctl.sourceTemperature !== null && ctl.sourceTemperature !== undefined ? ` · ${Number(ctl.sourceTemperature).toFixed(1)} °C` : ''
      e.ext.textContent = `External sensor · ${label}${temp}`
      e.ext.title = ctl.reason || ''
      e.ext.dataset.state = ctl.state || ''
    }

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

    this.renderSide(next)
    this.summary = { ...this.summary, name: next.name || this.summary.name, connected, power: on }
    if (openSheet && openSheet.view === this) renderSheet()
    renderHeader()
  }

  /**
   * Desktop controls panel, same height for every model: Power; one row with
   * the working-mode dropdown and (only if the unit has one) fan speed; a
   * two-column settings grid sized for the densest profile; one-line note.
   * Built once per control set, then only its state is updated, so the
   * 2-second refresh never closes the dropdown or moves focus.
   */
  renderSide(next) {
    const side = this.el.side
    const c = next.controls || {}
    const connected = Boolean(next.connected)
    const modes = c.mode ? (next.modes || []) : []
    const items = settingsItems(this)
    const sig = JSON.stringify([Boolean(c.power), modes.map((m) => [m.value, m.label]), Boolean(c.fan), items])
    if (sig !== this.sideSig) {
      this.sideSig = sig
      if (openMenu && openMenu.view === this) closeMenu(false)
      const id = attr(this.key)
      const parts = []
      parts.push(c.power
        ? `<div class="side-power"><div><b>Power</b><small data-s="powerSub"></small></div>
          <button type="button" class="power-toggle" data-s="power">${POWER_ICON}<span data-s="powerLabel">Off</span></button></div>`
        : '<div class="side-power side-slot" aria-hidden="true"></div>')
      const cells = []
      if (modes.length) {
        cells.push(`<div class="side-cell side-mode"><h3 id="${id}-modes">Working mode</h3>
          <div class="select">
            <button type="button" class="select-btn" data-s="modeBtn" aria-haspopup="listbox" aria-expanded="false" aria-labelledby="${id}-modes ${id}-modeval">
              <span id="${id}-modeval" data-s="modeValue">—</span><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 10l5 5 5-5"/></svg></button>
            <ul class="select-menu" role="listbox" data-s="modeMenu" aria-labelledby="${id}-modes" tabindex="-1" hidden>${modes.map((m) =>
              `<li role="option" class="select-opt" data-mode="${attr(m.value)}" aria-selected="false">${attr(m.label)}</li>`).join('')}</ul>
          </div></div>`)
      }
      if (c.fan) {
        cells.push(`<div class="side-cell side-fan"><h3 id="${id}-fan">Fan speed</h3>
          <div class="segmented" role="radiogroup" aria-labelledby="${id}-fan">
            <button type="button" role="radio" data-fan="low">Low</button>
            <button type="button" role="radio" data-fan="high">High</button></div></div>`)
      }
      parts.push(`<div class="side-controls">${cells.join('')}</div>`)
      const tiles = items.map((item) => {
        if (item === 'timer') {
          return `<div class="side-tile"><span data-s="timerLabel">Timer</span>
            <div class="stepper mini"><button type="button" data-s="timerMinus" aria-label="Shorter timer">−</button><b data-s="timerValue">Off</b><button type="button" data-s="timerPlus" aria-label="Longer timer">+</button></div></div>`
        }
        if (item === 'external') {
          return `<div class="side-tile" title="Control the unit from an external Signal K humidity sensor"><span>External sensor</span>
            <button type="button" class="switch" role="switch" aria-label="External sensor" data-ext="1"></button></div>`
        }
        const label = { childLock: 'Child lock', sleep: 'Sleep', insideDry: 'Inside dry' }[item]
        const tip = { childLock: 'Locks the buttons on the unit', sleep: 'Sleep', insideDry: 'Dries the unit inside after use' }[item]
        return `<div class="side-tile" title="${tip}"><span>${label}</span>
          <button type="button" class="switch" role="switch" aria-label="${label}" data-toggle="${item}"></button></div>`
      })
      parts.push(`<div class="side-block side-settings"><h3>Settings</h3><div class="side-grid">${tiles.join('')}</div></div>`)
      parts.push('<p class="side-note" data-s="note"></p>')
      side.innerHTML = parts.join('')
      const q = (sel) => side.querySelector(sel)
      if (q('[data-s=power]')) q('[data-s=power]').addEventListener('click', () => this.command({ power: !(this.state && this.state.power) }))
      if (q('[data-s=modeBtn]')) {
        const btn = q('[data-s=modeBtn]')
        btn.addEventListener('click', () => (openMenu && openMenu.view === this ? closeMenu(true) : openMenuFor(this)))
        btn.addEventListener('keydown', (ev) => {
          if (ev.key === 'ArrowDown' || ev.key === 'ArrowUp') { ev.preventDefault(); openMenuFor(this) }
        })
        const menu = q('[data-s=modeMenu]')
        menu.addEventListener('click', (ev) => {
          const opt = ev.target.closest('[data-mode]')
          if (opt) this.pickMode(opt.dataset.mode)
        })
        menu.addEventListener('keydown', (ev) => menuKey(this, ev))
      }
      side.querySelectorAll('[data-fan]').forEach((b) => b.addEventListener('click', () => this.command({ fan: b.dataset.fan })))
      side.querySelectorAll('[data-toggle]').forEach((b) => b.addEventListener('click', () => {
        const k = b.dataset.toggle
        this.command({ [k]: !(this.state && this.state[k]) })
      }))
      if (q('[data-ext]')) q('[data-ext]').addEventListener('click', () => this.setControl({ mode: this.ext().active ? 'internal' : 'external' }))
      if (q('[data-s=timerMinus]')) {
        q('[data-s=timerMinus]').addEventListener('click', () => this.command({ timerHours: Math.max(0, (Number(this.state.timerHours) || 0) - 1) }))
        q('[data-s=timerPlus]').addEventListener('click', () => this.command({ timerHours: Math.min(this.state.timerMaxHours || 24, (Number(this.state.timerHours) || 0) + 1) }))
      }
    }
    const q = (sel) => side.querySelector(sel)
    const on = Boolean(next.power)
    if (q('[data-s=power]')) {
      const b = q('[data-s=power]')
      b.classList.toggle('on', on)
      b.disabled = !connected
      b.setAttribute('aria-pressed', String(on))
      q('[data-s=powerLabel]').textContent = on ? 'On' : 'Off'
      const ctl = this.ext(next)
      q('[data-s=powerSub]').textContent = !connected ? 'Not connected'
        : ctl.active ? `External sensor: ${(EXT_STATE[ctl.state] || ctl.state || '—').toLowerCase()}`
          : !on ? 'The unit is off' : next.compressor ? 'Compressor running' : 'On, waiting for the hygrostat'
    }
    if (q('[data-s=modeBtn]')) {
      q('[data-s=modeValue]').textContent = modeLabel(next)
      q('[data-s=modeBtn]').disabled = !connected
      if (!connected && openMenu && openMenu.view === this) closeMenu(false)
      side.querySelectorAll('[data-mode]').forEach((o) => {
        const sel = o.dataset.mode === next.mode
        o.classList.toggle('selected', sel)
        o.setAttribute('aria-selected', String(sel))
      })
    }
    side.querySelectorAll('[data-fan]').forEach((b) => {
      const sel = b.dataset.fan === next.fan
      b.classList.toggle('selected', sel)
      b.setAttribute('aria-checked', String(sel))
      b.disabled = !connected
    })
    side.querySelectorAll('[data-toggle]').forEach((b) => {
      const v = Boolean(next[b.dataset.toggle])
      b.classList.toggle('on', v)
      b.setAttribute('aria-checked', String(v))
      b.disabled = !connected
    })
    if (q('[data-ext]')) {
      const b = q('[data-ext]')
      const v = this.ext(next).active
      b.classList.toggle('on', v)
      b.setAttribute('aria-checked', String(v))
      b.disabled = !connected
    }
    if (q('[data-s=timerValue]')) {
      const h = Number(next.timerHours) || 0
      const left = Math.round(Number(next.timerRemainingMin) || 0)
      q('[data-s=timerValue]').textContent = h > 0 ? `${h} h` : 'Off'
      q('[data-s=timerLabel]').closest('.side-tile').title = h > 0 ? `Turns the unit off after ${h} h${left > 0 ? `, ${left} min left` : ''}` : 'No timer set'
      q('[data-s=timerMinus]').disabled = !connected || h <= 0
      q('[data-s=timerPlus]').disabled = !connected || h >= (next.timerMaxHours || 24)
    }
    const note = `${next.profile ? `${next.profile.name}${next.profile.verified ? '' : ' (unverified map)'}. ` : ''}Setup: Signal K Admin → Plugin Config → AlecoAir.`
    q('[data-s=note]').textContent = note
    q('[data-s=note]').title = note
  }

  /** Desktop dropdown choice: sent at once, like a tap in the phone mode sheet. */
  pickMode(value) {
    closeMenu(true)
    if (this.state && value !== this.state.mode) this.command({ mode: value })
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
  if (st.control && st.control.configured) items.push('external')
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

/* Desktop working-mode dropdown: one open at a time, overlays the card (never resizes it). */
let openMenu = null // { view }

function menuParts(view) {
  const side = view.el.side
  return { btn: side.querySelector('[data-s=modeBtn]'), menu: side.querySelector('[data-s=modeMenu]') }
}

function openMenuFor(view) {
  if (!view.state || !view.state.connected) return
  if (openMenu && openMenu.view !== view) closeMenu(false)
  const { btn, menu } = menuParts(view)
  if (!btn || !menu) return
  openMenu = { view }
  view.root.classList.add('menu-open')
  menu.hidden = false
  btn.setAttribute('aria-expanded', 'true')
  const opts = [...menu.querySelectorAll('[data-mode]')]
  const cur = opts.find((o) => o.dataset.mode === view.state.mode) || opts[0]
  setActive(menu, cur)
  menu.focus({ preventScroll: true })
}

function closeMenu(refocus) {
  if (!openMenu) return
  const { view } = openMenu
  openMenu = null
  view.root.classList.remove('menu-open')
  const { btn, menu } = menuParts(view)
  if (menu) menu.hidden = true
  if (btn) {
    btn.setAttribute('aria-expanded', 'false')
    if (refocus) btn.focus({ preventScroll: true })
  }
}

function setActive(menu, opt) {
  menu.querySelectorAll('.select-opt').forEach((o) => o.classList.toggle('active', o === opt))
  if (opt) {
    if (!opt.id) opt.id = `${menu.getAttribute('aria-labelledby')}-${opt.dataset.mode}`
    menu.setAttribute('aria-activedescendant', opt.id)
  }
}

function menuKey(view, ev) {
  const { menu } = menuParts(view)
  const opts = [...menu.querySelectorAll('[data-mode]')]
  const i = opts.findIndex((o) => o.classList.contains('active'))
  if (ev.key === 'ArrowDown' || ev.key === 'ArrowUp') {
    ev.preventDefault()
    const n = opts.length
    setActive(menu, opts[((i < 0 ? 0 : i) + (ev.key === 'ArrowDown' ? 1 : -1) + n) % n])
  } else if (ev.key === 'Home' || ev.key === 'End') {
    ev.preventDefault()
    setActive(menu, opts[ev.key === 'Home' ? 0 : opts.length - 1])
  } else if (ev.key === 'Enter' || ev.key === ' ') {
    ev.preventDefault()
    if (opts[i]) view.pickMode(opts[i].dataset.mode)
  } else if (ev.key === 'Tab') {
    closeMenu(false)
  }
}

document.addEventListener('pointerdown', (ev) => {
  if (openMenu && !ev.target.closest('.select')) closeMenu(false)
})

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
      } else if (item === 'external') {
        const ctl = view.ext()
        body.appendChild(toggleRow('External sensor', ctl.active, () => view.setControl({ mode: ctl.active ? 'internal' : 'external' }),
          ctl.active ? (ctl.reason || EXT_STATE[ctl.state] || '') : 'Control the unit from an external Signal K humidity sensor'))
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
document.addEventListener('keydown', (ev) => {
  if (ev.key !== 'Escape') return
  if (openMenu) closeMenu(true)
  else if (openSheet) closeSheet()
})
// Growing the window past the breakpoint closes a phone sheet; the controls are on the card then.
// Shrinking below it closes the desktop mode dropdown.
WIDE.addEventListener('change', () => {
  if (WIDE.matches && openSheet) closeSheet()
  if (!WIDE.matches && openMenu) closeMenu(false)
})

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
  if (openMenu) closeMenu(false)
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
