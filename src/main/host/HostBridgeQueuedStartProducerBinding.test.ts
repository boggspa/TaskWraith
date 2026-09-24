import { describe, expect, it, vi } from 'vitest'
import { createHostProjectionSerialQueue } from '../../host-runtime/HostProjectionSerialQueue'
import {
  createHostBridgeQueuedStartAdapter,
  type HostBridgeQueuedStartAdapterOptions
} from './HostBridgeQueuedStartAdapter'
import type {
  createHostBridgeQueuedStartProducer,
  HostBridgeQueuedStartIdentity,
  HostBridgeQueuedStartProducerOptions
} from './HostBridgeQueuedStartProducer'
import { createHostBridgeQueuedStartProducerBinding } from './HostBridgeQueuedStartProducerBinding'
import type { createHostBridgeQueuedRoundStartProducer } from './HostBridgeQueuedRoundStartProducer'

type Producer = ReturnType<typeof createHostBridgeQueuedStartProducer>
type RoundProducer = ReturnType<typeof createHostBridgeQueuedRoundStartProducer>
const COMMAND_ID = '11111111-1111-4111-8111-111111111111'
const IDENTITY: HostBridgeQueuedStartIdentity = {
  hostCommandActionId: `host:command:${COMMAND_ID}`,
  threadId: 'thread-a',
  runId: 'run-a',
  promptMessageId: 'prompt-a',
  provider: 'codex'
}
const INVOCATION = { provider: IDENTITY.provider, appRunId: IDENTITY.runId }

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

function registeredAdapter(overrides: Partial<HostBridgeQueuedStartAdapterOptions> = {}) {
  const onPrepared = vi.fn()
  const adapter = createHostBridgeQueuedStartAdapter({
    runProjectionOperation: createHostProjectionSerialQueue(),
    onPrepared,
    ...overrides
  })
  expect(
    adapter.register({
      hostCommandActionId: IDENTITY.hostCommandActionId,
      threadId: IDENTITY.threadId,
      authority: {
        actorId: 'actor-a',
        clientId: 'client-a',
        clientClass: 'desktop',
        commandFingerprint: 'fingerprint-a'
      }
    }).kind
  ).toBe('registered')
  return { adapter, onPrepared, abort: vi.fn<(commandId: string) => void>() }
}

function harness(overrides: Partial<HostBridgeQueuedStartProducerOptions> = {}) {
  let current: Producer | null = null
  const persistenceEnabled = vi.fn(() => true)
  const awaitPromptAndStartDurable = vi.fn(async () => undefined)
  const verifyPromptAndStart = vi.fn(() => true)
  const onCurrentProducer = vi.fn((producer: Producer | null) => {
    current = producer
  })
  const binding = createHostBridgeQueuedStartProducerBinding({
    persistenceEnabled,
    awaitPromptAndStartDurable,
    verifyPromptAndStart,
    onCurrentProducer,
    ...overrides
  })
  const producer = (): Producer => {
    if (!current) throw new Error('expected current producer')
    return current
  }
  return {
    binding,
    producer,
    current: () => current,
    onCurrentProducer,
    persistenceEnabled,
    awaitPromptAndStartDurable,
    verifyPromptAndStart
  }
}

function observation(producer: Producer) {
  const handle = producer.observeDispatch(IDENTITY)
  if (!handle) throw new Error('expected bound dispatch observation')
  return handle
}

describe('HostBridgeQueuedStartProducerBinding', () => {
  it('constructs lazily and publishes through the exact bound adapter after persistence', async () => {
    const h = harness()
    expect(h.onCurrentProducer).not.toHaveBeenCalled()
    expect(h.persistenceEnabled).not.toHaveBeenCalled()
    expect(h.awaitPromptAndStartDurable).not.toHaveBeenCalled()
    expect(h.verifyPromptAndStart).not.toHaveBeenCalled()

    const a = registeredAdapter()
    h.binding.onAdapter(a.adapter, a.abort)
    const producer = h.producer()
    expect(h.onCurrentProducer).toHaveBeenCalledExactlyOnceWith(producer)
    observation(producer).observer.onAdapterInvoked?.(INVOCATION)
    await producer.drain()

    expect(h.awaitPromptAndStartDurable).toHaveBeenCalledExactlyOnceWith(IDENTITY)
    expect(a.adapter.get(IDENTITY.hostCommandActionId)).toMatchObject({
      phase: 'prepared',
      prepared: { start: { kind: 'solo', runId: IDENTITY.runId } }
    })
    expect(a.onPrepared).toHaveBeenCalledOnce()
    expect(a.abort).not.toHaveBeenCalled()
    await h.binding.beforeShutdown!(a.adapter)
    expect(h.current()).toBeNull()
  })

  it('fences A synchronously without clearing or fencing B while A awaits persistence', async () => {
    const journal = deferred()
    const awaitDurable = vi
      .fn()
      .mockImplementationOnce(() => journal.promise)
      .mockResolvedValue(undefined)
    const h = harness({ awaitPromptAndStartDurable: awaitDurable })
    const a = registeredAdapter()
    const b = registeredAdapter()
    h.binding.onAdapter(a.adapter, a.abort)
    const producerA = h.producer()
    const pendingA = observation(producerA)
    pendingA.observer.onAdapterInvoked?.(INVOCATION)
    expect(awaitDurable).toHaveBeenCalledOnce()

    h.binding.onAdapter(b.adapter, b.abort)
    const producerB = h.producer()
    expect(producerB).not.toBe(producerA)
    const stoppingA = h.binding.beforeShutdown!(a.adapter)
    // These assertions precede the first await of shutdown.
    expect(a.abort).toHaveBeenCalledExactlyOnceWith(COMMAND_ID)
    expect(producerA.observeDispatch(IDENTITY)).toBeUndefined()
    expect(h.current()).toBe(producerB)
    expect(h.onCurrentProducer.mock.calls.map(([producer]) => producer)).toEqual([
      producerA,
      producerB
    ])
    expect(b.abort).not.toHaveBeenCalled()

    observation(producerB).observer.onAdapterInvoked?.(INVOCATION)
    await stoppingA
    await producerB.drain()
    expect(b.onPrepared).toHaveBeenCalledOnce()
    journal.resolve()
    await journal.promise
    await producerA.drain()
    pendingA.dispatchSettled({ dispatched: true, appRunId: IDENTITY.runId })
    expect(a.onPrepared).not.toHaveBeenCalled()
    expect(h.current()).toBe(producerB)
    await h.binding.beforeShutdown!(a.adapter)
    expect(h.current()).toBe(producerB)
    await h.binding.beforeShutdown!(b.adapter)
    expect(h.current()).toBeNull()
  })

  it('clears A before draining and preserves B bound while A has a pending publication', async () => {
    const publication = deferred()
    const entered = deferred()
    const h = harness()
    const a = registeredAdapter({
      onPrepared: async () => {
        entered.resolve()
        await publication.promise
      }
    })
    const b = registeredAdapter()
    h.binding.onAdapter(a.adapter, a.abort)
    const producerA = h.producer()
    observation(producerA).observer.onAdapterInvoked?.(INVOCATION)
    await entered.promise
    let drainedA = false
    const stoppingA = Promise.resolve(h.binding.beforeShutdown!(a.adapter)).then(() => {
      drainedA = true
    })
    expect(h.current()).toBeNull()
    h.binding.onAdapter(b.adapter, b.abort)
    const producerB = h.producer()
    observation(producerB).observer.onAdapterInvoked?.(INVOCATION)
    await producerB.drain()
    expect(drainedA).toBe(false)
    expect(b.onPrepared).toHaveBeenCalledOnce()

    publication.resolve()
    await stoppingA
    expect(h.current()).toBe(producerB)
    expect(h.onCurrentProducer.mock.calls.map(([producer]) => producer)).toEqual([
      producerA,
      null,
      producerB
    ])
    expect(b.abort).not.toHaveBeenCalled()
    await h.binding.beforeShutdown!(b.adapter)
  })

  it('rejects adapter reuse without replacing its pending producer or abort callback', async () => {
    const journal = deferred()
    const h = harness({ awaitPromptAndStartDurable: () => journal.promise })
    const a = registeredAdapter()
    const replacementAbort = vi.fn()
    h.binding.onAdapter(a.adapter, a.abort)
    const producer = h.producer()
    observation(producer).observer.onAdapterInvoked?.(INVOCATION)
    expect(() => h.binding.onAdapter(a.adapter, replacementAbort)).toThrow(
      'HostBridgeQueuedStartProducerBinding adapter is already bound'
    )
    expect(h.current()).toBe(producer)
    expect(h.onCurrentProducer).toHaveBeenCalledOnce()
    await h.binding.beforeShutdown!(a.adapter)
    expect(a.abort).toHaveBeenCalledExactlyOnceWith(COMMAND_ID)
    expect(replacementAbort).not.toHaveBeenCalled()
    expect(() => h.binding.onAdapter(a.adapter, replacementAbort)).toThrow(
      'HostBridgeQueuedStartProducerBinding adapter is already bound'
    )
    journal.resolve()
    await producer.drain()
    expect(a.onPrepared).not.toHaveBeenCalled()
  })

  it('ignores unknown and drained adapters without clearing the current producer again', async () => {
    const h = harness()
    const a = registeredAdapter()
    const unknown = registeredAdapter()
    await h.binding.beforeShutdown!(unknown.adapter)
    expect(h.onCurrentProducer).not.toHaveBeenCalled()
    h.binding.onAdapter(a.adapter, a.abort)
    const producer = h.producer()
    const beginShutdown = vi.spyOn(producer, 'beginShutdown')
    await h.binding.beforeShutdown!(unknown.adapter)
    expect(h.current()).toBe(producer)
    await h.binding.beforeShutdown!(a.adapter)
    await h.binding.beforeShutdown!(a.adapter)
    expect(beginShutdown).toHaveBeenCalledOnce()
    expect(h.onCurrentProducer.mock.calls.map(([value]) => value)).toEqual([producer, null])
  })
})

describe('HostBridgeQueuedStartProducerBinding round generations', () => {
  it.each(['before', 'after'] as const)(
    'keeps B usable when A shutdown begins %s B binds',
    async (order) => {
      const journalA = deferred()
      let current: RoundProducer | null = null
      const onCurrentRound = vi.fn((producer: RoundProducer | null) => {
        current = producer
      })
      const binding = createHostBridgeQueuedStartProducerBinding({
        persistenceEnabled: () => true,
        awaitPromptAndStartDurable: async () => undefined,
        verifyPromptAndStart: () => true,
        onCurrentProducer: vi.fn(),
        roundStart: {
          persistenceEnabled: () => true,
          awaitPromptAndRoundDurable: vi
            .fn()
            .mockImplementationOnce(() => journalA.promise)
            .mockResolvedValue(undefined),
          verifyPromptAndRound: () => true,
          onCurrentProducer: onCurrentRound
        }
      })
      const currentRound = (): RoundProducer => {
        if (!current) throw new Error('expected bound round producer')
        return current
      }
      const a = registeredAdapter()
      const b = registeredAdapter()
      binding.onAdapter(a.adapter, a.abort)
      const producerA = currentRound()
      const observationA = producerA.observeRound(IDENTITY)!
      observationA.observer.onRoundReserved('round-a')
      const pendingA = observationA.observer.onRoundPersistedBeforeParticipants('round-a')
      let shutdownA: Promise<void>
      if (order === 'before') {
        shutdownA = Promise.resolve(binding.beforeShutdown!(a.adapter))
        expect(current).toBeNull()
        binding.onAdapter(b.adapter, b.abort)
      } else {
        binding.onAdapter(b.adapter, b.abort)
        shutdownA = Promise.resolve(binding.beforeShutdown!(a.adapter))
      }
      const producerB = currentRound()
      expect(producerB).not.toBe(producerA)
      const observationB = producerB.observeRound(IDENTITY)!
      observationB.observer.onRoundReserved('round-b')
      await observationB.observer.onRoundPersistedBeforeParticipants('round-b')
      await shutdownA
      await pendingA
      expect(currentRound()).toBe(producerB)
      expect(a.abort).toHaveBeenCalledExactlyOnceWith(COMMAND_ID)
      expect(a.onPrepared).not.toHaveBeenCalled()
      expect(b.onPrepared).toHaveBeenCalledOnce()
      expect(b.abort).not.toHaveBeenCalled()
      expect(b.adapter.get(IDENTITY.hostCommandActionId)?.prepared?.start).toEqual({
        kind: 'ensemble',
        roundId: 'round-b',
        participantRunIds: []
      })
      journalA.resolve()
      await producerA.drain()
      expect(a.onPrepared).not.toHaveBeenCalled()
      expect(onCurrentRound.mock.calls.map(([value]) => value)).toEqual(
        order === 'before' ? [producerA, null, producerB] : [producerA, producerB]
      )
      await binding.beforeShutdown!(b.adapter)
      expect(current).toBeNull()
    }
  )
})
