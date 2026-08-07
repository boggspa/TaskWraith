import { describe, expect, it, vi } from 'vitest'

import {
  NativeWindowLeaseError,
  NativeWindowLeaseRegistry,
  type NativeWindowLeaseExecutorContext,
  type NativeWindowLeaseGrantInput,
  type NativeWindowLeaseOwnershipValidator,
  type NativeWindowLeaseRegistryOptions
} from './NativeWindowLeaseRegistry'

function createRegistry(options: Partial<NativeWindowLeaseRegistryOptions> = {}): {
  registry: NativeWindowLeaseRegistry
  now: { value: number }
  validateOwnership: ReturnType<typeof vi.fn>
} {
  const now = { value: 10_000 }
  let id = 0
  const validateOwnership = vi.fn(() => true as const)
  const registry = new NativeWindowLeaseRegistry({
    instanceEpoch: 'instance-a',
    validateOwnership:
      (options.validateOwnership as NativeWindowLeaseOwnershipValidator | undefined) ??
      validateOwnership,
    now: options.now ?? (() => now.value),
    createLeaseId: options.createLeaseId ?? (() => `lease-${++id}`)
  })
  return { registry, now, validateOwnership }
}

function grant(overrides: Partial<NativeWindowLeaseGrantInput> = {}): NativeWindowLeaseGrantInput {
  return {
    instanceEpoch: 'instance-a',
    chatId: 'chat-a',
    runId: 'run-a',
    provider: 'codex',
    participantId: 'operator-a',
    launchAttemptId: 'attempt-a',
    expectedPid: 101,
    selectedPid: 101,
    selectedProcessStartedAt: '2026-07-28T02:40:00.000Z',
    windowId: 42,
    windowHandleId: 'daemon-window-handle-a',
    consentEpoch: 'consent-a',
    consentGeneration: 1,
    expiresAt: 20_000,
    approvedAt: 9_999,
    approvedBy: 'user',
    allowedVerbs: ['observe', 'inspect', 'click', 'fill'],
    stepBudget: 2,
    ...overrides
  }
}

function owner(
  overrides: Partial<NativeWindowLeaseExecutorContext> = {}
): NativeWindowLeaseExecutorContext {
  return {
    instanceEpoch: 'instance-a',
    chatId: 'chat-a',
    runId: 'run-a',
    provider: 'codex',
    participantId: 'operator-a',
    ...overrides
  }
}

function expectCode(
  action: () => unknown,
  code: NativeWindowLeaseError['code']
): NativeWindowLeaseError {
  try {
    action()
    throw new Error(`Expected NativeWindowLeaseError(${code})`)
  } catch (error) {
    expect(error).toBeInstanceOf(NativeWindowLeaseError)
    expect((error as NativeWindowLeaseError).code).toBe(code)
    return error as NativeWindowLeaseError
  }
}

describe('NativeWindowLeaseRegistry', () => {
  it('binds exact picker, consent, run, process, and operator identity without exposing authority to renderer status', () => {
    const { registry, validateOwnership } = createRegistry()
    const input = grant()
    const result = registry.grantOrReplace(input)
    input.windowHandleId = 'mutated-after-grant'
    input.consentEpoch = 'mutated-consent'

    expect(result.lease).toMatchObject({
      leaseId: 'lease-1',
      instanceEpoch: 'instance-a',
      chatId: 'chat-a',
      runId: 'run-a',
      provider: 'codex',
      participantId: 'operator-a',
      launchAttemptId: 'attempt-a',
      expectedPid: 101,
      selectedPid: 101,
      selectedProcessStartedAt: '2026-07-28T02:40:00.000Z',
      windowId: 42,
      windowHandleId: 'daemon-window-handle-a',
      consentEpoch: 'consent-a',
      consentGeneration: 1,
      approvedAt: 9_999,
      approvedBy: 'user',
      allowedVerbs: ['observe', 'inspect', 'click', 'fill'],
      stepsUsed: 0
    })
    expect(Object.isFrozen(result.lease)).toBe(true)
    expect(Object.isFrozen(result.lease.allowedVerbs)).toBe(true)
    expect(result.lease.expectedPid).toBe(result.lease.selectedPid)

    const resolved = registry.resolveForExecutor(owner())
    expect(resolved).toBe(result.lease)
    expect(validateOwnership).toHaveBeenCalledTimes(2)

    const status = registry.status()
    expect(status.lease).toMatchObject({
      leaseId: 'lease-1',
      expectedPid: 101,
      windowId: 42,
      trustState: 'user-approved',
      allowedVerbs: ['observe', 'inspect', 'click', 'fill'],
      stepsRemaining: 2
    })
    expect(status.lease).not.toHaveProperty('windowHandleId')
    expect(status.lease).not.toHaveProperty('consentEpoch')
    expect(status.lease).not.toHaveProperty('instanceEpoch')
    expect(Object.isFrozen(status.lease)).toBe(true)
    expect(Object.isFrozen(status.lease?.allowedVerbs)).toBe(true)
  })

  it('fails closed for a different instance, chat, run, provider, or participant before live validation', () => {
    const { registry, validateOwnership } = createRegistry()
    registry.grantOrReplace(grant())
    const cases: NativeWindowLeaseExecutorContext[] = [
      owner({ instanceEpoch: 'instance-b' }),
      owner({ chatId: 'chat-b' }),
      owner({ runId: 'run-b' }),
      owner({ provider: 'claude' }),
      owner({ participantId: 'operator-b' })
    ]

    for (const foreignOwner of cases) {
      expectCode(() => registry.resolveForExecutor(foreignOwner), 'owner-mismatch')
    }
    expect(validateOwnership).toHaveBeenCalledTimes(1)
    expect(registry.status().lease?.leaseId).toBe('lease-1')
  })

  it('rejects mismatched app instances and stale/replayed consent before replacing a valid lease', () => {
    const { registry } = createRegistry()
    const first = registry.grantOrReplace(grant())

    expectCode(
      () =>
        registry.grantOrReplace(
          grant({ instanceEpoch: 'instance-b', consentEpoch: 'consent-b', consentGeneration: 2 })
        ),
      'instance-epoch-mismatch'
    )
    expectCode(
      () => registry.grantOrReplace(grant({ consentEpoch: 'consent-b', consentGeneration: 1 })),
      'stale-consent-generation'
    )
    expectCode(() => registry.grantOrReplace(grant({ consentGeneration: 2 })), 'consent-replay')

    expect(registry.resolveForExecutor(owner())).toBe(first.lease)
  })

  it('grants a descendant window whose ownership was proved upstream', () => {
    const { registry } = createRegistry()

    const result = registry.grantOrReplace(grant({ selectedPid: 199, ownership: 'descendant' }))

    expect(result.lease).toMatchObject({
      expectedPid: 101,
      selectedPid: 199,
      ownership: 'descendant'
    })
  })

  it('refuses a descendant claim that names the launch process itself', () => {
    const { registry } = createRegistry()

    // Mislabelling an exact match as a descendant would let a caller opt out
    // of the equality rule without ever producing a chain.
    expectCode(
      () => registry.grantOrReplace(grant({ selectedPid: 101, ownership: 'descendant' })),
      'invalid-input'
    )
  })

  it('requires exact picker identity, a canonical process start, user provenance, and known verbs', () => {
    const { registry } = createRegistry()

    expectCode(() => registry.grantOrReplace(grant({ windowId: 0 })), 'invalid-input')
    expectCode(() => registry.grantOrReplace(grant({ selectedPid: 102 })), 'invalid-input')
    expectCode(
      () => registry.grantOrReplace(grant({ selectedPid: 102, ownership: 'nonsense' as never })),
      'invalid-input'
    )
    expectCode(
      () => registry.grantOrReplace(grant({ selectedProcessStartedAt: 'process-start-e\u0301' })),
      'invalid-input'
    )
    expectCode(() => registry.grantOrReplace(grant({ allowedVerbs: [] })), 'invalid-input')
    expectCode(
      () =>
        registry.grantOrReplace(
          grant({
            allowedVerbs: [
              'observe',
              'drag'
            ] as unknown as NativeWindowLeaseGrantInput['allowedVerbs']
          })
        ),
      'invalid-input'
    )
    expectCode(
      () => registry.grantOrReplace(grant({ approvedBy: 'agent' as 'user' })),
      'invalid-input'
    )
    expectCode(() => registry.grantOrReplace(grant({ approvedAt: 10_001 })), 'invalid-input')
  })

  it('does not copy or validate legacy process-group metadata', () => {
    for (const legacyPgid of [undefined, null, 0, 303, 'not-a-pgid']) {
      const { registry } = createRegistry()
      const candidate = { ...grant(), expectedPgid: legacyPgid, selectedPgid: legacyPgid }
      const result = registry.grantOrReplace(candidate)

      expect(result.lease).not.toHaveProperty('expectedPgid')
      expect(result.lease).not.toHaveProperty('selectedPgid')
      expect(registry.resolveForExecutor(owner())).toBe(result.lease)
    }
  })

  it('keeps exactly one active lease and makes replacement plus stale detach eager and harmless', () => {
    const { registry } = createRegistry()
    const first = registry.grantOrReplace(grant())
    const second = registry.grantOrReplace(
      grant({
        consentEpoch: 'consent-b',
        consentGeneration: 2,
        expectedPid: 202,
        selectedPid: 202,
        windowHandleId: 'daemon-window-handle-b'
      })
    )

    expect(second.replaced).toMatchObject({
      reason: 'replaced',
      lease: { leaseId: first.lease.leaseId, windowHandleId: 'daemon-window-handle-a' }
    })
    expect(registry.revokeExact(first.lease.leaseId)).toBeNull()
    expect(registry.resolveForExecutor(owner())).toBe(second.lease)

    expect(registry.revokeExact(second.lease.leaseId)).toMatchObject({
      reason: 'user-detached',
      lease: { windowHandleId: 'daemon-window-handle-b' }
    })
    expect(registry.status().lease).toBeNull()
  })

  it('revokes immediately when live LaunchAttempt/PID ownership cannot be revalidated', () => {
    let allowed = true
    const validateOwnership = vi.fn(() => allowed as true)
    const { registry } = createRegistry({ validateOwnership })
    registry.grantOrReplace(grant())
    allowed = false

    const error = expectCode(
      () => registry.resolveForExecutor(owner()),
      'ownership-validation-failed'
    )
    expect(error.revocation).toMatchObject({
      reason: 'ownership-invalid',
      lease: { windowHandleId: 'daemon-window-handle-a' }
    })
    expect(registry.status().lease).toBeNull()
  })

  it('fails closed on an asynchronous ownership validator', () => {
    const { registry } = createRegistry({
      validateOwnership: (() =>
        Promise.resolve(true)) as unknown as NativeWindowLeaseOwnershipValidator
    })

    const error = expectCode(() => registry.grantOrReplace(grant()), 'async-ownership-validator')
    expect(error.revocation).toBeUndefined()
    expect(registry.status().lease).toBeNull()
  })

  it('returns a main-only expiry revocation so the caller can detach the daemon handle before publishing null', () => {
    const { registry, now } = createRegistry()
    registry.grantOrReplace(grant({ expiresAt: 10_001 }))
    now.value = 10_001

    const status = registry.status()
    expect(status.lease).toBeNull()
    expect(status.expired).toMatchObject({
      reason: 'expired',
      lease: { windowHandleId: 'daemon-window-handle-a' }
    })
    expect(registry.sweepExpired()).toBeNull()
  })

  it('keeps approved observation live after the final control step, then revokes on a later control attempt', () => {
    const { registry } = createRegistry()
    registry.grantOrReplace(grant({ stepBudget: 2 }))

    const first = registry.consumeControlStep(owner(), 'click')
    expect(first).toMatchObject({ stepsRemaining: 1 })
    expect(first).not.toHaveProperty('revokeAfterUse')
    expect(registry.status().lease?.stepsUsed).toBe(1)

    const final = registry.consumeControlStep(owner(), 'fill')
    expect(final.lease.windowHandleId).toBe('daemon-window-handle-a')
    expect(final.stepsRemaining).toBe(0)
    expect(registry.status().lease).toMatchObject({ stepsUsed: 2, stepsRemaining: 0 })
    expect(registry.resolveForExecutor(owner(), 'observe')).toBe(final.lease)

    const exhausted = expectCode(
      () => registry.consumeControlStep(owner(), 'click'),
      'step-budget-exhausted'
    )
    expect(exhausted.revocation).toMatchObject({
      reason: 'step-budget-exhausted',
      lease: { stepsUsed: 2, windowHandleId: 'daemon-window-handle-a' }
    })
    expect(registry.status().lease).toBeNull()
  })

  it('enforces user-approved verbs without consuming a step or invalidating the lease', () => {
    const { registry } = createRegistry()
    registry.grantOrReplace(grant({ allowedVerbs: ['observe', 'click'] }))

    expect(registry.resolveForExecutor(owner(), 'observe').windowId).toBe(42)
    expectCode(() => registry.resolveForExecutor(owner(), 'inspect'), 'verb-not-allowed')
    expectCode(() => registry.consumeControlStep(owner(), 'fill'), 'verb-not-allowed')
    expectCode(
      () => registry.resolveForExecutor(owner(), 'click' as unknown as 'observe'),
      'invalid-input'
    )
    expect(registry.status().lease).toMatchObject({ stepsUsed: 0, stepsRemaining: 2 })
    expect(registry.consumeControlStep(owner(), 'click').stepsRemaining).toBe(1)
  })

  it('revokes only exact terminal run and launch-attempt identities', () => {
    const { registry } = createRegistry()
    const current = registry.grantOrReplace(grant())

    expect(registry.revokeForRun({ chatId: 'chat-b', runId: 'run-a' })).toBeNull()
    expect(registry.revokeForRun({ chatId: 'chat-a', runId: 'run-b' })).toBeNull()
    expect(registry.revokeForLaunchAttempt('attempt-b')).toBeNull()
    expect(registry.status().lease?.leaseId).toBe(current.lease.leaseId)

    expect(registry.revokeForLaunchAttempt('attempt-a')).toMatchObject({
      reason: 'launch-terminal',
      lease: { leaseId: current.lease.leaseId }
    })
    expect(registry.status().lease).toBeNull()
  })
})
