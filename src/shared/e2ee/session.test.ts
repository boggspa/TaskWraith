import { describe, it, expect } from 'vitest'
import { E2eeSession } from './session'
import { generateIdentityKeyPair, generateEphemeralKeyPair, exportRawX25519PublicKey, importRawX25519PublicKey } from './keys'
import { deriveSessionKeys } from './keyschedule'
import { seal } from './cipher'
import type { E2eeFrame } from './protocol'

/**
 * Wire a mac + iphone session through an in-memory async "relay". `send` from
 * one side enqueues delivery to the other; `pump()` drains until quiescent.
 * `drop()` clears in-flight frames (simulates a socket close on reconnect).
 * Every frame delivered to the iphone is also captured for replay tests.
 */
function wire(opts?: { trustPeer?: boolean; macPinsIphone?: boolean }) {
  const macIdentity = generateIdentityKeyPair()
  const iphoneIdentity = generateIdentityKeyPair()
  const macReceived: Array<{ method: string; params: unknown }> = []
  const iphoneReceived: Array<{ method: string; params: unknown }> = []
  const macCodes: string[] = []
  const iphoneCodes: string[] = []
  const framesToIphone: E2eeFrame[] = []
  const framesFromMac: E2eeFrame[] = []
  const macErrors: Error[] = []
  let queue: Array<() => Promise<void>> = []

  const mac: E2eeSession = new E2eeSession({
    role: 'mac',
    sessionId: 'sess-1',
    identityKeyPair: macIdentity,
    peerIdentityPublicKey: opts?.macPinsIphone ? iphoneIdentity.publicKey : undefined,
    send: (f: E2eeFrame) => {
      framesToIphone.push(f)
      framesFromMac.push(f)
      queue.push(() => iphone.handleFrame(f))
    },
    onAppMessage: (method, params) => macReceived.push({ method, params }),
    onConfirmCode: (c) => macCodes.push(c),
    onError: (e) => macErrors.push(e),
    trustPeer: opts?.trustPeer === false ? () => false : () => true
  })
  let iphone: E2eeSession
  iphone = new E2eeSession({
    role: 'iphone',
    sessionId: 'sess-1',
    identityKeyPair: iphoneIdentity,
    peerIdentityPublicKey: macIdentity.publicKey, // learned from the QR bootstrap
    send: (f: E2eeFrame) => queue.push(() => mac.handleFrame(f)),
    onAppMessage: (method, params) => iphoneReceived.push({ method, params }),
    onConfirmCode: (c) => iphoneCodes.push(c)
  })

  const pump = async (): Promise<void> => {
    let guard = 0
    while (queue.length && guard++ < 1000) {
      await queue.shift()!()
    }
  }
  const drop = (): void => {
    queue = []
  }
  /** Replace the iphone with a BRAND-NEW session object — fresh msgId
   * counters, no session memory — modeling an app relaunch (vs
   * `.reconnect()`, which models the same process redialing). */
  const swapIphone = (): E2eeSession => {
    iphone = new E2eeSession({
      role: 'iphone',
      sessionId: 'sess-1',
      identityKeyPair: iphoneIdentity,
      peerIdentityPublicKey: macIdentity.publicKey,
      send: (f: E2eeFrame) => queue.push(() => mac.handleFrame(f)),
      onAppMessage: (method, params) => iphoneReceived.push({ method, params }),
      onConfirmCode: (c) => iphoneCodes.push(c)
    })
    return iphone
  }
  /** Both endpoints start (generate ephemerals); iphone then sends clientHello. */
  const establish = async (): Promise<void> => {
    mac.start()
    iphone.start()
    await pump()
  }
  return {
    mac,
    iphone,
    macReceived,
    iphoneReceived,
    macCodes,
    iphoneCodes,
    framesToIphone,
    pump,
    drop,
    establish,
    swapIphone,
    framesFromMac,
    macErrors
  }
}

describe('E2eeSession handshake', () => {
  it('establishes both sides and derives the same confirm code', async () => {
    const w = wire()
    await w.establish()
    expect(w.mac.isEstablished).toBe(true)
    expect(w.iphone.isEstablished).toBe(true)
    expect(w.macCodes[0]).toMatch(/^\d{6}$/)
    expect(w.macCodes[0]).toBe(w.iphoneCodes[0]) // transcript binding
  })

  it('refuses to establish when the Mac does not trust the peer', async () => {
    const w = wire({ trustPeer: false })
    await w.establish()
    expect(w.mac.isEstablished).toBe(false)
  })
})

describe('E2eeSession app channel', () => {
  it('round-trips app messages both directions', async () => {
    const w = wire()
    await w.establish()
    w.mac.sendApp('bridge.runEvent', { n: 1 })
    w.iphone.sendApp('bridge.requestActionAck', { kind: 'cancelRun' })
    await w.pump()
    expect(w.iphoneReceived).toContainEqual({ method: 'bridge.runEvent', params: { n: 1 } })
    expect(w.macReceived).toContainEqual({
      method: 'bridge.requestActionAck',
      params: { kind: 'cancelRun' }
    })
  })

  it('drops a replayed encrypted frame (transport seq guard)', async () => {
    const w = wire()
    await w.establish()
    w.mac.sendApp('bridge.runEvent', { n: 7 })
    await w.pump()
    expect(w.iphoneReceived.filter((m) => m.method === 'bridge.runEvent')).toHaveLength(1)
    // Re-deliver the last enc frame the mac sent — must be dropped by the seq guard.
    const lastEnc = [...w.framesToIphone].reverse().find((f) => f.t === 'enc')!
    await w.iphone.handleFrame(lastEnc)
    expect(w.iphoneReceived.filter((m) => m.method === 'bridge.runEvent')).toHaveLength(1)
  })
})

describe('E2eeSession reconnect + replay', () => {
  it('replays an app message that was buffered but never delivered', async () => {
    const w = wire()
    await w.establish()
    w.mac.sendApp('bridge.runEvent', { n: 42 })
    w.drop() // in-flight frame lost before delivery
    expect(w.iphoneReceived).toHaveLength(0)
    w.mac.reconnect()
    w.iphone.reconnect()
    await w.pump()
    expect(w.mac.isEstablished).toBe(true)
    expect(w.iphone.isEstablished).toBe(true)
    expect(w.iphoneReceived).toEqual([{ method: 'bridge.runEvent', params: { n: 42 } }])
  })

  it('does not re-deliver an already-acked message after reconnect', async () => {
    const w = wire()
    await w.establish()
    w.mac.sendApp('bridge.runEvent', { n: 1 })
    await w.pump() // delivered
    w.iphone.sendApp('bridge.requestActionAck', { ok: true }) // carries ack → trims mac buffer
    await w.pump()
    w.drop()
    w.mac.reconnect()
    w.iphone.reconnect()
    await w.pump()
    expect(w.iphoneReceived.filter((m) => m.method === 'bridge.runEvent')).toHaveLength(1)
  })

  it('re-handshakes when ONLY the iphone reconnects (relay kept the Mac socket alive)', async () => {
    // The relay frees just the dropped role's slot — the Mac side never sees a
    // socket close, so its session object still holds the old keys + transport
    // counters when the fresh clientHello arrives. onClientHello must reset
    // per-connection state (and mint a fresh ephemeral), or the stale
    // lastRecvSeq discards every frame of the new connection.
    const w = wire()
    await w.establish()
    // Traffic in both directions so both transport counters are > 0.
    w.mac.sendApp('bridge.runEvent', { n: 1 })
    w.iphone.sendApp('bridge.requestActionAck', { ok: true })
    await w.pump()

    w.drop() // iphone's socket dies; mac session object untouched
    w.iphone.reconnect() // fresh clientHello against the established mac session
    await w.pump()

    expect(w.mac.isEstablished).toBe(true)
    expect(w.iphone.isEstablished).toBe(true)
    // The new channel works in both directions.
    w.mac.sendApp('bridge.runEvent', { n: 2 })
    w.iphone.sendApp('bridge.requestActionAck', { ok: true, n: 2 })
    await w.pump()
    expect(w.iphoneReceived.filter((m) => m.method === 'bridge.runEvent')).toHaveLength(2)
    expect(w.macReceived.filter((m) => m.method === 'bridge.requestActionAck')).toHaveLength(2)
  })

  it('accepts a FRESH peer session after an app relaunch (msgId epoch reset)', async () => {
    // A relaunched phone restarts its app msgId counter at 1, but the Mac's
    // long-lived listening session kept its inbound watermark across the
    // re-handshake — so every post-relaunch action was silently dropped as
    // "duplicate app msgId" (observed live). resume{lastAckedMsgId: 0}
    // signals a memoryless peer: the receiver resets its watermark (fresh
    // handshake keys already prevent cross-epoch ciphertext replay) and
    // clears its outbound replay buffer (state arrives via the establish
    // snapshot, not stale replays).
    const w = wire()
    await w.establish()
    w.iphone.sendApp('bridge.requestActionAck', { n: 1 })
    w.iphone.sendApp('bridge.requestActionAck', { n: 2 })
    w.iphone.sendApp('bridge.requestActionAck', { n: 3 })
    await w.pump()
    expect(w.macReceived).toHaveLength(3)

    // App relaunch: brand-new session object, counters back to 1.
    w.drop()
    const fresh = w.swapIphone()
    fresh.start()
    await w.pump()
    expect(w.mac.isEstablished).toBe(true)
    expect(fresh.isEstablished).toBe(true)

    fresh.sendApp('bridge.requestActionAck', { n: 'relaunch-1' })
    fresh.sendApp('bridge.requestActionAck', { n: 'relaunch-2' })
    await w.pump()
    // Without the epoch reset these two were dropped as duplicates 1 and 2.
    expect(w.macReceived).toHaveLength(5)
    expect(w.macReceived[3].params).toEqual({ n: 'relaunch-1' })
  })
})

describe('E2eeSession security gates (crypto review BD4)', () => {
  it('drops an app message a peer sends before the handshake authenticates', async () => {
    // A hostile relay completes ONLY the ephemeral ECDH (clientHello ->
    // serverHello) — the Mac derives keys but has not verified the peer's
    // pinned identity. A forged app frame sealed with those keys must NOT
    // reach onAppMessage. (Mirrors the live attack; the gate is `established`,
    // not `keys`.)
    const w = wire()
    const attackerEph = generateEphemeralKeyPair()
    const attackerNonce = Buffer.alloc(16, 0x99)
    w.mac.start()
    // Attacker's clientHello drives the Mac to derive keys (pre-auth).
    await w.mac.handleFrame({
      t: 'clientHello',
      protocol: 'taskwraith-e2ee-v1',
      sessionId: 'sess-1',
      role: 'iphone',
      ephemeralPubKey: exportRawX25519PublicKey(attackerEph.publicKey).toString('base64'),
      nonce: attackerNonce.toString('base64')
    } as E2eeFrame)
    const serverHello = w.framesFromMac.find((f) => f.t === 'serverHello')!
    expect(serverHello).toBeDefined()
    // Attacker derives the same directional keys and seals a forged action.
    const keys = deriveSessionKeys({
      myEphemeralPrivate: attackerEph.privateKey,
      peerEphemeralPublic: importRawX25519PublicKey(
        Buffer.from((serverHello as { ephemeralPubKey: string }).ephemeralPubKey, 'base64')
      ),
      clientNonce: attackerNonce,
      serverNonce: Buffer.from((serverHello as { nonce: string }).nonce, 'base64')
    })
    const sealed = seal(
      keys.iphoneToMac,
      'iphone->mac',
      'sess-1',
      0,
      Buffer.from(JSON.stringify({ msgId: 1, method: 'bridge.requestActionAck', params: {} }), 'utf8')
    )
    await w.mac.handleFrame({
      t: 'enc',
      sessionId: 'sess-1',
      seq: 0,
      nonce: sealed.nonce.toString('base64'),
      ct: sealed.ct.toString('base64'),
      tag: sealed.tag.toString('base64')
    } as E2eeFrame)
    expect(w.macReceived).toHaveLength(0)
  })

  it('tears down on a second clientHello during first pairing (SAS-grind defense)', async () => {
    const w = wire()
    const hello = (seed: number): E2eeFrame => {
      const eph = generateEphemeralKeyPair()
      return {
        t: 'clientHello',
        protocol: 'taskwraith-e2ee-v1',
        sessionId: 'sess-1',
        role: 'iphone',
        ephemeralPubKey: exportRawX25519PublicKey(eph.publicKey).toString('base64'),
        nonce: Buffer.alloc(16, seed).toString('base64')
      } as E2eeFrame
    }
    w.mac.start()
    await w.mac.handleFrame(hello(0x01))
    await w.mac.handleFrame(hello(0x02))
    expect(w.macErrors.some((e) => /grind|second clientHello/i.test(e.message))).toBe(true)
  })

  it('allows a second clientHello for a pinned peer after an interrupted reconnect', async () => {
    const w = wire({ macPinsIphone: true })
    const hello = (seed: number): E2eeFrame => {
      const eph = generateEphemeralKeyPair()
      return {
        t: 'clientHello',
        protocol: 'taskwraith-e2ee-v1',
        sessionId: 'sess-1',
        role: 'iphone',
        ephemeralPubKey: exportRawX25519PublicKey(eph.publicKey).toString('base64'),
        nonce: Buffer.alloc(16, seed).toString('base64')
      } as E2eeFrame
    }
    w.mac.start()
    await w.mac.handleFrame(hello(0x01))
    await w.mac.handleFrame(hello(0x02))
    expect(w.macErrors).toHaveLength(0)
    expect(w.framesFromMac.filter((frame) => frame.t === 'serverHello')).toHaveLength(2)
  })
})
