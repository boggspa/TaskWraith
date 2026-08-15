import { describe, it, expect, vi } from 'vitest'
import {
  RemoteBridgeRuntime,
  pairIdFromIdentityPubKey,
  relayHttpBase,
  type PairedHostProjectionGatewayPort,
  type RemotePairingPrompt,
  type RemotePairingPersistence
} from './RemoteBridgeRuntime'
import type { PairedHostProjectionAttachment } from './PairedHostProjectionGateway'
import type { PersistedRemotePairing } from './RemotePairingStore'
import type { TransportSocketFactory, TransportSocketHandlers } from './RemoteTransportClient'
import { E2eeSession } from '../../shared/e2ee/session'
import {
  b64,
  exportRawEd25519PublicKey,
  generateIdentityKeyPair,
  importRawEd25519PublicKey
} from '../../shared/e2ee/keys'
import { verifyRegisterRequest, type RegisterRequest } from '../../shared/e2ee/resolve'
import { buildRemoteProjectionEnvelope } from '../RemoteTaskProjection'
import type { E2eeFrame } from '../../shared/e2ee/protocol'
import type { RunEvent, RunEventSink } from '../RunEventBus'

const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 10))

const emptyAppStore = {
  getWorkspaces: () => [],
  getChats: () => [],
  getChat: () => null
}

function memoryPairingStore(initial: PersistedRemotePairing[] = []): {
  store: RemotePairingPersistence
  list: () => PersistedRemotePairing[]
} {
  let devices = [...initial]
  return {
    store: {
      list: () => [...devices],
      upsert: (pairing) => {
        const index = devices.findIndex(
          (device) => device.iphoneIdentityPubKey === pairing.iphoneIdentityPubKey
        )
        if (index >= 0) devices[index] = pairing
        else devices.push(pairing)
      },
      remove: (iphoneIdentityPubKey) => {
        const before = devices.length
        devices = devices.filter((device) => device.iphoneIdentityPubKey !== iphoneIdentityPubKey)
        return devices.length < before
      },
      clear: () => {
        devices = []
      }
    },
    list: () => [...devices]
  }
}

function hostGatewayHarness() {
  const attachments: PairedHostProjectionAttachment[] = []
  const gateway = {
    attach: vi.fn(async (attachment: PairedHostProjectionAttachment) => {
      attachments.push(attachment)
    }),
    detach: vi.fn(),
    dispose: vi.fn(),
    request: vi.fn(async () => ({ kind: 'health.get', frame: { hostStatus: 'ok' } })),
    resync: vi.fn(async () => true)
  } satisfies PairedHostProjectionGatewayPort
  return { gateway, attachments }
}

function harness(
  opts: {
    pairingWindowMs?: number
    pairingStore?: RemotePairingPersistence
    hostPlatform?: string
    advertiseRelayUrls?: string[]
    runEventFilter?: (event: RunEvent) => boolean
    hostProjectionGateway?: PairedHostProjectionGatewayPort
  } = {}
) {
  const macId = generateIdentityKeyPair()
  const iphoneId = generateIdentityKeyPair()
  const prompts: RemotePairingPrompt[] = []
  const iphoneMessages: Array<{ method: string; params: unknown }> = []
  const iphoneCodes: string[] = []
  const routed: Array<{ method: string; params: unknown }> = []
  const broadcasterChanges: Array<boolean> = []
  const connectedCounts: number[] = []
  const pairedCounts: number[] = []
  let capturedSink: RunEventSink | null = null
  let clientHandlers: TransportSocketHandlers | null = null
  let iphone: E2eeSession | null = null

  const socketFactory: TransportSocketFactory = (_url, _headers, handlers) => {
    clientHandlers = handlers
    setTimeout(() => handlers.onOpen(), 0)
    return {
      send: (data: string) => void iphone?.handleFrame(JSON.parse(data) as E2eeFrame),
      close: () => undefined
    }
  }

  const envelope = buildRemoteProjectionEnvelope({
    kind: 'taskCard',
    payload: { id: 'chat-1', title: 'Demo task' },
    generatedAt: '2026-06-09T00:00:00.000Z',
    envelopeId: 'remote-task:chat-1:no-run'
  })

  const registrations: Array<{ url: string; body: RegisterRequest }> = []

  const runtime = new RemoteBridgeRuntime({
    relayUrl: 'ws://relay.test',
    macDisplayName: 'Test Mac',
    hostPlatform: opts.hostPlatform,
    advertiseRelayUrls: opts.advertiseRelayUrls,
    identity: macId,
    socketFactory,
    appStore: emptyAppStore,
    projectionSource: { listRemoteProjectionEnvelopes: () => [envelope] },
    hostProjectionGateway: opts.hostProjectionGateway,
    routeAction: vi.fn(async (method: string, params: unknown) => {
      routed.push({ method, params })
      return { accepted: true, reasonCode: 'testStub' }
    }),
    runEventFilter: opts.runEventFilter,
    subscribeRunEvents: (sink) => {
      capturedSink = sink
      return () => {
        capturedSink = null
      }
    },
    onPairingPrompt: (prompt) => prompts.push(prompt),
    onBroadcasterChange: (b) => broadcasterChanges.push(b !== null),
    onConnectedDeviceCountChange: (n) => connectedCounts.push(n),
    onPairedDeviceCountChange: (n) => pairedCounts.push(n),
    pairingWindowMs: opts.pairingWindowMs,
    pairingStore: opts.pairingStore,
    postRegistration: async (url, body) => {
      registrations.push({ url, body })
      return { ok: true, status: 200 }
    }
  })

  /** Scan the QR: build the iPhone session from ONLY the bootstrap payload. */
  const scanAndConnect = (bootstrap: {
    sessionId: string
    macIdentityPubKey: string
  }): void => {
    iphone = new E2eeSession({
      role: 'iphone',
      sessionId: bootstrap.sessionId,
      identityKeyPair: iphoneId,
      peerIdentityPublicKey: importRawEd25519PublicKey(b64.decode(bootstrap.macIdentityPubKey)),
      send: (frame: E2eeFrame) => clientHandlers?.onMessage(JSON.stringify(frame)),
      onAppMessage: (method, params) => iphoneMessages.push({ method, params }),
      onConfirmCode: (code) => iphoneCodes.push(code)
    })
    iphone.start()
  }

  return {
    runtime,
    macId,
    iphoneId,
    scanAndConnect,
    prompts,
    iphoneMessages,
    iphoneCodes,
    routed,
    broadcasterChanges,
    connectedCounts,
    pairedCounts,
    registrations,
    sendFromIphone: (m: string, p?: unknown) => iphone!.sendApp(m, p),
    getSink: () => capturedSink
  }
}

describe('RemoteBridgeRuntime pairing', () => {
  it('returns the locked bootstrap shape with everything the phone needs', () => {
    const h = harness()
    const result = h.runtime.beginPairing('My iPad')
    expect(result.ok).toBe(true)
    const { pairingSessionID, bootstrapPayload } = result.bootstrap
    expect(bootstrapPayload.sessionId).toBe(pairingSessionID)
    expect(bootstrapPayload.v).toBe(1)
    expect(bootstrapPayload.protocol).toBe('taskwraith-e2ee-v1')
    expect(bootstrapPayload.relayUrl).toBe('ws://relay.test')
    expect(bootstrapPayload.macDisplayName).toBe('Test Mac')
    expect(b64.decode(bootstrapPayload.macIdentityPubKey)).toHaveLength(32)
    expect(bootstrapPayload.expiresAt).toBeGreaterThan(Date.now())
  })

  it('defaults relayUrls to the single advertised URL (v1 parity)', () => {
    const h = harness()
    const { bootstrapPayload } = h.runtime.beginPairing('My iPad').bootstrap
    expect(bootstrapPayload.relayUrls).toEqual(['ws://relay.test'])
  })

  it('advertises the per-call candidate list, preferring wss for the v1 relayUrl field', () => {
    const h = harness()
    const { bootstrapPayload } = h.runtime.beginPairing('My iPad', {
      advertiseRelayUrls: [
        'ws://192.168.0.147:8787',
        'ws://100.99.131.73:8787',
        'wss://mac.tailnet.ts.net'
      ]
    }).bootstrap
    // New phones receive LAN + zero-setup direct tailnet + optional WSS…
    expect(bootstrapPayload.relayUrls).toEqual([
      'ws://192.168.0.147:8787',
      'ws://100.99.131.73:8787',
      'wss://mac.tailnet.ts.net'
    ])
    // …old phones read the single field, which keeps the works-anywhere door.
    expect(bootstrapPayload.relayUrl).toBe('wss://mac.tailnet.ts.net')
  })

  it('mints a NEW session when the live candidate set changes (stale-QR guard)', async () => {
    const h = harness()
    const first = h.runtime.beginPairing('My iPad', {
      advertiseRelayUrls: ['ws://192.168.0.147:8787', 'wss://mac.tailnet.ts.net']
    })
    await settle()
    // Same candidates → cached session is reused (copied payloads stay live).
    const same = h.runtime.beginPairing('My iPad', {
      advertiseRelayUrls: ['ws://192.168.0.147:8787', 'wss://mac.tailnet.ts.net']
    })
    expect(same.bootstrap.pairingSessionID).toBe(first.bootstrap.pairingSessionID)
    // Front door died between clicks → the cached bootstrap would re-advertise
    // a known-dead door; a fresh session is minted with the live set instead.
    const degraded = h.runtime.beginPairing('My iPad', {
      advertiseRelayUrls: ['ws://192.168.0.147:8787']
    })
    expect(degraded.bootstrap.pairingSessionID).not.toBe(first.bootstrap.pairingSessionID)
    expect(degraded.bootstrap.bootstrapPayload.relayUrls).toEqual(['ws://192.168.0.147:8787'])
    expect(degraded.bootstrap.bootstrapPayload.relayUrl).toBe('ws://192.168.0.147:8787')
  })

  it('re-issues the LIVE session on repeat beginPairing; force mints a new one', async () => {
    // Remounting the Devices page calls beginPairing again — that must NOT
    // kill the QR/payload the user already copied (the silent-invalidation
    // pairing bug). Only the explicit Refresh button forces a new session.
    const h = harness()
    const first = h.runtime.beginPairing('My iPad')
    await settle()
    const again = h.runtime.beginPairing('My iPad')
    expect(again.bootstrap.pairingSessionID).toBe(first.bootstrap.pairingSessionID)
    expect(again.bootstrap.bootstrapPayload).toEqual(first.bootstrap.bootstrapPayload)

    // A different device label is a different pairing intent → new session.
    const renamed = h.runtime.beginPairing('Other iPad')
    expect(renamed.bootstrap.pairingSessionID).not.toBe(first.bootstrap.pairingSessionID)

    // Force (Refresh QR) always mints fresh.
    const forced = h.runtime.beginPairing('Other iPad', { force: true })
    expect(forced.bootstrap.pairingSessionID).not.toBe(renamed.bootstrap.pairingSessionID)
  })

  it('surfaces the confirm prompt and establishes after user confirm', async () => {
    const h = harness()
    const { bootstrap } = h.runtime.beginPairing('My iPad')
    await settle()
    h.scanAndConnect(bootstrap.bootstrapPayload)
    await settle()

    expect(h.prompts).toHaveLength(1)
    expect(h.prompts[0].sessionID).toBe(bootstrap.pairingSessionID)
    expect(h.prompts[0].controllerDisplayName).toBe('My iPad')
    expect(h.prompts[0].code).toMatch(/^\d{6}$/)
    expect(h.prompts[0].code).toBe(h.iphoneCodes[0])
    expect(h.runtime.isEstablished).toBe(false)

    // Wrong session id → stale prompt rejected.
    expect(h.runtime.finalizePairing('nope', true).ok).toBe(false)

    const finalize = h.runtime.finalizePairing(bootstrap.pairingSessionID, true)
    expect(finalize).toEqual({ ok: true, paired: true })
    await settle()
    expect(h.runtime.isEstablished).toBe(true)
  })

  it('declined pairing tears the session down', async () => {
    const h = harness()
    const { bootstrap } = h.runtime.beginPairing()
    await settle()
    h.scanAndConnect(bootstrap.bootstrapPayload)
    await settle()
    const finalize = h.runtime.finalizePairing(bootstrap.pairingSessionID, false)
    expect(finalize).toEqual({ ok: true, paired: false })
    await settle()
    expect(h.runtime.isEstablished).toBe(false)
    // The session is gone — finalizing again misses.
    expect(h.runtime.finalizePairing(bootstrap.pairingSessionID, true).ok).toBe(false)
  })
})

describe('RemoteBridgeRuntime.describeHost (QR-optional discovery advertisement)', () => {
  it('advertises the public self-description without minting a session', () => {
    const h = harness()
    const info = h.runtime.describeHost()
    expect(info.protocol).toBe('taskwraith-e2ee-v1')
    expect(info.macDisplayName).toBe('Test Mac')
    expect(b64.decode(info.macIdentityPubKey)).toHaveLength(32)
    expect(info.relayUrls).toEqual(['ws://relay.test'])
    // Pure read: no pairing prompt armed, and a later beginPairing still mints
    // a brand-new pending session (describeHost left none behind).
    expect(h.prompts).toHaveLength(0)
    const first = h.runtime.beginPairing()
    const second = h.runtime.beginPairing('iPad', { force: true })
    expect(second.bootstrap.pairingSessionID).not.toBe(first.bootstrap.pairingSessionID)
  })

  it('matches the pairing bootstrap exactly (no drift in pubkey/relay/identity)', () => {
    const h = harness({
      hostPlatform: 'windows',
      advertiseRelayUrls: ['ws://lan:8787', 'wss://x.ts.net']
    })
    const info = h.runtime.describeHost()
    const { bootstrapPayload } = h.runtime.beginPairing('iPad').bootstrap
    expect(info.macIdentityPubKey).toBe(bootstrapPayload.macIdentityPubKey)
    expect(info.relayUrls).toEqual(bootstrapPayload.relayUrls)
    expect(info.protocol).toBe(bootstrapPayload.protocol)
    expect(info.macDisplayName).toBe(bootstrapPayload.macDisplayName)
    // hostPlatform rides along for the phone's per-OS glyph.
    expect(info.hostPlatform).toBe('windows')
    expect(info.relayUrls).toEqual(['ws://lan:8787', 'wss://x.ts.net'])
  })

  it('omits hostPlatform when the host did not set one', () => {
    const h = harness()
    expect(h.runtime.describeHost().hostPlatform).toBeUndefined()
  })
})

describe('RemoteBridgeRuntime.beginPairingOnDemand (unauthenticated /v1/beginpair)', () => {
  it('mints a session in a free slot, labelled distinctly from a console QR', () => {
    const h = harness()
    const result = h.runtime.beginPairingOnDemand()
    expect(result?.ok).toBe(true)
    expect(result?.bootstrap.bootstrapPayload.sessionId).toBeTruthy()
  })

  it('re-issues the SAME session to repeat POSTs (idempotent — no socket churn)', () => {
    const h = harness()
    const first = h.runtime.beginPairingOnDemand()
    const again = h.runtime.beginPairingOnDemand()
    expect(again?.bootstrap.pairingSessionID).toBe(first?.bootstrap.pairingSessionID)
  })

  it('REFUSES (null) rather than evicting a live console QR pairing', () => {
    const h = harness()
    // The user starts a QR pairing at the desktop (a real device label)…
    const qr = h.runtime.beginPairing('My iPad')
    // …an anonymous tailnet POST must not tear it down.
    expect(h.runtime.beginPairingOnDemand()).toBeNull()
    // The console session is untouched.
    const stillThere = h.runtime.beginPairing('My iPad')
    expect(stillThere.bootstrap.pairingSessionID).toBe(qr.bootstrap.pairingSessionID)
  })

  it('lets the console QR path still evict an on-demand session (human outranks POST)', () => {
    const h = harness()
    const onDemand = h.runtime.beginPairingOnDemand()
    // A real console pairing with a different label tears down the on-demand one.
    const qr = h.runtime.beginPairing('My iPad')
    expect(qr.bootstrap.pairingSessionID).not.toBe(onDemand?.bootstrap.pairingSessionID)
  })

  // Field bug (2026-08-15, found pairing a simulator against a dev host whose
  // tailscale-serve front door was refusing): the console QR probes its doors
  // and advertises only the live ones, but this path took no override at all,
  // so `resolveAdvertiseRelayUrls` fell back to the STATIC list and handed the
  // phone a door the Mac had already logged as ECONNREFUSED. Worse, the v1
  // `relayUrl` field prefers wss, so the dead door became the PRIMARY and the
  // phone reported "Couldn't connect to your Mac's Tailscale address".
  it('advertises the live-probed candidate set, never the static fallback', () => {
    const h = harness()
    const result = h.runtime.beginPairingOnDemand(['ws://192.168.0.147:8787'])
    expect(result?.bootstrap.bootstrapPayload.relayUrls).toEqual(['ws://192.168.0.147:8787'])
    expect(result?.bootstrap.bootstrapPayload.relayUrl).toBe('ws://192.168.0.147:8787')
  })

  it('re-issues an in-window session even when a fresh probe is supplied', () => {
    const h = harness()
    const first = h.runtime.beginPairingOnDemand(['ws://192.168.0.147:8787'])
    const again = h.runtime.beginPairingOnDemand(['ws://192.168.0.147:8787'])
    expect(again?.bootstrap.pairingSessionID).toBe(first?.bootstrap.pairingSessionID)
  })
})

describe('RemoteBridgeRuntime established channel', () => {
  async function establish(h: ReturnType<typeof harness>) {
    const { bootstrap } = h.runtime.beginPairing('iPad')
    await settle()
    h.scanAndConnect(bootstrap.bootstrapPayload)
    await settle()
    h.runtime.finalizePairing(bootstrap.pairingSessionID, true)
    await settle()
    expect(h.runtime.isEstablished).toBe(true)
  }

  it('seeds a projection snapshot through the encrypted channel on establish', async () => {
    const h = harness()
    await establish(h)
    expect(h.broadcasterChanges).toEqual([true])
    const snapshot = h.iphoneMessages.find(
      (m) => m.method === 'bridge.broadcastRemoteProjectionSnapshot'
    )
    expect(snapshot).toBeDefined()
    const projections = (snapshot!.params as { projections: unknown[] }).projections
    expect(projections).toHaveLength(1)
    expect(projections[0]).toMatchObject({
      schemaVersion: 1,
      source: 'mac',
      kind: 'taskCard',
      payload: { id: 'chat-1' }
    })
  })

  it('attaches Host v2 to the pinned device identity and forwards its push frames', async () => {
    const host = hostGatewayHarness()
    const h = harness({ hostProjectionGateway: host.gateway })
    await establish(h)

    const deviceKey = b64.encode(exportRawEd25519PublicKey(h.iphoneId.publicKey))
    expect(host.gateway.attach).toHaveBeenCalledOnce()
    expect(host.attachments[0]).toMatchObject({
      deviceKey,
      clientId: pairIdFromIdentityPubKey(deviceKey),
      displayName: 'iPad'
    })

    host.attachments[0]!.send('bridge.hostState', { phase: 'live' })
    await settle()
    expect(h.iphoneMessages.at(-1)).toEqual({
      method: 'bridge.hostState',
      params: { phase: 'live' }
    })
  })

  it('routes exact Host requests without accepting a client-supplied device identity', async () => {
    const host = hostGatewayHarness()
    const h = harness({ hostProjectionGateway: host.gateway })
    await establish(h)
    h.iphoneMessages.length = 0

    h.sendFromIphone('bridge.requestHost', {
      requestId: 'host-req-1',
      deviceKey: 'spoofed-device-key',
      kind: 'health.get',
      params: {}
    })
    await settle()

    const deviceKey = b64.encode(exportRawEd25519PublicKey(h.iphoneId.publicKey))
    expect(host.gateway.request).toHaveBeenCalledWith(deviceKey, {
      kind: 'health.get',
      params: {}
    })
    expect(h.routed).toHaveLength(0)
    expect(h.iphoneMessages).toContainEqual({
      method: 'bridge.ack',
      params: {
        requestId: 'host-req-1',
        method: 'bridge.requestHost',
        ok: true,
        result: { kind: 'health.get', frame: { hostStatus: 'ok' } }
      }
    })
  })

  it('targets Host replay recovery and detaches the gateway on unpair', async () => {
    const host = hostGatewayHarness()
    const h = harness({ hostProjectionGateway: host.gateway })
    await establish(h)
    const deviceKey = b64.encode(exportRawEd25519PublicKey(h.iphoneId.publicKey))

    ;(
      h.runtime as unknown as {
        resyncDeviceOnReplayGap: (key: string) => void
      }
    ).resyncDeviceOnReplayGap(deviceKey)
    await settle()
    expect(host.gateway.resync).toHaveBeenCalledWith(deviceKey)

    h.runtime.unpair(deviceKey)
    expect(host.gateway.detach).toHaveBeenCalledWith(deviceKey)
  })

  it('forwards run events as bridge.runEvent', async () => {
    const h = harness()
    await establish(h)
    const sink = h.getSink()
    expect(sink).not.toBeNull()
    sink!.handle({
      channel: 'agent-output',
      provider: 'claude',
      payload: { kind: 'text', text: 'hello from a run' },
      publishedAt: '2026-06-09T00:00:01.000Z'
    })
    await settle()
    const runEvent = h.iphoneMessages.find((m) => m.method === 'bridge.runEvent')
    expect(runEvent).toBeDefined()
    expect(runEvent!.params).toMatchObject({
      channel: 'agent-output',
      provider: 'claude',
      payload: { text: 'hello from a run' }
    })
  })

  it('wires the optional run-event filter onto the bridge sink', async () => {
    const runEventFilter = vi.fn(() => false)
    const h = harness({ runEventFilter })
    await establish(h)
    const sink = h.getSink()
    expect(sink).not.toBeNull()
    const sampleEvent: RunEvent = {
      channel: 'agent-output',
      provider: 'claude',
      payload: { appChatId: 'chat-1', text: 'hello from a run' },
      publishedAt: '2026-06-09T00:00:01.000Z'
    }
    expect(sink!.filter?.(sampleEvent)).toBe(false)
    expect(runEventFilter).toHaveBeenCalledWith(sampleEvent)
  })

  it('routes inbound actions with pairID bound to the pinned identity', async () => {
    const h = harness()
    await establish(h)
    h.sendFromIphone('bridge.requestActionAck', {
      requestId: 'req-1',
      pairID: 'spoofed-pair-id',
      payloadBase64: Buffer.from('{}').toString('base64'),
      payloadBytes: 2
    })
    await settle()
    expect(h.routed).toHaveLength(1)
    expect(h.routed[0].method).toBe('bridge.requestActionAck')
    const boundParams = h.routed[0].params as { pairID: string; requestId: string }
    // The spoofed pairID was overwritten with the identity-derived one.
    expect(boundParams.pairID).toMatch(/^iphone-[0-9a-f]{16}$/)
    expect(boundParams.requestId).toBe('req-1')

    const ack = h.iphoneMessages.find((m) => m.method === 'bridge.ack')
    expect(ack).toBeDefined()
    expect(ack!.params).toMatchObject({
      requestId: 'req-1',
      method: 'bridge.requestActionAck',
      ok: true,
      result: { accepted: true }
    })
  })

  it('injects the authenticated requestingDeviceKey into routeAction, ignoring any client value', async () => {
    const h = harness()
    await establish(h)
    h.sendFromIphone('bridge.requestActionAck', {
      requestId: 'req-k',
      requestingDeviceKey: 'spoofed-device-key',
      payloadBase64: Buffer.from('{}').toString('base64'),
      payloadBytes: 2
    })
    await settle()
    expect(h.routed).toHaveLength(1)
    const params = h.routed[0].params as { requestingDeviceKey: string }
    // The spoofed value was overwritten with the pinned-identity-derived key.
    expect(params.requestingDeviceKey).not.toBe('spoofed-device-key')
    expect(typeof params.requestingDeviceKey).toBe('string')
    expect(params.requestingDeviceKey.length).toBeGreaterThan(20)
  })

  it('resyncProjectionToDevice re-pushes the snapshot to exactly the requesting device', async () => {
    const h = harness()
    await establish(h)
    // Drive one inbound action so we learn the authenticated device key.
    h.sendFromIphone('bridge.requestActionAck', {
      requestId: 'req-x',
      payloadBase64: Buffer.from('{}').toString('base64'),
      payloadBytes: 2
    })
    await settle()
    const deviceKey = (h.routed[0].params as { requestingDeviceKey: string }).requestingDeviceKey

    h.iphoneMessages.length = 0 // clear the establish-time snapshot
    const result = h.runtime.resyncProjectionToDevice(deviceKey)
    expect(result.ok).toBe(true)
    expect(result.sentEnvelopes).toBeGreaterThan(0)
    const methods = h.iphoneMessages.map((m) => m.method)
    expect(methods).toContain('bridge.broadcastWorkspaceList')
    expect(methods).toContain('bridge.broadcastRemoteProjectionSnapshot')

    // Unknown device → safe no-op, no throw.
    expect(h.runtime.resyncProjectionToDevice('not-a-real-key')).toEqual({
      ok: false,
      reason: 'device not connected'
    })
  })

  it('publishes both live and paired device counts on establish and on unpair (RC6)', async () => {
    const h = harness()
    await establish(h)
    // Establish fires BOTH signals: this device is genuinely connected.
    expect(h.connectedCounts.at(-1)).toBe(1)
    expect(h.pairedCounts.at(-1)).toBe(1)
    // Unpair drops both to 0 (releases the powerSaveBlocker exactly as before).
    h.runtime.unpair()
    await settle()
    expect(h.connectedCounts.at(-1)).toBe(0)
    expect(h.pairedCounts.at(-1)).toBe(0)
  })

  it('rejects unsupported inbound methods without touching the router', async () => {
    const h = harness()
    await establish(h)
    h.sendFromIphone('bridge.formatDisk', { requestId: 'req-evil' })
    await settle()
    expect(h.routed).toHaveLength(0)
    const ack = h.iphoneMessages.find((m) => m.method === 'bridge.ack')
    expect(ack!.params).toMatchObject({ requestId: 'req-evil', ok: false })
  })

  it('router errors come back as ok:false acks instead of crashing', async () => {
    const h = harness()
    await establish(h)
    ;(h.runtime as unknown as { opts: { routeAction: unknown } }).opts.routeAction = async () => {
      throw new Error('decode failed')
    }
    h.sendFromIphone('bridge.requestActionAck', { requestId: 'req-2' })
    await settle()
    const acks = h.iphoneMessages.filter((m) => m.method === 'bridge.ack')
    expect(acks.at(-1)!.params).toMatchObject({
      requestId: 'req-2',
      ok: false,
      error: 'decode failed'
    })
  })
})

describe('RemoteBridgeRuntime trusted reconnect (T5)', () => {
  it('persists the pairing + posts a signed registration on confirm', async () => {
    const memory = memoryPairingStore()
    const h = harness({ pairingStore: memory.store })
    const { bootstrap } = h.runtime.beginPairing('My iPad')
    await settle()
    h.scanAndConnect(bootstrap.bootstrapPayload)
    await settle()
    h.runtime.finalizePairing(bootstrap.pairingSessionID, true)
    await settle()

    const phoneKeyB64 = b64.encode(exportRawEd25519PublicKey(h.iphoneId.publicKey))
    expect(memory.list()).toEqual([
      expect.objectContaining({
        v: 1,
        iphoneIdentityPubKey: phoneKeyB64,
        controllerDisplayName: 'My iPad'
      })
    ])

    expect(h.registrations.length).toBeGreaterThanOrEqual(1)
    const { url, body } = h.registrations[0]
    expect(url).toBe('http://relay.test/v1/resolve/register')
    expect(body).toMatchObject({
      v: 1,
      sessionId: bootstrap.pairingSessionID,
      allowedPeers: [phoneKeyB64],
      macIdentityPubKey: b64.encode(exportRawEd25519PublicKey(h.macId.publicKey))
    })
    expect(verifyRegisterRequest(body)).toBe(true)
  })

  it('startListening resumes the persisted pairing — established with NO prompt', async () => {
    const phoneId = generateIdentityKeyPair()
    const memory = memoryPairingStore()
    const h = harness({ pairingStore: memory.store })
    // Seed as if a previous app run had paired this phone.
    memory.store.upsert({
      v: 1,
      iphoneIdentityPubKey: b64.encode(exportRawEd25519PublicKey(h.iphoneId.publicKey)),
      controllerDisplayName: 'Resumed iPad',
      pairedAt: '2026-06-09T12:00:00.000Z'
    })
    void phoneId

    expect(h.runtime.startListening()).toBe(true)
    // Persisted remote-access intent is published immediately, before the
    // phone reconnects, so the host can hold its no-sleep assertion across a
    // later screen lock.
    expect(h.pairedCounts.at(-1)).toBe(1)
    await settle()
    // The registration reveals the freshly minted sessionId (what the phone
    // gets from the resolve directory).
    expect(h.registrations.length).toBeGreaterThanOrEqual(1)
    const sessionId = h.registrations[0].body.sessionId

    h.scanAndConnect({
      sessionId,
      macIdentityPubKey: b64.encode(exportRawEd25519PublicKey(h.macId.publicKey))
    })
    await settle()

    expect(h.runtime.isEstablished).toBe(true)
    expect(h.prompts).toHaveLength(0) // trusted reconnect — never re-prompt
    expect(
      h.iphoneMessages.some((m) => m.method === 'bridge.broadcastRemoteProjectionSnapshot')
    ).toBe(true)
  })

  it('startListening is a no-op without a persisted pairing', () => {
    const memory = memoryPairingStore()
    const h = harness({ pairingStore: memory.store })
    expect(h.runtime.startListening()).toBe(false)
    expect(h.registrations).toHaveLength(0)
  })

  it('a declined re-pairing falls back to listening for the persisted pairing', async () => {
    const previousPhone = generateIdentityKeyPair()
    const previousKeyB64 = b64.encode(exportRawEd25519PublicKey(previousPhone.publicKey))
    const memory = memoryPairingStore([
      {
        v: 1,
        iphoneIdentityPubKey: previousKeyB64,
        controllerDisplayName: 'Old iPad',
        pairedAt: '2026-06-09T12:00:00.000Z'
      }
    ])
    const h = harness({ pairingStore: memory.store })

    const { bootstrap } = h.runtime.beginPairing('New iPad')
    await settle()
    h.scanAndConnect(bootstrap.bootstrapPayload)
    await settle()
    expect(h.prompts).toHaveLength(1)

    h.runtime.finalizePairing(bootstrap.pairingSessionID, false)
    await settle()

    // The old pairing survives and a fresh registration for it was posted.
    expect(memory.list()[0]?.iphoneIdentityPubKey).toBe(previousKeyB64)
    const fallback = h.registrations.at(-1)
    expect(fallback?.body.allowedPeers).toEqual([previousKeyB64])
    expect(fallback?.body.sessionId).not.toBe(bootstrap.pairingSessionID)
  })

  it('unpair clears persistence and tears the session down', async () => {
    const memory = memoryPairingStore()
    const h = harness({ pairingStore: memory.store })
    const { bootstrap } = h.runtime.beginPairing('My iPad')
    await settle()
    h.scanAndConnect(bootstrap.bootstrapPayload)
    await settle()
    h.runtime.finalizePairing(bootstrap.pairingSessionID, true)
    await settle()
    expect(memory.list()).toHaveLength(1)
    expect(h.broadcasterChanges).toEqual([true])
    expect(h.getSink()).not.toBeNull()

    h.runtime.unpair()
    expect(memory.list()).toEqual([])
    expect(h.runtime.isEstablished).toBe(false)
    expect(h.runtime.hasPersistedPairing).toBe(false)
    expect(h.broadcasterChanges).toEqual([true, false])
    expect(h.getSink()).toBeNull()
  })

  it('listPairedDevices reports persisted metadata and live connection state', async () => {
    const memory = memoryPairingStore()
    const h = harness({ pairingStore: memory.store })
    const { bootstrap } = h.runtime.beginPairing('My iPad')
    await settle()
    h.scanAndConnect(bootstrap.bootstrapPayload)
    await settle()
    h.runtime.finalizePairing(bootstrap.pairingSessionID, true)
    await settle()

    const devices = h.runtime.listPairedDevices()
    expect(devices).toHaveLength(1)
    expect(devices[0]).toMatchObject({
      controllerDisplayName: 'My iPad',
      connected: true
    })
    expect(devices[0].pairId).toMatch(/^iphone-[0-9a-f]{16}$/)
  })
})

describe('relayHttpBase', () => {
  it('maps ws/wss schemes to http/https and strips trailing slashes', () => {
    expect(relayHttpBase('ws://relay.test')).toBe('http://relay.test')
    expect(relayHttpBase('wss://relay.example.com/')).toBe('https://relay.example.com')
  })
})
