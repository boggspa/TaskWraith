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

  it('reserves root ownership before preflight and binds final runtime authority once', () => {
    const observed: Array<{
      entry: ScheduledOccurrenceLeaseEntry
      payload: ScheduledOccurrenceLeasePayloadSnapshot
    }> = []
    const registry = createRegistry({
      validateLive: (entry, checkedPayload) => {
        observed.push({ entry, payload: checkedPayload })
        return true
      }
    })
    const lease = registry.reserveRootOwnership({
      taskId: 'task-late-root',
      rootRunId: 'root-late-root',
      sealSignature: 'seal-late-root',
      owner: 'solo'
    })

    expect(registry.taskIdForRun('root-late-root')).toBe('task-late-root')
    expect(registry.taskIdForRun('run-late-root')).toBeUndefined()
    expectCode(
      () =>
        registry.validateLive(lease, {
          appRunId: 'run-late-root',
          provider: 'codex',
          runtimeProfileId: 'profile-late-root',
          dispatchAuthorityDigest: 'dispatch-late-root'
        }),
      'lease-not-bound'
    )

    const result = registry.bindAndStart(lease, {
      appRunId: 'run-late-root',
      provider: 'codex',
      runtimeProfileId: 'profile-late-root',
      dispatchAuthorityDigest: 'dispatch-late-root'
    })

    expect(result).toEqual({
      kind: 'scheduled',
      payload: {
        appRunId: 'run-late-root',
        provider: 'codex',
        runtimeProfileId: 'profile-late-root',
        dispatchAuthorityDigest: 'dispatch-late-root'
      }
    })
    expect(registry.taskIdForRun('run-late-root')).toBe('task-late-root')
    expect(observed).toHaveLength(1)
    expect(observed[0]?.entry).toMatchObject({
      state: 'reserved',
      binding: {
        kind: 'root',
        taskId: 'task-late-root',
        rootRunId: 'root-late-root',
        appRunId: 'run-late-root',
        sealSignature: 'seal-late-root',
        owner: 'solo',
        provider: 'codex',
        runtimeProfileId: 'profile-late-root',
        dispatchAuthorityDigest: 'dispatch-late-root'
      }
    })
    expect(observed[0]?.entry.binding).toBe(observed[0]?.entry.rootBinding)
    expect(observed[0]?.payload).toBe(result.payload)
    expect(Object.isFrozen(observed[0]?.entry.binding)).toBe(true)
  })

  it('admits a late root exactly once without binding runtime authority', () => {
    const registry = createRegistry()
    const lease = registry.reserveRootOwnership({
      taskId: 'task-admitted-root',
      rootRunId: 'root-admitted-root',
      sealSignature: 'seal-admitted-root',
      owner: 'solo'
    })
    const admittedBinding = {
      appRunId: 'run-admitted-root',
      provider: 'codex',
      runtimeProfileId: 'profile-admitted-root',
      dispatchAuthorityDigest: 'dispatch-admitted-root'
    } as const

    const admission = registry.admitAdapterEntry(lease, {
      taskId: 'task-admitted-root',
      appRunId: admittedBinding.appRunId
    })

    expect(admission).toBe(true)
    expect(admission).not.toHaveProperty('then')
    expect(registry.taskIdForRun(admittedBinding.appRunId)).toBe('task-admitted-root')
    expectCode(() => registry.validateLive(lease, admittedBinding), 'lease-not-bound')
    expectCode(
      () =>
        registry.assertAndStart(undefined, {
          ...admittedBinding,
          provider: null,
          runtimeProfileId: null,
          dispatchAuthorityDigest: null
        }),
      'lease-required'
    )
    expectCode(
      () =>
        registry.bindAndStart(lease, {
          ...admittedBinding,
          appRunId: 'run-not-admitted'
        }),
      'lease-mismatch'
    )
    expect(registry.taskIdForRun('run-not-admitted')).toBeUndefined()
    expect(registry.bindAndStart(lease, admittedBinding).kind).toBe('scheduled')
  })

  it('admits late child ownership and constrains its eventual binding', () => {
    const registry = createRegistry()
    const root = registry.reserveRootOwnership({
      taskId: 'task-admitted-child',
      rootRunId: 'root-admitted-child',
      sealSignature: 'seal-admitted-child',
      owner: 'loop-root'
    })
    registry.admitAdapterEntry(root, {
      taskId: 'task-admitted-child',
      appRunId: 'run-admitted-child-root'
    })
    registry.bindAndStart(root, {
      appRunId: 'run-admitted-child-root',
      provider: 'codex',
      runtimeProfileId: null,
      dispatchAuthorityDigest: 'dispatch-admitted-child-root'
    })
    const child = registry.reserveChildOwnership(root, {
      owner: { kind: 'loop-step', stepId: 'admitted-step' }
    })

    expectCode(
      () =>
        registry.admitAdapterEntry(child, {
          taskId: 'task-wrong-child',
          appRunId: 'run-admitted-child'
        }),
      'lease-mismatch'
    )
    expect(registry.taskIdForRun('run-admitted-child')).toBeUndefined()
    expect(
      registry.admitAdapterEntry(child, {
        taskId: 'task-admitted-child',
        appRunId: 'run-admitted-child'
      })
    ).toBe(true)
    expectCode(
      () =>
        registry.bindAndStart(child, {
          appRunId: 'run-wrong-child',
          provider: 'grok',
          runtimeProfileId: null,
          dispatchAuthorityDigest: 'dispatch-admitted-child'
        }),
      'lease-mismatch'
    )
    expect(
      registry.bindAndStart(child, {
        appRunId: 'run-admitted-child',
        provider: 'grok',
        runtimeProfileId: null,
        dispatchAuthorityDigest: 'dispatch-admitted-child'
      }).kind
    ).toBe('scheduled')
  })

  it('rejects adapter replay and cross-entry run collisions without partial admission', () => {
    const registry = createRegistry()
    const first = registry.reserveRootOwnership({
      taskId: 'task-admission-first',
      rootRunId: 'root-admission-first',
      sealSignature: 'seal-admission-first',
      owner: 'solo'
    })
    const second = registry.reserveRootOwnership({
      taskId: 'task-admission-second',
      rootRunId: 'root-admission-second',
      sealSignature: 'seal-admission-second',
      owner: 'solo'
    })
    registry.admitAdapterEntry(first, {
      taskId: 'task-admission-first',
      appRunId: 'run-shared-admission'
    })

    expectCode(
      () =>
        registry.admitAdapterEntry(first, {
          taskId: 'task-admission-first',
          appRunId: 'run-shared-admission'
        }),
      'adapter-entry-replay'
    )
    expectCode(
      () =>
        registry.admitAdapterEntry(first, {
          taskId: 'task-admission-first',
          appRunId: 'run-alternate-replay'
        }),
      'adapter-entry-replay'
    )
    expectCode(
      () =>
        registry.admitAdapterEntry(second, {
          taskId: 'task-admission-second',
          appRunId: 'run-shared-admission'
        }),
      'duplicate-run-id'
    )
    expect(registry.taskIdForRun('run-alternate-replay')).toBeUndefined()
    expect(
      registry.admitAdapterEntry(second, {
        taskId: 'task-admission-second',
        appRunId: 'run-admission-second'
      })
    ).toBe(true)
  })

  it('requires exact admission scalars and snapshots each one once', () => {
    const reads = { taskId: 0, appRunId: 0 }
    const registry = createRegistry()
    const lease = registry.reserveRootOwnership({
      taskId: 'task-exact-admission',
      rootRunId: 'root-exact-admission',
      sealSignature: 'seal-exact-admission',
      owner: 'solo'
    })
    const input = {
      get taskId() {
        reads.taskId += 1
        return 'task-exact-admission'
      },
      get appRunId() {
        reads.appRunId += 1
        return 'run-exact-admission'
      }
    }

    expectCode(
      () =>
        registry.admitAdapterEntry(lease, {
          taskId: ' task-exact-admission',
          appRunId: 'run-exact-admission'
        }),
      'invalid-input'
    )
    expectCode(
      () =>
        registry.admitAdapterEntry(lease, {
          taskId: 'task-exact-admission',
          appRunId: Promise.resolve('run-exact-admission')
        } as unknown as { taskId: string; appRunId: string }),
      'invalid-input'
    )
    expect(registry.admitAdapterEntry(lease, input)).toBe(true)
    expect(reads).toEqual({ taskId: 1, appRunId: 1 })
  })

  it('rejects admission after abort, revoke, start, or terminal transition', () => {
    const registry = createRegistry()
    const reserve = (suffix: string) =>
      registry.reserveRootOwnership({
        taskId: `task-${suffix}`,
        rootRunId: `root-${suffix}`,
        sealSignature: `seal-${suffix}`,
        owner: 'solo'
      })

    const aborted = reserve('admission-aborted')
    registry.abortReserved(aborted)
    expectCode(
      () =>
        registry.admitAdapterEntry(aborted, {
          taskId: 'task-admission-aborted',
          appRunId: 'run-admission-aborted'
        }),
      'lease-not-reserved'
    )

    const revoked = reserve('admission-revoked')
    registry.revokeRoot(revoked)
    expectCode(
      () =>
        registry.admitAdapterEntry(revoked, {
          taskId: 'task-admission-revoked',
          appRunId: 'run-admission-revoked'
        }),
      'lease-not-reserved'
    )

    const terminal = reserve('admission-terminal')
    registry.admitAdapterEntry(terminal, {
      taskId: 'task-admission-terminal',
      appRunId: 'run-admission-terminal'
    })
    registry.bindAndStart(terminal, {
      appRunId: 'run-admission-terminal',
      provider: 'codex',
      runtimeProfileId: null,
      dispatchAuthorityDigest: 'dispatch-admission-terminal'
    })
    expectCode(
      () =>
        registry.admitAdapterEntry(terminal, {
          taskId: 'task-admission-terminal',
          appRunId: 'run-admission-terminal'
        }),
      'lease-not-reserved'
    )
    registry.markTerminal(terminal)
    expectCode(
      () =>
        registry.admitAdapterEntry(terminal, {
          taskId: 'task-admission-terminal',
          appRunId: 'run-admission-terminal'
        }),
      'lease-not-reserved'
    )
  })

  it('retains admitted run ids through tombstones and releases them only after expiry', () => {
    let now = 100
    const registry = createRegistry({ tombstoneTtlMs: 50, now: () => now })
    const lease = registry.reserveRootOwnership({
      taskId: 'task-admission-tombstone',
      rootRunId: 'root-admission-tombstone',
      sealSignature: 'seal-admission-tombstone',
      owner: 'solo'
    })
    registry.admitAdapterEntry(lease, {
      taskId: 'task-admission-tombstone',
      appRunId: 'run-admission-tombstone'
    })
    registry.abortReserved(lease)

    expectCode(
      () =>
        registry.assertAndStart(undefined, {
          appRunId: 'run-admission-tombstone',
          provider: null,
          runtimeProfileId: null,
          dispatchAuthorityDigest: null
        }),
      'lease-required'
    )
    const collision = registry.reserveRootOwnership({
      taskId: 'task-admission-collision',
      rootRunId: 'root-admission-collision',
      sealSignature: 'seal-admission-collision',
      owner: 'solo'
    })
    expectCode(
      () =>
        registry.admitAdapterEntry(collision, {
          taskId: 'task-admission-collision',
          appRunId: 'run-admission-tombstone'
        }),
      'duplicate-run-id'
    )

    now = 151
    expect(registry.taskIdForRun('run-admission-tombstone')).toBeUndefined()
    expect(
      registry.assertAndStart(undefined, {
        appRunId: 'run-admission-tombstone',
        provider: null,
        runtimeProfileId: null,
        dispatchAuthorityDigest: null
      }).kind
    ).toBe('ordinary')
    expect(
      registry.admitAdapterEntry(collision, {
        taskId: 'task-admission-collision',
        appRunId: 'run-admission-tombstone'
      })
    ).toBe(true)
  })

  it('blocks admission getter reentrancy without registering either prospective run', () => {
    const registry = createRegistry()
    const outer = registry.reserveRootOwnership({
      taskId: 'task-admission-outer',
      rootRunId: 'root-admission-outer',
      sealSignature: 'seal-admission-outer',
      owner: 'solo'
    })
    const nested = registry.reserveRootOwnership({
      taskId: 'task-admission-nested',
      rootRunId: 'root-admission-nested',
      sealSignature: 'seal-admission-nested',
      owner: 'solo'
    })
    const reentrant = {
      taskId: 'task-admission-outer',
      get appRunId() {
        registry.admitAdapterEntry(nested, {
          taskId: 'task-admission-nested',
          appRunId: 'run-admission-nested'
        })
        return 'run-admission-outer'
      }
    }

    expectCode(() => registry.admitAdapterEntry(outer, reentrant), 'reentrant-validation')
    expect(registry.taskIdForRun('run-admission-outer')).toBeUndefined()
    expect(registry.taskIdForRun('run-admission-nested')).toBeUndefined()
    expect(
      registry.admitAdapterEntry(outer, {
        taskId: 'task-admission-outer',
        appRunId: 'run-admission-outer'
      })
    ).toBe(true)
    expect(
      registry.admitAdapterEntry(nested, {
        taskId: 'task-admission-nested',
        appRunId: 'run-admission-nested'
      })
    ).toBe(true)
  })

  it('fixes a late binding before live validation and never permits rebinding it', () => {
    let validationSucceeds = false
    const registry = createRegistry({
      validateLive: () => {
        if (!validationSucceeds) {
          return false as unknown as true
        }
        return true
      }
    })
    const lease = registry.reserveRootOwnership({
      taskId: 'task-fixed',
      rootRunId: 'root-fixed',
      sealSignature: 'seal-fixed',
      owner: 'solo'
    })
    const finalBinding = {
      appRunId: 'run-fixed',
      provider: 'grok',
      runtimeProfileId: null,
      dispatchAuthorityDigest: 'dispatch-fixed'
    } as const

    expectCode(() => registry.bindAndStart(lease, finalBinding), 'live-validation-failed')
    expect(registry.taskIdForRun('run-fixed')).toBe('task-fixed')
    expectCode(
      () => registry.bindAndStart(lease, { ...finalBinding, appRunId: 'run-rebound' }),
      'lease-mismatch'
    )
    expectCode(
      () => registry.bindAndStart(lease, { ...finalBinding, provider: 'codex' }),
      'payload-mismatch'
    )

    validationSucceeds = true
    expect(registry.bindAndStart(lease, finalBinding).kind).toBe('scheduled')
    expectCode(() => registry.bindAndStart(lease, finalBinding), 'lease-not-reserved')
  })

  it('snapshots every final binding scalar once before fixing it', () => {
    const reads = { appRunId: 0, provider: 0, runtimeProfileId: 0, dispatchAuthorityDigest: 0 }
    const registry = createRegistry()
    const lease = registry.reserveRootOwnership({
      taskId: 'task-getters',
      rootRunId: 'root-getters',
      sealSignature: 'seal-getters',
      owner: 'solo'
    })
    const source = {
      get appRunId() {
        reads.appRunId += 1
        return 'run-getters'
      },
      get provider() {
        reads.provider += 1
        return 'claude'
      },
      get runtimeProfileId() {
        reads.runtimeProfileId += 1
        return 'profile-getters'
      },
      get dispatchAuthorityDigest() {
        reads.dispatchAuthorityDigest += 1
        return 'dispatch-getters'
      }
    }

    const result = registry.bindAndStart(lease, source)

    expect(reads).toEqual({
      appRunId: 1,
      provider: 1,
      runtimeProfileId: 1,
      dispatchAuthorityDigest: 1
    })
    expect(Object.isFrozen(result.payload)).toBe(true)
    expect(result.payload).toEqual({
      appRunId: 'run-getters',
      provider: 'claude',
      runtimeProfileId: 'profile-getters',
      dispatchAuthorityDigest: 'dispatch-getters'
    })
  })

  it('blocks ownership getter reentrancy before consuming capacity or run ids', () => {
    const registry = createRegistry({ maxEntries: 1 })
    const reentrantOwnership = {
      get taskId() {
        registry.reserveRootOwnership({
          taskId: 'task-nested-owner',
          rootRunId: 'root-nested-owner',
          sealSignature: 'seal-nested-owner',
          owner: 'solo'
        })
        return 'task-outer-owner'
      },
      rootRunId: 'root-outer-owner',
      sealSignature: 'seal-outer-owner',
      owner: 'solo' as const
    }

    expectCode(() => registry.reserveRootOwnership(reentrantOwnership), 'reentrant-validation')
    expect(registry.taskIdForRun('root-outer-owner')).toBeUndefined()
    expect(registry.taskIdForRun('root-nested-owner')).toBeUndefined()
    expect(
      registry.reserveRootOwnership({
        taskId: 'task-after-reentry',
        rootRunId: 'root-after-reentry',
        sealSignature: 'seal-after-reentry',
        owner: 'solo'
      })
    ).toBeDefined()
  })

  it('keeps aborted and revoked unbound ownership reservations unusable', () => {
    const registry = createRegistry()
    const aborted = registry.reserveRootOwnership({
      taskId: 'task-aborted-late',
      rootRunId: 'root-aborted-late',
      sealSignature: 'seal-aborted-late',
      owner: 'solo'
    })
    expect(registry.abortReserved(aborted)).toBe(true)
    expectCode(
      () =>
        registry.bindAndStart(aborted, {
          appRunId: 'run-aborted-late',
          provider: 'codex',
          runtimeProfileId: null,
          dispatchAuthorityDigest: 'dispatch-aborted-late'
        }),
      'lease-not-reserved'
    )

    const revoked = registry.reserveRootOwnership({
      taskId: 'task-revoked-late',
      rootRunId: 'root-revoked-late',
      sealSignature: 'seal-revoked-late',
      owner: 'solo'
    })
    expect(registry.revokeRoot(revoked)).toBe(true)
    expectCode(
      () =>
        registry.bindAndStart(revoked, {
          appRunId: 'run-revoked-late',
          provider: 'codex',
          runtimeProfileId: null,
          dispatchAuthorityDigest: 'dispatch-revoked-late'
        }),
      'lease-not-reserved'
    )
    expect(registry.taskIdForRun('root-aborted-late')).toBe('task-aborted-late')
    expect(registry.taskIdForRun('root-revoked-late')).toBe('task-revoked-late')
  })

  it('reserves child ownership without runtime authority and blocks root termination', () => {
    const observed: ScheduledOccurrenceLeaseEntry[] = []
    const registry = createRegistry({
      validateLive: (entry) => {
        observed.push(entry)
        return true
      }
    })
    const root = registry.reserveRoot({
      taskId: 'task-late-child',
      rootRunId: 'root-late-child',
      appRunId: 'run-late-child-root',
      sealSignature: 'seal-late-child',
      owner: 'loop-root',
      provider: 'codex',
      runtimeProfileId: 'profile-root',
      dispatchAuthorityDigest: 'dispatch-late-child-root'
    })
    registry.assertAndStart(root, {
      appRunId: 'run-late-child-root',
      provider: 'codex',
      runtimeProfileId: 'profile-root',
      dispatchAuthorityDigest: 'dispatch-late-child-root'
    })
    const child = registry.reserveChildOwnership(root, {
      owner: { kind: 'loop-step', stepId: 'late-step' }
    })

    expectCode(() => registry.markTerminal(root), 'live-children')
    expectCode(
      () =>
        registry.validateLive(child, {
          appRunId: 'run-late-step',
          provider: 'grok',
          runtimeProfileId: null,
          dispatchAuthorityDigest: 'dispatch-late-step'
        }),
      'lease-not-bound'
    )
    expect(
      registry.bindAndStart(child, {
        appRunId: 'run-late-step',
        provider: 'grok',
        runtimeProfileId: null,
        dispatchAuthorityDigest: 'dispatch-late-step'
      }).kind
    ).toBe('scheduled')
    expect(observed.at(-1)).toMatchObject({
      state: 'reserved',
      binding: {
        kind: 'child',
        taskId: 'task-late-child',
        rootRunId: 'root-late-child',
        rootAppRunId: 'run-late-child-root',
        appRunId: 'run-late-step',
        owner: { kind: 'loop-step', stepId: 'late-step' },
        provider: 'grok',
        runtimeProfileId: null,
        dispatchAuthorityDigest: 'dispatch-late-step'
      }
    })
    expect(registry.markTerminal(child)).toBe(true)
    expect(registry.markTerminal(root)).toBe(true)
  })

  it('applies root-start, root-kind, and owner compatibility to child ownership reservations', () => {
    const registry = createRegistry()
    const root = registry.reserveRootOwnership({
      taskId: 'task-child-guards',
      rootRunId: 'root-child-guards',
      sealSignature: 'seal-child-guards',
      owner: 'loop-root'
    })
    expectCode(
      () =>
        registry.reserveChildOwnership(root, {
          owner: { kind: 'loop-step', stepId: 'too-early' }
        }),
      'root-not-started'
    )
    registry.bindAndStart(root, {
      appRunId: 'run-child-guards-root',
      provider: 'codex',
      runtimeProfileId: null,
      dispatchAuthorityDigest: 'dispatch-child-guards-root'
    })
    expectCode(
      () =>
        registry.reserveChildOwnership(root, {
          owner: {
            kind: 'ensemble-seat',
            roundId: 'wrong-round',
            participantId: 'wrong-participant'
          }
        }),
      'owner-mismatch'
    )
    const child = registry.reserveChildOwnership(root, {
      owner: { kind: 'loop-step', stepId: 'valid-step' }
    })
    expectCode(
      () =>
        registry.reserveChildOwnership(child, {
          owner: { kind: 'loop-step', stepId: 'nested-step' }
        }),
      'invalid-lease-kind'
    )
    expectCode(
      () =>
        registry.reserveChildOwnership(
          root,
          null as unknown as { owner: { kind: 'loop-step'; stepId: string } }
        ),
      'invalid-input'
    )
    expect(registry.abortReserved(child)).toBe(true)
    expect(registry.markTerminal(root)).toBe(true)
  })

  it('revokes an unbound child with its root and never lets it start later', () => {
    const registry = createRegistry()
    const root = registry.reserveRoot({
      taskId: 'task-revoke-child',
      rootRunId: 'root-revoke-child',
      appRunId: 'run-revoke-child-root',
      sealSignature: 'seal-revoke-child',
      owner: 'ensemble-root',
      provider: null,
      runtimeProfileId: null,
      dispatchAuthorityDigest: 'dispatch-revoke-child-root'
    })
    registry.assertAndStart(root, {
      appRunId: 'run-revoke-child-root',
      provider: null,
      runtimeProfileId: null,
      dispatchAuthorityDigest: 'dispatch-revoke-child-root'
    })
    const child = registry.reserveChildOwnership(root, {
      owner: {
        kind: 'ensemble-seat',
        roundId: 'round-revoke',
        participantId: 'participant-revoke'
      }
    })

    expect(registry.revokeRoot(root)).toBe(true)
    expectCode(
      () =>
        registry.bindAndStart(child, {
          appRunId: 'run-revoked-child',
          provider: 'claude',
          runtimeProfileId: null,
          dispatchAuthorityDigest: 'dispatch-revoked-child'
        }),
      'lease-not-reserved'
    )
  })

  it('blocks late binding reentrancy without partially binding the target lease', () => {
    let reenter = true
    const targetBinding = {
      appRunId: 'run-reentrant-target',
      provider: 'codex',
      runtimeProfileId: null,
      dispatchAuthorityDigest: 'dispatch-reentrant-target'
    } as const
    const registry = createRegistry({
      validateLive: () => {
        if (reenter) registry.bindAndStart(target, targetBinding)
        return true
      }
    })
    const source = registry.reserveRootOwnership({
      taskId: 'task-reentrant-source',
      rootRunId: 'root-reentrant-source',
      sealSignature: 'seal-reentrant-source',
      owner: 'solo'
    })
    const target = registry.reserveRootOwnership({
      taskId: 'task-reentrant-target',
      rootRunId: 'root-reentrant-target',
      sealSignature: 'seal-reentrant-target',
      owner: 'solo'
    })
    const sourceBinding = {
      appRunId: 'run-reentrant-source',
      provider: 'grok',
      runtimeProfileId: null,
      dispatchAuthorityDigest: 'dispatch-reentrant-source'
    } as const

    expectCode(() => registry.bindAndStart(source, sourceBinding), 'reentrant-validation')
    expect(registry.taskIdForRun('run-reentrant-source')).toBe('task-reentrant-source')
    expect(registry.taskIdForRun('run-reentrant-target')).toBeUndefined()

    reenter = false
    expect(registry.bindAndStart(source, sourceBinding).kind).toBe('scheduled')
    expect(registry.bindAndStart(target, targetBinding).kind).toBe('scheduled')
  })

  it('blocks reentrancy from final-binding getters before any authority is fixed', () => {
    const registry = createRegistry()
    const source = registry.reserveRootOwnership({
      taskId: 'task-getter-reentry',
      rootRunId: 'root-getter-reentry',
      sealSignature: 'seal-getter-reentry',
      owner: 'solo'
    })
    const nested = registry.reserveRootOwnership({
      taskId: 'task-getter-nested',
      rootRunId: 'root-getter-nested',
      sealSignature: 'seal-getter-nested',
      owner: 'solo'
    })
    const nestedBinding = {
      appRunId: 'run-getter-nested',
      provider: 'codex',
      runtimeProfileId: null,
      dispatchAuthorityDigest: 'dispatch-getter-nested'
    } as const
    const reentrantBinding = {
      get appRunId() {
        registry.bindAndStart(nested, nestedBinding)
        return 'run-getter-reentry'
      },
      provider: 'codex',
      runtimeProfileId: null,
      dispatchAuthorityDigest: 'dispatch-getter-reentry'
    }

    expectCode(() => registry.bindAndStart(source, reentrantBinding), 'reentrant-validation')
    expect(registry.taskIdForRun('run-getter-reentry')).toBeUndefined()
    expect(registry.taskIdForRun('run-getter-nested')).toBeUndefined()
    expect(
      registry.bindAndStart(source, {
        appRunId: 'run-getter-reentry',
        provider: 'codex',
        runtimeProfileId: null,
        dispatchAuthorityDigest: 'dispatch-getter-reentry'
      }).kind
    ).toBe('scheduled')
    expect(registry.bindAndStart(nested, nestedBinding).kind).toBe('scheduled')
  })

  it('rejects a colliding final run id without consuming the unbound reservation', () => {
    const registry = createRegistry()
    reserveSolo(registry, 'occupied')
    const late = registry.reserveRootOwnership({
      taskId: 'task-collision-late',
      rootRunId: 'root-collision-late',
      sealSignature: 'seal-collision-late',
      owner: 'solo'
    })

    expectCode(
      () =>
        registry.bindAndStart(late, {
          appRunId: 'run-occupied',
          provider: 'codex',
          runtimeProfileId: 'profile-codex',
          dispatchAuthorityDigest: 'dispatch-collision'
        }),
      'duplicate-run-id'
    )
    expect(
      registry.bindAndStart(late, {
        appRunId: 'run-collision-late',
        provider: 'codex',
        runtimeProfileId: 'profile-codex',
        dispatchAuthorityDigest: 'dispatch-collision'
      }).kind
    ).toBe('scheduled')
  })
})
