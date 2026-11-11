'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')
const { buildDeviceReport, assertSanitized, redactText } = require('../plugin/report')
const { PROFILES } = require('../plugin/profiles')
const { D13_DPS } = require('./helpers/fakes')

const SECRETS = {
  tuyaId: 'bfLEAKEDDEVICE0001',
  localKey: 'super-secret-local-key',
  ip: '172.22.22.224',
  email: 'owner@example.com',
  prefix: 'environment.inside.dehumidifier.secretunit',
  electrical: 'electrical.loads.dehumidifierSecretunit.power'
}

function sample(extra) {
  return buildDeviceReport(Object.assign({
    device: {
      key: 'secretunit',
      name: 'Cabin unit',
      tuyaId: SECRETS.tuyaId,
      ip: SECRETS.ip,
      productId: 'iodmvdwo1jjf8x5d',
      model: 'D13',
      paths: { prefix: SECRETS.prefix, electrical: SECRETS.electrical }
    },
    profile: PROFILES.generic,
    source: 'fallback',
    suggestion: null,
    rawDps: D13_DPS,
    reportedDps: Object.keys(D13_DPS),
    map: {},
    protocol: '3.5',
    connected: true,
    lastError: 'connect failed 172.22.22.224:6668 for owner@example.com',
    pluginVersion: '0.0.3',
    signalkVersion: '2.37.0',
    nodeVersion: 'v20.0.0'
  }, extra || {}))
}

function blob(report) {
  return report.title + '\n' + report.body + '\n' + report.url
}

test('a report for an unknown unit includes the product id and live DPs', () => {
  const report = sample()
  assert.equal(report.title, 'Device report: unknown AlecoAir (product id iodmvdwo1jjf8x5d)')
  assert.deepEqual(report.labels, ['device-report', 'unknown-model'])
  assert.match(report.body, /iodmvdwo1jjf8x5d/)
  assert.match(report.body, /generic/)
  assert.match(report.body, /Tuya LAN protocol 3\.5/)
  assert.match(report.body, /\| 1 \| `true` \| yes \| \(unmapped\) \|/)
  assert.match(report.body, /\| 6 \| `61` \| yes \| \(unmapped\) \|/)
  assert.match(report.body, /### What works/)
  assert.match(report.body, /### What does not/)
  assert.match(report.url, /^https:\/\/github\.com\/Haimana\/signalk-alecoair\/issues\/new\?/)
  assert.match(decodeURIComponent(report.url), /iodmvdwo1jjf8x5d/)
})

test('a report never includes keys, device ids, IPs, emails or Signal K paths', () => {
  const report = sample()
  assertSanitized(report, Object.values(SECRETS))
  const text = blob(report)
  assert.equal(text.includes('bfLEAKEDDEVICE0001'), false)
  assert.equal(text.includes('super-secret-local-key'), false)
  assert.equal(text.includes('172.22.22.224'), false)
  assert.equal(text.includes('owner@example.com'), false)
  assert.equal(text.includes('environment.inside.dehumidifier'), false)
  assert.equal(text.includes('electrical.loads'), false)
  assert.equal(text.includes('secretunit'), false)
  assert.match(report.body, /\[redacted-ip\]/)
  assert.match(report.body, /\[redacted\]/)
})

test('a known profile uses a verified label set and maps DP roles', () => {
  const report = sample({
    profile: PROFILES.traditio,
    source: 'productId',
    map: PROFILES.traditio.dps
  })
  assert.equal(report.title, 'Device report: AlecoAir Traditio (D13 / D25) (traditio)')
  assert.deepEqual(report.labels, ['device-report'])
  assert.match(report.body, /auto, by product id/)
  assert.match(report.body, /verified/)
  assert.match(report.body, /\| 1 \| `true` \| yes \| power \|/)
  assert.match(report.body, /\| 4 \| - \| no \| fan \|/)
})

test('redactText strips IPs with ports and emails', () => {
  assert.equal(redactText('at 10.0.0.5:6668 from a@b.co'), 'at [redacted-ip] from [redacted]')
})
