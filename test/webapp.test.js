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
  assert.ok(/role="radiogroup"/.test(app) && /data-mode=/.test(app), 'modes are a radio group')
})
