'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')
const { DiscoveryService, toPrefix } = require('../plugin/discovery')

test('concurrent devices share one scan', async () => {
  let scans = 0
  const discovery = new DiscoveryService({
    scan: async () => { scans += 1; await new Promise((r) => setTimeout(r, 20)); return [{ id: 'a', ip: '172.22.22.10' }, { id: 'b', ip: '172.22.22.11' }] }
  })
  const [a, b, c] = await Promise.all([discovery.resolveIp('a'), discovery.resolveIp('b'), discovery.resolveIp('zzz')])
  assert.equal(scans, 1)
  assert.equal(a.ip, '172.22.22.10')
  assert.equal(b.ip, '172.22.22.11')
  assert.equal(c, null)
  await discovery.resolveIp('a')
  assert.equal(scans, 1, 'cached within the TTL')
  await discovery.scan({ force: true })
  assert.equal(scans, 2)
})

test('single unidentified TCP host is used only when allowed', async () => {
  const discovery = new DiscoveryService({ scan: async () => [{ id: '', ip: '172.22.22.224', tcp: true }] })
  assert.equal(await discovery.resolveIp('x'), null)
  assert.equal((await discovery.resolveIp('x', { allowSingleTcp: true })).ip, '172.22.22.224')
})

test('passes configured subnets to the sweep', async () => {
  let seen = null
  const discovery = new DiscoveryService({ subnets: ['10.0.5.0/24'], scan: async (opts) => { seen = opts; return [] } })
  await discovery.scan()
  assert.deepEqual(seen.prefixes, ['10.0.5.'])
  assert.equal(toPrefix('bogus'), null)
})
