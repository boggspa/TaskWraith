import { EventEmitter } from 'node:events'

import { describe, expect, it, vi } from 'vitest'

import type {
  HostBootstrapWelcome,
  HostCommand,
  HostCommandReceipt,
  HostDeltasFrame,
  HostHealthFrame,
  HostSnapshotFrame
} from '../../shared/hostProtocol'
import { createEmptyHostSnapshot } from '../../shared/hostProtocol'
import type {
  HostProjectionClient,
  HostProjectionClientOptions
} from '../host/HostProjectionClient'
import {
  PAIRED_HOST_PROJECTION_METHODS,
  PairedHostProjectionGateway,
  PairedHostProjectionRequestError,
  type PairedHostProjectionRetryHandle
} from './PairedHostProjectionGateway'

const DEVICE_KEY = Buffer.alloc(32, 7).toString('base64')
const CLIENT_ID = 'iphone-0123456789abcdef'

function welcome(cursor = 4): HostBootstrapWelcome {
  return {
    type: 'host.welcome',
    protocolVersion: 2,
    controlProtocolCompat: 1,
    projectionVersion: 2,
    hostId: '11111111-1111-4111-8111-111111111111',
    hostVersion: '1.9.4',
    sessionId: '22222222-2222-4222-8222-222222222222',
    generation: 3,
    cursor,
    authenticatedClient: {
      clientId: CLIENT_ID,
      clientClass: 'ios',
      clientVersion: '1.9.4',
      subjectId: DEVICE_KEY
    },
    capabilities: [
      'bootstrap',
      'snapshot',
      'deltas',
      'model-offers',
      'commands',
      'receipts',
      'health'
    ],
    freshness: 'live'
  }
}

function snapshotFrame(cursor = 4): HostSnapshotFrame {
  return {
    type: 'host.snapshot',
    protocolVersion: 2,
    snapshot: createEmptyHostSnapshot({
      generation: 3,
      cursor,
      generatedAt: '2026-08-09T20:00:00.000Z'
    })
  }
}

function receipt(commandId = 'command-1'): HostCommandReceipt {
  return {
    type: 'host.receipt',
    protocolVersion: 2,
    commandId,
    idempotencyKey: 'idem-1',
    name: 'ping',
    actor: { actorId: CLIENT_ID, clientId: CLIENT_ID, clientClass: 'ios' },
    authority: { decision: 'allow' },
    status: 'succeeded',
    commandFingerprint: 'a'.repeat(64),
    generation: 3,
    cursor: 5,
    createdAt: '2026-08-09T20:00:00.000Z',
    updatedAt: '2026-08-09T20:00:01.000Z'
  }
}

class FakeHostClient extends EventEmitter {
  connected = false
  welcome: HostBootstrapWelcome | null = null
  readonly connect = vi.fn(async () => {
    this.connected = true
    this.welcome = welcome()
    return this.welcome
  })
  readonly close = vi.fn(() => {
    this.connected = false
    this.welcome = null
  })
  readonly getSnapshot = vi.fn(async () => snapshotFrame())
  readonly getDeltasSince = vi.fn(async (position: { generation: number; cursor: number }) => ({
    type: 'host.deltas',
    protocolVersion: 2,
    result: {
      kind: 'deltas',
      generation: position.generation,
      fromCursor: position.cursor,
      toCursor: position.cursor,
      deltas: []
    }
  }))
  readonly lookupReceipt = vi.fn(async () => receipt())
  readonly getThreadOffers = vi.fn(async (threadId: string) => ({
    threadId,
    provider: {
      runtimeProvider: 'mistral',
      displayProvider: 'Mistral',
      hueKey: 'mistral',
      accent: '#D44404',
      shortCode: 'MST'
    },
    models: [],
    source: 'curated' as const
  }))
  readonly getHealth = vi.fn(async () => ({
    type: 'host.health',
    protocolVersion: 2,
    health: {
      hostStatus: 'ok',
      connectionPhase: 'live',
      supervised: true,
      freshness: 'live'
    }
  }))
  readonly submitCommand = vi.fn(async (command: HostCommand) => receipt(command.commandId))
  readonly exportTwMission = vi.fn(async () => ({
    bundle: { manifest: { schemaVersion: 1 }, snapshot: {} },
    bytes: new Uint8Array([1, 2, 3])
  }))

  disconnect(): void {
    this.connected = false
    this.welcome = null
    this.emit('disconnected', null)
  }
}

function harness() {
  const fake = new FakeHostClient()
  const sent: Array<{ method: string; params: unknown }> = []
  const retries: Array<{ callback: () => void; delayMs: number; cancelled: boolean }> = []
  const createClient = vi.fn(
    (_options: HostProjectionClientOptions) => fake as unknown as HostProjectionClient
  )
  const gateway = new PairedHostProjectionGateway({
    userDataPath: '/tmp/taskwraith-paired-host-test',
    clientVersion: '1.9.4',
    createClient,
    scheduleRetry: (callback, delayMs): PairedHostProjectionRetryHandle => {
      const entry = { callback, delayMs, cancelled: false }
      retries.push(entry)
      return { cancel: () => (entry.cancelled = true) }
    }
  })
  const attach = () =>
    gateway.attach({
      deviceKey: DEVICE_KEY,
      clientId: CLIENT_ID,
      displayName: 'My iPhone',
      send: (method, params) => sent.push({ method, params })
    })
  return { gateway, fake, sent, retries, createClient, attach }
}

describe('PairedHostProjectionGateway', () => {
  it('binds the pinned phone as an iOS Host client and seeds welcome + snapshot', async () => {
    const h = harness()
    await h.attach()

    expect(h.gateway.attachedCount).toBe(1)
    expect(h.fake.connect).toHaveBeenCalledOnce()
    expect(h.fake.getSnapshot).toHaveBeenCalledOnce()
    expect(h.sent.map((entry) => entry.method)).toEqual([
      PAIRED_HOST_PROJECTION_METHODS.state,
      PAIRED_HOST_PROJECTION_METHODS.welcome,
      PAIRED_HOST_PROJECTION_METHODS.snapshot,
      PAIRED_HOST_PROJECTION_METHODS.state
    ])
    expect(h.sent[0]?.params).toEqual({ phase: 'connecting' })
    expect(h.sent.at(-1)?.params).toEqual({ phase: 'live', generation: 3, cursor: 4 })
  })

  it('forwards Host delta and health events only through the attached device callback', async () => {
    const h = harness()
    await h.attach()
    h.sent.length = 0
    const deltas: HostDeltasFrame = {
      type: 'host.deltas',
      protocolVersion: 2,
      result: { kind: 'deltas', generation: 3, fromCursor: 4, toCursor: 4, deltas: [] }
    }
    const health: HostHealthFrame = {
      type: 'host.health',
      protocolVersion: 2,
      health: {
        hostStatus: 'ok',
        connectionPhase: 'live',
        supervised: true,
        freshness: 'live'
      }
    }

    h.fake.emit('deltas', deltas, 1)
    h.fake.emit('health', health, 2)
    expect(h.sent).toEqual([
      { method: PAIRED_HOST_PROJECTION_METHODS.deltas, params: deltas },
      { method: PAIRED_HOST_PROJECTION_METHODS.health, params: health }
    ])

    h.gateway.detach(DEVICE_KEY)
    h.fake.emit('deltas', deltas, 3)
    expect(h.sent).toHaveLength(2)
    expect(h.fake.close).toHaveBeenCalledOnce()
  })

  it('validates read requests through the Host transport codec', async () => {
    const h = harness()
    await h.attach()

    const snapshot = await h.gateway.request(DEVICE_KEY, { kind: 'snapshot.get', params: {} })
    expect(snapshot).toEqual({ kind: 'snapshot.get', frame: snapshotFrame() })
    const deltas = await h.gateway.request(DEVICE_KEY, {
      kind: 'deltas.since',
      params: { generation: 3, cursor: 4 }
    })
    expect(deltas).toMatchObject({ kind: 'deltas.since' })
    expect(h.fake.getDeltasSince).toHaveBeenCalledWith({ generation: 3, cursor: 4 })
    const offers = await h.gateway.request(DEVICE_KEY, {
      kind: 'thread.offers',
      params: { threadId: 'thread-1' }
    })
    expect(offers).toMatchObject({ kind: 'thread.offers', offers: { threadId: 'thread-1' } })
    expect(h.fake.getThreadOffers).toHaveBeenCalledWith('thread-1')
    await expect(
      h.gateway.request(DEVICE_KEY, {
        kind: 'deltas.since',
        params: { generation: 3, cursor: -1 }
      })
    ).rejects.toMatchObject({ code: 'invalid_payload' })
    await expect(
      h.gateway.request(DEVICE_KEY, { kind: 'format.disk', params: {} })
    ).rejects.toMatchObject({ code: 'unknown_request_kind' })
    for (const request of [
      { kind: 'provider.status', params: {} },
      { kind: 'provider.offers', params: { providerId: 'codex' } },
      { kind: 'provider.auth.flows', params: { providerId: 'codex' } },
      { kind: 'provider.auth.status', params: { providerId: 'codex' } },
      { kind: 'thread.history', params: { threadId: 'thread-1', limit: 25 } },
      {
        kind: 'history.since',
        params: { threadId: 'thread-1', since: { generation: 3, cursor: 4 } }
      },
      { kind: 'host.shutdown', params: {} }
    ]) {
      await expect(h.gateway.request(DEVICE_KEY, request)).rejects.toMatchObject({
        code: 'unauthorized'
      })
    }
  })

  it('explicitly refuses workspace Git reads when the paired client did not negotiate them', async () => {
    const h = harness()
    await h.attach()

    expect(h.createClient.mock.calls[0]?.[0].capabilities).not.toContain('workspace-git')
    await expect(
      h.gateway.request(DEVICE_KEY, {
        kind: 'workspace.git.read',
        params: { workspaceId: 'workspace-1', scope: 'diff', path: 'src/main/index.ts' }
      })
    ).rejects.toMatchObject({ code: 'unauthorized' })
  })

  it('submits only commands whose actor exactly matches the authenticated pair', async () => {
    const h = harness()
    await h.attach()
    const command: HostCommand = {
      type: 'host.command',
      protocolVersion: 2,
      commandId: 'command-1',
      idempotencyKey: 'idem-1',
      actor: { actorId: CLIENT_ID, clientId: CLIENT_ID, clientClass: 'ios' },
      name: 'ping',
      target: { kind: 'host', id: 'host' },
      arguments: {},
      issuedAt: '2026-08-09T20:00:00.000Z'
    }

    const accepted = await h.gateway.request(DEVICE_KEY, {
      kind: 'command.submit',
      params: command
    })
    expect(accepted).toMatchObject({ kind: 'command.submit', receipt: { commandId: 'command-1' } })
    expect(h.fake.submitCommand).toHaveBeenCalledOnce()

    await expect(
      h.gateway.request(DEVICE_KEY, {
        kind: 'command.submit',
        params: {
          ...command,
          actor: { actorId: 'spoof', clientId: 'spoof', clientClass: 'desktop' }
        }
      })
    ).rejects.toBeInstanceOf(PairedHostProjectionRequestError)
    expect(h.fake.submitCommand).toHaveBeenCalledOnce()
  })

  it('marks cache state reconnecting and schedules bounded recovery on Host loss', async () => {
    const h = harness()
    await h.attach()
    h.sent.length = 0

    h.fake.disconnect()
    expect(h.sent).toEqual([
      { method: PAIRED_HOST_PROJECTION_METHODS.state, params: { phase: 'reconnecting' } }
    ])
    expect(h.retries).toHaveLength(1)
    expect(h.retries[0]?.delayMs).toBe(500)

    h.retries[0]!.callback()
    await vi.waitFor(() => expect(h.fake.connect).toHaveBeenCalledTimes(2))
    await vi.waitFor(() =>
      expect(h.sent.some((entry) => entry.method === PAIRED_HOST_PROJECTION_METHODS.snapshot)).toBe(
        true
      )
    )
  })

  it('rejects unattached callers and cancels pending retry on detach', async () => {
    const h = harness()
    await expect(
      h.gateway.request(DEVICE_KEY, { kind: 'health.get', params: {} })
    ).rejects.toMatchObject({ code: 'unauthorized' })
    await h.attach()
    h.fake.disconnect()
    expect(h.retries).toHaveLength(1)
    h.gateway.detach(DEVICE_KEY)
    expect(h.retries[0]?.cancelled).toBe(true)
  })
})
