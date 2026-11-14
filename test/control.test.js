'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')
const { ExternalController, normalizeControlConfig, controlStrategy, toPercent, toCelsius } = require('../plugin/control')

const MIN = 60 * 1000
const T0 = Date.UTC(2026, 10, 13, 8, 0, 0)

/** Public state of a connected D13 Traditio (continuous via target 25). */
function traditio(over = {}) {
  return {
    connected: true,
    power: true,
    mode: 'auto',
    targetHumidity: 50,
    humidity: 50,
    defrost: false,
    tankFull: false,
    controls: { power: true, mode: true, targetHumidity: true },
    modes: [{ value: 'auto', label: 'Auto / hygrostat' }, { value: 'continuous', label: 'Continuous (CO)' }, { value: 'sleep', label: 'Sleep' }],
    humidityRange: { min: 30, max: 80, step: 5 },
    ...over
  }
}

/** A tiny unit model that applies the controller's commands like the runtime would. */
function harness(cfg = {}, persisted = {}, unitOver = {}) {
  const ctl = new ExternalController({ humidityPath: 'environment.inside.test.relativeHumidity', ...cfg }, persisted)
  const unit = traditio(unitOver)
  let now = T0
  let rh = 50
  let rhAt = T0
  let temp = null
  const sent = []
  const apply = (cmd) => {
    sent.push(cmd)
    if (cmd.power !== undefined) unit.power = cmd.power
    if (cmd.mode === 'continuous') { unit.mode = 'continuous'; unit.targetHumidity = 25 }
    else if (cmd.mode !== undefined) unit.mode = cmd.mode
    if (cmd.targetHumidity !== undefined) unit.targetHumidity = cmd.targetHumidity
  }
  const h = {
    ctl,
    unit,
    sent,
    get now() { return now },
    advance(ms) { now += ms; rhAt = now },
    stale(ms) { now += ms },
    humidity(v) { rh = v; rhAt = now },
    temperature(c) { temp = c },
    tick() {
      const r = ctl.tick(now, unit, {
        humidity: { path: 'environment.inside.test.relativeHumidity', value: rh, at: rhAt },
        temperature: temp === null ? null : { path: 'environment.inside.test.temperature', value: temp, at: now }
      })
      r.commands.forEach(apply)
      return r
    }
  }
  return h
}

test('config: defaults, ranges, paths as list or comma string', () => {
  const c = normalizeControlConfig({})
  assert.equal(c.enabled, false)
  assert.equal(c.humidityPath, '')
  assert.equal(c.hysteresisOn, 3)
  assert.equal(c.hysteresisOff, 2)
  assert.equal(c.minOnMinutes, 10)
  assert.equal(c.minOffMinutes, 10)
  assert.equal(c.staleMinutes, 5)
  assert.equal(c.minTemperature, 5)
  assert.equal(c.onSensorLoss, 'internal')
  assert.equal('manualPauseMinutes' in c, false)
  assert.equal('manualPauseMinutes' in normalizeControlConfig({ manualPauseMinutes: 60 }), false, 'old field is dropped')
  assert.equal('combine' in c, false, 'one sensor, nothing to combine')
  const d = normalizeControlConfig({ enabled: true, humidityPath: 'vessels.self.environment.inside.a.relativeHumidity', onSensorLoss: 'off', minOnMinutes: -3 })
  assert.equal(d.humidityPath, 'environment.inside.a.relativeHumidity')
  assert.equal(d.onSensorLoss, 'off')
  assert.equal(d.minOnMinutes, 0)
  const m = normalizeControlConfig({ humidityPaths: ['', 'environment.inside.b.relativeHumidity', 'environment.inside.c.relativeHumidity'], combine: 'average' })
  assert.equal(m.humidityPath, 'environment.inside.b.relativeHumidity', 'an old list keeps its first path')
  assert.equal('humidityPaths' in m, false)
})

test('units: ratio or percent humidity, Kelvin or Celsius temperature', () => {
  assert.equal(toPercent(0.62), 62)
  assert.equal(toPercent(62), 62)
  assert.equal(toPercent(1.2), 120)
  assert.equal(toPercent(null), null)
  assert.equal(Math.round(toCelsius(291.65) * 100) / 100, 18.5)
  assert.equal(toCelsius(18.5), 18.5)
})

test('internal mode sends nothing', () => {
  const h = harness()
  const r = h.tick()
  assert.deepEqual(r.commands, [])
  assert.equal(r.status.state, 'internal')
})

test('enable puts the unit in CO, remembers its mode and target, and follows the hysteresis', () => {
  const h = harness({ minOnMinutes: 0, minOffMinutes: 0 })
  h.ctl.enable(h.unit)
  assert.equal(h.ctl.target, 50, 'controller target defaults to the unit hygrostat target')
  h.humidity(60)
  let r = h.tick()
  assert.deepEqual(r.commands, [{ mode: 'continuous' }], 'already on: only CO')
  assert.deepEqual(h.ctl.saved, { mode: 'auto', targetHumidity: 50 })
  assert.equal(r.status.state, 'running')
  assert.equal(h.unit.targetHumidity, 25)

  h.advance(MIN); h.humidity(49); r = h.tick()
  assert.deepEqual(r.commands, [], 'inside the band: hold')
  h.advance(MIN); h.humidity(48); r = h.tick()
  assert.deepEqual(r.commands, [{ power: false }], 'target − 2 switches off')
  assert.equal(r.status.state, 'idle')
  h.advance(MIN); h.humidity(52); r = h.tick()
  assert.deepEqual(r.commands, [], 'below target + 3: stays off')
  h.advance(MIN); h.humidity(53); r = h.tick()
  assert.deepEqual(r.commands, [{ power: true }], 'target + 3 switches on')
  assert.equal(h.ctl.takeDirty(), true)
})

test('minimum on and off times hold the switch back', () => {
  const h = harness()
  h.ctl.enable(h.unit, 50)
  h.humidity(60)
  h.tick()
  h.humidity(40)
  let r = h.tick()
  assert.deepEqual(r.commands, [{ power: false }], 'no switch yet since control started: no wait')
  h.advance(MIN); h.humidity(60); r = h.tick()
  assert.deepEqual(r.commands, [])
  assert.equal(r.status.state, 'waiting')
  assert.match(r.status.reason, /minimum off time/)
  h.advance(8 * MIN); r = h.tick()
  assert.equal(r.status.state, 'waiting')
  h.advance(MIN); r = h.tick()
  assert.deepEqual(r.commands, [{ power: true }], 'after 10 min off')
  h.advance(5 * MIN); h.humidity(40); r = h.tick()
  assert.equal(r.status.state, 'waiting')
  assert.match(r.status.reason, /minimum on time/)
  h.advance(5 * MIN); r = h.tick()
  assert.deepEqual(r.commands, [{ power: false }], 'after 10 min on')
})

test('no power-off during defrost: waits until it ends', () => {
  const h = harness({ minOnMinutes: 0 })
  h.ctl.enable(h.unit, 50)
  h.humidity(60); h.tick()
  h.unit.defrost = true
  h.advance(MIN); h.humidity(40)
  let r = h.tick()
  assert.deepEqual(r.commands, [])
  assert.equal(r.status.state, 'defrost')
  h.unit.defrost = false
  h.advance(MIN); r = h.tick()
  assert.deepEqual(r.commands, [{ power: false }])
})

test('tank full: no commands, the firmware handles it', () => {
  const h = harness({ minOnMinutes: 0 })
  h.ctl.enable(h.unit, 50)
  h.humidity(60); h.tick()
  h.unit.tankFull = true
  h.advance(MIN); h.humidity(40)
  const r = h.tick()
  assert.deepEqual(r.commands, [])
  assert.equal(r.status.state, 'tank-full')
})

test('stale sensor, fallback internal: unit hygrostat restored once, control resumes when the sensor is back', () => {
  const h = harness({ minOnMinutes: 0, minOffMinutes: 0 })
  h.ctl.enable(h.unit, 55)
  h.humidity(50); h.tick()
  assert.equal(h.unit.power, false)
  h.stale(5 * MIN + 1)
  let r = h.tick()
  assert.deepEqual(r.commands, [{ mode: 'auto', targetHumidity: 50, power: true }])
  assert.equal(r.status.state, 'sensor-missing')
  h.stale(MIN); r = h.tick()
  assert.deepEqual(r.commands, [], 'applied only once')
  h.humidity(62); r = h.tick()
  assert.deepEqual(r.commands, [{ mode: 'continuous' }], 'back in CO; already on')
  assert.equal(r.status.state, 'running')
})

test('stale sensor, fallback off: switched off, but not during defrost', () => {
  const h = harness({ onSensorLoss: 'off', minOnMinutes: 0 })
  h.ctl.enable(h.unit, 50)
  h.humidity(60); h.tick()
  h.unit.defrost = true
  h.stale(6 * MIN)
  let r = h.tick()
  assert.deepEqual(r.commands, [])
  assert.equal(r.status.state, 'sensor-missing')
  h.unit.defrost = false
  r = h.tick()
  assert.deepEqual(r.commands, [{ power: false }])
})

test('power changed on the unit: external control ends at once, the unit is left as it is', () => {
  const h = harness({ minOnMinutes: 0, minOffMinutes: 0 })
  h.ctl.enable(h.unit, 50)
  h.humidity(60); h.tick()
  h.advance(MIN); h.tick()
  h.unit.power = false // someone pressed the button
  h.advance(MIN)
  let r = h.tick()
  assert.deepEqual(r.commands, [], 'no restore, no command')
  assert.equal(r.status.state, 'internal')
  assert.match(r.status.reason, /changed outside the plugin \(power switched off\)/)
  assert.equal(h.ctl.mode, 'internal')
  assert.equal(h.ctl.saved, null)
  assert.equal(h.ctl.takeDirty(), true, 'persisted')
  const exit = { at: new Date(h.now).toISOString(), cause: 'outside', reason: r.status.reason }
  assert.deepEqual(h.ctl.persisted(), { mode: 'internal', target: 50, saved: null, lastExit: exit })
  assert.deepEqual(h.ctl.publicStatus(h.unit, h.now).lastExit, exit)
  h.advance(MIN); r = h.tick()
  assert.equal(r.status.reason, exit.reason, 'the reason is not overwritten on the next tick')
  h.advance(90 * MIN); r = h.tick()
  assert.deepEqual(r.commands, [], 'it does not come back by itself')
  assert.equal(h.unit.power, false)
  assert.equal(h.unit.mode, 'continuous', 'the unit keeps whatever it has')
  h.ctl.enable(h.unit)
  r = h.tick()
  assert.deepEqual(r.commands, [{ power: true }], 'picking external again resumes it')
})

test('mode or target changed on the unit (leaving CO) also ends external control without commands', () => {
  const h = harness({ minOnMinutes: 0 })
  h.ctl.enable(h.unit, 50)
  h.humidity(60); h.tick()
  h.advance(MIN); h.tick() // the unit confirms CO
  h.advance(MIN)
  h.unit.mode = 'auto'; h.unit.targetHumidity = 45
  const r = h.tick()
  assert.match(r.status.reason, /mode changed to auto 45 %/)
  assert.equal(r.status.state, 'internal')
  assert.deepEqual(r.commands, [])
  assert.equal(h.unit.targetHumidity, 45)
  assert.equal(h.ctl.mode, 'internal')
})

test('an external change during defrost also ends control; defrost never gets a power-off from the controller', () => {
  const h = harness({ minOnMinutes: 0 })
  h.ctl.enable(h.unit, 50)
  h.humidity(60); h.tick()
  h.advance(MIN); h.tick() // confirmed
  h.unit.defrost = true
  h.advance(MIN); h.unit.mode = 'sleep'
  const r = h.tick()
  assert.deepEqual(r.commands, [])
  assert.equal(h.ctl.mode, 'internal')
})

const ctlMode = (h) => h.ctl.mode

test('the controller\'s own commands do not count as manual changes (grace while the unit catches up)', () => {
  const h = harness({ minOnMinutes: 0, minOffMinutes: 0 })
  h.ctl.enable(h.unit, 50)
  h.humidity(60)
  const r = h.ctl.tick(h.now, h.unit, { humidity: { path: 'x', value: 60, at: h.now } })
  assert.deepEqual(r.commands, [{ mode: 'continuous' }])
  // The unit has not reported CO yet a few seconds later.
  const r2 = h.ctl.tick(h.now + 5000, h.unit, { humidity: { path: 'x', value: 60, at: h.now + 5000 } })
  assert.equal(r2.status.state, 'running')
  assert.equal(ctlMode(h), 'external')
})

test('too cold: the unit is not started below the minimum temperature', () => {
  const h = harness({ temperaturePath: 'environment.inside.test.temperature', minTemperature: 5, minOnMinutes: 0, minOffMinutes: 0 })
  h.ctl.enable(h.unit, 50)
  h.unit.power = false
  h.temperature(3)
  h.humidity(70)
  let r = h.tick()
  assert.deepEqual(r.commands, [{ mode: 'continuous' }], 'CO, but no power-on')
  assert.equal(r.status.state, 'too-cold')
  h.advance(MIN); h.temperature(5.5); r = h.tick()
  assert.equal(r.status.state, 'too-cold', '1 °C hysteresis before restarting')
  h.advance(MIN); h.temperature(6.5); r = h.tick()
  assert.deepEqual(r.commands, [{ power: true }])
  h.advance(MIN); h.temperature(2); r = h.tick()
  assert.deepEqual(r.commands, [{ power: false }], 'running unit is stopped when it gets cold')
})

test('a stale reading counts as no reading', () => {
  const ctl = new ExternalController({ humidityPath: 'a' })
  assert.equal(ctl.fresh({ path: 'a', value: 55, at: T0 }, T0 + 4 * MIN), 55)
  assert.equal(ctl.fresh({ path: 'a', value: 55, at: T0 }, T0 + 6 * MIN), null)
  assert.equal(ctl.fresh(null, T0), null)
})

test('disable restores the remembered mode and target and switches the unit on', () => {
  const h = harness({ minOnMinutes: 0 }, {}, { targetHumidity: 45 })
  h.ctl.enable(h.unit)
  assert.equal(h.ctl.target, 45)
  h.humidity(30); h.tick()
  assert.equal(h.unit.power, false)
  h.ctl.disable()
  const r = h.tick()
  assert.deepEqual(r.commands, [{ mode: 'auto', targetHumidity: 45, power: true }])
  assert.equal(h.ctl.saved, null)
  assert.equal(h.ctl.mode, 'internal')
  assert.deepEqual(h.tick().commands, [])
})

test('restart: persisted external mode, target and saved settings are picked up; unit already in CO', () => {
  const h = harness({ minOnMinutes: 0 }, { mode: 'external', target: 55, saved: { mode: 'auto', targetHumidity: 50 } }, { mode: 'continuous', targetHumidity: 25, power: true })
  h.humidity(58)
  let r = h.tick()
  assert.deepEqual(r.commands, [{ mode: 'continuous' }], 'CO is sent again after a restart even though the unit reports it (no persisted power: power kept)')
  assert.equal(r.status.state, 'running')
  assert.equal(h.ctl.target, 55)
  h.ctl.disable()
  r = h.tick()
  assert.deepEqual(r.commands, [{ mode: 'auto', targetHumidity: 50, power: true }], 'restores what was saved before the restart')
})

test('restart while in CO without saved settings restores the normal hygrostat (first mode, 50 %)', () => {
  const h = harness({}, { mode: 'external', target: 50 }, { mode: 'continuous', targetHumidity: 25 })
  h.humidity(50); h.tick()
  assert.deepEqual(h.ctl.saved, { mode: 'auto', targetHumidity: 50 })
})

test('profile without continuous mode: lowest hygrostat target plus power on/off', () => {
  const unit = {
    connected: true, power: false, mode: 'auto', targetHumidity: 50, defrost: false, tankFull: false,
    controls: { power: true, mode: true, targetHumidity: true },
    modes: [{ value: 'auto', label: 'Normal' }, { value: 'laundry', label: 'Laundry' }],
    humidityRange: { min: 25, max: 80, step: 5 }
  }
  assert.equal(controlStrategy(unit).strategy, 'min-target')
  const ctl = new ExternalController({ humidityPath: 'x' })
  ctl.enable(unit, 50)
  const r = ctl.tick(T0, unit, { humidity: { path: 'x', value: 60, at: T0 } })
  assert.deepEqual(r.commands, [{ targetHumidity: 25 }, { power: true }])
  unit.targetHumidity = 25; unit.power = true
  ctl.disable()
  const r2 = ctl.tick(T0 + MIN, unit, {})
  assert.deepEqual(r2.commands, [{ mode: 'auto', targetHumidity: 50, power: true }])
})

test('a unit without power control cannot be driven', () => {
  const unit = traditio({ controls: { power: false, mode: false, targetHumidity: false }, modes: [] })
  const ctl = new ExternalController({ humidityPath: 'x' })
  ctl.enable(unit, 50)
  const r = ctl.tick(T0, unit, { humidity: { path: 'x', value: 60, at: T0 } })
  assert.deepEqual(r.commands, [])
  assert.equal(r.status.state, 'unsupported')
})

test('offline unit: no commands; a failed command backs off and retries', () => {
  const h = harness({ minOnMinutes: 0 })
  h.ctl.enable(h.unit, 50)
  h.unit.connected = false
  h.humidity(60)
  let r = h.tick()
  assert.equal(r.status.state, 'offline')
  assert.deepEqual(r.commands, [])
  h.unit.connected = true
  r = h.ctl.tick(h.now, h.unit, { humidity: { path: 'x', value: 60, at: h.now } })
  assert.deepEqual(r.commands, [{ mode: 'continuous' }])
  h.ctl.commandFailed(h.now)
  r = h.ctl.tick(h.now + 10000, h.unit, { humidity: { path: 'x', value: 60, at: h.now + 10000 } })
  assert.deepEqual(r.commands, [])
  r = h.ctl.tick(h.now + 31000, h.unit, { humidity: { path: 'x', value: 60, at: h.now + 31000 } })
  assert.deepEqual(r.commands, [{ mode: 'continuous' }], 'retried after the back-off')
})

test('stop: fallback internal restores the hygrostat; fallback off switches off', () => {
  const a = new ExternalController({ humidityPath: 'x' }, { mode: 'external', target: 50, saved: { mode: 'auto', targetHumidity: 50 } })
  assert.deepEqual(a.stopCommands(traditio({ mode: 'continuous', targetHumidity: 25, power: false })), [{ mode: 'auto', targetHumidity: 50, power: true }])
  const b = new ExternalController({ humidityPath: 'x', onSensorLoss: 'off' }, { mode: 'external', target: 50 })
  assert.deepEqual(b.stopCommands(traditio({ mode: 'continuous', power: true })), [{ power: false }])
  const c = new ExternalController({ humidityPath: 'x' }, { mode: 'internal' })
  assert.deepEqual(c.stopCommands(traditio()), [])
})

test('target accepts ratio or percent and is snapped to the unit\'s hygrostat step and range', () => {
  const ctl = new ExternalController({})
  const unit = traditio()
  assert.equal(ctl.setTarget(0.55, unit), 55)
  assert.equal(ctl.setTarget(62, unit), 60)
  assert.equal(ctl.setTarget(63, unit), 65)
  assert.equal(ctl.setTarget(5, unit), 30, 'Traditio minimum')
  assert.equal(ctl.setTarget(95, unit), 80, 'Traditio maximum')
  assert.equal(ctl.setTarget(45, unit), 45, 'on-step values are kept')
  assert.equal(ctl.setTarget(52), 50, 'remembers the last range seen')
  const purify = new ExternalController({})
  assert.equal(purify.setTarget(26, { humidityRange: { min: 25, max: 80, step: 5 } }), 25)
  assert.throws(() => ctl.setTarget('x'))
})

test('a persisted off-step target is snapped on the first tick; 45 stays 45', () => {
  const a = harness({}, { mode: 'external', target: 47, saved: { mode: 'auto', targetHumidity: 50 } }, { mode: 'continuous', targetHumidity: 25 })
  a.humidity(50); a.tick()
  assert.equal(a.ctl.target, 45)
  assert.equal(a.ctl.takeDirty(), true)
  const b = harness({}, { mode: 'external', target: 45, saved: { mode: 'auto', targetHumidity: 50 } }, { mode: 'continuous', targetHumidity: 25 })
  b.humidity(50); b.tick()
  assert.equal(b.ctl.target, 45)
})

test('picking another working mode leaves external control in one command', () => {
  const h = harness({ minOnMinutes: 0 }, {}, { targetHumidity: 45 })
  h.ctl.enable(h.unit)
  h.humidity(30); h.tick()
  assert.equal(h.unit.mode, 'continuous')
  assert.deepEqual(h.ctl.leaveTo(h.unit, 'sleep'), { mode: 'sleep', targetHumidity: 45, power: true })
  assert.equal(h.ctl.mode, 'internal')
  assert.equal(h.ctl.saved, null)
  assert.deepEqual(h.tick().commands, [], 'no restore on top of the picked mode')
  const k = harness({}, { mode: 'external', target: 50, saved: { mode: 'auto', targetHumidity: 50 } }, { mode: 'continuous', targetHumidity: 25 })
  assert.deepEqual(k.ctl.leaveTo(k.unit, 'continuous'), { mode: 'continuous', power: true })
  const a = harness({}, { mode: 'external', target: 50, saved: { mode: 'auto', targetHumidity: 50 } }, { mode: 'continuous', targetHumidity: 25 })
  assert.deepEqual(a.ctl.leaveTo(a.unit, 'auto'), { mode: 'auto', targetHumidity: 50, power: true })
})

test('restart: the controller\'s power choice and last switch time are persisted and resumed', () => {
  const h = harness({ minOnMinutes: 10, minOffMinutes: 10 })
  h.ctl.enable(h.unit, 50)
  h.humidity(40); h.tick()
  assert.equal(h.unit.power, false)
  const saved = JSON.parse(JSON.stringify(h.ctl.persisted()))
  assert.equal(saved.power, false)
  assert.equal(saved.lastSwitchAt, h.now)
  // Plugin stop restored the hygrostat (Manual 50, power on); then the new instance starts.
  const r = harness({ minOnMinutes: 10, minOffMinutes: 10 }, saved, { mode: 'auto', targetHumidity: 50, power: true })
  r.advance(MIN)
  r.humidity(51) // inside the band
  const out = r.tick()
  assert.deepEqual(out.commands, [{ mode: 'continuous' }, { power: false }], 'back in CO and off, as before the restart')
  assert.equal(out.status.state, 'idle')
  r.advance(MIN); r.humidity(60)
  assert.equal(r.tick().status.state, 'waiting', 'minimum off time counts from the switch before the restart')
})

test('persisted state from an earlier draft without power: the unit\'s current power is kept', () => {
  const r = harness({}, { mode: 'external', target: 50, saved: { mode: 'auto', targetHumidity: 50 } }, { mode: 'continuous', targetHumidity: 25, power: true })
  r.humidity(50)
  assert.deepEqual(r.tick().commands, [{ mode: 'continuous' }], 'CO again, power left as it is')
})


test('restart race: the first reading still shows the old CO/off, then the hand-back (Auto, on) arrives; External stays, CO and off are restored', () => {
  const persisted = { mode: 'external', target: 50, saved: { mode: 'auto', targetHumidity: 50 }, power: false, lastSwitchAt: T0 - 30 * MIN }
  const h = harness({ minOnMinutes: 10, minOffMinutes: 10 }, persisted, { mode: 'continuous', targetHumidity: 25, power: false })
  h.humidity(50)
  let r = h.tick()
  assert.deepEqual(r.commands, [{ mode: 'continuous' }, { power: false }], 'always CO + the saved power on the first take-over')
  // The stopping instance's hand-back lands after that: Auto 50, on.
  h.unit.mode = 'auto'; h.unit.targetHumidity = 50; h.unit.power = true
  h.advance(5000); r = h.tick()
  assert.equal(h.ctl.mode, 'external', 'unconfirmed: no exit')
  assert.deepEqual(r.commands, [])
  h.advance(11000); r = h.tick()
  assert.equal(h.ctl.mode, 'external', 'still unconfirmed after the settle time: no exit')
  assert.deepEqual(r.commands, [])
  h.advance(15000); r = h.tick()
  assert.deepEqual(r.commands, [{ mode: 'continuous' }, { power: false }], 'sent again after RESEND_MS')
  assert.equal(h.unit.mode, 'continuous'); assert.equal(h.unit.power, false)
  h.advance(5000); h.tick()
  assert.equal(h.ctl.confirmed, false, 'not before SETTLE_MS')
  h.advance(11000); r = h.tick()
  assert.equal(h.ctl.confirmed, true, 'confirmed once the unit reports CO/off after the settle time')
  assert.equal(h.ctl.mode, 'external')
  assert.equal(h.ctl.lastExit, null)
  // From now on a real change on the unit ends External.
  h.unit.power = true
  h.advance(5000); r = h.tick()
  assert.equal(h.ctl.mode, 'internal')
  assert.equal(h.ctl.lastExit.cause, 'outside')
})

test('unconfirmed command: re-sent every 30 s, never taken as a manual change; error state after 3 tries', () => {
  const h = harness({ minOnMinutes: 0, minOffMinutes: 0 })
  h.ctl.enable(h.unit, 50)
  h.humidity(60)
  const at = (ms) => h.ctl.tick(h.now + ms, h.unit, { humidity: { path: 'x', value: 60, at: h.now + ms } })
  assert.deepEqual(at(0).commands, [{ mode: 'continuous' }])
  // The unit ignores it (stays Auto).
  assert.deepEqual(at(20000).commands, [])
  assert.deepEqual(at(31000).commands, [{ mode: 'continuous' }])
  assert.deepEqual(at(62000).commands, [{ mode: 'continuous' }])
  const r = at(93000)
  assert.deepEqual(r.commands, [{ mode: 'continuous' }])
  assert.equal(r.status.state, 'error')
  assert.equal(h.ctl.mode, 'external')
})

test('last exit: kept across a restart, cleared by picking External or another mode, hidden after 12 h', () => {
  const h = harness({ minOnMinutes: 0, minOffMinutes: 0 })
  h.ctl.enable(h.unit, 50)
  h.humidity(60); h.tick()
  h.advance(MIN); h.tick()
  h.unit.power = false
  h.advance(MIN); h.tick()
  const saved = JSON.parse(JSON.stringify(h.ctl.persisted()))
  assert.equal(saved.lastExit.cause, 'outside')
  const again = new ExternalController({ humidityPath: 'x' }, saved)
  assert.deepEqual(again.publicStatus(h.unit, h.now).lastExit, saved.lastExit, 'still shown after a restart')
  assert.equal(again.publicStatus(h.unit, h.now + 13 * 60 * MIN).lastExit, null, 'expires after 12 h')
  again.enable(h.unit)
  assert.equal(again.lastExit, null, 'External picked again')
  const other = new ExternalController({ humidityPath: 'x' }, saved)
  assert.equal(other.clearLastExit(), true, 'another mode picked')
  assert.equal(other.persisted().lastExit, undefined)
})

test('config: onShutdown keep (default) or internal', () => {
  assert.equal(normalizeControlConfig({}).onShutdown, 'keep')
  assert.equal(normalizeControlConfig({ onShutdown: 'internal' }).onShutdown, 'internal')
  assert.equal(normalizeControlConfig({ onShutdown: 'x' }).onShutdown, 'keep')
})
