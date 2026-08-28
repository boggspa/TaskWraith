import { describe, it, expect } from 'vitest'
import {
  RemoteTransportClient,
  type TransportSocketFactory,
  type TransportSocketHandlers
} from './RemoteTransportClient'
import { E2eeSession } from '../../shared/e2ee/session'
import { exportRawEd25519PublicKey, generateIdentityKeyPair } from '../../shared/e2ee/keys'
import type { E2eeFrame } from '../../shared/e2ee/protocol'

const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 10))

/** Build a Mac client wired to a fake-iPhone E2eeSession via an in-memory socket. */
function harness(opts: { pinPeer?: boolean } = {}) {
  const macId = generateIdentityKeyPair()
  const iphoneId = generateIdentityKeyPair()
  const macConfirmCodes: string[] = []
  const macMessages: Array<{ method: string; params: unknown }> = []
  const iphoneMessages: Array<{ method: string; params: unknown }> = []
  const iphoneCodes: string[] = []
  const established: string[] = []
  let clientHandlers: TransportSocketHandlers | null = null
  // Assigned after the Mac client exists so the fake socket can close over it.
  // eslint-disable-next-line prefer-const
  let iphone: E2eeSession

  const socketFactory: TransportSocketFactory = (_url, _headers, handlers) => {
    clientHandlers = handlers
    setTimeout(() => handlers.onOpen(), 0)
    return {
      send: (data: string) => void iphone.handleFrame(JSON.parse(data) as E2eeFrame),
      close: () => undefined
    }
  }

  const client = new RemoteTransportClient({
    identityKeyPair: macId,
    socketFactory,
    pinnedPeerIdentityRaw: opts.pinPeer
      ? exportRawEd25519PublicKey(iphoneId.publicKey)
      : undefined,
    onConfirmCode: (_sessionId, code) => macConfirmCodes.push(code),
    onMessage: (method, params) => macMessages.push({ method, params }),
    onEstablished: (sessionId) => established.push(sessionId)
  })

  iphone = new E2eeSession({
    role: 'iphone',
    sessionId: 'sess-T1',
    identityKeyPair: iphoneId,
    peerIdentityPublicKey: macId.publicKey, // from the QR bootstrap
    send: (frame: E2eeFrame) => clientHandlers?.onMessage(JSON.stringify(frame)),
    onAppMessage: (method, params) => iphoneMessages.push({ method, params }),
    onConfirmCode: (code) => iphoneCodes.push(code)
  })

  return {
    client,
    startIphone: () => iphone.start(),
    sendFromIphone: (m: string, p?: unknown) => iphone.sendApp(m, p),
    macConfirmCodes,
    macMessages,
    iphoneMessages,
    iphoneCodes,
    established
  }
}

describe('RemoteTransportClient pairing', () => {
  it('surfaces a confirm code, holds trust until finalize, then establishes', async () => {
    const h = harness()
    h.client.beginSession('ws://relay.test', 'sess-T1')
    await settle() // socket open → mac.start()
    h.startIphone()
    await settle() // handshake up to clientAuth → confirm code surfaced

    expect(h.macConfirmCodes[0]).toMatch(/^\d{6}$/)
    expect(h.macConfirmCodes[0]).toBe(h.iphoneCodes[0])
    expect(h.client.isConnected).toBe(false) // not established until finalize

    h.client.finalizePairing(true)
    await settle()
    expect(h.client.isConnected).toBe(true)
    expect(h.established).toEqual(['sess-T1'])
  })

  it('stays unestablished when the user cancels pairing', async () => {
    const h = harness()
    h.client.beginSession('ws://relay.test', 'sess-T1')
    await settle()
    h.startIphone()
    await settle()
    h.client.finalizePairing(false)
    await settle()
    expect(h.client.isConnected).toBe(false)
  })

  it('auto-trusts a pinned peer identity without surfacing a confirm code', async () => {
    const h = harness({ pinPeer: true })
    h.client.beginSession('ws://relay.test', 'sess-T1')
    await settle()
    h.startIphone()
    await settle()
    // Established with NO finalizePairing and NO prompt — trusted reconnect.
    expect(h.client.isConnected).toBe(true)
    expect(h.macConfirmCodes).toHaveLength(0)
  })
})

describe('RemoteTransportClient app channel', () => {
  it('pipes messages both directions once established', async () => {
    const h = harness()
    h.client.beginSession('ws://relay.test', 'sess-T1')
    await settle()
    h.startIphone()
    await settle()
    h.client.finalizePairing(true)
    await settle()

    h.client.send('bridge.runEvent', { n: 1 })
    h.sendFromIphone('bridge.requestActionAck', { kind: 'cancelRun' })
    await settle()

    expect(h.iphoneMessages).toContainEqual({ method: 'bridge.runEvent', params: { n: 1 } })
    expect(h.macMessages).toContainEqual({
      method: 'bridge.requestActionAck',
      params: { kind: 'cancelRun' }
    })
  })

  it('send() is a no-op before the session is established', async () => {
    const h = harness()
    h.client.beginSession('ws://relay.test', 'sess-T1')
    await settle()
    expect(() => h.client.send('bridge.runEvent', { n: 1 })).not.toThrow()
    expect(h.iphoneMessages).toHaveLength(0)
  })
})

describe('RemoteTransportClient liveness watchdog (RC6)', () => {
  function livenessHarness() {
    const macId = generateIdentityKeyPair()
    const iphoneId = generateIdentityKeyPair()
    let clock = 1000
    let dropOutbound = false
    let closeCalls = 0
    const connectionChanges: boolean[] = []
    let recoveryCount = 0
    let clientHandlers: TransportSocketHandlers | null = null
    // eslint-disable-next-line prefer-const
    let iphone: E2eeSession

    const socketFactory: TransportSocketFactory = (_url, _headers, handlers) => {
      clientHandlers = handlers
      setTimeout(() => handlers.onOpen(), 0)
      return {
        // A silently-OS-killed socket: outbound frames vanish, so the phone
        // never receives PINGs and never PONGs back.
        send: (data: string) => {
          if (dropOutbound) return
          void iphone.handleFrame(JSON.parse(data) as E2eeFrame)
        },
        close: () => {
          closeCalls += 1
        }
      }
    }

    const client = new RemoteTransportClient({
      identityKeyPair: macId,
      socketFactory,
      pinnedPeerIdentityRaw: exportRawEd25519PublicKey(iphoneId.publicKey),
      now: () => clock,
      pingIntervalMs: 5,
      pingTimeoutMs: 40,
      onConnectionChange: (c) => connectionChanges.push(c),
      onRecovered: () => {
        recoveryCount += 1
      }
    })
    iphone = new E2eeSession({
      role: 'iphone',
      sessionId: 'sess-live',
      identityKeyPair: iphoneId,
      peerIdentityPublicKey: macId.publicKey,
      send: (frame: E2eeFrame) => clientHandlers?.onMessage(JSON.stringify(frame)),
      onAppMessage: () => {},
      onConfirmCode: () => {}
    })

    return {
      client,
      establish: async () => {
        client.beginSession('ws://relay.test', 'sess-live')
        await settle()
        iphone.start()
        await settle()
      },
      // Drive the interval callback deterministically (avoids real-timer flake).
      tick: () => (client as unknown as { livenessTick: () => void }).livenessTick(),
      advance: (ms: number) => {
        clock += ms
      },
      setDrop: (v: boolean) => {
        dropOutbound = v
      },
      connectionChanges,
      recoveryCount: () => recoveryCount,
      closeCalls: () => closeCalls,
      isEstablished: () =>
        (client as unknown as { session?: { isEstablished: boolean } }).session?.isEstablished ===
        true
    }
  }

  it('never marks a healthy link down (pongs keep refreshing lastPongAt)', async () => {
    const h = livenessHarness()
    await h.establish()
    expect(h.client.isConnected).toBe(true)
    for (let i = 0; i < 10; i++) {
      h.advance(5) // < pingTimeoutMs, and each tick's pong refreshes liveness
      h.tick()
      await settle()
    }
    expect(h.client.isConnected).toBe(true)
    expect(h.connectionChanges.filter((c) => c === false)).toHaveLength(0)
  })

  it('marks a silent link down WITHOUT closing the socket or disposing the session', async () => {
    const h = livenessHarness()
    await h.establish()
    expect(h.client.isConnected).toBe(true)

    h.setDrop(true) // OS-kills the socket — no pongs return
    h.advance(100) // past pingTimeoutMs
    h.tick()

    expect(h.client.isConnected).toBe(false) // logical link down
    expect(h.connectionChanges.at(-1)).toBe(false)
    expect(h.closeCalls()).toBe(0) // NOT torn down — the dead peer is the phone
    expect(h.isEstablished()).toBe(true) // session intact for a re-handshake
  })

  it('self-heals on a resumed pong with no re-handshake', async () => {
    const h = livenessHarness()
    await h.establish()
    h.setDrop(true)
    h.advance(100)
    h.tick()
    expect(h.client.isConnected).toBe(false)

    // Pongs resume on the SAME session.
    h.setDrop(false)
    h.tick() // this ping now reaches the phone, which pongs back
    await settle()
    expect(h.client.isConnected).toBe(true)
    expect(h.recoveryCount()).toBe(1)

    // Further healthy pongs are ordinary keepalives, not repeated recoveries.
    h.tick()
    await settle()
    expect(h.recoveryCount()).toBe(1)
  })
})
