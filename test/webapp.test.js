'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const path = require('path')
const vm = require('vm')

const pub = path.join(__dirname, '..', 'public')
const html = fs.readFileSync(path.join(pub, 'index.html'), 'utf8')
const app = fs.readFileSync(path.join(pub, 'app.js'), 'utf8')

test('WebApp script compiles', () => {
  assert.doesNotThrow(() => new vm.Script(app, { filename: 'app.js' }))
})

test('every unit is rendered from one compact per-device template (stacked, no tab switcher)', () => {
  const tpl = html.match(/<template id="deviceTemplate">([\s\S]*?)<\/template>/)
  assert.ok(tpl, 'index.html has the per-device template')
  assert.equal(/\sid="/.test(tpl[1]), false, 'no ids inside the template, it is cloned once per unit')
  assert.equal(/id="switcher"/.test(html), false, 'the one-at-a-time switcher is gone')
  assert.ok(/id="deviceList"/.test(html))
})

test('every element the device card script uses exists in the template', () => {
  const tpl = html.match(/<template id="deviceTemplate">([\s\S]*?)<\/template>/)[1]
  const roles = new Set([...tpl.matchAll(/data-r="([A-Za-z]+)"/g)].map((m) => m[1]))
  const used = new Set([...app.matchAll(/\b(?:e|this\.el)\.([A-Za-z]+)\b/g)].map((m) => m[1]))
  for (const r of used) assert.ok(roles.has(r), `template is missing data-r="${r}"`)
})

test('mode, fan and settings open one shared bottom sheet; only reported controls are offered', () => {
  assert.ok(/id="sheetBackdrop"/.test(html), 'bottom sheet in the page')
  for (const r of ['powerBtn', 'modeBtn', 'fanBtn', 'settingsBtn', 'minus', 'plus', 'target', 'indoor']) {
    assert.ok(html.includes(`data-r="${r}"`), `card has ${r}`)
  }
  assert.ok(/show\(e\.fanBtn, c\.fan\)/.test(app), 'fan button follows controls.fan')
  assert.ok(/st\.modes/.test(app), 'mode sheet lists the plugin modes from state')
  assert.equal(/Manual|Sleeping/.test(app), false, 'no hard-coded official-app mode names')
})

test('desktop: wide card with the controls expanded on the right; phones keep the bar and sheets', () => {
  const css = fs.readFileSync(path.join(pub, 'styles.css'), 'utf8')
  assert.ok(html.includes('data-r="side"'), 'card has the desktop controls panel')
  assert.ok(html.includes('class="actions"'), 'phone bottom bar still in the card')
  assert.equal(/repeat\(2, minmax/.test(css), false, 'no two-column grid of square cards')
  const wide = css.match(/@media \(min-width: (\d+)px\)\s*\{[^@]*\.unit-side/)
  assert.ok(wide, 'controls panel is shown only from a desktop breakpoint')
  assert.ok(app.includes(`(min-width: ${wide[1]}px)`), 'script uses the same breakpoint')
})

test('desktop: working mode is a dropdown (listbox), not a radio list; phones keep the mode sheet', () => {
  assert.ok(/aria-haspopup="listbox"/.test(app), 'mode button opens a listbox')
  assert.ok(/role="listbox"/.test(app) && /role="option"[^`]*data-mode=/.test(app), 'modes are options of the listbox')
  assert.equal(/role="radio"[^`]*data-mode=/.test(app), false, 'modes are no longer radio buttons')
  assert.ok(/openSheetFor\(this, 'mode'\)/.test(app), 'phone bar still opens the mode sheet')
  assert.ok(/kind === 'mode'/.test(app), 'mode sheet still lists the modes')
  // Choosing sends at once; outside click and Escape close the menu.
  assert.ok(/pickMode\(value\)\s*\{[\s\S]*?this\.command\(\{ mode: value \}\)/.test(app), 'a choice sends the mode command')
  assert.ok(/addEventListener\('pointerdown'/.test(app), 'outside click closes the dropdown')
  assert.ok(/ev\.key !== 'Escape'[\s\S]*?closeMenu/.test(app), 'Escape closes the dropdown')
  assert.ok(/!WIDE\.matches && openMenu\) closeMenu/.test(app), 'narrowing below the breakpoint closes the dropdown')
  assert.ok(/WIDE\.matches && openSheet\) closeSheet/.test(app), 'widening past the breakpoint closes a sheet')
})

test('desktop: fixed-height controls panel, same card height for every model', () => {
  const css = fs.readFileSync(path.join(pub, 'styles.css'), 'utf8')
  const menu = css.match(/\.select-menu\s*\{([^}]*)\}/)
  assert.ok(menu && /position:\s*absolute/.test(menu[1]), 'open dropdown overlays instead of pushing the layout')
  assert.ok(/class="side-controls"/.test(app), 'mode and fan share one row')
  assert.ok(/\.side-controls\s*\{[^}]*min-height/.test(css), 'mode/fan row keeps its height when a unit has no fan')
  assert.ok(/\.side-grid\s*\{[^}]*minmax\(0, 1fr\) minmax\(0, 1fr\)[^}]*min-height/.test(css), 'settings are a two-column grid with a reserved height')
  assert.ok(/if \(c\.fan\)/.test(app), 'fan only for units that report one, no dummy control')
  assert.ok(/\.mode-pill\[hidden\]\s*\{[^}]*visibility:\s*hidden/.test(css), 'left column keeps the mode pill room')
  // Built once per control set, then only refreshed, so the 2 s poll does not close the dropdown.
  assert.ok(/if \(sig !== this\.sideSig\)/.test(app), 'side panel is rebuilt only when the control set changes')
})

test('external sensor: one more entry in the working-mode menu; ring and −/+ follow the controller; status line on the card', () => {
  assert.ok(html.includes('data-r="ext"'), 'card has the external-control status line')
  assert.equal(/toggleRow\('External sensor'/.test(app), false, 'no separate switch in the Settings sheet')
  assert.equal(/data-ext=/.test(app), false, 'no separate switch in the desktop settings grid')
  assert.equal(/items\.push\('external'\)/.test(app), false)
  assert.ok(/mode === 'external'/.test(app), 'the external entry is the plugin mode `external` from state.modes')
  assert.ok(/\/control`/.test(app), 'the external target goes to the control route, not to the unit')
  assert.ok(/Number\(ctl\.target \|\| 50\) \+ dir \* r\.step/.test(app), '−/+ step the external target by the hygrostat step')
  assert.equal(/EXT_RANGE/.test(app), false, 'no separate 1 % range')
  assert.equal(/manual-pause/.test(app), false, 'no manual pause any more')
  assert.ok(/sourceHumidity/.test(app), 'ring shows the external humidity')
  for (const s of ['running', 'idle', 'waiting', 'defrost', 'sensor-missing', 'too-cold']) {
    assert.ok(app.includes(`${s.includes('-') ? `'${s}'` : s}:`), `status label for ${s}`)
  }
})
