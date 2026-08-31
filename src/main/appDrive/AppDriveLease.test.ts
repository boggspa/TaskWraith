import { describe, expect, it } from 'vitest'
import { AppDriveLeaseRegistry, type AuthorizeAppDriveLeaseInput } from './AppDriveLease'
import { AppDriveSessionReportStore } from './AppDriveSessionReport'

function setup() {
  const now = { value: 1_000 }
  let id = 0
  let reportId = 0
  let actionId = 0
  let observationId = 0
  return {
    now,
    leases: new AppDriveLeaseRegistry({
      now: () => now.value,
      createLeaseId: () => `lease-${++id}`,
      reports: new AppDriveSessionReportStore({
        now: () => now.value,
        createReportId: () => `report-${++reportId}`,
        createActionId: () => `action-${++actionId}`,
        createObservationId: () => `observation-${++observationId}`
      })
    })
  }
}

function binding(
  overrides: Partial<AuthorizeAppDriveLeaseInput> = {}
): AuthorizeAppDriveLeaseInput {
  return {
    surfaceId: 'canvas-a',
    surfaceKind: 'web',
    chatId: 'chat-a',
    runId: 'run-a',
    provider: 'codex',
    participantId: 'seat-a',
    approvedBy: 'user',
    approvalId: 'approval-a',
    approvedAt: 1_000,
    expiresAt: 10_000,
    allowedVerbs: ['click', 'fill'],
    stepBudget: 2,
    target: { canvasId: 'canvas-a', origin: 'https://example.test' },
    ...overrides
  }
}

function consume(leases: AppDriveLeaseRegistry, overrides: Record<string, unknown> = {}) {
  return leases.acquireAndConsume({
    surfaceId: 'canvas-a',
    surfaceKind: 'web',
    chatId: 'chat-a',
    runId: 'run-a',
    provider: 'codex',
    participantId: 'seat-a',
    verb: 'click',
    ...overrides
  } as never)
}

function emulatorBinding(
  overrides: Partial<AuthorizeAppDriveLeaseInput> = {}
): AuthorizeAppDriveLeaseInput {
  return binding({
    surfaceId: 'canvas-emulator-a',
    surfaceKind: 'emulator',
    allowedVerbs: ['emulator_step'],
    target: { canvasId: 'canvas-emulator-a' },
    ...overrides
  })
}

function consumeEmulator(leases: AppDriveLeaseRegistry, overrides: Record<string, unknown> = {}) {
  return leases.acquireAndConsume({
    surfaceId: 'canvas-emulator-a',
    surfaceKind: 'emulator',
    chatId: 'chat-a',
    runId: 'run-a',
    provider: 'codex',
    participantId: 'seat-a',
    verb: 'emulator_step',
    ...overrides
  } as never)
}

describe('AppDriveLeaseRegistry', () => {
  it('mints only from explicit user approval and freezes the exact binding', () => {
    const { leases } = setup()
    const lease = leases.authorizeUserLease(binding())
    expect(lease).toMatchObject({
      leaseId: 'lease-1',
      reportId: 'report-1',
      surfaceId: 'canvas-a',
      surfaceKind: 'web',
      approvedBy: 'user',
      independentVerificationRequired: false,
      stepBudget: 2,
      stepsRemaining: 2,
      target: { canvasId: 'canvas-a', origin: 'https://example.test' }
    })
    expect(Object.isFrozen(lease)).toBe(true)
    expect(() => leases.authorizeUserLease({ ...binding(), approvedBy: 'agent' as never })).toThrow(
      /user approval/i
    )
  })

  it('refuses an agent action before a user-minted lease exists', () => {
    const { leases } = setup()
    expect(consume(leases)).toMatchObject({ ok: false, code: 'consent-required' })
  })

  it('validates the full lease before creating a report', () => {
    const { leases } = setup()
    expect(() => leases.authorizeUserLease(binding({ allowedVerbs: [''] }))).toThrow(/verb/i)
    expect(leases.peek('canvas-a')).toBeNull()
    expect(leases.queryReports({ chatId: 'chat-a' })).toEqual([])
  })

  it('consumes a bounded step and refuses exact binding/verb drift', () => {
    const { leases } = setup()
    leases.authorizeUserLease(binding())
    expect(consume(leases)).toMatchObject({
      ok: true,
      lease: { stepsUsed: 1, stepsRemaining: 1 }
    })
    expect(consume(leases, { runId: 'run-b' })).toMatchObject({
      ok: false,
      code: 'binding-mismatch'
    })
    expect(consume(leases, { verb: 'scroll' })).toMatchObject({
      ok: false,
      code: 'verb-not-allowed'
    })
  })

  it('keeps emulator_step as a distinct exact-surface lease and report kind', () => {
    const { leases } = setup()
    const lease = leases.authorizeUserLease(emulatorBinding())
    expect(lease).toMatchObject({
      surfaceId: 'canvas-emulator-a',
      surfaceKind: 'emulator',
      target: { canvasId: 'canvas-emulator-a' },
      allowedVerbs: ['emulator_step']
    })

    const admitted = consumeEmulator(leases)
    expect(admitted).toMatchObject({ ok: true, lease: { surfaceKind: 'emulator' } })
    expect(consumeEmulator(leases, { surfaceKind: 'web' })).toMatchObject({
      ok: false,
      code: 'binding-mismatch'
    })
    expect(consumeEmulator(leases, { verb: 'click' })).toMatchObject({
      ok: false,
      code: 'verb-not-allowed'
    })

    if (!admitted.ok) throw new Error('expected emulator admission')
    leases.completeAction({
      leaseId: admitted.lease.leaseId,
      actionId: admitted.actionId,
      actor: { runId: 'run-a', provider: 'codex', participantId: 'seat-a' },
      executed: true,
      surfaceVerification: 'changed'
    })
    expect(leases.queryReports({ chatId: 'chat-a' })[0]).toMatchObject({
      surfaceKind: 'emulator',
      actions: [expect.objectContaining({ verb: 'emulator_step', status: 'verified' })]
    })
  })

  it('refuses emulator lease metadata that could widen its reviewed surface', () => {
    const { leases } = setup()
    expect(() =>
      leases.authorizeUserLease(
        emulatorBinding({
          target: { canvasId: 'canvas-emulator-a', origin: 'https://example.test' }
        })
      )
    ).toThrow(/exact canvas surface/i)
    expect(() =>
      leases.authorizeUserLease(emulatorBinding({ allowedVerbs: ['emulator_step', 'click'] }))
    ).toThrow(/only emulator_step/i)
  })

  it('refuses after the bounded step budget is exhausted', () => {
    const { leases } = setup()
    leases.authorizeUserLease(binding({ stepBudget: 1 }))
    expect(consume(leases).ok).toBe(true)
    expect(consume(leases)).toMatchObject({
      ok: false,
      code: 'step-budget-exhausted',
      lease: { status: 'revoked', revocationReason: 'step-budget-exhausted' }
    })
  })

  it('expires mechanically and cannot be extended by a stale caller', () => {
    const { leases, now } = setup()
    leases.authorizeUserLease(binding({ expiresAt: 1_100 }))
    now.value = 1_101
    expect(consume(leases)).toMatchObject({
      ok: false,
      code: 'expired',
      lease: { status: 'revoked', revocationReason: 'expired' }
    })
  })

  it('revokes on navigation, close, takeover, run terminal, and chat close', () => {
    const reasons = [
      'navigation',
      'surface-closed',
      'human-takeover',
      'run-terminal',
      'chat-closed'
    ] as const
    for (const reason of reasons) {
      const { leases } = setup()
      leases.authorizeUserLease(binding())
      const revoked =
        reason === 'run-terminal'
          ? leases.revokeForRun('run-a')[0]
          : reason === 'chat-closed'
            ? leases.revokeForChat('chat-a')[0]
            : leases.revokeSurface('canvas-a', reason)
      expect(revoked).toMatchObject({ status: 'revoked', revocationReason: reason })
      expect(consume(leases).ok).toBe(false)
    }
  })

  it('transfers an existing user lease without reminting approval', () => {
    const { leases } = setup()
    const initial = leases.authorizeUserLease(binding())
    const transferred = leases.transfer({
      surfaceId: 'canvas-a',
      fromRunId: 'run-a',
      fromProvider: 'codex',
      toRunId: 'run-b',
      toProvider: 'claude',
      toParticipantId: 'seat-b'
    })
    expect(transferred).toMatchObject({
      ok: true,
      lease: {
        leaseId: initial.leaseId,
        approvedBy: 'user',
        runId: 'run-b',
        provider: 'claude',
        participantId: 'seat-b'
      }
    })
    expect(
      consume(leases, {
        runId: 'run-b',
        provider: 'claude',
        participantId: 'seat-b'
      }).ok
    ).toBe(true)
  })

  it('keeps an in-flight action bound to its original actor across transfer', () => {
    const { leases } = setup()
    leases.authorizeUserLease(binding())
    const admitted = consume(leases)
    if (!admitted.ok) throw new Error('expected action admission')
    leases.transfer({
      surfaceId: 'canvas-a',
      fromRunId: 'run-a',
      fromProvider: 'codex',
      toRunId: 'run-b',
      toProvider: 'claude',
      toParticipantId: 'seat-b'
    })
    const completion = {
      leaseId: admitted.lease.leaseId,
      actionId: admitted.actionId,
      executed: true,
      surfaceVerification: 'changed' as const
    }
    expect(() =>
      leases.completeAction({
        ...completion,
        actor: { runId: 'run-b', provider: 'claude', participantId: 'seat-b' }
      })
    ).toThrow(/another actor/i)
    expect(
      leases.completeAction({
        ...completion,
        actor: { runId: 'run-a', provider: 'codex', participantId: 'seat-a' }
      })
    ).toMatchObject({ status: 'verified' })
  })

  it('reports an inconclusive action and accepts a distinct verifier attestation', () => {
    const { leases } = setup()
    leases.authorizeUserLease(binding())
    const admitted = consume(leases, { independentVerificationRequired: true })
    expect(admitted).toMatchObject({
      ok: true,
      reportId: 'report-1',
      actionId: 'action-1',
      independentVerificationRequired: true
    })
    if (!admitted.ok) throw new Error('expected admission')
    leases.completeAction({
      leaseId: admitted.lease.leaseId,
      actionId: admitted.actionId,
      actor: { runId: 'run-a', provider: 'codex', participantId: 'seat-a' },
      executed: true,
      surfaceVerification: 'unchanged'
    })
    expect(leases.queryReports({ chatId: 'chat-a' })[0].counts.awaitingVerification).toBe(1)
    const actorObservation = leases.recordObservation({
      chatId: 'chat-a',
      surfaceId: 'canvas-a',
      observer: { runId: 'run-a', provider: 'codex', participantId: 'seat-a' }
    })!
    expect(() =>
      leases.verifyAction({
        reportId: admitted.reportId,
        actionId: admitted.actionId,
        surfaceId: 'canvas-a',
        observationId: actorObservation.observationId,
        chatId: 'chat-a',
        verifier: { runId: 'run-a', provider: 'codex', participantId: 'seat-a' },
        verdict: 'confirmed'
      })
    ).toThrow(/different Ensemble participant/i)
    const reviewer = { runId: 'run-b', provider: 'claude', participantId: 'seat-b' }
    const reviewerObservation = leases.recordObservation({
      chatId: 'chat-a',
      surfaceId: 'canvas-a',
      observer: reviewer
    })!
    expect(
      leases.verifyAction({
        reportId: admitted.reportId,
        actionId: admitted.actionId,
        surfaceId: 'canvas-a',
        observationId: reviewerObservation.observationId,
        chatId: 'chat-a',
        verifier: reviewer,
        verdict: 'confirmed'
      })
    ).toMatchObject({ status: 'verified' })
  })

  it('persists independent verification as a lease policy after user approval', () => {
    const { leases } = setup()
    leases.authorizeUserLease(binding({ independentVerificationRequired: true }))
    expect(consume(leases)).toMatchObject({
      ok: true,
      independentVerificationRequired: true,
      lease: { independentVerificationRequired: true }
    })
    expect(leases.queryReports({ chatId: 'chat-a' })[0]).toMatchObject({
      independentVerificationRequired: true,
      actions: [expect.objectContaining({ independentVerificationRequired: true })]
    })
  })

  it('refuses independent verification mode for a solo actor before consuming a step', () => {
    const { leases } = setup()
    leases.authorizeUserLease(binding({ participantId: undefined }))
    expect(
      consume(leases, { participantId: undefined, independentVerificationRequired: true })
    ).toMatchObject({ ok: false, code: 'independent-verifier-required' })
    expect(leases.peek('canvas-a')).toMatchObject({ stepsUsed: 0, stepsRemaining: 2 })
  })

  it('replacing a surface rotates lease identity and resets the bounded budget', () => {
    const { leases } = setup()
    const first = leases.authorizeUserLease(binding())
    consume(leases)
    const second = leases.authorizeUserLease(binding({ approvalId: 'approval-b' }))
    expect(second.leaseId).not.toBe(first.leaseId)
    expect(second).toMatchObject({ stepsUsed: 0, stepsRemaining: 2 })
  })
})
