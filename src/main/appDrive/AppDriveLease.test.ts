import { describe, expect, it } from 'vitest'
import { AppDriveLeaseRegistry, type AuthorizeAppDriveLeaseInput } from './AppDriveLease'

function setup() {
  const now = { value: 1_000 }
  let id = 0
  return {
    now,
    leases: new AppDriveLeaseRegistry({
      now: () => now.value,
      createLeaseId: () => `lease-${++id}`
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

describe('AppDriveLeaseRegistry', () => {
  it('mints only from explicit user approval and freezes the exact binding', () => {
    const { leases } = setup()
    const lease = leases.authorizeUserLease(binding())
    expect(lease).toMatchObject({
      leaseId: 'lease-1',
      surfaceId: 'canvas-a',
      surfaceKind: 'web',
      approvedBy: 'user',
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
      toRunId: 'run-b',
      toParticipantId: 'seat-b'
    })
    expect(transferred).toMatchObject({
      ok: true,
      lease: {
        leaseId: initial.leaseId,
        approvedBy: 'user',
        runId: 'run-b',
        participantId: 'seat-b'
      }
    })
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
