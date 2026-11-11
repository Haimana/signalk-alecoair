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

test('every unit is rendered from one per-device template (stacked, no tab switcher)', () => {
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
