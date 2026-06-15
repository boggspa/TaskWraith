import { describe, it, expect, afterEach } from 'vitest'
import { WebSocket } from 'ws'
import { createRelayServer, type RelayServerHandle } from '../src/server'
import { E2eeSession, type E2eeSessionOptions } from '../../src/shared/e2ee/session'
import { generateIdentityKeyPair } from '../../src/shared/e2ee/keys'
import type { E2eeFrame } from '../../src/shared/e2ee/protocol'

const SESSION_ID = 'sess-relay'

let relay: RelayServerHandle | null = null
const openSockets: WebSocket[] = []

afterEach(async () => {
  for (const ws of openSockets.splice(0)) {
    try {
      ws.terminate()
    } catch {
      /* ignore */
    }
  }
  if (relay) {
    await relay.close()
    relay = null
  }
})

function connectEndpoint(
  url: string,
  role: 'mac' | 'iphone',
  makeOptions: (send: (f: E2eeFrame) => void) => E2eeSessionOptions
): Promise<{ ws: WebSocket; session: E2eeSession }> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, { headers: { 'x-taskwraith-role': role } })
    openSockets.push(ws)
    const session = new E2eeSession(makeOptions((f) => ws.send(JSON.stringify(f))))
    ws.on('open', () => resolve({ ws, session }))
    ws.on('error', reject)
    ws.on('message', (data) => {
      try {
        void session.handleFrame(JSON.parse(data.toString()) as E2eeFrame)
      } catch {
        /* ignore non-JSON */
      }
    })
  })
}

function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void } {
  let resolve!: (v: T) => void
  const promise = new Promise<T>((r) => (resolve = r))
  return { promise, resolve }
}

describe('taskwraith-relay round-trip', () => {
  it('two endpoints complete the e2ee handshake + exchange an app message through the relay', async () => {
    relay = await createRelayServer({})
    const url = `ws://127.0.0.1:${relay.port}/v1/session/${SESSION_ID}`
    const macId = generateIdentityKeyPair()
    const iphoneId = generateIdentityKeyPair()

    const macEstablished = deferred<void>()
    const iphoneEstablished = deferred<void>()
    const iphoneGotApp = deferred<{ method: string; params: unknown }>()

    const mac = await connectEndpoint(url, 'mac', (send) => ({
      role: 'mac',
      sessionId: SESSION_ID,
      identityKeyPair: macId,
      send,
      onAppMessage: () => undefined,
      onEstablished: () => macEstablished.resolve(),
      trustPeer: () => true
    }))
    const iphone = await connectEndpoint(url, 'iphone', (send) => ({
      role: 'iphone',
      sessionId: SESSION_ID,
      identityKeyPair: iphoneId,
      peerIdentityPublicKey: macId.publicKey,
      send,
      onAppMessage: (method, params) => iphoneGotApp.resolve({ method, params }),
      onEstablished: () => iphoneEstablished.resolve()
    }))

    mac.session.start()
    iphone.session.start()
    await Promise.all([macEstablished.promise, iphoneEstablished.promise])

    expect(relay.roomCount()).toBe(1)
    mac.session.sendApp('bridge.runEvent', { hello: 1 })
    const received = await iphoneGotApp.promise
    expect(received).toEqual({ method: 'bridge.runEvent', params: { hello: 1 } })
  })

  it('a newer connection takes over an occupied seat (zombie eviction)', async () => {
    // The old behavior rejected the newcomer (4002) — which deadlocked
    // trusted reconnect when an app killed behind a proxy left a no-FIN
    // zombie holding the seat. The seat is only a forwarding slot (trust is
    // the e2ee handshake), so the newcomer wins and the incumbent is closed.
    relay = await createRelayServer({})
    const url = `ws://127.0.0.1:${relay.port}/v1/session/${SESSION_ID}`
    const id = generateIdentityKeyPair()
    const first = await connectEndpoint(url, 'iphone', (send) => ({
      role: 'iphone',
      sessionId: SESSION_ID,
      identityKeyPair: id,
      send,
      onAppMessage: () => undefined
    }))
    const firstClosed = deferred<number>()
    first.ws.on('close', (code) => firstClosed.resolve(code))

    const macGotFrame = deferred<string>()
    const mac = new WebSocket(url, { headers: { 'x-taskwraith-role': 'mac' } })
    openSockets.push(mac)
    await new Promise<void>((resolve, reject) => {
      mac.on('open', () => resolve())
      mac.on('error', reject)
    })
    mac.on('message', (data) => macGotFrame.resolve(data.toString()))

    const second = new WebSocket(url, { headers: { 'x-taskwraith-role': 'iphone' } })
    openSockets.push(second)
    await new Promise<void>((resolve, reject) => {
      second.on('open', () => resolve())
      second.on('error', reject)
    })

    // Incumbent evicted with the takeover code; newcomer owns the seat and
    // its frames forward to the mac.
    expect(await firstClosed.promise).toBe(4006)
    second.send('{"t":"probe"}')
    expect(await macGotFrame.promise).toBe('{"t":"probe"}')
  })

  it('terminates a socket that stops ponging while its peer keeps the room alive', async () => {
    // Per-socket liveness: lastActivity is room-wide, so a live mac's pongs
    // used to keep a dead iphone socket unswept forever. autoPong:false
    // simulates the no-FIN zombie (kernel ACKs, application never pongs).
    relay = await createRelayServer({ heartbeatMs: 100 })
    const url = `ws://127.0.0.1:${relay.port}/v1/session/${SESSION_ID}`
    const mac = new WebSocket(url, { headers: { 'x-taskwraith-role': 'mac' } })
    openSockets.push(mac)
    const zombie = new WebSocket(url, {
      headers: { 'x-taskwraith-role': 'iphone' },
      autoPong: false
    })
    openSockets.push(zombie)
    const zombieClosed = deferred<number>()
    zombie.on('close', (code) => zombieClosed.resolve(code))
    await Promise.all(
      [mac, zombie].map(
        (ws) =>
          new Promise<void>((resolve, reject) => {
            ws.on('open', () => resolve())
            ws.on('error', reject)
          })
      )
    )
    // Two heartbeat ticks: first marks not-alive + pings, second terminates.
    expect(await zombieClosed.promise).toBe(1006)
    expect(mac.readyState).toBe(WebSocket.OPEN)
  })

  it('does not create an empty room for a per-IP rejected connection', async () => {
    relay = await createRelayServer({ maxConnectionsPerIp: 1 })
    const first = new WebSocket(`ws://127.0.0.1:${relay.port}/v1/session/sess-a`, {
      headers: { 'x-taskwraith-role': 'mac' }
    })
    openSockets.push(first)
    await new Promise<void>((resolve, reject) => {
      first.on('open', () => resolve())
      first.on('error', reject)
    })
    expect(relay.roomCount()).toBe(1)

    const rejected = new WebSocket(`ws://127.0.0.1:${relay.port}/v1/session/sess-b`, {
      headers: { 'x-taskwraith-role': 'iphone' }
    })
    openSockets.push(rejected)
    const closed = deferred<number>()
    rejected.on('close', (code) => closed.resolve(code))

    expect(await closed.promise).toBe(4004)
    expect(relay.roomCount()).toBe(1)
  })

  it('closes a connection with a bad role header', async () => {
    relay = await createRelayServer({})
    const url = `ws://127.0.0.1:${relay.port}/v1/session/${SESSION_ID}`
    const closed = deferred<number>()
    const ws = new WebSocket(url, { headers: { 'x-taskwraith-role': 'bogus' } })
    openSockets.push(ws)
    ws.on('close', (code) => closed.resolve(code))
    expect(await closed.promise).toBe(4001)
  })
})
