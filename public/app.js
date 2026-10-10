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

let apiBase = '/api'
let state = null
let busy = false

async function resolveApi() {
  const candidates = ['/api', '/plugins/signalk-alecoair-d13']
  for (const base of candidates) {
    try {
      const res = await fetch(`${base}/health`, { cache: 'no-store' })
      if (res.ok) {
        apiBase = base
        const health = await res.json()
        ui.sim.textContent = health.simulate ? 'simulator LAN' : 'Tuya LAN'
        ui.sim.classList.toggle('ok', !health.simulate)
        ui.sim.classList.toggle('warn', Boolean(health.simulate))
        return health
      }
    } catch {
      // try next
    }
  }
  throw new Error('Nu găsesc API-ul pluginului Signal K.')
}

function setBanner(text, kind) {
  ui.banner.textContent = text || ''
  ui.banner.classList.toggle('show', Boolean(text))
  ui.banner.classList.toggle('error', kind === 'error')
}

function render(next) {
  state = next
  const connected = Boolean(next.connected)
  ui.conn.textContent = connected ? 'conectat' : 'deconectat'
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
  ui.tank.textContent = `${Number(next.tankLiters || 0).toFixed(2)} L`
  ui.comp.textContent = next.compressor ? 'ON' : 'OFF'

  ui.power.classList.toggle('on', Boolean(next.power))
  ui.power.textContent = next.power ? 'ON' : 'OFF'
  ui.powerLabel.textContent = next.power
    ? (next.compressor ? 'Compresor în lucru, 13 L/zi' : 'Pornit, așteaptă higrostatul')
    : 'Oprit'

  ui.target.value = String(next.targetHumidity || 50)
  ui.targetLabel.textContent = `${next.targetHumidity || 50}%`
  ui.timer.textContent = `${next.timerHours || 0} h`
  if (next.timerRemainingMin) ui.timer.textContent = `${next.timerHours || 0} h · ${next.timerRemainingMin} min`

  document.querySelectorAll('#modeSeg [data-mode]').forEach((btn) => {
    btn.classList.toggle('active', next.sleep ? btn.dataset.mode === 'sleep' : btn.dataset.mode === next.mode)
  })
  document.querySelectorAll('#fanSeg [data-fan]').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.fan === next.fan)
  })
  ui.lock.textContent = next.childLock ? 'Child lock ON' : 'Child lock'
  ui.dry.textContent = next.insideDry ? 'Uscare internă ON' : 'Uscare internă'
  ui.tankAlert.classList.toggle('show', Boolean(next.tankFull))
  ui.defrostAlert.classList.toggle('show', Boolean(next.defrost))
  ui.raw.textContent = JSON.stringify(next.rawDps && Object.keys(next.rawDps).length ? next.rawDps : next, null, 2)

  if (next.lastError) setBanner(next.lastError, 'error')
  else if (!connected) setBanner('Aparatul nu răspunde pe LAN. Verifică IP-ul, deviceId și localKey, sau lasă simulatorul pornit.', 'error')
  else setBanner('')
}

function labelMode(mode, sleep) {
  if (sleep) return 'Sleep'
  if (mode === 'continuous') return 'Continuu / rufe'
  return 'Auto'
}

async function command(body) {
  if (busy) return
  busy = true
  try {
    const res = await fetch(`${apiBase}/command`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    })
    const data = await res.json()
    if (!res.ok) throw new Error(data.error || 'Comanda a eșuat')
    render(data)
  } catch (err) {
    setBanner(err.message, 'error')
  } finally {
    busy = false
  }
}

function bind() {
  ui.power.addEventListener('click', () => command({ power: !(state && state.power) }))
  document.querySelectorAll('#modeSeg [data-mode]').forEach((btn) => {
    btn.addEventListener('click', () => command({ mode: btn.dataset.mode }))
  })
  document.querySelectorAll('#fanSeg [data-fan]').forEach((btn) => {
    btn.addEventListener('click', () => command({ fan: btn.dataset.fan }))
  })
  ui.target.addEventListener('change', () => command({ targetHumidity: Number(ui.target.value) }))
  ui.target.addEventListener('input', () => {
    ui.targetLabel.textContent = `${ui.target.value}%`
  })
  $('timerMinus').addEventListener('click', () => command({ timerHours: Math.max(0, (state?.timerHours || 0) - 1) }))
  $('timerPlus').addEventListener('click', () => command({ timerHours: Math.min(24, (state?.timerHours || 0) + 1) }))
  ui.lock.addEventListener('click', () => command({ childLock: !(state && state.childLock) }))
  ui.dry.addEventListener('click', () => command({ insideDry: !(state && state.insideDry) }))
}

async function emptyTank() {
  const url = apiBase.endsWith('/command') ? apiBase.replace(/\/command$/, '/empty-tank') : `${apiBase}/empty-tank`
  const res = await fetch(url, { method: 'POST' })
  if (res.ok) render(await res.json())
}

async function live() {
  if (apiBase === '/api' && window.EventSource) {
    const es = new EventSource('/api/stream')
    es.onmessage = (ev) => {
      try { render(JSON.parse(ev.data)) } catch { /* ignore */ }
    }
    es.onerror = () => { /* polling fallback below */ }
  }
  setInterval(async () => {
    if (document.hidden) return
    try {
      const res = await fetch(`${apiBase}/state`, { cache: 'no-store' })
      if (res.ok) render(await res.json())
    } catch {
      setBanner('Conexiunea cu pluginul s-a întrerupt.', 'error')
    }
  }, 2000)
}

async function boot() {
  bind()
  $('emptyTank').addEventListener('click', emptyTank)
  try {
    await resolveApi()
    const res = await fetch(`${apiBase}/state`, { cache: 'no-store' })
    if (!res.ok) throw new Error('Starea aparatului nu este disponibilă.')
    render(await res.json())
    live()
  } catch (err) {
    setBanner(err.message, 'error')
    ui.conn.textContent = 'eroare'
    ui.conn.className = 'pill alert'
    ui.powerLabel.textContent = 'Nu pot citi starea'
  }
}

boot()
