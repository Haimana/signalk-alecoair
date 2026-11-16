'use strict'

/**
 * Regression tests for 0.0.6:
 * - C1: tuyapi emits 'error' on refused, unreachable and timed-out connects
 *   and on unparsable packets. With no listener that is an uncaught
 *   exception that stops the whole Signal K process.
 * - H1: a stop() during a reconnect must close the connection it opened.
 * - H2: a failed start() that was stopped must leave no poll timer.
 *
 * Only loopback sockets are used, so the tests also run without a network.
 */

const { test } = require('node:test')
const assert = require('node:assert/strict')
const net = require('net')
const { EventEmitter } = require('events')
const TuyAPI = require('tuyapi')
const { TuyaLanDevice } = require('../plugin/tuya-lan')
const { DeviceRuntime } = require('../plugin/runtime')
const { PROFILES } = require('../plugin/profiles')
const { createCodec } = require('../plugin/mapper')
const { makeFakeLan, wait } = require('./helpers/fakes')

const DEVICE = { deviceId: 'bfTESTDEVICE0001', localKey: '0123456789abcdef' }

/** Collect uncaught exceptions instead of letting them end the test run. */
async function noUncaught(fn) {
  const caught = []
  const onUncaught = (err) => caught.push(err)
  process.on('uncaughtException', onUncaught)
  try {
    await fn()
    await wait(100)
  } finally {
    process.removeListener('uncaughtException', onUncaught)
  }
  assert.deepEqual(caught.map((e) => String(e && e.message)), [], 'no uncaught exception')
}

/** Real tuyapi, pointed at a loopback port instead of 6668. */
function tuyapiOn(port) {
  return function LoopbackTuyAPI(options) {
    return new TuyAPI({ ...options, ip: '127.0.0.1', port })
  }
}

async function closedPort() {
  const server = net.createServer()
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()
  await new Promise((resolve) => server.close(resolve))
  return port
}

async function tcpServer(onConnection) {
  const sockets = new Set()
  const server = net.createServer((socket) => {
    sockets.add(socket)
    socket.on('error', () => {})
    socket.on('close', () => sockets.delete(socket))
    socket.resume() // read, so the peer's close is seen
    onConnection(socket)
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  return {
    port: server.address().port,
    sockets,
    close: () => new Promise((resolve) => {
      for (const s of sockets) s.destroy()
      server.close(resolve)
    })
  }
}

/** A TuyAPI stand-in that fails the way tuyapi does: emit 'error' from a socket callback, then reject. */
function failingTuyAPI(message, { delayMs = 5 } = {}) {
  const made = []
  class FailingTuyAPI extends EventEmitter {
    constructor(options) {
      super()
      this.device = { ip: options.ip }
      made.push(this)
    }

    connect() {
      return new Promise((resolve, reject) => {
        setTimeout(() => {
          this.emit('error', new Error(message))
          reject(new Error(message))
        }, delayMs)
      })
    }

    get() { return Promise.reject(new Error('not connected')) }
    disconnect() {}
  }
  FailingTuyAPI.made = made
  return FailingTuyAPI
}

function runtimeWith(deps, extra = {}) {
  return new DeviceRuntime({
    key: 'd13',
    tuyaId: DEVICE.deviceId,
    localKey: DEVICE.localKey,
    ip: '172.22.22.224',
    protocol: '3.5',
    codec: createCodec(PROFILES.traditio, {}, 'D13'),
    ...extra
  }, deps)
}

test('C1: a refused LAN connect (real tuyapi) rejects without an uncaught error', async () => {
  const port = await closedPort()
  await noUncaught(async () => {
    const lan = new TuyaLanDevice({ ...DEVICE, ip: '127.0.0.1', version: '3.5' }, tuyapiOn(port))
    await assert.rejects(lan.connect(), /ECONNREFUSED/)
    lan.disconnect()
  })
})

test('C1: an unparsable packet (real tuyapi) is not an uncaught error', async () => {
  const srv = await tcpServer((socket) => socket.write(Buffer.from('garbage')))
  try {
    await noUncaught(async () => {
      const lan = new TuyaLanDevice({ ...DEVICE, ip: '127.0.0.1', version: '3.3' }, tuyapiOn(srv.port))
      // no onError(): the permanent listener alone must keep the process up
      await lan.connect().catch(() => {})
      await wait(200)
      lan.disconnect()
    })
  } finally {
    await srv.close()
  }
})

for (const message of ['Error from socket: connect EHOSTUNREACH 172.22.22.224:6668', 'connection timed out', 'Packet too short']) {
  test(`C1: start() survives tuyapi emitting '${message}' during connect, then retries`, async () => {
    const Failing = failingTuyAPI(message)
    const rt = runtimeWith({ TuyAPI: Failing })
    await noUncaught(async () => {
      await rt.start()
      assert.equal(rt.getPublicState().connected, false)
      assert.match(rt.state.lastError, new RegExp(message.split(' ')[0]))
      assert.ok(rt.reconnectTimer, 'a reconnect is scheduled')
      await rt.stop()
    })
    assert.ok(Failing.made.length >= 1)
  })
}

test('C1: the reconnect path survives a refused connect (real tuyapi) for every protocol', async () => {
  const port = await closedPort()
  const rt = runtimeWith({ TuyAPI: tuyapiOn(port) }, { protocol: 'auto' })
  rt.started = true
  await noUncaught(async () => {
    await rt.reconnect()
    assert.equal(rt.state.connected, false)
    assert.match(rt.state.lastError, /ECONNREFUSED/)
    await rt.stop()
  })
})

test('C1: an error after disconnect() (late socket error) is swallowed', async () => {
  const Failing = failingTuyAPI('x')
  await noUncaught(async () => {
    const lan = new TuyaLanDevice({ ...DEVICE, ip: '127.0.0.1' }, Failing)
    lan.onError(() => { throw new Error('handler of a closed device must not run') })
    lan.disconnect()
    Failing.made[0].emit('error', new Error('Error from socket: read ECONNRESET'))
  })
})

test('C1: disconnect() closes a half-open socket (tuyapi connect still in progress)', async () => {
  const srv = await tcpServer(() => {}) // accepts, never answers the 3.5 handshake
  try {
    await noUncaught(async () => {
      const lan = new TuyaLanDevice({ ...DEVICE, ip: '127.0.0.1', version: '3.5' }, tuyapiOn(srv.port))
      lan.connect(3000).catch(() => {})
      for (let i = 0; i < 50 && srv.sockets.size === 0; i++) await wait(20)
      assert.equal(srv.sockets.size, 1, 'socket open')
      lan.disconnect()
      for (let i = 0; i < 50 && srv.sockets.size > 0; i++) await wait(20)
      assert.equal(srv.sockets.size, 0, 'socket closed by disconnect()')
    })
  } finally {
    await srv.close()
  }
})

test('H1: stop() during a reconnect disconnects the device that reconnect opened', async () => {
  const FakeLan = makeFakeLan()
  let release
  const gate = new Promise((resolve) => { release = resolve })
  class SlowLan extends FakeLan {
    constructor(options) {
      super(options)
      this.disconnected = false
    }

    async connect() { if (SlowLan.slow) await gate }
    disconnect() { this.disconnected = true }
  }
  SlowLan.slow = false
  const rt = runtimeWith({ TuyaLanDevice: SlowLan })
  await rt.start()
  assert.equal(rt.getPublicState().connected, true)
  SlowLan.slow = true
  const pending = rt.reconnect()
  await wait(20)
  await rt.stop()
  release()
  await pending
  const opened = FakeLan.instances[FakeLan.instances.length - 1]
  assert.equal(opened.disconnected, true, 'the device opened during the reconnect is closed')
  assert.equal(rt.device, null)
  assert.equal(rt.timers.length, 0)
  assert.equal(rt.reconnectTimer, null)
})

test('H2: a failed start() that is stopped mid-way leaves no poll timer and no reconnect', async () => {
  const FakeLan = makeFakeLan()
  class FailingLan extends FakeLan {
    async connect() {
      await wait(50)
      throw new Error('connection timed out')
    }
  }
  const rt = runtimeWith({ TuyaLanDevice: FailingLan })
  const starting = rt.start()
  await wait(10)
  await rt.stop()
  await starting
  assert.equal(rt.timers.length, 0, 'no poll interval left behind')
  assert.equal(rt.reconnectTimer, null, 'no reconnect scheduled')
})
