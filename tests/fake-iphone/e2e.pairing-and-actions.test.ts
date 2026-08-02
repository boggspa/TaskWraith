/*
 * iOS transport keystone e2e — the SwiftUI acceptance contract.
 *
 * One process, nothing faked at the seams that matter:
 *   real relay (ws server)  ⇄  real RemoteBridgeRuntime via wsTransportSocketFactory
 *                           ⇄  FakeIphoneClient built ONLY from src/shared/e2ee + ws
 * with a REAL BridgeActionRouter (allowlist + audit + executor spy) behind the
 * runtime — the same policy spine production wires.
 *
 * Asserts, in order: (1) pairing — bootstrap shape + identical 6-digit codes on
 * both sides + finalize establishes; (2) snapshot — the locked
 * RemoteProjectionEnvelope wire shape arrives decrypted; (3) actions —
 * allowlisted cancelRun accepted + executor effect + audit entry bound to the
 * identity-derived pairID, non-allowlisted denied with a reasonCode;
 * (4) drop/resume — buffered messages replay exactly once after a hard drop +
 * a fresh snapshot re-seeds; (5) hardening — replayed frames are dropped
 * pre-action and a tampered ciphertext fails the GCM tag without killing the
 * channel.
 */

import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest'
import { createRelayServer, type RelayServerHandle } from '../../relay/src/server'
import {
  RemoteBridgeRuntime,
  type RemotePairingPrompt
} from '../../src/main/remote/RemoteBridgeRuntime'
import { wsTransportSocketFactory } from '../../src/main/remote/wsTransportSocket'
import { BridgeActionRouter } from '../../src/main/BridgeActionRouter'
import { RemoteWorkspaceAllowlist } from '../../src/main/RemoteWorkspaceAllowlist'
import type {
  BridgeActionExecutionResult,
  BridgeActionExecutor
} from '../../src/main/BridgeActionExecutor'
import type {
  RemoteDeviceAuditRecord,
  RemoteDeviceAuditRecordInput
} from '../../src/main/remote/RemoteDeviceAuditLedger'
import { buildRemoteProjectionEnvelope } from '../../src/main/RemoteTaskProjection'
import type { RunEventSink } from '../../src/main/RunEventBus'
import { generateIdentityKeyPair, b64 } from '../../src/shared/e2ee/keys'
import type { EncryptedFrame } from '../../src/shared/e2ee/protocol'
import { FakeIphoneClient } from './FakeIphoneClient'

const settle = (ms = 25): Promise<void> => new Promise((r) => setTimeout(r, ms))

async function until(check: () => boolean, timeoutMs = 5_000, label = 'condition'): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`)
    await settle(10)
  }
}

const EXECUTOR_METHODS = [
  'executeApprovalReply',
  'executeQuestionReply',
  'executeQuestionReject',
  'executeComposerPrompt',
  'executeCancelRun',
  'executeEnsembleCancelRound',
  'executeEnsembleSkipActiveParticipant',
  'executeEnsembleWakeNow',
  'executeEnsembleCancelWakeup',
  'executeEnsembleQueuePrompt',
  'executeEnsembleSteer',
  'executeRegisterApnsToken',
  'executeSetYoloMode',
  'executeTogglePinChat',
  'executeTogglePinWorkspace'
] as const

function makeSpyExecutor(): {
  executor: BridgeActionExecutor
  calls: Array<{ method: string; payload: unknown }>
} {
  const calls: Array<{ method: string; payload: unknown }> = []
  const executor = {} as Record<string, (payload: unknown) => Promise<BridgeActionExecutionResult>>
  for (const method of EXECUTOR_METHODS) {
    executor[method] = async (payload: unknown) => {
      calls.push({ method, payload })
      return { executed: true, message: `${method} ok` }
    }
  }
  return { executor: executor as unknown as BridgeActionExecutor, calls }
}

function encodeAction(payload: Record<string, unknown>): {
  payloadBase64: string
  payloadBytes: number
} {
  // Mirrors the Swift encode() helper: mutating actions REQUIRE
  // actionId + expiresAt (router enforcement); explicit values win.
  const stamped = {
    issuedAt: Date.now(),
    expiresAt: Date.now() + 60_000,
    ...payload
  }
  const wire = Buffer.from(JSON.stringify(stamped), 'utf8')
  return { payloadBase64: wire.toString('base64'), payloadBytes: wire.length }
}

interface MacSide {
  runtime: RemoteBridgeRuntime
  prompts: RemotePairingPrompt[]
  executorCalls: Array<{ method: string; payload: unknown }>
  auditRecords: RemoteDeviceAuditRecord[]
  emitRunEvent: (payload: unknown) => void
}

let relay: RelayServerHandle
let relayUrl = ''
const cleanups: Array<() => void> = []

function makeMacSide(): MacSide {
  const prompts: RemotePairingPrompt[] = []
  const auditRecords: RemoteDeviceAuditRecord[] = []
  const { executor, calls } = makeSpyExecutor()

  const allowlist = new RemoteWorkspaceAllowlist({})
  allowlist.upsert({
    workspaceId: 'ws-allowed',
    path: '/tmp/e2e-ws-allowed',
    mode: 'read-write'
  })

  const router = new BridgeActionRouter({
    allowlist,
    executor,
    auditLedger: {
      append: async (input: RemoteDeviceAuditRecordInput) => {
        const record: RemoteDeviceAuditRecord = {
          id: input.id || `audit-${auditRecords.length + 1}`,
          deviceId: input.deviceId,
          capability: input.capability,
          action: input.action,
          ...(input.chatId ? { chatId: input.chatId } : {}),
          decision: input.decision,
          reason: input.reason,
          timestamp: input.timestamp || new Date().toISOString()
        }
        auditRecords.push(record)
        return record
      }
    },
    log: () => {}
  })

  let runEventSink: RunEventSink | null = null
  const envelope = buildRemoteProjectionEnvelope({
    kind: 'taskCard',
    payload: { id: 'chat-1', title: 'E2E demo task' },
    generatedAt: '2026-06-09T00:00:00.000Z',
    envelopeId: 'remote-task:chat-1:no-run'
  })

  const runtime = new RemoteBridgeRuntime({
    relayUrl,
    macDisplayName: 'E2E Mac',
    identity: generateIdentityKeyPair(),
    socketFactory: wsTransportSocketFactory,
    appStore: { getWorkspaces: () => [], getChats: () => [], getChat: () => null },
    projectionSource: { listRemoteProjectionEnvelopes: () => [envelope] },
    routeAction: (method, params) => router.route(method, params),
    subscribeRunEvents: (sink) => {
      runEventSink = sink
      return () => {
        runEventSink = null
      }
    },
    onPairingPrompt: (prompt) => prompts.push(prompt)
  })
  cleanups.push(() => runtime.dispose())

  return {
    runtime,
    prompts,
    executorCalls: calls,
    auditRecords,
    emitRunEvent: (payload) => {
      if (!runEventSink) throw new Error('run-event sink not subscribed yet')
      runEventSink.handle({
        channel: 'agent-output',
        provider: 'claude',
        payload,
        publishedAt: new Date().toISOString()
      })
    }
  }
}

async function pairAndEstablish(mac: MacSide): Promise<FakeIphoneClient> {
  const begin = mac.runtime.beginPairing('E2E iPad')
  const phone = new FakeIphoneClient()
  cleanups.push(() => phone.close())
  phone.scan(begin.bootstrap.bootstrapPayload)
  await phone.connect()
  await until(() => mac.prompts.length > 0, 5_000, 'pairing prompt on the Mac')
  expect(mac.prompts[0].code).toBe(phone.confirmCode)
  const finalize = mac.runtime.finalizePairing(begin.bootstrap.pairingSessionID, true)
  expect(finalize).toEqual({ ok: true, paired: true })
  await phone.waitForEstablished()
  await until(() => mac.runtime.isEstablished, 5_000, 'mac establishment')
  return phone
}

beforeAll(async () => {
  relay = await createRelayServer({ port: 0 })
  relayUrl = `ws://127.0.0.1:${relay.port}`
})

afterAll(async () => {
  await relay.close()
})

afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup()
})

describe('e2e: pairing', () => {
  it('pairs through the real relay — bootstrap shape, matching codes, finalize establishes', async () => {
    const mac = makeMacSide()
    const begin = mac.runtime.beginPairing('E2E iPad')
    const payload = begin.bootstrap.bootstrapPayload
    expect(payload).toMatchObject({
      v: 1,
      protocol: 'taskwraith-e2ee-v1',
      relayUrl,
      sessionId: begin.bootstrap.pairingSessionID,
      macDisplayName: 'E2E Mac'
    })
    expect(b64.decode(payload.macIdentityPubKey)).toHaveLength(32)
    expect(payload.expiresAt).toBeGreaterThan(Date.now())

    const phone = new FakeIphoneClient()
    cleanups.push(() => phone.close())
    phone.scan(payload)
    await phone.connect()

    // Both screens show the same transcript-derived 6-digit code.
    await until(() => mac.prompts.length > 0, 5_000, 'pairing prompt')
    expect(mac.prompts[0]).toMatchObject({
      sessionID: begin.bootstrap.pairingSessionID,
      controllerDisplayName: 'E2E iPad'
    })
    expect(mac.prompts[0].code).toMatch(/^\d{6}$/)
    expect(mac.prompts[0].code).toBe(phone.confirmCode)
    expect(phone.isEstablished).toBe(false)

    mac.runtime.finalizePairing(begin.bootstrap.pairingSessionID, true)
    await phone.waitForEstablished()
    expect(mac.runtime.isEstablished).toBe(true)
  }, 15_000)
})

describe('e2e: projection snapshot', () => {
  it('delivers the locked RemoteProjectionEnvelope shape through the encrypted channel', async () => {
    const mac = makeMacSide()
    const phone = await pairAndEstablish(mac)
    const snapshot = await phone.waitForMessage(
      (m) => m.method === 'bridge.broadcastRemoteProjectionSnapshot',
      5_000,
      'projection snapshot'
    )
    const { projections } = snapshot.params as { projections: unknown[] }
    expect(projections).toHaveLength(1)
    expect(projections[0]).toMatchObject({
      schemaVersion: 1,
      source: 'mac',
      kind: 'taskCard',
      payload: { id: 'chat-1', title: 'E2E demo task' }
    })
  }, 15_000)
})

describe('e2e: action round-trip', () => {
  it('allowlisted cancelRun is accepted, executed, and audited under the bound pairID', async () => {
    const mac = makeMacSide()
    const phone = await pairAndEstablish(mac)

    const ack = await phone.request('bridge.requestActionAck', {
      // Spoofed pairID MUST be ignored — the runtime binds the audited
      // identity to the pinned key from the handshake.
      pairID: 'spoofed-by-client',
      ...encodeAction({
        kind: 'cancelRun',
        actionId: 'act-1',
        workspaceId: 'ws-allowed',
        threadId: 'thread-1',
        provider: 'claude',
        runId: 'run-1'
      })
    })
    expect(ack.ok).toBe(true)
    expect(ack.result).toMatchObject({ accepted: true })

    expect(mac.executorCalls).toHaveLength(1)
    expect(mac.executorCalls[0].method).toBe('executeCancelRun')
    expect(mac.executorCalls[0].payload).toMatchObject({ runId: 'run-1', provider: 'claude' })

    expect(mac.auditRecords).toHaveLength(1)
    expect(mac.auditRecords[0]).toMatchObject({
      capability: 'cancel',
      action: 'cancelRun',
      decision: 'allowed'
    })
    expect(mac.auditRecords[0].deviceId).toMatch(/^iphone-[0-9a-f]{16}$/)
    expect(mac.auditRecords[0].deviceId).not.toBe('spoofed-by-client')
  }, 15_000)

  it('non-allowlisted workspace is denied with a reasonCode and no executor effect', async () => {
    const mac = makeMacSide()
    const phone = await pairAndEstablish(mac)

    const ack = await phone.request('bridge.requestActionAck', {
      ...encodeAction({
        kind: 'cancelRun',
        actionId: 'act-2',
        workspaceId: 'ws-not-listed',
        threadId: 'thread-1',
        provider: 'claude',
        runId: 'run-2'
      })
    })
    expect(ack.ok).toBe(true) // routed fine — the POLICY denied it
    const result = ack.result as { accepted: boolean; reasonCode?: string }
    expect(result.accepted).toBe(false)
    expect(result.reasonCode).toBeTruthy()
    expect(mac.executorCalls).toHaveLength(0)
    expect(
      mac.auditRecords.filter((record) => record.decision === 'denied')
    ).toHaveLength(1)
  }, 15_000)
})

describe('e2e: drop + resume', () => {
  it('replays exactly the missed messages after a hard drop and re-seeds a snapshot', async () => {
    const mac = makeMacSide()
    const phone = await pairAndEstablish(mac)

    mac.emitRunEvent({ marker: 1 })
    mac.emitRunEvent({ marker: 2 })
    mac.emitRunEvent({ marker: 3 })
    await until(
      () => phone.messages.filter((m) => m.method === 'bridge.runEvent').length === 3,
      5_000,
      'first three run events'
    )

    // Hard drop (no close handshake) — the relay keeps the Mac's socket.
    phone.dropConnection()
    await settle(50)

    // Mac keeps emitting into the void; the session buffers for replay.
    mac.emitRunEvent({ marker: 4 })
    mac.emitRunEvent({ marker: 5 })

    await phone.reconnect()
    await phone.waitForEstablished()
    await until(
      () => phone.messages.filter((m) => m.method === 'bridge.runEvent').length === 5,
      5_000,
      'replayed run events'
    )

    const markers = phone.messages
      .filter((m) => m.method === 'bridge.runEvent')
      .map((m) => (m.params as { payload: { marker: number } }).payload.marker)
    // Exactly once each, in order — no duplicates of 1-3, no gap before 4-5.
    expect(markers).toEqual([1, 2, 3, 4, 5])

    // Each establish re-seeded a snapshot (idempotent by envelopeId).
    const snapshots = phone.messages.filter(
      (m) => m.method === 'bridge.broadcastRemoteProjectionSnapshot'
    )
    expect(snapshots.length).toBeGreaterThanOrEqual(2)
  }, 20_000)
})

describe('e2e: hardening', () => {
  it('drops a replayed encrypted frame before it reaches the router', async () => {
    const mac = makeMacSide()
    const phone = await pairAndEstablish(mac)

    const ack = await phone.request('bridge.requestActionAck', {
      ...encodeAction({
        kind: 'cancelRun',
        actionId: 'act-replay',
        workspaceId: 'ws-allowed',
        threadId: 'thread-1',
        provider: 'claude',
        runId: 'run-replay'
      })
    })
    expect(ack.ok).toBe(true)
    expect(mac.executorCalls).toHaveLength(1)

    // Replay the exact frame that carried the action.
    const actionFrame = phone.sentEncFrames.at(-1)!
    phone.sendRawFrame(actionFrame)
    await settle(100)
    expect(mac.executorCalls).toHaveLength(1) // still exactly once

    // The router's actionId guard is defense-in-depth BEHIND the transport
    // guard — the audit trail shows one decision, not two.
    expect(mac.auditRecords).toHaveLength(1)
  }, 15_000)

  it('rejects a tampered ciphertext (GCM tag) without killing the channel', async () => {
    const mac = makeMacSide()
    const phone = await pairAndEstablish(mac)

    await phone.request('bridge.requestActionAck', {
      ...encodeAction({
        kind: 'cancelRun',
        actionId: 'act-t1',
        workspaceId: 'ws-allowed',
        threadId: 'thread-1',
        provider: 'claude',
        runId: 'run-t1'
      })
    })
    expect(mac.executorCalls).toHaveLength(1)

    // Forge: fresh seq (passes the monotonic guard) + flipped ciphertext byte.
    const last = phone.sentEncFrames.at(-1)!
    const ct = b64.decode(last.ct)
    ct[0] ^= 0xff
    const forged: EncryptedFrame = { ...last, seq: last.seq + 1, ct: b64.encode(ct) }
    phone.sendRawFrame(forged)
    await settle(100)
    expect(mac.executorCalls).toHaveLength(1) // tag failure → never decrypted

    // The channel survives: the next legitimate action still round-trips
    // (its seq equals the forged one — the failed frame never advanced the
    // receive counter).
    const ack = await phone.request('bridge.requestActionAck', {
      ...encodeAction({
        kind: 'cancelRun',
        actionId: 'act-t2',
        workspaceId: 'ws-allowed',
        threadId: 'thread-1',
        provider: 'claude',
        runId: 'run-t2'
      })
    })
    expect(ack.ok).toBe(true)
    expect(mac.executorCalls).toHaveLength(2)
  }, 15_000)
})
