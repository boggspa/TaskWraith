import { describe, expect, it } from 'vitest'
import {
  HOST_CONTROL_PROTOCOL_COMPAT_VERSION,
  HOST_PROTOCOL_VERSION,
  HOST_PROJECTION_VERSION,
  applyHostDeltaCursor,
  assertHostSnapshotFamilies,
  createEmptyHostSnapshot,
  decodeHostBootstrapHello,
  decodeHostBootstrapWelcome,
  decodeHostCommand,
  decodeHostCommandReceipt,
  decodeHostDeltaEnvelope,
  evaluateHostIdempotencyFingerprints,
  hostCommandFingerprint,
  type HostCommand,
  type HostDeltaEnvelope
} from './hostProtocol'

const client = {
  clientId: 'client-desktop-1',
  clientClass: 'desktop' as const,
  clientVersion: '1.9.2'
}

const actor = {
  actorId: 'user-1',
  clientId: client.clientId,
  clientClass: client.clientClass
}

function sampleCommand(overrides: Partial<HostCommand> = {}): HostCommand {
  return {
    type: 'host.command',
    protocolVersion: HOST_PROTOCOL_VERSION,
    commandId: 'cmd-1',
    idempotencyKey: 'idem-1',
    actor,
    name: 'composer.send',
    target: { threadId: 'thread-1' },
    arguments: { text: 'hello host' },
    issuedAt: '2026-08-03T17:00:00.000Z',
    ...overrides
  }
}

function sampleDelta(overrides: Partial<HostDeltaEnvelope> = {}): HostDeltaEnvelope {
  return {
    protocolVersion: HOST_PROTOCOL_VERSION,
    projectionVersion: HOST_PROJECTION_VERSION,
    generation: 3,
    cursor: 11,
    previousCursor: 10,
    kind: 'upsert',
    family: 'thread',
    entityId: 'thread-1',
    payload: { title: 'Mission' },
    at: '2026-08-03T17:00:00.000Z',
    ...overrides
  }
}

describe('Host protocol Wave 2A contract', () => {
  it('round-trips bootstrap hello/welcome with v1 control compat', () => {
    const hello = decodeHostBootstrapHello({
      type: 'host.hello',
      protocolVersion: HOST_PROTOCOL_VERSION,
      controlProtocolCompat: HOST_CONTROL_PROTOCOL_COMPAT_VERSION,
      projectionVersion: HOST_PROJECTION_VERSION,
      client,
      capabilities: ['bootstrap', 'snapshot', 'deltas', 'commands', 'receipts']
    })
    expect(hello).toEqual({
      ok: true,
      value: {
        type: 'host.hello',
        protocolVersion: 2,
        controlProtocolCompat: 1,
        projectionVersion: 1,
        client,
        capabilities: ['bootstrap', 'snapshot', 'deltas', 'commands', 'receipts']
      }
    })

    const welcome = decodeHostBootstrapWelcome({
      type: 'host.welcome',
      protocolVersion: HOST_PROTOCOL_VERSION,
      controlProtocolCompat: HOST_CONTROL_PROTOCOL_COMPAT_VERSION,
      projectionVersion: HOST_PROJECTION_VERSION,
      hostId: 'host-local-1',
      hostVersion: '1.9.2',
      sessionId: 'sess-1',
      generation: 3,
      cursor: 10,
      authenticatedClient: client,
      capabilities: ['bootstrap', 'snapshot', 'deltas', 'commands', 'receipts'],
      freshness: 'live'
    })
    expect(welcome.ok).toBe(true)
    if (welcome.ok) {
      expect(welcome.value.generation).toBe(3)
      expect(welcome.value.cursor).toBe(10)
      expect(welcome.value.controlProtocolCompat).toBe(1)
      expect(welcome.value.freshness).toBe('live')
    }
  })

  it('rejects adversarial bootstrap and capability values', () => {
    expect(
      decodeHostBootstrapHello({
        type: 'host.hello',
        protocolVersion: 1,
        projectionVersion: HOST_PROJECTION_VERSION,
        client,
        capabilities: ['snapshot']
      })
    ).toMatchObject({ ok: false, error: 'unsupported protocol version' })

    expect(
      decodeHostBootstrapHello({
        type: 'host.hello',
        protocolVersion: HOST_PROTOCOL_VERSION,
        projectionVersion: HOST_PROJECTION_VERSION,
        client,
        capabilities: ['launch-providers']
      })
    ).toMatchObject({ ok: false, error: 'unknown capability: launch-providers' })

    expect(
      decodeHostBootstrapWelcome({
        type: 'host.welcome',
        protocolVersion: HOST_PROTOCOL_VERSION,
        controlProtocolCompat: 99,
        projectionVersion: HOST_PROJECTION_VERSION,
        hostId: 'host',
        hostVersion: '1',
        sessionId: 's',
        generation: 0,
        cursor: 0,
        authenticatedClient: client,
        capabilities: [],
        freshness: 'live'
      })
    ).toMatchObject({ ok: false, error: 'control protocol compat required' })
  })

  it('keeps provider / round / mission / connection outcomes distinct in snapshots', () => {
    const snapshot = createEmptyHostSnapshot({ generation: 1, cursor: 0 })
    snapshot.runs.push({
      runId: 'run-1',
      threadId: 'thread-1',
      providerId: 'codex',
      providerOutcome: 'completed'
    })
    snapshot.rounds.push({
      roundId: 'round-1',
      threadId: 'thread-1',
      status: 'cancelled',
      participantIds: ['p1'],
      providerRunIds: ['run-1']
    })
    snapshot.missions.push({
      missionId: 'mission-1',
      threadId: 'thread-1',
      title: 'Host Arc',
      status: 'active',
      updatedAt: 1
    })
    snapshot.health.connectionPhase = 'reconnecting'
    snapshot.health.freshness = 'cached'
    snapshot.freshness = 'cached'

    expect(assertHostSnapshotFamilies(snapshot)).toEqual({ ok: true, value: true })
    expect(snapshot.runs[0]?.providerOutcome).toBe('completed')
    expect(snapshot.rounds[0]?.status).toBe('cancelled')
    expect(snapshot.missions[0]?.status).toBe('active')
    expect(snapshot.health.connectionPhase).toBe('reconnecting')
    expect(snapshot.freshness).toBe('cached')
  })

  it('represents unavailable usage explicitly and rejects fake zero', () => {
    const snapshot = createEmptyHostSnapshot({ generation: 1, cursor: 0 })
    expect(snapshot.usage.availability).toBe('unavailable')
    expect(snapshot.usage.tokens).toBeUndefined()
    expect(assertHostSnapshotFamilies(snapshot).ok).toBe(true)

    snapshot.usage = { availability: 'unavailable', tokens: 0 }
    expect(assertHostSnapshotFamilies(snapshot)).toMatchObject({
      ok: false,
      error: 'unavailable usage must not publish tokens:0'
    })
  })

  it('applies deltas with generation/previousCursor resnapshot rules', () => {
    const current = { generation: 3, cursor: 10 }

    expect(applyHostDeltaCursor(current, sampleDelta())).toEqual({
      outcome: 'applied',
      generation: 3,
      cursor: 11
    })
    expect(applyHostDeltaCursor(current, sampleDelta({ cursor: 10, previousCursor: 9 }))).toEqual({
      outcome: 'duplicate',
      generation: 3,
      cursor: 10
    })
    expect(applyHostDeltaCursor(current, sampleDelta({ cursor: 9, previousCursor: 8 }))).toEqual({
      outcome: 'late',
      generation: 3,
      cursor: 10
    })
    expect(
      applyHostDeltaCursor(current, sampleDelta({ previousCursor: 8, cursor: 11 }))
    ).toMatchObject({
      outcome: 'require_resnapshot',
      reason: 'previous_cursor_mismatch'
    })
    expect(
      applyHostDeltaCursor(current, sampleDelta({ generation: 4, previousCursor: 0, cursor: 1 }))
    ).toMatchObject({
      outcome: 'require_resnapshot',
      reason: 'generation_mismatch'
    })
    expect(
      applyHostDeltaCursor(
        current,
        sampleDelta({ kind: 'generation-reset', generation: 4, previousCursor: 0, cursor: 0 })
      )
    ).toMatchObject({
      outcome: 'require_resnapshot',
      reason: 'generation_reset'
    })
  })

  it('round-trips delta/command/receipt codecs and bounds adversarial inputs', () => {
    const delta = decodeHostDeltaEnvelope(sampleDelta({ kind: 'tombstone', tombstone: true }))
    expect(delta.ok).toBe(true)

    expect(
      decodeHostDeltaEnvelope(sampleDelta({ kind: 'tombstone', tombstone: false }))
    ).toMatchObject({ ok: false, error: 'tombstone kind requires tombstone:true' })

    const command = decodeHostCommand(sampleCommand())
    expect(command.ok).toBe(true)

    expect(
      decodeHostCommand(sampleCommand({ arguments: { text: 'x'.repeat(12_001) } }))
    ).toMatchObject({ ok: false, error: 'composer text is required' })

    expect(
      decodeHostCommand(
        sampleCommand({
          name: 'receipt.lookup',
          target: {},
          arguments: {}
        })
      )
    ).toMatchObject({
      ok: false,
      error: 'receipt.lookup requires commandId or idempotencyKey'
    })

    const receipt = decodeHostCommandReceipt({
      type: 'host.receipt',
      protocolVersion: HOST_PROTOCOL_VERSION,
      commandId: 'cmd-1',
      idempotencyKey: 'idem-1',
      name: 'composer.send',
      actor,
      authority: { decision: 'allow' },
      status: 'executed',
      generation: 3,
      cursor: 11,
      createdAt: '2026-08-03T17:00:00.000Z',
      updatedAt: '2026-08-03T17:00:01.000Z',
      resultSummary: 'queued'
    })
    expect(receipt.ok).toBe(true)

    expect(
      decodeHostCommandReceipt({
        type: 'host.receipt',
        protocolVersion: HOST_PROTOCOL_VERSION,
        commandId: 'cmd-1',
        idempotencyKey: 'idem-1',
        name: 'composer.send',
        actor,
        authority: { decision: 'deny' },
        status: 'denied',
        generation: 3,
        cursor: 11,
        createdAt: '2026-08-03T17:00:00.000Z',
        updatedAt: '2026-08-03T17:00:01.000Z'
      })
    ).toMatchObject({ ok: false, error: 'deny authority requires reason' })
  })

  it('detects same-idempotency-key / different-command conflicts', () => {
    const a = sampleCommand()
    const b = sampleCommand({
      commandId: 'cmd-2',
      arguments: { text: 'different body' }
    })
    const fa = hostCommandFingerprint(a)
    const fb = hostCommandFingerprint(b)
    expect(fa).not.toEqual(fb)
    expect(evaluateHostIdempotencyFingerprints(fa, fa)).toBe('replay')
    expect(evaluateHostIdempotencyFingerprints(fb, fa)).toBe('conflict')
  })

  it('bounds compact transcript previews', () => {
    const snapshot = createEmptyHostSnapshot({ generation: 1, cursor: 0 })
    snapshot.threads.push({
      id: 'thread-1',
      workspaceId: null,
      title: 't',
      chatKind: 'single',
      archived: false,
      pinned: false,
      updatedAt: 1,
      messageCount: 1,
      latestPreview: 'x'.repeat(2_001),
      previewTruncated: true
    })
    expect(assertHostSnapshotFamilies(snapshot)).toMatchObject({
      ok: false,
      error: 'thread preview exceeds compact bound'
    })
  })
})
