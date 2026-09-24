import { describe, expect, it, vi } from 'vitest'
import { createHostProjectionSerialQueue } from '../../host-runtime/HostProjectionSerialQueue'
import { createEnsembleRoundStartObservation } from '../services/EnsembleRoundStartObserver'
import type { ChatRecord } from '../store/types'
import {
  createHostBridgeQueuedStartAdapter,
  type HostBridgeQueuedStartAdapterOptions
} from './HostBridgeQueuedStartAdapter'
import {
  createHostBridgeQueuedRoundStartProducer,
  dispatchObservedHostBridgeRound,
  verifyHostBridgeQueuedRoundStartRecord,
  type HostBridgeQueuedRoundStartIdentity,
  type HostBridgeQueuedRoundStartProducerOptions
} from './HostBridgeQueuedRoundStartProducer'

const COMMAND_ID = '11111111-1111-4111-8111-111111111111'
const ACTION_ID = `host:command:${COMMAND_ID}` as const
const IDENTITY: HostBridgeQueuedRoundStartIdentity = {
  hostCommandActionId: ACTION_ID,
  threadId: 'thread-a',
  roundId: 'round-a'
}
const CORRELATION = { hostCommandActionId: ACTION_ID, threadId: IDENTITY.threadId }
type RoundRecord = Pick<ChatRecord, 'appChatId' | 'ensemble' | 'messages'>

function roundRecord(): RoundRecord {
  return {
    appChatId: IDENTITY.threadId,
    ensemble: {
      enabled: true,
      maxParticipants: 2,
      participants: [],
      activeRound: {
        roundId: IDENTITY.roundId,
        status: 'running',
        prompt: 'start the ensemble once',
        startedAt: '2026-09-24T02:00:00.000Z',
        participants: []
      }
    },
    messages: [
      {
        id: `ensemble-user-${IDENTITY.roundId}`,
        role: 'user',
        content: 'start the ensemble once',
        timestamp: '2026-09-24T02:00:00.000Z',
        metadata: { kind: 'ensembleRoundPrompt', ensembleRoundId: IDENTITY.roundId }
      }
    ]
  }
}

function deferred() {
  let resolve!: () => void
  let reject!: (error: Error) => void
  const promise = new Promise<void>((ok, fail) => {
    resolve = ok
    reject = fail
  })
  return { promise, resolve, reject }
}

function harness(
  overrides: Partial<HostBridgeQueuedRoundStartProducerOptions> = {},
  bind = true,
  callbacks: Pick<HostBridgeQueuedStartAdapterOptions, 'onPrepared' | 'onFailure'> = {}
) {
  const stored = roundRecord()
  const persistenceEnabled = vi.fn(() => true)
  const awaitPromptAndRoundDurable = vi.fn(async () => undefined)
  const verifyPromptAndRound = vi.fn((identity: HostBridgeQueuedRoundStartIdentity) =>
    verifyHostBridgeQueuedRoundStartRecord(stored, identity)
  )
  const producer = createHostBridgeQueuedRoundStartProducer({
    persistenceEnabled,
    awaitPromptAndRoundDurable,
    verifyPromptAndRound,
    ...overrides
  })
  const adapter = createHostBridgeQueuedStartAdapter({
    runProjectionOperation: createHostProjectionSerialQueue(),
    ...callbacks
  })
  adapter.register({
    hostCommandActionId: ACTION_ID,
    threadId: IDENTITY.threadId,
    authority: {
      actorId: 'actor-a',
      clientId: 'client-a',
      clientClass: 'desktop',
      commandFingerprint: 'fingerprint-a'
    }
  })
  const originalPrepared = adapter.prepared
  const prepared = vi.spyOn(adapter, 'prepared')
  const settled = vi.spyOn(adapter, 'settled')
  const abort = vi.fn<(commandId: string) => void>()
  if (bind) producer.onAdapter(adapter, abort)
  return {
    producer,
    adapter,
    originalPrepared,
    prepared,
    settled,
    abort,
    stored,
    persistenceEnabled,
    awaitPromptAndRoundDurable,
    verifyPromptAndRound
  }
}

function observation(h: ReturnType<typeof harness>) {
  const handle = h.producer.observeRound(CORRELATION)
  if (!handle) throw new Error('expected a registered Host observation')
  return handle
}

async function publish(h: ReturnType<typeof harness>) {
  const handle = observation(h)
  handle.observer.onRoundReserved(IDENTITY.roundId)
  await handle.observer.onRoundPersistedBeforeParticipants(IDENTITY.roundId)
  await h.producer.drain()
  return handle
}

function expectUnproven(h: ReturnType<typeof harness>) {
  expect(h.prepared).not.toHaveBeenCalled()
  expect(h.settled).not.toHaveBeenCalled()
  expect(h.abort).toHaveBeenCalledExactlyOnceWith(COMMAND_ID)
}

describe('verifyHostBridgeQueuedRoundStartRecord', () => {
  it('requires the exact running round and uniquely linked user prompt without participant runs', () => {
    expect(verifyHostBridgeQueuedRoundStartRecord(roundRecord(), IDENTITY)).toBe(true)
    expect(verifyHostBridgeQueuedRoundStartRecord(null, IDENTITY)).toBe(false)
    expect(verifyHostBridgeQueuedRoundStartRecord(undefined, IDENTITY)).toBe(false)
  })

  it.each<{
    name: string
    change: (record: RoundRecord) => void
  }>([
    { name: 'different thread', change: (record) => (record.appChatId = 'another-thread') },
    { name: 'absent ensemble', change: (record) => delete record.ensemble },
    { name: 'disabled ensemble', change: (record) => (record.ensemble!.enabled = false) },
    { name: 'absent round', change: (record) => delete record.ensemble!.activeRound },
    {
      name: 'different round',
      change: (record) => (record.ensemble!.activeRound!.roundId = 'older-round')
    },
    {
      name: 'invalid start time',
      change: (record) => (record.ensemble!.activeRound!.startedAt = 'not-a-time')
    },
    {
      name: 'ended round',
      change: (record) => (record.ensemble!.activeRound!.endedAt = '2026-09-24T02:00:01.000Z')
    },
    { name: 'missing prompt', change: (record) => (record.messages = []) },
    { name: 'wrong prompt id', change: (record) => (record.messages[0].id = 'another-prompt') },
    { name: 'non-user prompt', change: (record) => (record.messages[0].role = 'assistant') },
    { name: 'absent metadata', change: (record) => delete record.messages[0].metadata },
    {
      name: 'wrong metadata kind',
      change: (record) => (record.messages[0].metadata!.kind = 'guestParticipantReply')
    },
    {
      name: 'wrong prompt linkage',
      change: (record) => (record.messages[0].metadata!.ensembleRoundId = 'older-round')
    },
    {
      name: 'different prompt content',
      change: (record) => (record.messages[0].content = 'another prompt')
    },
    {
      name: 'different prompt timestamp',
      change: (record) => (record.messages[0].timestamp = '2026-09-24T02:00:01.000Z')
    },
    { name: 'duplicate prompt id', change: (record) => record.messages.push(record.messages[0]) },
    {
      name: 'duplicate prompt metadata with a different id',
      change: (record) => record.messages.push({ ...record.messages[0], id: 'other-id' })
    }
  ])('rejects $name', ({ change }) => {
    const stored = roundRecord()
    change(stored)
    expect(verifyHostBridgeQueuedRoundStartRecord(stored, IDENTITY)).toBe(false)
  })

  it.each(['completed', 'cancelled', 'failed'] as const)(
    'rejects a %s round before dispatch',
    (status) => {
      const stored = roundRecord()
      stored.ensemble!.activeRound!.status = status
      expect(verifyHostBridgeQueuedRoundStartRecord(stored, IDENTITY)).toBe(false)
    }
  )

  it('allows unrelated transcript messages but rejects malformed identity', () => {
    const stored = roundRecord()
    stored.messages.push({
      id: 'old-answer',
      role: 'assistant',
      content: 'previous round',
      timestamp: '2026-09-23T02:00:00.000Z'
    })
    expect(verifyHostBridgeQueuedRoundStartRecord(stored, IDENTITY)).toBe(true)
    expect(
      verifyHostBridgeQueuedRoundStartRecord(stored, { ...IDENTITY, hostCommandActionId: 'phone' })
    ).toBe(false)
    expect(verifyHostBridgeQueuedRoundStartRecord(stored, { ...IDENTITY, roundId: '' })).toBe(false)
  })
})

describe('createHostBridgeQueuedRoundStartProducer', () => {
  it('captures persistence synchronously at reservation, then publishes only before participants', async () => {
    const gate = deferred()
    const h = harness({ awaitPromptAndRoundDurable: vi.fn(() => gate.promise) })
    const handle = observation(h)
    handle.observer.onRoundReserved(IDENTITY.roundId)
    expect(h.verifyPromptAndRound).toHaveBeenCalledExactlyOnceWith(IDENTITY)
    // A started Bridge response in the same tick cannot replace the detached
    // task's ownership fence or the captured journal barrier.
    handle.dispatchSettled({ status: 'started', roundId: IDENTITY.roundId })
    expect(h.prepared).not.toHaveBeenCalled()
    const waiting = handle.observer.onRoundPersistedBeforeParticipants(IDENTITY.roundId)
    await Promise.resolve()
    expect(h.prepared).not.toHaveBeenCalled()
    gate.resolve()
    await waiting
    await h.producer.drain()
    expect(h.verifyPromptAndRound).toHaveBeenCalledTimes(2)
    expect(h.prepared).toHaveBeenCalledExactlyOnceWith({
      kind: 'prepared',
      hostCommandActionId: ACTION_ID,
      threadId: IDENTITY.threadId,
      durablePromptAndStartPersisted: true,
      start: { kind: 'ensemble', roundId: IDENTITY.roundId, participantRunIds: [] },
      effectRefs: [
        { family: 'thread', entityId: IDENTITY.threadId },
        { family: 'round', entityId: IDENTITY.roundId }
      ]
    })
    expect(h.adapter.get(ACTION_ID)?.prepared?.start).toEqual({
      kind: 'ensemble',
      roundId: IDENTITY.roundId,
      participantRunIds: []
    })
    expect(h.abort).not.toHaveBeenCalled()
    expect(h.settled).not.toHaveBeenCalled()
  })

  it('captures the barrier in the reservation stack and never reacquires a newer one', async () => {
    const events: string[] = []
    const gate = deferred()
    const barrier = vi.fn<HostBridgeQueuedRoundStartProducerOptions['awaitPromptAndRoundDurable']>(
      () => {
        events.push('barrier')
        return gate.promise
      }
    )
    const h = harness({
      verifyPromptAndRound: () => {
        events.push('verify')
        return true
      },
      awaitPromptAndRoundDurable: barrier
    })
    const handle = observation(h)
    handle.observer.onRoundReserved(IDENTITY.roundId)
    expect(events).toEqual(['verify', 'barrier'])
    expect(barrier).toHaveBeenCalledExactlyOnceWith(IDENTITY)
    expect(Object.isFrozen(barrier.mock.calls[0][0])).toBe(true)
    gate.resolve()
    await h.producer.drain()
    expect(h.prepared).not.toHaveBeenCalled()
    await handle.observer.onRoundPersistedBeforeParticipants(IDENTITY.roundId)
    expect(events).toEqual(['verify', 'barrier', 'verify'])
    expect(barrier).toHaveBeenCalledTimes(1)
    expect(h.prepared).toHaveBeenCalledTimes(1)
  })

  it('rejects invalid-before/valid-after records without capturing a newer barrier', async () => {
    const h = harness()
    const handle = observation(h)
    const prompt = h.stored.messages.pop()!
    handle.observer.onRoundReserved(IDENTITY.roundId)
    h.stored.messages.push(prompt)
    await handle.observer.onRoundPersistedBeforeParticipants(IDENTITY.roundId)
    expect(h.awaitPromptAndRoundDurable).not.toHaveBeenCalled()
    expectUnproven(h)
  })

  it.each(['round', 'prompt', 'status'] as const)(
    'rechecks changed %s state after the captured barrier',
    async (change) => {
      const gate = deferred()
      const h = harness({ awaitPromptAndRoundDurable: () => gate.promise })
      const handle = observation(h)
      handle.observer.onRoundReserved(IDENTITY.roundId)
      const waiting = handle.observer.onRoundPersistedBeforeParticipants(IDENTITY.roundId)
      if (change === 'round') h.stored.ensemble!.activeRound!.roundId = 'newer-round'
      if (change === 'prompt') h.stored.messages = []
      if (change === 'status') h.stored.ensemble!.activeRound!.status = 'cancelled'
      gate.resolve()
      await waiting
      expectUnproven(h)
    }
  )

  it.each(['reservation', 'publication'] as const)(
    'abandons proof when local history is off at %s',
    async (point) => {
      const h = harness()
      const handle = observation(h)
      if (point === 'reservation') h.persistenceEnabled.mockReturnValue(false)
      handle.observer.onRoundReserved(IDENTITY.roundId)
      h.persistenceEnabled.mockReturnValue(false)
      await handle.observer.onRoundPersistedBeforeParticipants(IDENTITY.roundId)
      expectUnproven(h)
      if (point === 'reservation') expect(h.awaitPromptAndRoundDurable).not.toHaveBeenCalled()
    }
  )

  it.each(['persistenceEnabled', 'verifyPromptAndRound', 'awaitPromptAndRoundDurable'] as const)(
    'contains a synchronous %s failure',
    async (port) => {
      const h = harness()
      h[port].mockImplementation(() => {
        throw new Error('evidence failed')
      })
      const handle = observation(h)
      expect(() => handle.observer.onRoundReserved(IDENTITY.roundId)).not.toThrow()
      await handle.observer.onRoundPersistedBeforeParticipants(IDENTITY.roundId)
      expectUnproven(h)
    }
  )

  it('contains journal rejection even before the detached task observes it', async () => {
    const gate = deferred()
    const h = harness({ awaitPromptAndRoundDurable: () => gate.promise })
    const handle = observation(h)
    handle.observer.onRoundReserved(IDENTITY.roundId)
    gate.reject(new Error('fsync failed'))
    await Promise.resolve()
    expectUnproven(h)
    await handle.observer.onRoundPersistedBeforeParticipants(IDENTITY.roundId)
  })

  it.each(['queued', 'steered', 'declined', undefined])(
    'treats a %s result as uncertain without adopting an existing active round',
    async (status) => {
      const h = harness()
      const handle = observation(h)
      handle.dispatchSettled({ status, roundId: IDENTITY.roundId })
      handle.observer.onRoundReserved(IDENTITY.roundId)
      await handle.observer.onRoundPersistedBeforeParticipants(IDENTITY.roundId)
      expect(h.awaitPromptAndRoundDurable).not.toHaveBeenCalled()
      expectUnproven(h)
    }
  )

  it.each(['unreserved', 'missing-id', 'different-id'] as const)(
    'does not accept a started response with %s round correlation',
    async (problem) => {
      const h = harness()
      const handle = observation(h)
      if (problem !== 'unreserved') handle.observer.onRoundReserved(IDENTITY.roundId)
      handle.dispatchSettled({
        status: 'started',
        roundId:
          problem === 'missing-id'
            ? undefined
            : problem === 'different-id'
              ? 'other'
              : IDENTITY.roundId
      })
      await handle.observer.onRoundPersistedBeforeParticipants(IDENTITY.roundId)
      expectUnproven(h)
    }
  )

  it.each(['before-reservation', 'after-reservation'] as const)(
    'never reports failed for a dispatch throw %s',
    async (point) => {
      const h = harness()
      const handle = observation(h)
      if (point === 'after-reservation') handle.observer.onRoundReserved(IDENTITY.roundId)
      handle.dispatchRejected()
      handle.dispatchRejected()
      handle.observer.onRoundReserved(IDENTITY.roundId)
      await handle.observer.onRoundPersistedBeforeParticipants(IDENTITY.roundId)
      expectUnproven(h)
    }
  )

  it('fences duplicate reservation, proof callbacks, handles, and start ACKs', async () => {
    const h = harness()
    const handle = observation(h)
    expect(observation(h)).toBe(handle)
    handle.observer.onRoundReserved(IDENTITY.roundId)
    handle.observer.onRoundReserved(IDENTITY.roundId)
    const first = handle.observer.onRoundPersistedBeforeParticipants(IDENTITY.roundId)
    expect(handle.observer.onRoundPersistedBeforeParticipants(IDENTITY.roundId)).toBe(first)
    handle.dispatchSettled({ status: 'started', roundId: IDENTITY.roundId })
    handle.dispatchSettled({ status: 'started', roundId: IDENTITY.roundId })
    await first
    await handle.observer.onRoundPersistedBeforeParticipants(IDENTITY.roundId)
    expect(h.awaitPromptAndRoundDurable).toHaveBeenCalledTimes(1)
    expect(h.prepared).toHaveBeenCalledTimes(1)
    expect(h.abort).not.toHaveBeenCalled()
  })

  it.each(['reserve', 'before-participants'] as const)(
    'abandons a mismatched %s callback instead of recapturing another round',
    async (callback) => {
      const h = harness()
      const handle = observation(h)
      handle.observer.onRoundReserved(IDENTITY.roundId)
      if (callback === 'reserve') handle.observer.onRoundReserved('different-round')
      await handle.observer.onRoundPersistedBeforeParticipants(
        callback === 'before-participants' ? 'different-round' : IDENTITY.roundId
      )
      expect(h.awaitPromptAndRoundDurable).toHaveBeenCalledTimes(1)
      expectUnproven(h)
    }
  )

  it('never fabricates reservation when before-participants arrives first', async () => {
    const h = harness()
    const handle = observation(h)
    await handle.observer.onRoundPersistedBeforeParticipants(IDENTITY.roundId)
    handle.observer.onRoundReserved(IDENTITY.roundId)
    expect(h.awaitPromptAndRoundDurable).not.toHaveBeenCalled()
    expectUnproven(h)
  })

  it('is inert for gate OFF, ordinary Bridge calls, unknown actions, and wrong threads', async () => {
    const off = harness({}, false)
    expect(off.producer.observeRound(CORRELATION)).toBeUndefined()
    off.producer.unproven(CORRELATION)
    off.producer.beginShutdown()
    await off.producer.drain()
    const h = harness()
    for (const correlation of [
      { threadId: IDENTITY.threadId },
      { threadId: IDENTITY.threadId, hostCommandActionId: 'ordinary-action' },
      {
        threadId: IDENTITY.threadId,
        hostCommandActionId: 'host:command:22222222-2222-4222-8222-222222222222'
      },
      { ...CORRELATION, threadId: 'another-thread' }
    ]) {
      expect(h.producer.observeRound(correlation)).toBeUndefined()
      h.producer.unproven(correlation)
    }
    for (const candidate of [off, h]) {
      expect(candidate.awaitPromptAndRoundDurable).not.toHaveBeenCalled()
      expect(candidate.abort).not.toHaveBeenCalled()
      expect(candidate.prepared).not.toHaveBeenCalled()
      expect(candidate.settled).not.toHaveBeenCalled()
    }
  })

  it('freezes original correlation and rejects binding another supervisor', async () => {
    const h = harness()
    const input = { hostCommandActionId: ACTION_ID as string, threadId: IDENTITY.threadId }
    const handle = h.producer.observeRound(input)!
    input.threadId = 'different-thread'
    input.hostCommandActionId = 'different-action'
    handle.observer.onRoundReserved(IDENTITY.roundId)
    await handle.observer.onRoundPersistedBeforeParticipants(IDENTITY.roundId)
    expect(h.prepared.mock.calls[0][0].threadId).toBe(IDENTITY.threadId)
    const other = harness()
    expect(() => h.producer.onAdapter(other.adapter, other.abort)).toThrow('already bound')
  })

  it.each(['refused', 'throw'] as const)(
    'abandons a %s prepared publication without synthesizing a failed result',
    async (failure) => {
      const h = harness()
      if (failure === 'refused')
        h.prepared.mockResolvedValue({ kind: 'refused', reason: 'regression' })
      else h.prepared.mockRejectedValue(new Error('publication failed'))
      await publish(h)
      expect(h.abort).toHaveBeenCalledExactlyOnceWith(COMMAND_ID)
      expect(h.settled).not.toHaveBeenCalled()
    }
  )

  it('preserves proof if the adapter records prepared and then its caller throws', async () => {
    const h = harness()
    h.prepared.mockImplementation(async (event) => {
      await h.originalPrepared(event)
      throw new Error('after durable publication')
    })
    await publish(h)
    h.producer.beginShutdown()
    await h.producer.drain()
    expect(h.adapter.get(ACTION_ID)?.phase).toBe('prepared')
    expect(h.abort).not.toHaveBeenCalled()
    expect(h.settled).not.toHaveBeenCalled()
  })

  it('contains an actual adapter publication callback failure before ordinary participant work', async () => {
    const onFailure = vi.fn()
    const h = harness({}, true, {
      onPrepared: () => {
        throw new Error('authority callback failed')
      },
      onFailure
    })
    const handle = observation(h)
    const observed = createEnsembleRoundStartObservation(handle.observer, IDENTITY.roundId)
    const participantWork = vi.fn()
    observed.reserved()
    await observed.beforeParticipants().then(participantWork)
    expect(participantWork).toHaveBeenCalledTimes(1)
    expect(onFailure).toHaveBeenCalledExactlyOnceWith({
      hostCommandActionId: ACTION_ID,
      threadId: IDENTITY.threadId,
      reason: 'publication_failed'
    })
    expect(h.adapter.get(ACTION_ID)?.settled).toEqual({
      status: 'failed',
      errorCode: 'publication_failed'
    })
    expect(h.abort).toHaveBeenCalledExactlyOnceWith(COMMAND_ID)
    expect(h.settled).not.toHaveBeenCalled()
  })

  it('preserves a confirmed no-start settlement through uncertainty and shutdown', async () => {
    const h = harness()
    const handle = observation(h)
    await h.adapter.settled({
      kind: 'settled',
      hostCommandActionId: ACTION_ID,
      threadId: IDENTITY.threadId,
      status: 'cancelled',
      errorCode: 'queued_prompt_cancelled'
    })
    h.settled.mockClear()
    handle.observer.onRoundStartUnproven(IDENTITY.roundId)
    h.producer.beginShutdown()
    await h.producer.drain()
    expect(h.abort).not.toHaveBeenCalled()
    expect(h.prepared).not.toHaveBeenCalled()
    expect(h.settled).not.toHaveBeenCalled()
  })

  it('does not confuse earlier adapter publication failure with a proven no-start outcome', async () => {
    const h = harness({}, true, {
      onPrepared: () => {
        throw new Error('earlier publication failure')
      }
    })
    await h.originalPrepared({
      kind: 'prepared',
      hostCommandActionId: ACTION_ID,
      threadId: IDENTITY.threadId,
      durablePromptAndStartPersisted: true,
      start: { kind: 'ensemble', roundId: IDENTITY.roundId, participantRunIds: [] },
      effectRefs: [
        { family: 'thread', entityId: IDENTITY.threadId },
        { family: 'round', entityId: IDENTITY.roundId }
      ]
    })
    expect(h.producer.observeRound(CORRELATION)).toBeUndefined()
    h.producer.unproven(CORRELATION)
    expectUnproven(h)
  })

  it('preserves confirmed prepared proof through late errors and shutdown', async () => {
    const h = harness()
    const handle = await publish(h)
    handle.dispatchRejected()
    handle.observer.onRoundStartUnproven(IDENTITY.roundId)
    h.producer.unproven(CORRELATION)
    h.producer.beginShutdown()
    await h.producer.drain()
    expect(h.prepared).toHaveBeenCalledTimes(1)
    expect(h.abort).not.toHaveBeenCalled()
    expect(h.settled).not.toHaveBeenCalled()
  })

  it('contains a mutating abort throw exactly once without false failed settlement', async () => {
    const h = harness()
    let mutations = 0
    h.abort.mockImplementation(() => {
      mutations += 1
      throw new Error('after abort mutation')
    })
    const handle = observation(h)
    handle.dispatchRejected()
    h.producer.unproven(CORRELATION)
    handle.observer.onRoundStartUnproven(IDENTITY.roundId)
    h.producer.beginShutdown()
    await h.producer.drain()
    expect(mutations).toBe(1)
    expectUnproven(h)
  })

  it('explicit uncertainty releases the journal wait without cancelling participant work', async () => {
    const h = harness({ awaitPromptAndRoundDurable: () => new Promise(() => undefined) })
    const handle = observation(h)
    const observed = createEnsembleRoundStartObservation(handle.observer, IDENTITY.roundId)
    observed.reserved()
    const participantWork = vi.fn()
    const waiting = observed.beforeParticipants().then(participantWork)
    await Promise.resolve()
    observed.unproven()
    await waiting
    await h.producer.drain()
    expect(participantWork).toHaveBeenCalledTimes(1)
    expectUnproven(h)
  })

  it.each(['resolve', 'reject', 'never'] as const)(
    'shutdown drains without waiting on an unresolved barrier which will %s',
    async (later) => {
      const gate = deferred()
      const h = harness({ awaitPromptAndRoundDurable: () => gate.promise })
      const handle = observation(h)
      handle.observer.onRoundReserved(IDENTITY.roundId)
      const waiting = handle.observer.onRoundPersistedBeforeParticipants(IDENTITY.roundId)
      h.producer.beginShutdown()
      h.producer.beginShutdown()
      await Promise.all([waiting, h.producer.drain()])
      expectUnproven(h)
      if (later === 'resolve') gate.resolve()
      if (later === 'reject') gate.reject(new Error('late journal failure'))
      await Promise.resolve()
      handle.observer.onRoundReserved(IDENTITY.roundId)
      handle.dispatchSettled({ status: 'started', roundId: IDENTITY.roundId })
      await handle.observer.onRoundPersistedBeforeParticipants(IDENTITY.roundId)
      expect(h.producer.observeRound(CORRELATION)).toBeUndefined()
      expectUnproven(h)
    }
  )

  it('drains no provider turn and fences a reserved round whose detached task has not started', async () => {
    const gate = deferred()
    const h = harness({ awaitPromptAndRoundDurable: () => gate.promise })
    const handle = observation(h)
    handle.observer.onRoundReserved(IDENTITY.roundId)
    await h.producer.drain()
    expect(h.prepared).not.toHaveBeenCalled()
    h.producer.beginShutdown()
    await h.producer.drain()
    gate.resolve()
    await handle.observer.onRoundPersistedBeforeParticipants(IDENTITY.roundId)
    expectUnproven(h)
  })

  it('unproven without an observation is correlated, idempotent, and prevents a later observation', () => {
    const h = harness()
    h.producer.unproven(CORRELATION)
    h.producer.unproven(CORRELATION)
    expect(h.producer.observeRound(CORRELATION)).toBeUndefined()
    expectUnproven(h)
  })
})

describe('dispatchObservedHostBridgeRound', () => {
  it('preserves the exact synchronous result and only records its correlation', async () => {
    const h = harness()
    const handle = observation(h)
    const result = { status: 'started' as const, roundId: IDENTITY.roundId, applicationField: 42 }
    const actual = dispatchObservedHostBridgeRound(handle, (observer) => {
      expect(observer).toBe(handle.observer)
      observer!.onRoundReserved(IDENTITY.roundId)
      return result
    })
    expect(actual).toBe(result)
    expect(actual.applicationField).toBe(42)
    expect(h.prepared).not.toHaveBeenCalled()
    await handle.observer.onRoundPersistedBeforeParticipants(IDENTITY.roundId)
    expect(h.prepared).toHaveBeenCalledTimes(1)
    expect(h.abort).not.toHaveBeenCalled()
  })

  it('treats an unavailable optional orchestrator as uncertain and preserves undefined', () => {
    const h = harness()
    expect(dispatchObservedHostBridgeRound(observation(h), () => undefined)).toBeUndefined()
    expectUnproven(h)
  })

  it('records uncertainty after a side effect and rethrows the original dispatch error', () => {
    const h = harness()
    const failure = new Error('dispatch threw after invocation')
    const sideEffect = vi.fn()
    expect(() =>
      dispatchObservedHostBridgeRound(observation(h), () => {
        sideEffect()
        throw failure
      })
    ).toThrow(failure)
    expect(sideEffect).toHaveBeenCalledTimes(1)
    expectUnproven(h)
  })

  it('preserves ordinary unobserved dispatch, its result, and its error', () => {
    const result = { status: 'steered' as const }
    const dispatch = vi.fn(() => result)
    expect(dispatchObservedHostBridgeRound(undefined, dispatch)).toBe(result)
    expect(dispatch).toHaveBeenCalledExactlyOnceWith(undefined)
    const failure = new Error('ordinary dispatch failure')
    expect(() =>
      dispatchObservedHostBridgeRound(undefined, () => {
        throw failure
      })
    ).toThrow(failure)
  })
})
