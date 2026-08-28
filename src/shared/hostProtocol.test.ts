import { describe, expect, it } from 'vitest'
import {
  HOST_APPROVAL_DECIDE_DECISIONS,
  HOST_CAPABILITY_ORDER,
  HOST_COMMAND_FINGERPRINT_HEX_LENGTH,
  HOST_CONTROL_PROTOCOL_COMPAT_VERSION,
  HOST_PROTOCOL_VERSION,
  HOST_PROJECTION_VERSION,
  HOST_PROTOCOL_MAX_TRANSCRIPT_PREVIEW,
  HOST_QUESTION_ANSWER_MAX_CHARS,
  HOST_RECEIPT_STATUSES,
  HOST_THREAD_RECORD_TRANSFER_MAX_BYTES,
  applyHostDeltaCursor,
  assertHostSnapshotFamilies,
  buildHostBootstrapWelcome,
  createEmptyHostSnapshot,
  decodeHostBootstrapHello,
  decodeHostBootstrapWelcome,
  decodeHostCommand,
  decodeHostCommandReceipt,
  decodeHostDeltaEnvelope,
  decodeHostDeltasFrame,
  decodeHostDeltasSinceResult,
  decodeHostHealthFrame,
  decodeHostHealthProjection,
  decodeHostSnapshot,
  decodeHostSnapshotFrame,
  evaluateHostIdempotencyFingerprints,
  evaluateHostIdempotencyReplay,
  encodeHostParticipantEntityId,
  encodeHostProviderEntityId,
  intersectHostCapabilities,
  isHostCommandFingerprint,
  normalizeHostCommandFingerprint,
  type HostCommand,
  type HostCommandReceipt,
  type HostCapability,
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

/** Fixed SHA-256 hex fixtures (not computed digests — wire format only). */
const FP_A = 'a'.repeat(HOST_COMMAND_FINGERPRINT_HEX_LENGTH)
const FP_B = 'b'.repeat(HOST_COMMAND_FINGERPRINT_HEX_LENGTH)
const FP_EMPTY_SHA256 = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'

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

function sampleReceipt(overrides: Partial<HostCommandReceipt> = {}): HostCommandReceipt {
  return {
    type: 'host.receipt',
    protocolVersion: HOST_PROTOCOL_VERSION,
    commandId: 'cmd-1',
    idempotencyKey: 'idem-1',
    name: 'composer.send',
    actor,
    authority: { decision: 'allow' },
    status: 'succeeded',
    commandFingerprint: FP_A,
    generation: 3,
    cursor: 11,
    createdAt: '2026-08-03T17:00:00.000Z',
    updatedAt: '2026-08-03T17:00:01.000Z',
    resultSummary: 'queued',
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
        projectionVersion: 2,
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
        sampleDelta({ kind: 'generation-reset', generation: 4, previousCursor: 0, cursor: 1 })
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

    const receipt = decodeHostCommandReceipt(sampleReceipt())
    expect(receipt.ok).toBe(true)
    if (receipt.ok) {
      expect(receipt.value.status).toBe('succeeded')
      expect(receipt.value.commandFingerprint).toBe(FP_A)
    }

    expect(
      decodeHostCommandReceipt({
        ...sampleReceipt(),
        authority: { decision: 'deny' },
        status: 'denied',
        resultSummary: undefined
      })
    ).toMatchObject({ ok: false, error: 'deny authority requires reason' })
  })

  it('uses canonical receipt statuses aligned with the durable store', () => {
    expect([...HOST_RECEIPT_STATUSES]).toEqual([
      'pending',
      'succeeded',
      'failed',
      'denied',
      'cancelled',
      'indeterminate',
      'conflict'
    ])

    for (const status of HOST_RECEIPT_STATUSES) {
      const decoded = decodeHostCommandReceipt(sampleReceipt({ status }))
      expect(decoded.ok).toBe(true)
      if (decoded.ok) expect(decoded.value.status).toBe(status)
    }

    for (const legacy of ['accepted', 'executed'] as const) {
      expect(
        decodeHostCommandReceipt({
          ...sampleReceipt(),
          status: legacy
        })
      ).toMatchObject({ ok: false, error: 'receipt status is invalid' })
    }
  })

  it('accepts only strict discriminated setup result references', () => {
    expect(
      decodeHostCommandReceipt(
        sampleReceipt({
          name: 'workspace.register',
          resultRef: { kind: 'workspace', workspaceId: 'workspace-1' }
        })
      )
    ).toMatchObject({
      ok: true,
      value: { resultRef: { kind: 'workspace', workspaceId: 'workspace-1' } }
    })
    expect(
      decodeHostCommandReceipt(
        sampleReceipt({
          name: 'provider.auth.cancel',
          resultRef: {
            kind: 'provider-auth',
            providerId: 'provider-1',
            operationId: 'operation-1'
          }
        })
      )
    ).toMatchObject({
      ok: true,
      value: { resultRef: { kind: 'provider-auth', operationId: 'operation-1' } }
    })
    expect(
      decodeHostCommandReceipt({
        ...sampleReceipt(),
        resultRef: { kind: 'workspace', id: 'workspace-1' }
      })
    ).toMatchObject({ ok: false, error: 'resultRef is invalid' })
    expect(
      decodeHostCommandReceipt({
        ...sampleReceipt({ status: 'failed' }),
        resultRef: { kind: 'thread', threadId: 'thread-1' }
      })
    ).toMatchObject({ ok: false, error: 'resultRef requires a succeeded receipt' })
  })

  it('requires lowercase SHA-256 hex commandFingerprint on receipts', () => {
    expect(isHostCommandFingerprint(FP_EMPTY_SHA256)).toBe(true)
    expect(normalizeHostCommandFingerprint(` ${FP_A.toUpperCase()} `)).toBe(FP_A)

    expect(
      decodeHostCommandReceipt({
        ...sampleReceipt(),
        commandFingerprint: undefined
      } as unknown as HostCommandReceipt)
    ).toMatchObject({
      ok: false,
      error: 'commandFingerprint must be lowercase SHA-256 hex'
    })

    expect(
      decodeHostCommandReceipt({
        ...sampleReceipt(),
        // Raw canonical string must never be accepted as a fingerprint.
        commandFingerprint: 'composer.send|threadId=thread-1|text="hello"|actor=user-1'
      })
    ).toMatchObject({
      ok: false,
      error: 'commandFingerprint must be lowercase SHA-256 hex'
    })

    expect(
      decodeHostCommandReceipt({
        ...sampleReceipt(),
        commandFingerprint: 'xyz'
      })
    ).toMatchObject({
      ok: false,
      error: 'commandFingerprint must be lowercase SHA-256 hex'
    })

    expect(
      decodeHostCommandReceipt({
        ...sampleReceipt(),
        commandFingerprint: 'g'.repeat(HOST_COMMAND_FINGERPRINT_HEX_LENGTH)
      })
    ).toMatchObject({
      ok: false,
      error: 'commandFingerprint must be lowercase SHA-256 hex'
    })
  })

  it('detects same-idempotency-key / different-fingerprint conflicts', () => {
    const existing = sampleReceipt({ commandId: 'cmd-1', commandFingerprint: FP_A })

    expect(
      evaluateHostIdempotencyReplay(
        { idempotencyKey: 'idem-1', commandFingerprint: FP_A },
        existing
      )
    ).toBe('replay')

    expect(
      evaluateHostIdempotencyReplay(
        { idempotencyKey: 'idem-1', commandFingerprint: FP_B },
        existing
      )
    ).toBe('conflict')

    // Different commandId with same fingerprint remains a reconnect-safe replay.
    expect(
      evaluateHostIdempotencyReplay(
        { idempotencyKey: 'idem-1', commandFingerprint: FP_A },
        { ...existing, commandId: 'cmd-other' }
      )
    ).toBe('replay')

    expect(evaluateHostIdempotencyFingerprints(FP_A, FP_A)).toBe('replay')
    expect(evaluateHostIdempotencyFingerprints(FP_B, FP_A)).toBe('conflict')
    expect(evaluateHostIdempotencyFingerprints('not-hex', FP_A)).toBe('conflict')
    expect(evaluateHostIdempotencyFingerprints(FP_A.toUpperCase(), FP_A)).toBe('replay')
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

  it('round-trips deltas-since results including retention_gap', () => {
    const available = decodeHostDeltasSinceResult({
      kind: 'deltas',
      generation: 3,
      fromCursor: 10,
      toCursor: 11,
      deltas: [sampleDelta()]
    })
    expect(available.ok).toBe(true)
    if (available.ok) {
      expect(available.value.kind).toBe('deltas')
      if (available.value.kind === 'deltas') {
        expect(available.value.deltas).toHaveLength(1)
        expect(available.value.toCursor).toBe(11)
      }
    }

    const gap = decodeHostDeltasSinceResult({
      kind: 'full_resnapshot_required',
      reason: 'retention_gap',
      generation: 5,
      cursor: 40,
      clientGeneration: 5,
      clientCursor: 2
    })
    expect(gap).toEqual({
      ok: true,
      value: {
        kind: 'full_resnapshot_required',
        reason: 'retention_gap',
        generation: 5,
        cursor: 40,
        clientGeneration: 5,
        clientCursor: 2
      }
    })

    expect(
      decodeHostDeltasSinceResult({
        kind: 'full_resnapshot_required',
        reason: 'cursor_regression',
        generation: 1,
        cursor: 0,
        clientGeneration: 1,
        clientCursor: 3
      })
    ).toMatchObject({ ok: false, error: 'deltas-since resnapshot reason is invalid' })
  })

  it('maps cursor regressions to late rather than a dead cursor_regression reason', () => {
    const current = { generation: 3, cursor: 10 }
    expect(applyHostDeltaCursor(current, sampleDelta({ cursor: 9, previousCursor: 8 }))).toEqual({
      outcome: 'late',
      generation: 3,
      cursor: 10
    })
  })

  it('accepts only bounded descriptor-only thread.record.persist commands', () => {
    const descriptor = {
      transferId: '11111111-1111-4111-8111-111111111111',
      sha256: 'a'.repeat(64),
      byteLength: 512 * 1024,
      expectedRevision: 7
    }
    const decoded = decodeHostCommand(
      sampleCommand({
        name: 'thread.record.persist',
        target: { threadId: 'thread-1' },
        arguments: descriptor
      })
    )
    expect(decoded).toMatchObject({
      ok: true,
      value: {
        name: 'thread.record.persist',
        target: { threadId: 'thread-1' },
        arguments: descriptor
      }
    })
    expect(descriptor.byteLength).toBeGreaterThan(256 * 1024)

    expect(
      decodeHostCommand(
        sampleCommand({
          name: 'thread.record.persist',
          target: { threadId: 'thread-1' },
          arguments: { ...descriptor, transferId: 'a'.repeat(128) }
        })
      ).ok
    ).toBe(true)
    expect(
      decodeHostCommand(
        sampleCommand({
          name: 'thread.record.persist',
          target: { threadId: 'thread-1' },
          arguments: { ...descriptor, transferId: 'a'.repeat(129) }
        })
      )
    ).toMatchObject({
      ok: false,
      error: 'thread.record.persist transferId is invalid'
    })

    for (const smuggled of [
      { ...descriptor, record: { appChatId: 'thread-1' } },
      { ...descriptor, path: '/tmp/record.json' }
    ]) {
      expect(
        decodeHostCommand(
          sampleCommand({
            name: 'thread.record.persist',
            target: { threadId: 'thread-1' },
            arguments: smuggled
          })
        )
      ).toMatchObject({
        ok: false,
        error: 'thread.record.persist has unknown argument keys'
      })
    }

    expect(
      decodeHostCommand(
        sampleCommand({
          name: 'thread.record.persist',
          target: { threadId: 'thread-1' },
          arguments: { ...descriptor, transferId: '../escape' }
        })
      )
    ).toMatchObject({ ok: false, error: 'thread.record.persist transferId is invalid' })
    expect(
      decodeHostCommand(
        sampleCommand({
          name: 'thread.record.persist',
          target: { threadId: 'thread-1' },
          arguments: { ...descriptor, sha256: 'A'.repeat(64) }
        })
      )
    ).toMatchObject({
      ok: false,
      error: 'thread.record.persist sha256 must be lowercase SHA-256 hex'
    })
    expect(
      decodeHostCommand(
        sampleCommand({
          name: 'thread.record.persist',
          target: { threadId: 'thread-1' },
          arguments: { ...descriptor, byteLength: HOST_THREAD_RECORD_TRANSFER_MAX_BYTES + 1 }
        })
      )
    ).toMatchObject({ ok: false, error: 'thread.record.persist byteLength is invalid' })
    expect(
      decodeHostCommand(
        sampleCommand({
          name: 'thread.record.persist',
          target: { threadId: 'thread-1' },
          arguments: { ...descriptor, expectedRevision: -1 }
        })
      )
    ).toMatchObject({ ok: false, error: 'thread.record.persist expectedRevision is invalid' })
  })

  it('accepts only an exact revision-bound thread.record.delete command', () => {
    expect(
      decodeHostCommand(
        sampleCommand({
          name: 'thread.record.delete',
          target: { threadId: 'thread-1' },
          arguments: { expectedRevision: 7 }
        })
      )
    ).toMatchObject({
      ok: true,
      value: {
        name: 'thread.record.delete',
        target: { threadId: 'thread-1' },
        arguments: { expectedRevision: 7 }
      }
    })
    expect(
      decodeHostCommand(
        sampleCommand({
          name: 'thread.record.delete',
          target: { threadId: 'thread-1' },
          arguments: { expectedRevision: -1 }
        })
      )
    ).toMatchObject({ ok: false, error: 'thread.record.delete expectedRevision is invalid' })
    expect(
      decodeHostCommand(
        sampleCommand({
          name: 'thread.record.delete',
          target: { threadId: 'thread-1' },
          arguments: { expectedRevision: 7, path: '/tmp/chat.json' }
        })
      )
    ).toMatchObject({ ok: false, error: 'thread.record.delete has unknown argument keys' })
  })

  it('accepts bounded Desktop workspace record commands without caller-asserted realPath', () => {
    const upsert = decodeHostCommand(
      sampleCommand({
        name: 'workspace.record.upsert',
        target: { workspaceId: 'workspace-1' },
        arguments: {
          path: '/workspace',
          displayName: 'Workspace',
          createdAt: 10,
          lastOpenedAt: 20,
          pinned: false,
          branch: 'main',
          geminiWorktree: { enabled: true, name: 'agy' }
        }
      })
    )
    expect(upsert.ok).toBe(true)
    expect(
      decodeHostCommand(
        sampleCommand({
          name: 'workspace.record.upsert',
          target: { workspaceId: 'workspace-1' },
          arguments: {
            path: '/workspace',
            realPath: '/caller-asserted',
            displayName: 'Workspace',
            createdAt: 10,
            lastOpenedAt: 20,
            pinned: false
          }
        })
      )
    ).toMatchObject({ ok: false, error: 'workspace.record.upsert has unknown argument keys' })
    expect(
      decodeHostCommand(
        sampleCommand({
          name: 'workspace.record.remove',
          target: { workspaceId: 'workspace-1' },
          arguments: {}
        })
      ).ok
    ).toBe(true)
    expect(
      decodeHostCommand(
        sampleCommand({
          name: 'workspace.records.clear',
          target: {},
          arguments: {}
        })
      ).ok
    ).toBe(true)
  })

  it('requires typed question.answer and approval.decide arguments', () => {
    const answered = decodeHostCommand(
      sampleCommand({
        name: 'question.answer',
        target: { questionId: 'q-1' },
        arguments: { decision: 'answer', answer: 'ship it', isCustom: false }
      })
    )
    expect(answered.ok).toBe(true)
    if (answered.ok) {
      expect(answered.value.arguments).toEqual({
        decision: 'answer',
        answer: 'ship it',
        isCustom: false
      })
    }

    const dismissed = decodeHostCommand(
      sampleCommand({
        name: 'question.answer',
        target: { questionId: 'q-1' },
        arguments: { decision: 'dismiss', message: 'later' }
      })
    )
    expect(dismissed.ok).toBe(true)

    expect(
      decodeHostCommand(
        sampleCommand({
          name: 'question.answer',
          target: { questionId: 'q-1' },
          arguments: {}
        })
      )
    ).toMatchObject({
      ok: false,
      error: 'question.answer decision must be answer or dismiss'
    })

    expect(
      decodeHostCommand(
        sampleCommand({
          name: 'question.answer',
          target: { questionId: 'q-1' },
          arguments: { decision: 'answer', answer: 'x'.repeat(HOST_QUESTION_ANSWER_MAX_CHARS + 1) }
        })
      )
    ).toMatchObject({
      ok: false,
      error: 'question.answer answer text is required and bounded'
    })

    expect(
      decodeHostCommand(
        sampleCommand({
          name: 'question.answer',
          target: { questionId: 'q-1' },
          arguments: { decision: 'answer', answer: 'yes', message: 'nope' }
        })
      )
    ).toMatchObject({
      ok: false,
      error: 'question.answer answer must not include dismiss message'
    })

    expect(
      decodeHostCommand(
        sampleCommand({
          name: 'question.answer',
          target: { questionId: 'q-1' },
          arguments: { decision: 'dismiss', answer: 'leftover' }
        })
      )
    ).toMatchObject({
      ok: false,
      error: 'question.answer dismiss must not include answer fields'
    })

    for (const decision of HOST_APPROVAL_DECIDE_DECISIONS) {
      const decoded = decodeHostCommand(
        sampleCommand({
          name: 'approval.decide',
          target: { approvalId: 'appr-1' },
          arguments: { decision, message: 'from phone' }
        })
      )
      expect(decoded.ok).toBe(true)
    }

    expect(
      decodeHostCommand(
        sampleCommand({
          name: 'approval.decide',
          target: { approvalId: 'appr-1' },
          arguments: { decision: 'grantExternalPathEdit' }
        })
      )
    ).toMatchObject({ ok: false, error: 'approval.decide decision is invalid' })

    expect(
      decodeHostCommand(
        sampleCommand({
          name: 'approval.decide',
          target: { approvalId: 'appr-1' },
          arguments: { decision: 'accept', path: '/tmp' }
        })
      )
    ).toMatchObject({ ok: false, error: 'approval.decide has unknown argument keys' })
  })

  it('intersects capabilities in stable host order without inventing entries', () => {
    expect(HOST_CAPABILITY_ORDER).toContain('workspace-git')
    expect(
      intersectHostCapabilities(HOST_CAPABILITY_ORDER, ['workspace-git' as HostCapability])
    ).toEqual(['workspace-git'])

    expect(
      intersectHostCapabilities(
        ['snapshot', 'deltas', 'commands', 'receipts', 'health'],
        ['health', 'commands', 'health', 'deltas']
      )
    ).toEqual(['deltas', 'commands', 'health'])

    // Runtime unknown strings are ignored (decode already rejects them on the wire).
    expect(
      intersectHostCapabilities(HOST_CAPABILITY_ORDER, [
        'snapshot',
        'not-a-cap' as (typeof HOST_CAPABILITY_ORDER)[number]
      ])
    ).toEqual(['snapshot'])

    expect(intersectHostCapabilities(HOST_CAPABILITY_ORDER, [])).toEqual([])
    expect(intersectHostCapabilities([], ['snapshot', 'deltas'])).toEqual([])
    expect(
      intersectHostCapabilities(
        ['snapshot', 'snapshot', 'deltas'],
        ['deltas', 'snapshot', 'compact-export']
      )
    ).toEqual(['snapshot', 'deltas'])
  })

  it('keeps absent optional decoder fields absent (exactOptionalPropertyTypes)', () => {
    const hello = decodeHostBootstrapHello({
      type: 'host.hello',
      protocolVersion: HOST_PROTOCOL_VERSION,
      projectionVersion: HOST_PROJECTION_VERSION,
      client: {
        ...client,
        subjectId: 'pair-1',
        displayName: 'Desktop'
      },
      capabilities: ['bootstrap']
    })
    expect(hello.ok).toBe(true)
    if (hello.ok) {
      expect(hello.value.client).toEqual({
        ...client,
        subjectId: 'pair-1',
        displayName: 'Desktop'
      })
      expect(Object.prototype.hasOwnProperty.call(hello.value.client, 'subjectId')).toBe(true)
    }

    const helloBare = decodeHostBootstrapHello({
      type: 'host.hello',
      protocolVersion: HOST_PROTOCOL_VERSION,
      projectionVersion: HOST_PROJECTION_VERSION,
      client,
      capabilities: ['bootstrap']
    })
    expect(helloBare.ok).toBe(true)
    if (helloBare.ok) {
      expect(Object.prototype.hasOwnProperty.call(helloBare.value.client, 'subjectId')).toBe(false)
      expect(Object.prototype.hasOwnProperty.call(helloBare.value.client, 'displayName')).toBe(
        false
      )
    }

    const deltaBare = decodeHostDeltaEnvelope({
      protocolVersion: HOST_PROTOCOL_VERSION,
      projectionVersion: HOST_PROJECTION_VERSION,
      generation: 1,
      cursor: 2,
      previousCursor: 1,
      kind: 'upsert',
      family: 'thread',
      at: '2026-08-03T17:00:00.000Z'
    })
    expect(deltaBare.ok).toBe(true)
    if (deltaBare.ok) {
      expect(Object.prototype.hasOwnProperty.call(deltaBare.value, 'entityId')).toBe(false)
      expect(Object.prototype.hasOwnProperty.call(deltaBare.value, 'payload')).toBe(false)
      expect(Object.prototype.hasOwnProperty.call(deltaBare.value, 'tombstone')).toBe(false)
    }

    const receiptBare = decodeHostCommandReceipt({
      type: 'host.receipt',
      protocolVersion: HOST_PROTOCOL_VERSION,
      commandId: 'cmd-bare',
      idempotencyKey: 'idem-bare',
      name: 'ping',
      actor,
      authority: { decision: 'allow' },
      status: 'succeeded',
      commandFingerprint: FP_A,
      generation: 1,
      cursor: 1,
      createdAt: '2026-08-03T17:00:00.000Z',
      updatedAt: '2026-08-03T17:00:00.000Z'
    })
    expect(receiptBare.ok).toBe(true)
    if (receiptBare.ok) {
      expect(Object.prototype.hasOwnProperty.call(receiptBare.value, 'resultSummary')).toBe(false)
      expect(Object.prototype.hasOwnProperty.call(receiptBare.value, 'errorCode')).toBe(false)
      expect(Object.prototype.hasOwnProperty.call(receiptBare.value, 'errorMessage')).toBe(false)
      expect(Object.prototype.hasOwnProperty.call(receiptBare.value, 'conflictCommandId')).toBe(
        false
      )
    }

    const receiptConflict = decodeHostCommandReceipt(
      sampleReceipt({
        status: 'conflict',
        conflictCommandId: 'cmd-original',
        errorCode: 'idempotency_conflict',
        errorMessage: 'fingerprint mismatch',
        resultSummary: undefined
      })
    )
    expect(receiptConflict.ok).toBe(true)
    if (receiptConflict.ok) {
      expect(receiptConflict.value.conflictCommandId).toBe('cmd-original')
      expect(receiptConflict.value.errorCode).toBe('idempotency_conflict')
      expect(Object.prototype.hasOwnProperty.call(receiptConflict.value, 'resultSummary')).toBe(
        false
      )
    }
  })
})

describe('Host protocol Wave 2D-1 read frames', () => {
  it('encodes participant identity from thread + roster id without aliases', () => {
    expect(encodeHostParticipantEntityId('thread:a', 'seat:b')).toEqual({
      ok: true,
      value: 'pt1:8:thread:a:6:seat:b'
    })
    expect(encodeHostParticipantEntityId('thread:a:seat', 'b')).not.toEqual(
      encodeHostParticipantEntityId('thread:a', 'seat:b')
    )
    expect(encodeHostParticipantEntityId(' thread', 'seat')).toMatchObject({ ok: false })
    expect(encodeHostParticipantEntityId('t'.repeat(300), 'p'.repeat(300))).toMatchObject({
      ok: false,
      error: expect.stringContaining('exceeds')
    })
  })

  it('encodes provider identity without provider/model aliases', () => {
    expect(encodeHostProviderEntityId('cursor', undefined)).toEqual({
      ok: true,
      value: 'p0:6:cursor'
    })
    expect(encodeHostProviderEntityId('cursor', 'grok:4')).toEqual({
      ok: true,
      value: 'p1:6:cursor:6:grok:4'
    })
    expect(encodeHostProviderEntityId('cursor:grok', '4')).not.toEqual(
      encodeHostProviderEntityId('cursor', 'grok:4')
    )
    expect(encodeHostProviderEntityId(' cursor', undefined)).toMatchObject({ ok: false })
    expect(encodeHostProviderEntityId('cursor', '')).toMatchObject({ ok: false })
  })

  it('round-trips decodeHostSnapshot for empty and populated compact snapshots', () => {
    const empty = createEmptyHostSnapshot({ generation: 2, cursor: 5 })
    const decodedEmpty = decodeHostSnapshot(empty)
    expect(decodedEmpty).toEqual({ ok: true, value: empty })
    if (decodedEmpty.ok) {
      expect(Object.prototype.hasOwnProperty.call(decodedEmpty.value, 'routing')).toBe(false)
    }

    const populated = createEmptyHostSnapshot({ generation: 4, cursor: 12 })
    populated.routing = {
      mode: 'continuous',
      fanout: 'locked_writers',
      activeParticipantId: 'p1',
      continuationHops: 1,
      maxContinuationHops: 455,
      bossParticipantId: 'boss-1',
      captainParticipantId: 'captain-1'
    }
    populated.workspaces.push({
      id: 'ws-1',
      name: 'AGBench',
      path: '/tmp/agbench',
      pinned: true,
      updatedAt: 1
    })
    populated.threads.push({
      id: 'thread-1',
      workspaceId: 'ws-1',
      title: 'Host Arc',
      chatKind: 'ensemble',
      archived: false,
      pinned: true,
      updatedAt: 2,
      messageCount: 3,
      latestPreview: 'progress',
      previewTruncated: false,
      providerId: 'codex',
      missionOutcome: 'active',
      activeRoundId: 'round-1'
    })
    populated.runs.push({
      runId: 'run-1',
      threadId: 'thread-1',
      providerId: 'codex',
      providerOutcome: 'completed',
      startedAt: 1,
      endedAt: 2,
      modelId: 'gpt-5.6'
    })
    populated.missions.push({
      missionId: 'mission-1',
      threadId: 'thread-1',
      title: 'Host Arc',
      status: 'active',
      goalId: 'goal-1',
      updatedAt: 3,
      activeRoundId: 'round-1'
    })
    populated.rounds.push({
      roundId: 'round-1',
      threadId: 'thread-1',
      status: 'running',
      startedAt: 1,
      participantIds: ['p1'],
      providerRunIds: ['run-1'],
      waves: [{ waveId: 'wave-1', status: 'open', participantIds: ['p1'], label: '2D-1' }]
    })
    populated.participants.push({
      id: 'p1',
      threadId: 'thread-1',
      providerId: 'cursor',
      role: 'CursorWork3',
      modelId: 'grok-4.5',
      reasoningEffort: 'xhigh',
      thinkingEnabled: false,
      permissionPresetId: 'workspace_write',
      stage: 'worker',
      order: 4,
      enabled: true,
      active: true,
      status: 'running'
    })
    populated.providers.push({
      providerId: 'cursor',
      displayProvider: 'Cursor',
      modelId: 'grok-4.5',
      modelLabel: 'Grok 4.5',
      shortCode: 'cur',
      available: true,
      note: 'path-b'
    })
    populated.questions.push({
      questionId: 'q-1',
      threadId: 'thread-1',
      status: 'open',
      promptPreview: 'Approve?',
      askedAt: 4,
      receiptId: 'rcpt-1'
    })
    populated.approvals.push({
      approvalId: 'appr-1',
      commandId: 'cmd-appr-1',
      threadId: 'thread-1',
      status: 'pending',
      actionKind: 'run_shell_command',
      createdAt: 5,
      summary: 'npm test'
    })
    populated.schedules.push({
      scheduleId: 'sched-1',
      title: 'Daily',
      enabled: true,
      nextFireAt: 6,
      threadId: 'thread-1'
    })
    populated.artifacts.push({
      artifactId: 'art-1',
      kind: 'diff',
      threadId: 'thread-1',
      title: 'patch',
      createdAt: 7,
      byteLength: 128,
      sha256: FP_EMPTY_SHA256
    })
    populated.warnings.push({
      warningId: 'warn-1',
      severity: 'info',
      code: 'note',
      message: 'ok',
      at: 8,
      threadId: 'thread-1'
    })
    populated.recovery = {
      reopenStatus: 'clean',
      lastCheckpointAt: 9,
      lastGeneration: 4,
      lastCursor: 12,
      detail: 'warm'
    }
    populated.usage = {
      availability: 'available',
      tokens: 42,
      costText: '$0.01',
      confidence: 'exact',
      band: 'low'
    }

    const decoded = decodeHostSnapshot(JSON.parse(JSON.stringify(populated)))
    expect(decoded).toEqual({ ok: true, value: populated })

    const missingParticipantThread = JSON.parse(JSON.stringify(populated))
    delete missingParticipantThread.participants[0].threadId
    expect(decodeHostSnapshot(missingParticipantThread)).toMatchObject({
      ok: false,
      error: expect.stringContaining('participants[0].threadId is required')
    })

    const invalidParticipantPosture = JSON.parse(JSON.stringify(populated))
    invalidParticipantPosture.participants[0].thinkingEnabled = 'yes'
    expect(decodeHostSnapshot(invalidParticipantPosture)).toMatchObject({
      ok: false,
      error: expect.stringContaining('participants[0].thinkingEnabled is invalid')
    })
  })

  it('rejects adversarial snapshot values without inventing families', () => {
    expect(decodeHostSnapshot(null)).toMatchObject({
      ok: false,
      error: 'snapshot must be an object'
    })
    expect(
      decodeHostSnapshot({
        ...createEmptyHostSnapshot({ generation: 1, cursor: 0 }),
        protocolVersion: 1
      })
    ).toMatchObject({ ok: false, error: 'unsupported protocol version' })

    const missingHealth = createEmptyHostSnapshot({
      generation: 1,
      cursor: 0
    }) as unknown as Record<string, unknown>
    delete missingHealth.health
    expect(decodeHostSnapshot(missingHealth)).toMatchObject({
      ok: false,
      error: 'health must be an object'
    })

    const oversizedPreview = createEmptyHostSnapshot({ generation: 1, cursor: 0 })
    oversizedPreview.threads.push({
      id: 't1',
      workspaceId: null,
      title: 'x',
      chatKind: 'single',
      archived: false,
      pinned: false,
      updatedAt: 1,
      messageCount: 1,
      latestPreview: 'x'.repeat(HOST_PROTOCOL_MAX_TRANSCRIPT_PREVIEW + 1)
    })
    expect(decodeHostSnapshot(oversizedPreview)).toMatchObject({
      ok: false,
      error: 'threads[0].latestPreview is invalid'
    })

    const fakeZero = createEmptyHostSnapshot({ generation: 1, cursor: 0 })
    fakeZero.usage = { availability: 'unavailable', tokens: 0 }
    expect(decodeHostSnapshot(fakeZero)).toMatchObject({
      ok: false,
      error: 'unavailable usage must not publish tokens'
    })
  })

  it('rejects an approval that cannot name the command it governs (Wave 4.2c)', () => {
    // DECODER-LAYER PIN. The client RED-proof lives in the TUI and the source
    // pin lives in HostMainComposition — NEITHER fails if the wire decoder
    // stops requiring commandId, because both of those supply the field
    // upstream. This is the only assertion that catches a strip at the decode
    // boundary, which is exactly where an allowlist rebuild silently drops a
    // field it was never taught. An approval that cannot name its command is
    // unbindable, so refusing it is the honest outcome.
    const uncorrelated = createEmptyHostSnapshot({ generation: 1, cursor: 0 })
    ;(uncorrelated.approvals as unknown[]).push({
      approvalId: 'appr-uncorrelated',
      status: 'pending',
      actionKind: 'composer.send',
      createdAt: 5,
      summary: 'Deferred composer.send'
    })
    expect(decodeHostSnapshot(JSON.parse(JSON.stringify(uncorrelated)))).toMatchObject({
      ok: false,
      error: 'approvals[0].commandId is required'
    })
  })

  it('decodes compact optional Channels state and bounds membership detail', () => {
    const snapshot = createEmptyHostSnapshot({ generation: 1, cursor: 0 })
    snapshot.channels = [
      {
        channelId: 'channel-a',
        threadId: 'thread-a',
        ownerMemberId: 'owner-a',
        title: 'Shared work',
        status: 'active',
        availability: 'ready',
        membershipRevision: 2,
        memberCount: 1,
        messageCount: 3,
        updatedAt: 4,
        members: [
          {
            memberId: 'owner-a',
            kind: 'human',
            displayName: 'Owner',
            status: 'active'
          }
        ],
        pendingAdmissionCount: 1,
        pendingHumanReviewCount: 2
      }
    ]

    expect(decodeHostSnapshot(snapshot)).toEqual({ ok: true, value: snapshot })

    snapshot.channels[0]!.members = Array.from({ length: 9 }, (_, index) => ({
      memberId: `member-${index}`,
      kind: 'human' as const,
      displayName: `Member ${index}`,
      status: 'active' as const
    }))
    expect(decodeHostSnapshot(snapshot)).toMatchObject({
      ok: false,
      error: 'channels[0].members exceeds compact bound'
    })
  })

  it('decodes host.snapshot / host.deltas / host.health frames', () => {
    const snapshot = createEmptyHostSnapshot({ generation: 3, cursor: 9 })
    const snapshotFrame = decodeHostSnapshotFrame({
      type: 'host.snapshot',
      protocolVersion: HOST_PROTOCOL_VERSION,
      snapshot
    })
    expect(snapshotFrame).toEqual({
      ok: true,
      value: {
        type: 'host.snapshot',
        protocolVersion: HOST_PROTOCOL_VERSION,
        snapshot
      }
    })

    expect(
      decodeHostSnapshotFrame({
        type: 'host.command',
        protocolVersion: HOST_PROTOCOL_VERSION,
        snapshot
      })
    ).toMatchObject({ ok: false, error: 'type must be host.snapshot' })

    const deltas = decodeHostDeltasFrame({
      type: 'host.deltas',
      protocolVersion: HOST_PROTOCOL_VERSION,
      result: {
        kind: 'deltas',
        generation: 3,
        fromCursor: 8,
        toCursor: 9,
        deltas: [sampleDelta({ generation: 3, cursor: 9, previousCursor: 8 })]
      }
    })
    expect(deltas.ok).toBe(true)
    if (deltas.ok) {
      expect(deltas.value.type).toBe('host.deltas')
      expect(deltas.value.result.kind).toBe('deltas')
    }

    const resnapshot = decodeHostDeltasFrame({
      type: 'host.deltas',
      protocolVersion: HOST_PROTOCOL_VERSION,
      result: {
        kind: 'full_resnapshot_required',
        reason: 'generation_reset',
        generation: 4,
        cursor: 1,
        clientGeneration: 3,
        clientCursor: 9
      }
    })
    expect(resnapshot).toEqual({
      ok: true,
      value: {
        type: 'host.deltas',
        protocolVersion: HOST_PROTOCOL_VERSION,
        result: {
          kind: 'full_resnapshot_required',
          reason: 'generation_reset',
          generation: 4,
          cursor: 1,
          clientGeneration: 3,
          clientCursor: 9
        }
      }
    })

    const health = decodeHostHealthProjection({
      hostStatus: 'ok',
      connectionPhase: 'live',
      supervised: true,
      freshness: 'live'
    })
    expect(health.ok).toBe(true)
    if (health.ok) {
      expect(Object.prototype.hasOwnProperty.call(health.value, 'detail')).toBe(false)
    }

    const healthFrame = decodeHostHealthFrame({
      type: 'host.health',
      protocolVersion: HOST_PROTOCOL_VERSION,
      health: {
        hostStatus: 'degraded',
        detail: 'restarting providers',
        connectionPhase: 'reconnecting',
        supervised: true,
        freshness: 'cached'
      }
    })
    expect(healthFrame).toEqual({
      ok: true,
      value: {
        type: 'host.health',
        protocolVersion: HOST_PROTOCOL_VERSION,
        health: {
          hostStatus: 'degraded',
          detail: 'restarting providers',
          connectionPhase: 'reconnecting',
          supervised: true,
          freshness: 'cached'
        }
      }
    })
  })

  it('mints HostBootstrapWelcome from authenticated context via capability intersection', () => {
    const minted = buildHostBootstrapWelcome({
      hostId: 'host-local-1',
      hostVersion: '1.9.2',
      sessionId: 'sess-mint-1',
      generation: 7,
      cursor: 21,
      authenticatedClient: client,
      hostCapabilityOffer: ['bootstrap', 'snapshot', 'deltas', 'commands', 'receipts', 'health'],
      clientCapabilityRequest: [
        'health',
        'snapshot',
        'health',
        'deltas',
        'unknown'
      ] as readonly HostCapability[],
      freshness: 'live'
    })
    // unknown rejected before intersect
    expect(minted).toMatchObject({
      ok: false,
      error: 'unknown client capability: unknown'
    })

    const ok = buildHostBootstrapWelcome({
      hostId: 'host-local-1',
      hostVersion: '1.9.2',
      sessionId: 'sess-mint-1',
      generation: 7,
      cursor: 21,
      authenticatedClient: {
        ...client,
        subjectId: 'pair-1'
      },
      hostCapabilityOffer: ['bootstrap', 'snapshot', 'deltas', 'commands', 'receipts', 'health'],
      clientCapabilityRequest: ['health', 'snapshot', 'health', 'deltas'],
      freshness: 'live'
    })
    expect(ok).toEqual({
      ok: true,
      value: {
        type: 'host.welcome',
        protocolVersion: HOST_PROTOCOL_VERSION,
        controlProtocolCompat: HOST_CONTROL_PROTOCOL_COMPAT_VERSION,
        projectionVersion: HOST_PROJECTION_VERSION,
        hostId: 'host-local-1',
        hostVersion: '1.9.2',
        sessionId: 'sess-mint-1',
        generation: 7,
        cursor: 21,
        authenticatedClient: {
          ...client,
          subjectId: 'pair-1'
        },
        capabilities: ['snapshot', 'deltas', 'health'],
        freshness: 'live'
      }
    })

    const bareClient = buildHostBootstrapWelcome({
      hostId: 'host-local-1',
      hostVersion: '1.9.2',
      sessionId: 'sess-mint-2',
      generation: 0,
      cursor: 0,
      authenticatedClient: client,
      hostCapabilityOffer: HOST_CAPABILITY_ORDER,
      clientCapabilityRequest: ['bootstrap'],
      freshness: 'cached'
    })
    expect(bareClient.ok).toBe(true)
    if (bareClient.ok) {
      expect(
        Object.prototype.hasOwnProperty.call(bareClient.value.authenticatedClient, 'subjectId')
      ).toBe(false)
      expect(bareClient.value.capabilities).toEqual(['bootstrap'])
      expect(bareClient.value.freshness).toBe('cached')
    }

    expect(
      buildHostBootstrapWelcome({
        hostId: '',
        hostVersion: '1.9.2',
        sessionId: 'sess',
        generation: 0,
        cursor: 0,
        authenticatedClient: client,
        hostCapabilityOffer: ['bootstrap'],
        clientCapabilityRequest: ['bootstrap'],
        freshness: 'live'
      })
    ).toMatchObject({ ok: false, error: 'hostId is required' })
  })

  it('keeps read-shaped HostCommandName values wire-compatible', () => {
    for (const name of ['snapshot.get', 'deltas.since', 'receipt.lookup', 'ping'] as const) {
      const decoded = decodeHostCommand(
        sampleCommand({
          name,
          target:
            name === 'receipt.lookup' ? { commandId: 'cmd-1' } : name === 'deltas.since' ? {} : {},
          arguments: name === 'deltas.since' ? { generation: 1, cursor: 0 } : {}
        })
      )
      expect(decoded.ok).toBe(true)
    }
  })
})
