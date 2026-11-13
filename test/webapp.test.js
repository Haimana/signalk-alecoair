'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const path = require('path')
const vm = require('vm')

const pub = path.join(__dirname, '..', 'public')
const html = fs.readFileSync(path.join(pub, 'index.html'), 'utf8')
const app = fs.readFileSync(path.join(pub, 'app.js'), 'utf8')
const css = fs.readFileSync(path.join(pub, 'styles.css'), 'utf8')
const tpl = (html.match(/<template id="deviceTemplate">([\s\S]*?)<\/template>/) || [])[1]

test('WebApp script compiles', () => {
  assert.doesNotThrow(() => new vm.Script(app, { filename: 'app.js' }))
})

test('every unit is one glass panel cloned from a template, stacked (no switcher, no sheets)', () => {
  assert.ok(tpl, 'index.html has the per-device template')
  assert.equal(/\sid="/.test(tpl), false, 'no ids inside the template, it is cloned once per unit')
  assert.ok(/id="deviceList"/.test(html))
  assert.equal(/id="switcher"|sheetBackdrop|id="subtitle"|class="footer"/.test(html), false, 'no switcher, sheet, subtitle or footer')
})

test('every element the card script uses exists in the template', () => {
  const roles = new Set([...tpl.matchAll(/data-r="([A-Za-z]+)"/g)].map((m) => m[1]))
  const used = new Set([...app.matchAll(/\b(?:e|this\.el)\.([A-Za-z]+)\b/g)].map((m) => m[1]))
  for (const r of used) assert.ok(roles.has(r), `template is missing data-r="${r}"`)
})

test('every icon the script or template references is defined', () => {
  const defined = new Set([...html.matchAll(/<symbol id="([\w-]+)"/g)].map((m) => m[1]))
  const refs = [...html.matchAll(/href="#(i-[\w-]+)"/g), ...app.matchAll(/'#?(i-[\w-]+)'/g)].map((m) => m[1])
  for (const r of refs) assert.ok(defined.has(r), `icon ${r} is not defined`)
  assert.ok(/'i-mode'/.test(app), 'unknown modes get a fallback icon')
})

test('modes are an icon row from state.modes (radio buttons), External last; no dropdown, no hard-coded names', () => {
  assert.ok(/role="radiogroup" aria-label="Working mode"/.test(tpl))
  assert.ok(/next\.modes/.test(app), 'mode buttons come from the live state')
  assert.ok(/class="mode" role="radio"/.test(app))
  assert.equal(/role="listbox"|select-menu/.test(app), false, 'no dropdown any more')
  assert.equal(/Manual|Sleeping/.test(app), false, 'no hard-coded official-app mode names')
  assert.ok(/m\.value === 'external'/.test(app), 'External comes from the plugin mode `external`')
  assert.ok(/pickMode\(value\)\s*\{[\s\S]*?this\.command\(\{ mode: value \}\)/.test(app), 'a tap sends the mode command')
  assert.ok(/\.modes \{[^}]*flex-wrap: wrap/.test(css), 'the mode row wraps')
})

test('controls follow the profile: fan, child lock, timer only when reported; range and step from state', () => {
  assert.ok(/show\(e\.fan, c\.fan\)/.test(app))
  assert.ok(/show\(e\.lock, c\.childLock\)/.test(app))
  assert.ok(/show\(e\.timerWrap, c\.timer\)/.test(app))
  assert.ok(/humidityRange/.test(app) && /r\.step/.test(app), 'range and step come from the profile')
  assert.ok(/'CO'/.test(app), 'continuous mode shows CO as the big value')
})

test('external sensor: target goes to the control route, antenna icon for the external humidity, tooltip with state', () => {
  assert.ok(/\/control`/.test(app), 'the external target goes to the control route, not to the unit')
  assert.ok(/sourceHumidity/.test(app))
  assert.ok(/#i-external/.test(app) && /#i-droplet/.test(app))
  assert.equal(/manual-pause|EXT_RANGE/.test(app), false)
  for (const s of ['running', 'idle', 'waiting', 'defrost', 'sensor-missing', 'too-cold']) {
    assert.ok(app.includes(`${s.includes('-') ? `'${s}'` : s}:`), `status label for ${s}`)
  }
})

test('accessibility and refresh: slider is keyboard-operable, targets are >= 44 px, cards are not rebuilt on refresh', () => {
  assert.ok(/role="slider"[^>]*tabindex="0"/.test(tpl))
  assert.ok(/ArrowRight/.test(app) && /Home/.test(app))
  assert.ok(/focus-visible/.test(css))
  for (const sel of ['.icon-btn', '.step']) {
    const m = css.match(new RegExp(`\\${sel} \\{[^}]*width: (\\d+)px`))
    assert.ok(m && Number(m[1]) >= 44, `${sel} is at least 44 px`)
  }
  assert.ok(/if \(sig === this\.modesSig\) return/.test(app), 'mode buttons are rebuilt only when the modes change')
  assert.ok(/if \(sig === this\.dotsSig\) return/.test(app), 'slider dots are rebuilt only when the range changes')
  assert.ok(/TARGET_DEBOUNCE_MS/.test(app) && /beginHold/.test(app), 'debounce and optimistic hold kept')
})

test('left: dotted arc with -/+ beside it and the values in its centre; right: modes on top, status below', () => {
  assert.ok(/class="dial"[\s\S]*data-r="minus"[\s\S]*class="ring"[\s\S]*class="readout"[\s\S]*data-r="plus"/.test(tpl), 'minus, arc with readout, plus')
  assert.ok(/class="side"[\s\S]*data-r="modes"[\s\S]*class="status"/.test(tpl), 'modes above the status icons on the right')
  assert.equal(/panel-bottom|slider-wrap/.test(tpl), false, 'no horizontal slider any more')
  assert.ok(/arcPoint\(/.test(app) && /sweep: 270/.test(app), '270-degree arc')
  assert.ok(/Math\.atan2/.test(app), 'tap or drag on the arc sets the target')
  const dim = css.match(/--dim: rgba\(255, 255, 255, (0\.\d+)\)/)
  assert.ok(dim && Number(dim[1]) >= 0.35, 'unlit elements are clearly visible')
})

test('-/+ are bare glyphs at the two ends of the arc; a solid sector shows the current humidity over the dotted gauge', () => {
  assert.ok(/<symbol id="i-minus" viewBox="0 0 24 24"><path [^>]*\/><\/symbol>/.test(html), 'minus has no circle outline')
  assert.ok(/<symbol id="i-plus" viewBox="0 0 24 24"><path [^>]*\/><\/symbol>/.test(html), 'plus has no circle outline')
  assert.ok(/step-min/.test(tpl) && /step-max/.test(tpl) && /\.step-min \{/.test(css) && /\.step-max \{/.test(css), 'placed at the min and max ends')
  assert.ok(/\.step \{[^}]*width: 48px; height: 48px/.test(css), '48 px hit area kept')
  assert.ok(/data-r="dots"[\s\S]*data-r="arcFill"[\s\S]*data-r="knob"/.test(tpl), 'dots, then the solid sector, then the knob on top')
  assert.ok(/arcFill\.setAttribute\('stroke-dasharray'/.test(app))
  assert.ok(/\.side \{[^}]*align-items: center/.test(css) && /\.modes \{[^}]*justify-content: center/.test(css) && /\.status \{[^}]*justify-content: center/.test(css), 'modes and status centred in the right column')
})
