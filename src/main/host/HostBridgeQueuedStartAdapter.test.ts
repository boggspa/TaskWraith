import { describe, expect, it, vi } from 'vitest'

import { createHostProjectionSerialQueue } from '../../host-runtime/HostProjectionSerialQueue'
import {
  createHostBridgeQueuedStartAdapter,
  type HostBridgePreparedEvent,
  type HostBridgeQueuedStartEventResult,
  type HostBridgeQueuedStartRegistration,
  type HostBridgeQueuedStartView,
  type HostBridgeStartEffectRef,
  type HostBridgeStartRef
} from './HostBridgeQueuedStartAdapter'

const ACTION_A = 'host:command:11111111-1111-4111-8111-111111111111'
const ACTION_B = 'host:command:22222222-2222-4222-8222-222222222222'
const ACTION_C = 'host:command:33333333-3333-4333-8333-333333333333'
const THREAD_A = 'thread-a'
const THREAD_B = 'thread-b'
const RUN_A = 'run-a'
const RUN_B = 'run-b'
const ROUND_A = 'round-a'

function registration(
  hostCommandActionId = ACTION_A,
  threadId = THREAD_A
): HostBridgeQueuedStartRegistration {
  return {
    hostCommandActionId,
    threadId,
    authority: {
      actorId: 'actor-a',
      clientId: 'client-a',
      clientClass: 'desktop',
      commandFingerprint: 'fingerprint-a'
    }
  }
}

function soloPrepared(
  hostCommandActionId = ACTION_A,
  threadId = THREAD_A,
  runId = RUN_A
): HostBridgePreparedEvent {
  return {
    kind: 'prepared',
    hostCommandActionId,
    threadId,
    durablePromptAndStartPersisted: true,
    start: { kind: 'solo', runId },
    effectRefs: [
      { family: 'run', entityId: runId },
      { family: 'thread', entityId: threadId }
    ]
  }
}

function resultView(result: HostBridgeQueuedStartEventResult): HostBridgeQueuedStartView {
  if (result.kind !== 'applied' && result.kind !== 'unchanged') {
    throw new Error('expected a view-bearing result, received ' + JSON.stringify(result))
  }
  return result.view
}

function deferred(): {
  promise: Promise<void>
  resolve(): void
  reject(error: unknown): void
} {
  let resolve!: () => void
  let reject!: (error: unknown) => void
  const promise = new Promise<void>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

describe('HostBridgeQueuedStartAdapter', () => {
  it('binds a canonical Host action to immutable Authority identity and thread correlation', async () => {
    const adapter = createHostBridgeQueuedStartAdapter({
      runProjectionOperation: async (operation) => operation()
    })

    const input = registration()
    const registered = adapter.register(input)
    expect(registered.kind).toBe('registered')
    if (registered.kind !== 'registered') throw new Error('registration failed')
    ;(input.authority as { actorId: string }).actorId = 'mutated-input'
    ;(registered.view.authority as { actorId: string }).actorId = 'mutated-return'

    expect(adapter.get(ACTION_A)).toMatchObject({
      hostCommandActionId: ACTION_A,
      threadId: THREAD_A,
      authority: {
        actorId: 'actor-a',
        clientId: 'client-a',
        clientClass: 'desktop',
        commandFingerprint: 'fingerprint-a'
      },
      phase: 'registered'
    })
    expect(adapter.register(registration()).kind).toBe('unchanged')
    expect(
      adapter.register({
        ...registration(),
        threadId: THREAD_B
      })
    ).toEqual({ kind: 'refused', reason: 'mismatch' })
    expect(
      adapter.register({
        ...registration(),
        authority: { ...registration().authority, actorId: 'actor-b' }
      })
    ).toEqual({ kind: 'refused', reason: 'mismatch' })
    expect(
      adapter.register({
        ...registration('phone:command:11111111-1111-4111-8111-111111111111')
      })
    ).toEqual({ kind: 'refused', reason: 'invalid' })

    expect(
      await adapter.queued({
        kind: 'queued',
        hostCommandActionId: ACTION_A,
        threadId: THREAD_B,
        queueId: 'queue-a',
        reservedRunId: RUN_A
      })
    ).toEqual({ kind: 'refused', reason: 'mismatch' })
  })

  it('publishes a direct solo prepared identity only after callback success and starts once', async () => {
    const onPrepared = vi.fn(async () => {
      expect(adapter.get(ACTION_A)?.phase).toBe('registered')
    })
    const onSettled = vi.fn(async () => {
      expect(adapter.get(ACTION_A)?.phase).toBe('prepared')
    })
    const adapter = createHostBridgeQueuedStartAdapter({
      runProjectionOperation: async (operation) => operation(),
      onPrepared,
      onSettled
    })
    adapter.register(registration())

    const prepared = await adapter.prepared(soloPrepared())
    expect(prepared.kind).toBe('applied')
    expect(resultView(prepared)).toMatchObject({
      phase: 'prepared',
      prepared: {
        start: { kind: 'solo', runId: RUN_A },
        effectRefs: [
          { family: 'thread', entityId: THREAD_A },
          { family: 'run', entityId: RUN_A }
        ]
      }
    })

    const started = await adapter.settled({
      kind: 'settled',
      hostCommandActionId: ACTION_A,
      threadId: THREAD_A,
      status: 'started'
    })
    expect(started.kind).toBe('applied')
    expect(resultView(started).settled).toEqual({
      status: 'started',
      start: { kind: 'solo', runId: RUN_A }
    })

    const repeated = await adapter.settled({
      kind: 'settled',
      hostCommandActionId: ACTION_A,
      threadId: THREAD_A,
      status: 'started'
    })
    expect(repeated.kind).toBe('unchanged')
    expect(onPrepared).toHaveBeenCalledTimes(1)
    expect(onSettled).toHaveBeenCalledTimes(1)
    expect(adapter.pendingCount()).toBe(0)
  })

  it('correlates a queued solo start to its reserved run and refuses mismatches', async () => {
    const onQueued = vi.fn()
    const adapter = createHostBridgeQueuedStartAdapter({
      runProjectionOperation: async (operation) => operation(),
      onQueued
    })
    adapter.register(registration())

    const queued = await adapter.queued({
      kind: 'queued',
      hostCommandActionId: ACTION_A,
      threadId: THREAD_A,
      queueId: 'queue-a',
      reservedRunId: RUN_A
    })
    expect(queued.kind).toBe('applied')
    expect(
      await adapter.queued({
        kind: 'queued',
        hostCommandActionId: ACTION_A,
        threadId: THREAD_A,
        queueId: 'queue-a',
        reservedRunId: RUN_A
      })
    ).toMatchObject({ kind: 'unchanged' })
    expect(
      await adapter.queued({
        kind: 'queued',
        hostCommandActionId: ACTION_A,
        threadId: THREAD_A,
        queueId: 'queue-b',
        reservedRunId: RUN_A
      })
    ).toEqual({ kind: 'refused', reason: 'mismatch' })
    expect(await adapter.prepared(soloPrepared(ACTION_A, THREAD_A, RUN_B))).toEqual({
      kind: 'refused',
      reason: 'mismatch'
    })
    expect((await adapter.prepared(soloPrepared())).kind).toBe('applied')
    expect(onQueued).toHaveBeenCalledTimes(1)
  })

  it('requires the exact complete solo or Ensemble effect identities', async () => {
    const adapter = createHostBridgeQueuedStartAdapter({
      runProjectionOperation: async (operation) => operation()
    })
    adapter.register(registration(ACTION_A))
    adapter.register(registration(ACTION_B))
    adapter.register(registration(ACTION_C))

    const ensembleStart: HostBridgeStartRef = {
      kind: 'ensemble',
      roundId: ROUND_A,
      participantRunIds: [RUN_B, RUN_A]
    }
    const exactEffects: HostBridgeStartEffectRef[] = [
      { family: 'round', entityId: ROUND_A },
      { family: 'run', entityId: RUN_B },
      { family: 'thread', entityId: THREAD_A },
      { family: 'run', entityId: RUN_A }
    ]

    expect(
      await adapter.prepared({
        kind: 'prepared',
        hostCommandActionId: ACTION_A,
        threadId: THREAD_A,
        durablePromptAndStartPersisted: true,
        start: ensembleStart,
        effectRefs: exactEffects.slice(0, -1)
      })
    ).toEqual({ kind: 'refused', reason: 'invalid' })
    expect(
      await adapter.prepared({
        kind: 'prepared',
        hostCommandActionId: ACTION_A,
        threadId: THREAD_A,
        durablePromptAndStartPersisted: true,
        start: ensembleStart,
        effectRefs: [...exactEffects, exactEffects[0]]
      })
    ).toEqual({ kind: 'refused', reason: 'invalid' })
    expect(
      await adapter.prepared({
        kind: 'prepared',
        hostCommandActionId: ACTION_A,
        threadId: THREAD_A,
        durablePromptAndStartPersisted: true,
        start: ensembleStart,
        effectRefs: [...exactEffects.slice(0, -1), { family: 'run', entityId: 'unexpected-run' }]
      })
    ).toEqual({ kind: 'refused', reason: 'invalid' })

    const event = {
      kind: 'prepared' as const,
      hostCommandActionId: ACTION_A,
      threadId: THREAD_A,
      durablePromptAndStartPersisted: true as const,
      start: ensembleStart,
      effectRefs: exactEffects
    }
    const applied = await adapter.prepared(event)
    expect(resultView(applied).prepared).toEqual({
      start: {
        kind: 'ensemble',
        roundId: ROUND_A,
        participantRunIds: [RUN_A, RUN_B]
      },
      effectRefs: [
        { family: 'thread', entityId: THREAD_A },
        { family: 'run', entityId: RUN_A },
        { family: 'run', entityId: RUN_B },
        { family: 'round', entityId: ROUND_A }
      ]
    })
    ;(ensembleStart.participantRunIds as string[])[0] = 'mutated-run'
    ;(exactEffects[0] as { entityId: string }).entityId = 'mutated-round'
    const returned = resultView(applied)
    if (returned.prepared?.start.kind === 'ensemble') {
      ;(returned.prepared.start.participantRunIds as string[])[0] = 'mutated-return'
    }
    ;(
      (returned.prepared?.effectRefs as HostBridgeStartEffectRef[])[0] as {
        entityId: string
      }
    ).entityId = 'mutated-effect'
    expect(adapter.get(ACTION_A)?.prepared).toEqual({
      start: {
        kind: 'ensemble',
        roundId: ROUND_A,
        participantRunIds: [RUN_A, RUN_B]
      },
      effectRefs: [
        { family: 'thread', entityId: THREAD_A },
        { family: 'run', entityId: RUN_A },
        { family: 'run', entityId: RUN_B },
        { family: 'round', entityId: ROUND_A }
      ]
    })

    expect(
      await adapter.prepared({
        ...soloPrepared(ACTION_B),
        durablePromptAndStartPersisted: false
      } as unknown as HostBridgePreparedEvent)
    ).toEqual({ kind: 'refused', reason: 'invalid' })
    expect(
      await adapter.prepared({
        ...soloPrepared(ACTION_C),
        start: { kind: 'solo', runId: '' }
      })
    ).toEqual({ kind: 'refused', reason: 'invalid' })
  })

  it.each([
    { label: 'round-only', participantRunIds: [] },
    { label: 'with participant runs', participantRunIds: [RUN_B, RUN_A] }
  ])(
    'publishes an Ensemble start $label through prepared and settled exactly once',
    async ({ participantRunIds }) => {
      const onPrepared = vi.fn()
      const onSettled = vi.fn()
      const adapter = createHostBridgeQueuedStartAdapter({
        runProjectionOperation: createHostProjectionSerialQueue(),
        onPrepared,
        onSettled
      })
      adapter.register(registration())
      const start: HostBridgeStartRef = { kind: 'ensemble', roundId: ROUND_A, participantRunIds }
      const event: HostBridgePreparedEvent = {
        kind: 'prepared',
        hostCommandActionId: ACTION_A,
        threadId: THREAD_A,
        durablePromptAndStartPersisted: true,
        start,
        effectRefs: [
          { family: 'round', entityId: ROUND_A },
          { family: 'thread', entityId: THREAD_A },
          ...participantRunIds.map((entityId) => ({ family: 'run' as const, entityId }))
        ]
      }
      const settled = {
        kind: 'settled' as const,
        hostCommandActionId: ACTION_A,
        threadId: THREAD_A,
        status: 'started' as const,
        start
      }
      expect(await adapter.settled(settled)).toEqual({ kind: 'refused', reason: 'regression' })
      const prepared = await adapter.prepared(event)
      expect(prepared.kind).toBe('applied')
      const expectedStart = { ...start, participantRunIds: [...participantRunIds].sort() }
      const expectedEffects = [
        { family: 'thread', entityId: THREAD_A },
        ...[...participantRunIds].sort().map((entityId) => ({ family: 'run', entityId })),
        { family: 'round', entityId: ROUND_A }
      ]
      expect(resultView(prepared).prepared).toEqual({
        start: expectedStart,
        effectRefs: expectedEffects
      })
      expect(adapter.pendingCount()).toBe(1)
      expect((await adapter.prepared(event)).kind).toBe('unchanged')
      expect(onPrepared).toHaveBeenCalledOnce()

      const changedStart = { ...start, participantRunIds: [...participantRunIds, 'other-run'] }
      expect(
        await adapter.prepared({
          ...event,
          start: changedStart,
          effectRefs: [...event.effectRefs, { family: 'run', entityId: 'other-run' }]
        })
      ).toEqual({ kind: 'refused', reason: 'mismatch' })
      expect(await adapter.settled({ ...settled, start: changedStart })).toEqual({
        kind: 'refused',
        reason: 'mismatch'
      })
      const started = await adapter.settled(settled)
      expect(started.kind).toBe('applied')
      expect(resultView(started).settled).toEqual({ status: 'started', start: expectedStart })
      expect((await adapter.settled({ ...settled, start: undefined })).kind).toBe('unchanged')
      expect(adapter.pendingCount()).toBe(0)
      expect(await adapter.prepared(event)).toEqual({ kind: 'refused', reason: 'terminal' })
      expect(await adapter.settled({ ...settled, start: changedStart })).toEqual({
        kind: 'refused',
        reason: 'terminal'
      })
      expect(onPrepared).toHaveBeenCalledOnce()
      expect(onSettled).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({
          phase: 'settled',
          prepared: { start: expectedStart, effectRefs: expectedEffects },
          settled: { status: 'started', start: expectedStart }
        })
      )
    }
  )

  it.each([
    'missing-thread',
    'missing-round',
    'extra-run',
    'duplicate-round',
    'missing-declared-run'
  ] as const)(
    'refuses %s effects without publishing or poisoning a subsequent round-only start',
    async (caseName) => {
      const onPrepared = vi.fn()
      const onSettled = vi.fn()
      const adapter = createHostBridgeQueuedStartAdapter({
        runProjectionOperation: createHostProjectionSerialQueue(),
        onPrepared,
        onSettled
      })
      adapter.register(registration())
      const event: HostBridgePreparedEvent = {
        kind: 'prepared',
        hostCommandActionId: ACTION_A,
        threadId: THREAD_A,
        durablePromptAndStartPersisted: true,
        start: { kind: 'ensemble', roundId: ROUND_A, participantRunIds: [] },
        effectRefs: [
          { family: 'thread', entityId: THREAD_A },
          { family: 'round', entityId: ROUND_A }
        ]
      }
      const effectRefs = [...event.effectRefs]
      if (caseName === 'missing-thread') effectRefs.shift()
      if (caseName === 'missing-round') effectRefs.pop()
      if (caseName === 'extra-run') effectRefs.push({ family: 'run', entityId: RUN_A })
      if (caseName === 'duplicate-round') effectRefs.push({ family: 'round', entityId: ROUND_A })
      const start: HostBridgeStartRef = {
        kind: 'ensemble',
        roundId: ROUND_A,
        participantRunIds: caseName === 'missing-declared-run' ? [RUN_A] : []
      }
      expect(await adapter.prepared({ ...event, start, effectRefs })).toEqual({
        kind: 'refused',
        reason: 'invalid'
      })
      expect(adapter.get(ACTION_A)).toEqual({ ...registration(), phase: 'registered' })
      expect(onPrepared).not.toHaveBeenCalled()
      expect(onSettled).not.toHaveBeenCalled()
      expect((await adapter.prepared(event)).kind).toBe('applied')
      expect(onPrepared).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({
          phase: 'prepared',
          prepared: { start: event.start, effectRefs: event.effectRefs }
        })
      )
    }
  )

  it.each(['omitted array', 'empty ID', 'duplicate IDs'] as const)(
    'refuses an Ensemble start with %s while retaining the required array schema',
    async (invalid) => {
      const onPrepared = vi.fn()
      const onSettled = vi.fn()
      const adapter = createHostBridgeQueuedStartAdapter({
        runProjectionOperation: createHostProjectionSerialQueue(),
        onPrepared,
        onSettled
      })
      adapter.register(registration())
      const start = {
        kind: 'ensemble',
        roundId: ROUND_A,
        ...(invalid === 'omitted array'
          ? {}
          : { participantRunIds: invalid === 'empty ID' ? [''] : [RUN_A, RUN_A] })
      } as HostBridgeStartRef
      const event: HostBridgePreparedEvent = {
        kind: 'prepared',
        hostCommandActionId: ACTION_A,
        threadId: THREAD_A,
        durablePromptAndStartPersisted: true,
        start,
        effectRefs: [
          { family: 'thread', entityId: THREAD_A },
          { family: 'round', entityId: ROUND_A },
          ...(invalid === 'duplicate IDs' ? [{ family: 'run' as const, entityId: RUN_A }] : [])
        ]
      }
      expect(await adapter.prepared(event)).toEqual({ kind: 'refused', reason: 'invalid' })
      expect(
        await adapter.settled({
          kind: 'settled',
          hostCommandActionId: ACTION_A,
          threadId: THREAD_A,
          status: 'started',
          start
        })
      ).toEqual({ kind: 'refused', reason: 'invalid' })
      expect(adapter.get(ACTION_A)).toEqual({ ...registration(), phase: 'registered' })
      expect(onPrepared).not.toHaveBeenCalled()
      expect(onSettled).not.toHaveBeenCalled()
    }
  )

  it('does not start before prepared proof and refuses regressions, mismatches, and late events', async () => {
    const adapter = createHostBridgeQueuedStartAdapter({
      runProjectionOperation: async (operation) => operation()
    })
    adapter.register(registration())

    expect(
      await adapter.settled({
        kind: 'settled',
        hostCommandActionId: ACTION_A,
        threadId: THREAD_A,
        status: 'started'
      })
    ).toEqual({ kind: 'refused', reason: 'regression' })

    expect((await adapter.prepared(soloPrepared())).kind).toBe('applied')
    expect(
      await adapter.queued({
        kind: 'queued',
        hostCommandActionId: ACTION_A,
        threadId: THREAD_A,
        queueId: 'queue-late',
        reservedRunId: RUN_A
      })
    ).toEqual({ kind: 'refused', reason: 'regression' })
    expect(
      await adapter.settled({
        kind: 'settled',
        hostCommandActionId: ACTION_A,
        threadId: THREAD_A,
        status: 'started',
        start: { kind: 'solo', runId: RUN_B }
      })
    ).toEqual({ kind: 'refused', reason: 'mismatch' })

    expect(
      (
        await adapter.settled({
          kind: 'settled',
          hostCommandActionId: ACTION_A,
          threadId: THREAD_A,
          status: 'failed',
          errorCode: 'provider-failed'
        })
      ).kind
    ).toBe('applied')
    expect(await adapter.prepared(soloPrepared())).toEqual({
      kind: 'refused',
      reason: 'terminal'
    })
    expect(
      await adapter.settled({
        kind: 'settled',
        hostCommandActionId: ACTION_A,
        threadId: THREAD_A,
        status: 'cancelled'
      })
    ).toEqual({ kind: 'refused', reason: 'terminal' })
  })

  it('captures queued values before the injected shared queue defers execution', async () => {
    const entered = deferred()
    const release = deferred()
    const sharedQueue = createHostProjectionSerialQueue()
    const held = sharedQueue(async () => {
      entered.resolve()
      await release.promise
    }, 'legacy-held-window')
    await entered.promise

    const onQueued = vi.fn()
    const runner = vi.fn(sharedQueue) as unknown as Parameters<
      typeof createHostBridgeQueuedStartAdapter
    >[0]['runProjectionOperation']
    const adapter = createHostBridgeQueuedStartAdapter({
      runProjectionOperation: runner,
      onQueued
    })
    adapter.register(registration())
    const event = {
      kind: 'queued' as const,
      hostCommandActionId: ACTION_A,
      threadId: THREAD_A,
      queueId: 'queue-original',
      reservedRunId: RUN_A
    }

    const pending = adapter.queued(event)
    event.queueId = ''
    event.reservedRunId = RUN_B
    await Promise.resolve()
    expect(onQueued).not.toHaveBeenCalled()
    expect(adapter.get(ACTION_A)?.phase).toBe('registered')
    expect(runner).toHaveBeenCalledWith(expect.any(Function), 'bridge-queued-start:' + ACTION_A)

    release.resolve()
    await held
    expect(resultView(await pending).queued).toEqual({
      queueId: 'queue-original',
      reservedRunId: RUN_A
    })
    expect(onQueued).toHaveBeenCalledTimes(1)
  })

  it('captures settled values before deferred execution and does not reread caller aliases', async () => {
    const entered = deferred()
    const release = deferred()
    const sharedQueue = createHostProjectionSerialQueue()
    const adapter = createHostBridgeQueuedStartAdapter({
      runProjectionOperation: sharedQueue
    })
    adapter.register(registration())
    expect((await adapter.prepared(soloPrepared())).kind).toBe('applied')

    const held = sharedQueue(async () => {
      entered.resolve()
      await release.promise
    }, 'legacy-held-window')
    await entered.promise

    const event = {
      kind: 'settled' as const,
      hostCommandActionId: ACTION_A,
      threadId: THREAD_A,
      status: 'failed' as 'started' | 'failed' | 'cancelled',
      errorCode: 'original-error'
    }
    const pending = adapter.settled(event)
    event.status = 'cancelled'
    event.errorCode = ''
    release.resolve()
    await held

    expect(resultView(await pending).settled).toEqual({
      status: 'failed',
      errorCode: 'original-error'
    })
  })

  it.each([
    {
      label: 'synchronous runner throw',
      runner: () => {
        throw new Error('sync queue failure')
      }
    },
    {
      label: 'rejected runner promise',
      runner: async () => {
        throw new Error('async queue failure')
      }
    }
  ])('fails closed on $label and drains without leaking pending state', async ({ runner }) => {
    const onFailure = vi.fn(async () => {
      throw new Error('advisory failure observer')
    })
    const adapter = createHostBridgeQueuedStartAdapter({
      runProjectionOperation: runner,
      onFailure
    })
    adapter.register(registration())

    await expect(
      adapter.queued({
        kind: 'queued',
        hostCommandActionId: ACTION_A,
        threadId: THREAD_A,
        queueId: 'queue-a',
        reservedRunId: RUN_A
      })
    ).resolves.toEqual({ kind: 'failed', reason: 'publication_failed' })
    await expect(adapter.drain()).resolves.toBeUndefined()
    expect(adapter.pendingCount()).toBe(0)
    expect(adapter.get(ACTION_A)).toMatchObject({
      phase: 'settled',
      settled: { status: 'failed', errorCode: 'publication_failed' }
    })
    expect(onFailure).toHaveBeenCalledTimes(1)
  })

  it('commits transitions only after callbacks succeed and terminalizes callback failures once', async () => {
    const onFailure = vi.fn()
    const adapter = createHostBridgeQueuedStartAdapter({
      runProjectionOperation: async (operation) => operation(),
      onQueued: async () => {
        throw new Error('projection callback failed')
      },
      onFailure
    })
    adapter.register(registration())

    expect(
      await adapter.queued({
        kind: 'queued',
        hostCommandActionId: ACTION_A,
        threadId: THREAD_A,
        queueId: 'queue-a',
        reservedRunId: RUN_A
      })
    ).toEqual({ kind: 'failed', reason: 'publication_failed' })
    expect(adapter.get(ACTION_A)).toMatchObject({
      phase: 'settled',
      settled: { status: 'failed', errorCode: 'publication_failed' }
    })
    expect(onFailure).toHaveBeenCalledTimes(1)

    expect(
      await adapter.queued({
        kind: 'queued',
        hostCommandActionId: ACTION_A,
        threadId: THREAD_A,
        queueId: 'queue-a',
        reservedRunId: RUN_A
      })
    ).toEqual({ kind: 'refused', reason: 'terminal' })
    expect(onFailure).toHaveBeenCalledTimes(1)
  })

  it('drain includes work admitted by a callback before the current task settles', async () => {
    let preparedPromise: Promise<HostBridgeQueuedStartEventResult> | undefined
    const adapter = createHostBridgeQueuedStartAdapter({
      runProjectionOperation: createHostProjectionSerialQueue(),
      onQueued: () => {
        preparedPromise = adapter.prepared(soloPrepared())
      }
    })
    adapter.register(registration())

    const queuedPromise = adapter.queued({
      kind: 'queued',
      hostCommandActionId: ACTION_A,
      threadId: THREAD_A,
      queueId: 'queue-a',
      reservedRunId: RUN_A
    })
    await adapter.drain()

    expect((await queuedPromise).kind).toBe('applied')
    expect(preparedPromise).toBeDefined()
    expect((await preparedPromise!).kind).toBe('applied')
    expect(adapter.get(ACTION_A)?.phase).toBe('prepared')
  })

  it('fences new work at shutdown while draining admitted work and allowing terminal settlement', async () => {
    const entered = deferred()
    const release = deferred()
    const sharedQueue = createHostProjectionSerialQueue()
    const held = sharedQueue(async () => {
      entered.resolve()
      await release.promise
    }, 'legacy-held-window')
    await entered.promise

    const adapter = createHostBridgeQueuedStartAdapter({
      runProjectionOperation: sharedQueue
    })
    adapter.register(registration())
    const admitted = adapter.queued({
      kind: 'queued',
      hostCommandActionId: ACTION_A,
      threadId: THREAD_A,
      queueId: 'queue-a',
      reservedRunId: RUN_A
    })
    adapter.beginShutdown()

    expect(adapter.register(registration(ACTION_B))).toEqual({
      kind: 'refused',
      reason: 'shutting_down'
    })
    expect(await adapter.prepared(soloPrepared())).toEqual({
      kind: 'refused',
      reason: 'shutting_down'
    })

    let drained = false
    const drainPromise = adapter.drain().then(() => {
      drained = true
    })
    await Promise.resolve()
    expect(drained).toBe(false)

    release.resolve()
    await held
    expect((await admitted).kind).toBe('applied')
    await drainPromise

    expect(
      (
        await adapter.settled({
          kind: 'settled',
          hostCommandActionId: ACTION_A,
          threadId: THREAD_A,
          status: 'cancelled',
          errorCode: 'shutdown'
        })
      ).kind
    ).toBe('applied')
    expect(adapter.pendingCount()).toBe(0)
  })
})
