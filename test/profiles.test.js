'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')
const { PROFILES, resolveProfile, suggestProfile, listProfiles } = require('../plugin/profiles')
const { D13_DPS } = require('./helpers/fakes')

test('only Traditio is verified', () => {
  const verified = Object.values(PROFILES).filter((p) => p.verified).map((p) => p.id)
  assert.deepEqual(verified, ['traditio'])
})

test('profile is selected by the AlecoAir productId', () => {
  assert.equal(resolveProfile({ profile: 'auto', productId: 'b9oyi2yofflroq1g' }).profile.id, 'traditio')
  assert.equal(resolveProfile({ profile: 'auto', productId: 'hp1sjssyokokbrsg' }).profile.id, 'shinco-home')
  assert.equal(resolveProfile({ profile: 'auto', productId: 'gcthce4ejb8nzgow' }).profile.id, 'd12-eco')
  assert.equal(resolveProfile({ profile: 'auto', productId: 'pzq25786mlkxmtbb' }).profile.id, 'd16-purify')
})

test('an unknown product never silently gets the D13 map', () => {
  const r = resolveProfile({ profile: 'auto', productId: 'unknownproduct00' })
  assert.equal(r.profile.id, 'generic')
  assert.equal(r.source, 'fallback')
  assert.deepEqual(r.profile.dps, {})
})

test('an explicit profile wins over the productId', () => {
  const r = resolveProfile({ profile: 'traditio', productId: 'hp1sjssyokokbrsg' })
  assert.equal(r.profile.id, 'traditio')
  assert.equal(r.source, 'manual')
  assert.equal(resolveProfile({ profile: 'nope' }).profile.id, 'generic')
})

test('fingerprint suggests Traditio for the live D13 DPs', () => {
  assert.equal(suggestProfile(D13_DPS), 'traditio')
})

test('fingerprint tells D12 ECO from Traditio by the mode value', () => {
  assert.equal(suggestProfile({ 1: true, 2: 50, 5: 'Rain_Day', 6: 60, 19: 0 }), 'd12-eco')
  assert.equal(suggestProfile({ 1: true, 2: '0', 3: 60, 4: 50, 11: 0 }), 'shinco-home')
  assert.equal(suggestProfile({ 1: true, 7: 3 }), null)
})

test('profile list for Admin carries no functions or regexes', () => {
  const list = listProfiles()
  assert.ok(list.find((p) => p.id === 'traditio').models.some((m) => m.id === 'D13'))
  assert.doesNotThrow(() => JSON.parse(JSON.stringify(list)))
  assert.equal(JSON.stringify(list).includes('fingerprint'), false)
})
