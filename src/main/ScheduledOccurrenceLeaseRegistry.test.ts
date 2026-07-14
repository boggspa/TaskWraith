import { describe, expect, it, vi } from 'vitest'
import {
  ScheduledOccurrenceLeaseError,
  ScheduledOccurrenceLeaseRegistry,
  type ScheduledOccurrenceLease,
  type ScheduledOccurrenceLeaseEntry,
  type ScheduledOccurrenceLeasePayload,
  type ScheduledOccurrenceLeasePayloadSnapshot,
  type ScheduledOccurrenceLeaseRegistryOptions,
  type ScheduledOccurrenceLiveValidator
} from './ScheduledOccurrenceLeaseRegistry'

function createRegistry(
  options: Omit<ScheduledOccurrenceLeaseRegistryOptions, 'validateLive'> & {
    validateLive?: ScheduledOccurrenceLiveValidator
  } = {}
): ScheduledOccurrenceLeaseRegistry {
  return new ScheduledOccurrenceLeaseRegistry({
    ...options,
    validateLive: options.validateLive ?? (() => true as const)
  })
}

function reserveSolo(
  registry: ScheduledOccurrenceLeaseRegistry,
  suffix = 'one',
  runtime: { provider: string | null; runtimeProfileId: string | null } = {
    provider: 'codex',
    runtimeProfileId: 'profile-codex'
  }
): ScheduledOccurrenceLease {
  return registry.reserveRoot({
    taskId: `task-${suffix}`,
    rootRunId: `root-${suffix}`,
    appRunId: `run-${suffix}`,
    sealSignature: `seal-${suffix}`,
    owner: 'solo',
    dispatchAuthorityDigest: `dispatch-${suffix}`,
    ...runtime
  })
}

function payload(
  suffix = 'one',
  overrides: Partial<ScheduledOccurrenceLeasePayload> = {}
): ScheduledOccurrenceLeasePayload {
  return {
    appRunId: `run-${suffix}`,
    provider: 'codex',
    runtimeProfileId: 'profile-codex',
    dispatchAuthorityDigest: `dispatch-${suffix}`,
    ...overrides
  }
}

function expectCode(action: () => unknown, code: ScheduledOccurrenceLeaseError['code']): void {
  try {
    action()
    throw new Error(`Expected ScheduledOccurrenceLeaseError(${code})`)
  } catch (error) {
    expect(error).toBeInstanceOf(ScheduledOccurrenceLeaseError)
    expect((error as ScheduledOccurrenceLeaseError).code).toBe(code)
  }
}

describe('ScheduledOccurrenceLeaseRegistry', () => {
  it('requires a live validator at construction and an opaque in-process lease', () => {
    expectCode(
      () =>
        new ScheduledOccurrenceLeaseRegistry(
          {} as unknown as ScheduledOccurrenceLeaseRegistryOptions
        ),
      'invalid-input'
    )

    const registry = createRegistry()
    const lease = reserveSolo(registry)
    expect(Object.isFrozen(lease)).toBe(true)
    expect(Reflect.ownKeys(lease)).not.toContain('taskId')
    expect(Reflect.ownKeys(lease)).not.toContain('appRunId')
    expect(() => JSON.stringify(lease)).toThrow('cannot be serialized')
    expect(() => structuredClone(lease)).toThrow()
  })

  it('allows an ordinary run explicitly while rejecting every lease asymmetry', () => {
    const validateLive = vi.fn(() => true as const)
    const registry = createRegistry({ validateLive })
    const first = reserveSolo(registry, 'first')
    const second = reserveSolo(registry, 'second')
    const forged = Object.freeze({}) as ScheduledOccurrenceLease

    const ordinaryPayload = payload('ordinary', { dispatchAuthorityDigest: null })
    const ordinary = registry.assertAndStart(undefined, ordinaryPayload)
    expect(ordinary).toEqual({ kind: 'ordinary', payload: ordinaryPayload })
    expect(Object.isFrozen(ordinary)).toBe(true)
    expect(Object.isFrozen(ordinary.payload)).toBe(true)
    expect(validateLive).not.toHaveBeenCalled()

    expectCode(
      () => registry.assertAndStart(undefined, payload('ordinary-authority')),
      'payload-mismatch'
    )
    expectCode(() => registry.assertAndStart(forged, ordinaryPayload), 'unknown-lease')
    expectCode(() => registry.assertAndStart(undefined, payload('first')), 'lease-required')
    expectCode(() => registry.assertAndStart(first, payload('second')), 'lease-mismatch')

    expect(registry.assertAndStart(second, payload('second')).kind).toBe('scheduled')
  })

  it('requires exact provider and runtime-profile bindings, including explicit null', () => {
    const registry = createRegistry()
    const lease = reserveSolo(registry)

    expectCode(
      () => registry.assertAndStart(lease, payload('one', { provider: 'claude' })),
      'payload-mismatch'
    )
    expectCode(
      () =>
        registry.assertAndStart(lease, {
          appRunId: 'run-one',
          provider: 'codex'
        } as ScheduledOccurrenceLeasePayload),
      'invalid-input'
    )
    expectCode(
      () => registry.assertAndStart(lease, payload('one', { runtimeProfileId: null })),
      'payload-mismatch'
    )
    expectCode(
      () =>
        registry.assertAndStart(
          lease,
          payload('one', { dispatchAuthorityDigest: 'tampered-dispatch-authority' })
        ),
      'payload-mismatch'
    )

    expect(registry.assertAndStart(lease, payload()).kind).toBe('scheduled')

    const nullLease = reserveSolo(registry, 'null', {
      provider: null,
      runtimeProfileId: null
    })
    expectCode(
      () =>
        registry.assertAndStart(nullLease, {
          appRunId: 'run-null',
          provider: 'codex',
          runtimeProfileId: null,
          dispatchAuthorityDigest: 'dispatch-null'
        }),
      'payload-mismatch'
    )
    expect(
      registry.assertAndStart(nullLease, {
        appRunId: 'run-null',
        provider: null,
        runtimeProfileId: null,
        dispatchAuthorityDigest: 'dispatch-null'
      }).kind
    ).toBe('scheduled')
  })

  it('snapshots caller-owned scalars once and returns the exact frozen object validated', () => {
    const reads = { appRunId: 0, provider: 0, runtimeProfileId: 0, dispatchAuthorityDigest: 0 }
    let validatedPayload: ScheduledOccurrenceLeasePayloadSnapshot | undefined
    const registry = createRegistry({
      validateLive: (_entry, checkedPayload) => {
        validatedPayload = checkedPayload
        return true
      }
    })
    const lease = reserveSolo(registry)
    const mutableValues = {
      appRunId: 'run-one',
      provider: 'codex',
      runtimeProfileId: 'profile-codex',
      dispatchAuthorityDigest: 'dispatch-one'
    }
    const callerOwnedPayload = {
      get appRunId() {
        reads.appRunId += 1
        return mutableValues.appRunId
      },
      get provider() {
        reads.provider += 1
        return mutableValues.provider
      },
      get runtimeProfileId() {
        reads.runtimeProfileId += 1
        return mutableValues.runtimeProfileId
      },
      get dispatchAuthorityDigest() {
        reads.dispatchAuthorityDigest += 1
        return mutableValues.dispatchAuthorityDigest
      }
    }

    const result = registry.assertAndStart(lease, callerOwnedPayload)
    mutableValues.provider = 'claude'
    mutableValues.runtimeProfileId = 'changed-after-start'
    mutableValues.dispatchAuthorityDigest = 'changed-after-start'

    expect(reads).toEqual({
      appRunId: 1,
      provider: 1,
      runtimeProfileId: 1,
      dispatchAuthorityDigest: 1
    })
    expect(result.kind).toBe('scheduled')
    expect(result.payload).toBe(validatedPayload)
    expect(Object.isFrozen(result.payload)).toBe(true)
    expect(result.payload).toEqual({
      appRunId: 'run-one',
      provider: 'codex',
      runtimeProfileId: 'profile-codex',
      dispatchAuthorityDigest: 'dispatch-one'
    })
  })

  it('fails closed unless durable validation returns literal true', () => {
    const invalidResults: Array<{
      label: string
      validator: ScheduledOccurrenceLiveValidator
      code: ScheduledOccurrenceLeaseError['code']
    }> = [
      {
        label: 'void',
        validator: (() => undefined) as unknown as ScheduledOccurrenceLiveValidator,
        code: 'live-validation-failed'
      },
      {
        label: 'false',
        validator: (() => false) as unknown as ScheduledOccurrenceLiveValidator,
        code: 'live-validation-failed'
      },
      {
        label: 'truthy object',
        validator: (() => ({})) as unknown as ScheduledOccurrenceLiveValidator,
        code: 'live-validation-failed'
      },
      {
        label: 'thenable',
        validator: (() => Promise.resolve(true)) as unknown as ScheduledOccurrenceLiveValidator,
        code: 'async-live-validator'
      }
    ]

    for (const candidate of invalidResults) {
      const registry = createRegistry({ validateLive: candidate.validator })
      const lease = reserveSolo(registry, candidate.label)
      expectCode(() => registry.assertAndStart(lease, payload(candidate.label)), candidate.code)
      expect(registry.taskIdForRun(`run-${candidate.label}`), candidate.label).toBe(
        `task-${candidate.label}`
      )
    }
  })

  it('blocks validation and mutation reentrancy registry-wide, not merely per lease', () => {
    let action: 'mutate' | 'validate' | 'none' = 'none'
    const validateLive: ScheduledOccurrenceLiveValidator = () => {
      if (action === 'mutate') registry.abortReserved(mutationTarget)
      if (action === 'validate') registry.validateLive(validationTarget, payload('validation'))
      return true
    }
    const registry = createRegistry({ validateLive })
    const source = reserveSolo(registry, 'source')
    const mutationTarget = reserveSolo(registry, 'mutation')
    const validationTarget = reserveSolo(registry, 'validation')

    action = 'mutate'
    expectCode(() => registry.assertAndStart(source, payload('source')), 'reentrant-validation')
    action = 'validate'
    expectCode(() => registry.assertAndStart(source, payload('source')), 'reentrant-validation')

    action = 'none'
    expect(registry.assertAndStart(source, payload('source')).kind).toBe('scheduled')
    expect(registry.assertAndStart(mutationTarget, payload('mutation')).kind).toBe('scheduled')
    expect(registry.assertAndStart(validationTarget, payload('validation')).kind).toBe('scheduled')
  })

  it('requires a started loop root and permits only loop-step children', () => {
    const registry = createRegistry()
    const root = registry.reserveRoot({
      taskId: 'task-loop',
      rootRunId: 'root-loop',
      appRunId: 'run-loop-root',
      sealSignature: 'seal-loop',
      owner: 'loop-root',
      provider: 'codex',
      runtimeProfileId: null,
      dispatchAuthorityDigest: 'dispatch-loop-root'
    })

    expectCode(
      () =>
        registry.reserveChild(root, {
          appRunId: 'run-step-early',
          owner: { kind: 'loop-step', stepId: 'step-early' },
          provider: 'grok',
          runtimeProfileId: null,
          dispatchAuthorityDigest: 'dispatch-step-early'
        }),
      'root-not-started'
    )
    registry.assertAndStart(root, {
      appRunId: 'run-loop-root',
      provider: 'codex',
      runtimeProfileId: null,
      dispatchAuthorityDigest: 'dispatch-loop-root'
    })
    const step = registry.reserveChild(root, {
      appRunId: 'run-step-one',
      owner: { kind: 'loop-step', stepId: 'step-one' },
      provider: 'grok',
      runtimeProfileId: 'grok-loop',
      dispatchAuthorityDigest: 'dispatch-step-one'
    })
    expectCode(
      () =>
        registry.reserveChild(root, {
          appRunId: 'run-seat-wrong',
          owner: {
            kind: 'ensemble-seat',
            roundId: 'round-one',
            participantId: 'participant-one'
          },
          provider: 'codex',
          runtimeProfileId: null,
          dispatchAuthorityDigest: 'dispatch-seat-wrong'
        }),
      'owner-mismatch'
    )

    expect(
      registry.assertAndStart(step, {
        appRunId: 'run-step-one',
        provider: 'grok',
        runtimeProfileId: 'grok-loop',
        dispatchAuthorityDigest: 'dispatch-step-one'
      }).kind
    ).toBe('scheduled')
  })

  it('permits only ensemble-seat children for a started ensemble root', () => {
    const observed: ScheduledOccurrenceLeaseEntry[] = []
    const registry = createRegistry({
      validateLive: (entry) => {
        observed.push(entry)
        return true
      }
    })
    const root = registry.reserveRoot({
      taskId: 'task-ensemble',
      rootRunId: 'root-ensemble',
      appRunId: 'run-ensemble-root',
      sealSignature: 'seal-ensemble',
      owner: 'ensemble-root',
      provider: null,
      runtimeProfileId: null,
      dispatchAuthorityDigest: 'dispatch-ensemble-root'
    })
    registry.assertAndStart(root, {
      appRunId: 'run-ensemble-root',
      provider: null,
      runtimeProfileId: null,
      dispatchAuthorityDigest: 'dispatch-ensemble-root'
    })
    const seat = registry.reserveChild(root, {
      appRunId: 'run-seat-one',
      owner: {
        kind: 'ensemble-seat',
        roundId: 'round-one',
        participantId: 'participant-one',
        laneId: 'fanout-one'
      },
      provider: 'claude',
      runtimeProfileId: 'claude-seat',
      dispatchAuthorityDigest: 'dispatch-seat-one'
    })
    expectCode(
      () =>
        registry.reserveChild(root, {
          appRunId: 'run-step-wrong',
          owner: { kind: 'loop-step', stepId: 'step-one' },
          provider: 'codex',
          runtimeProfileId: null,
          dispatchAuthorityDigest: 'dispatch-step-wrong'
        }),
      'owner-mismatch'
    )

    registry.validateLive(seat, {
      appRunId: 'run-seat-one',
      provider: 'claude',
      runtimeProfileId: 'claude-seat',
      dispatchAuthorityDigest: 'dispatch-seat-one'
    })
    expect(observed.at(-1)).toMatchObject({
      binding: {
        kind: 'child',
        provider: 'claude',
        runtimeProfileId: 'claude-seat',
        dispatchAuthorityDigest: 'dispatch-seat-one',
        owner: {
          kind: 'ensemble-seat',
          roundId: 'round-one',
          participantId: 'participant-one',
          laneId: 'fanout-one'
        }
      },
      rootBinding: {
        owner: 'ensemble-root',
        provider: null,
        runtimeProfileId: null,
        dispatchAuthorityDigest: 'dispatch-ensemble-root'
      }
    })
  })

  it('never lets a solo root mint children, even after it starts', () => {
    const registry = createRegistry()
    const root = reserveSolo(registry)
    registry.assertAndStart(root, payload())

    expectCode(
      () =>
        registry.reserveChild(root, {
          appRunId: 'run-solo-step',
          owner: { kind: 'loop-step', stepId: 'step-one' },
          provider: 'codex',
          runtimeProfileId: null,
          dispatchAuthorityDigest: 'dispatch-solo-step'
        }),
      'owner-mismatch'
    )
    expectCode(
      () =>
        registry.reserveChild(root, {
          appRunId: 'run-solo-seat',
          owner: {
            kind: 'ensemble-seat',
            roundId: 'round-one',
            participantId: 'participant-one'
          },
          provider: 'codex',
          runtimeProfileId: null,
          dispatchAuthorityDigest: 'dispatch-solo-seat'
        }),
      'owner-mismatch'
    )
  })

  it('enforces unique run aliases and cascades root revocation to children', () => {
    const registry = createRegistry()
    const root = registry.reserveRoot({
      taskId: 'task-loop',
      rootRunId: 'root-loop',
      appRunId: 'run-loop',
      sealSignature: 'seal-loop',
      owner: 'loop-root',
      provider: 'codex',
      runtimeProfileId: null,
      dispatchAuthorityDigest: 'dispatch-loop'
    })
    registry.assertAndStart(root, {
      appRunId: 'run-loop',
      provider: 'codex',
      runtimeProfileId: null,
      dispatchAuthorityDigest: 'dispatch-loop'
    })
    const child = registry.reserveChild(root, {
      appRunId: 'run-step',
      owner: { kind: 'loop-step', stepId: 'step-one' },
      provider: 'grok',
      runtimeProfileId: null,
      dispatchAuthorityDigest: 'dispatch-step'
    })

    expect(registry.taskIdForRun('root-loop')).toBe('task-loop')
    expect(registry.taskIdForRun('run-step')).toBe('task-loop')
    expectCode(
      () =>
        registry.reserveChild(root, {
          appRunId: 'root-loop',
          owner: { kind: 'loop-step', stepId: 'duplicate' },
          provider: 'grok',
          runtimeProfileId: null,
          dispatchAuthorityDigest: 'dispatch-duplicate'
        }),
      'duplicate-run-id'
    )

    expect(registry.revokeRoot(root)).toBe(true)
    expect(registry.revokeRoot(root)).toBe(false)
    expectCode(
      () =>
        registry.assertAndStart(child, {
          appRunId: 'run-step',
          provider: 'grok',
          runtimeProfileId: null,
          dispatchAuthorityDigest: 'dispatch-step'
        }),
      'lease-not-reserved'
    )
  })

  it('requires children to finish before a started root can terminate', () => {
    const registry = createRegistry()
    const root = registry.reserveRoot({
      taskId: 'task-loop',
      rootRunId: 'root-loop',
      appRunId: 'run-loop',
      sealSignature: 'seal-loop',
      owner: 'loop-root',
      provider: 'codex',
      runtimeProfileId: null,
      dispatchAuthorityDigest: 'dispatch-loop'
    })
    registry.assertAndStart(root, {
      appRunId: 'run-loop',
      provider: 'codex',
      runtimeProfileId: null,
      dispatchAuthorityDigest: 'dispatch-loop'
    })
    const child = registry.reserveChild(root, {
      appRunId: 'run-step',
      owner: { kind: 'loop-step', stepId: 'step-one' },
      provider: 'grok',
      runtimeProfileId: null,
      dispatchAuthorityDigest: 'dispatch-step'
    })
    registry.assertAndStart(child, {
      appRunId: 'run-step',
      provider: 'grok',
      runtimeProfileId: null,
      dispatchAuthorityDigest: 'dispatch-step'
    })

    expectCode(() => registry.markTerminal(root), 'live-children')
    expect(registry.markTerminal(child)).toBe(true)
    expect(registry.markTerminal(child)).toBe(false)
    expect(registry.markTerminal(root)).toBe(true)
  })

  it('keeps recent terminal ids as bounded tombstones instead of evicting replay evidence', () => {
    let now = 100
    const registry = createRegistry({ maxEntries: 2, tombstoneTtlMs: 50, now: () => now })
    const first = reserveSolo(registry, 'first')
    registry.assertAndStart(first, payload('first'))
    registry.markTerminal(first)
    const second = reserveSolo(registry, 'second')
    registry.abortReserved(second)

    expect(registry.taskIdForRun('run-first')).toBe('task-first')
    expectCode(() => registry.assertAndStart(undefined, payload('first')), 'lease-required')
    expectCode(() => reserveSolo(registry, 'third'), 'capacity-exhausted')

    now = 151
    expect(registry.taskIdForRun('run-first')).toBeUndefined()
    expect(
      registry.assertAndStart(undefined, payload('first', { dispatchAuthorityDigest: null })).kind
    ).toBe('ordinary')
    expect(reserveSolo(registry, 'third')).toBeDefined()
  })

  it('aborts only unused reservations and keeps their ids replay-protected', () => {
    const registry = createRegistry()
    const reserved = reserveSolo(registry, 'reserved')
    expect(registry.abortReserved(reserved)).toBe(true)
    expect(registry.abortReserved(reserved)).toBe(false)
    expectCode(() => registry.assertAndStart(undefined, payload('reserved')), 'lease-required')

    const started = reserveSolo(registry, 'started')
    registry.assertAndStart(started, payload('started'))
    expectCode(() => registry.abortReserved(started), 'invalid-transition')
  })
})
