import { describe, expect, it, vi } from 'vitest'
import { createHostProjectionSerialQueue } from '../../host-runtime/HostProjectionSerialQueue'
import type { ChatRecord, RunStatus } from '../store/types'
import { createHostBridgeQueuedStartAdapter } from './HostBridgeQueuedStartAdapter'
import {
  createHostBridgeQueuedStartProducer,
  verifyHostBridgeQueuedStartRecord,
  type HostBridgeQueuedStartIdentity,
  type HostBridgeQueuedStartProducerOptions
} from './HostBridgeQueuedStartProducer'

const COMMAND_ID = '11111111-1111-4111-8111-111111111111'
const ACTION_ID = `host:command:${COMMAND_ID}` as const
const IDENTITY: HostBridgeQueuedStartIdentity = {
  hostCommandActionId: ACTION_ID,
  threadId: 'thread-a',
  runId: 'run-a',
  promptMessageId: 'prompt-a',
  provider: 'codex'
}
const INVOCATION = { provider: 'codex' as const, appRunId: IDENTITY.runId }
type StartRecord = Pick<ChatRecord, 'appChatId' | 'runs' | 'messages'>
const RECORDED_RUN_STATUSES: Record<RunStatus, true> = {
  running: true,
  sleeping: true,
  success: true,
  success_with_warnings: true,
  failed: true,
  cancelled: true
}

function startRecord(): StartRecord {
  return {
    appChatId: IDENTITY.threadId,
    runs: [
      {
        runId: IDENTITY.runId,
        provider: 'codex',
        promptMessageId: IDENTITY.promptMessageId,
        startedAt: '2026-09-24T00:00:00.000Z',
        status: 'running'
      }
    ],
    messages: [
      {
        id: IDENTITY.promptMessageId,
        role: 'user',
        content: 'send once',
        timestamp: '2026-09-24T00:00:00.000Z'
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

function harness(overrides: Partial<HostBridgeQueuedStartProducerOptions> = {}, bind = true) {
  const stored = startRecord()
  const persistenceEnabled = vi.fn(() => true)
  const awaitPromptAndStartDurable = vi.fn(async () => undefined)
  const verifyPromptAndStart = vi.fn((identity: HostBridgeQueuedStartIdentity) =>
    verifyHostBridgeQueuedStartRecord(stored, identity)
  )
  const producer = createHostBridgeQueuedStartProducer({
    persistenceEnabled,
    awaitPromptAndStartDurable,
    verifyPromptAndStart,
    ...overrides
  })
  const adapter = createHostBridgeQueuedStartAdapter({
    runProjectionOperation: createHostProjectionSerialQueue()
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
  const prepared = vi.spyOn(adapter, 'prepared')
  const settled = vi.spyOn(adapter, 'settled')
  const abort = vi.fn<(commandId: string) => void>()
  if (bind) producer.onAdapter(adapter, abort)
  return {
    producer,
    adapter,
    prepared,
    settled,
    abort,
    stored,
    persistenceEnabled,
    awaitPromptAndStartDurable,
    verifyPromptAndStart
  }
}

function observation(h: ReturnType<typeof harness>) {
  const handle = h.producer.observeDispatch(IDENTITY)
  if (!handle) throw new Error('expected registered Host observation')
  return handle
}

describe('verifyHostBridgeQueuedStartRecord', () => {
  it('requires the exact chat, unique run, provider, and linked user row', () => {
    const record = startRecord()
    expect(verifyHostBridgeQueuedStartRecord(record, IDENTITY)).toBe(true)
    expect(verifyHostBridgeQueuedStartRecord(undefined, IDENTITY)).toBe(false)
    expect(verifyHostBridgeQueuedStartRecord({ ...record, appChatId: 'other' }, IDENTITY)).toBe(
      false
    )
    expect(verifyHostBridgeQueuedStartRecord({ ...record, runs: [] }, IDENTITY)).toBe(false)
    expect(verifyHostBridgeQueuedStartRecord({ ...record, messages: [] }, IDENTITY)).toBe(false)
    expect(
      verifyHostBridgeQueuedStartRecord(
        { ...record, runs: [...record.runs!, ...record.runs!] },
        IDENTITY
      )
    ).toBe(false)
    expect(
      verifyHostBridgeQueuedStartRecord(
        { ...record, messages: [...record.messages, ...record.messages] },
        IDENTITY
      )
    ).toBe(false)
    expect(
      verifyHostBridgeQueuedStartRecord(
        { ...record, runs: [{ ...record.runs![0], runId: 'other' }] },
        IDENTITY
      )
    ).toBe(false)
    expect(
      verifyHostBridgeQueuedStartRecord(
        { ...record, runs: [{ ...record.runs![0], provider: 'claude' }] },
        IDENTITY
      )
    ).toBe(false)
    expect(
      verifyHostBridgeQueuedStartRecord(
        { ...record, runs: [{ ...record.runs![0], promptMessageId: 'other' }] },
        IDENTITY
      )
    ).toBe(false)
    expect(
      verifyHostBridgeQueuedStartRecord(
        { ...record, messages: [{ ...record.messages[0], role: 'assistant' }] },
        IDENTITY
      )
    ).toBe(false)
    expect(
      verifyHostBridgeQueuedStartRecord(
        { ...record, messages: [{ ...record.messages[0], runId: 'other' }] },
        IDENTITY
      )
    ).toBe(false)
  })

  it.each(Object.keys(RECORDED_RUN_STATUSES))(
    'recognizes a recorded %s start after actual invocation',
    (status) => {
      const record = startRecord()
      record.runs![0].status = status
      expect(verifyHostBridgeQueuedStartRecord(record, IDENTITY)).toBe(true)
    }
  )

  it('rejects a queued row, invalid timestamp, and reused prompt linkage', () => {
    const record = startRecord()
    record.runs![0].status = 'queued'
    expect(verifyHostBridgeQueuedStartRecord(record, IDENTITY)).toBe(false)
    record.runs![0].status = 'running'
    record.runs![0].startedAt = 'not-a-date'
    expect(verifyHostBridgeQueuedStartRecord(record, IDENTITY)).toBe(false)
    const reused = startRecord()
    reused.runs!.push({ ...reused.runs![0], runId: 'second-run' })
    expect(verifyHostBridgeQueuedStartRecord(reused, IDENTITY)).toBe(false)
  })
})

describe('HostBridgeQueuedStartProducer', () => {
  it('is inert without the ON-path binding and for ordinary or unregistered Bridge work', async () => {
    const off = harness({}, false)
    expect(off.producer.observeDispatch(IDENTITY)).toBeUndefined()
    off.producer.unproven(IDENTITY)
    off.producer.queueCancelled(IDENTITY)
    off.producer.queueDeclined(IDENTITY)
    await off.producer.drain()
    expect(off.abort).not.toHaveBeenCalled()
    expect(off.prepared).not.toHaveBeenCalled()
    expect(off.settled).not.toHaveBeenCalled()
    const on = harness()
    for (const input of [
      { ...IDENTITY, hostCommandActionId: undefined },
      { ...IDENTITY, hostCommandActionId: 'phone-action' },
      { ...IDENTITY, hostCommandActionId: 'host:command:22222222-2222-4222-8222-222222222222' },
      { ...IDENTITY, threadId: 'other-thread' }
    ]) {
      expect(on.producer.observeDispatch(input)).toBeUndefined()
      on.producer.unproven(input)
    }
    expect(on.awaitPromptAndStartDurable).not.toHaveBeenCalled()
    expect(on.abort).not.toHaveBeenCalled()
  })

  it('waits for exact invocation and the persistence barrier before emitting prepared', async () => {
    const barrier = deferred()
    const awaitDurable = vi.fn(() => barrier.promise)
    const h = harness({ awaitPromptAndStartDurable: awaitDurable })
    const handle = observation(h)
    expect(h.prepared).not.toHaveBeenCalled()
    expect(awaitDurable).not.toHaveBeenCalled()
    handle.observer.onAdapterInvoked?.(INVOCATION)
    expect(awaitDurable).toHaveBeenCalledExactlyOnceWith(IDENTITY)
    expect(h.prepared).not.toHaveBeenCalled()
    expect(h.verifyPromptAndStart).toHaveBeenCalledExactlyOnceWith(IDENTITY)
    // Completion of the provider turn does not stand in for a journal receipt.
    handle.dispatchSettled({ dispatched: true, appRunId: IDENTITY.runId })
    expect(h.prepared).not.toHaveBeenCalled()
    barrier.resolve()
    await h.producer.drain()
    expect(h.verifyPromptAndStart).toHaveBeenCalledTimes(2)
    expect(h.verifyPromptAndStart).toHaveBeenLastCalledWith(IDENTITY)
    expect(h.prepared).toHaveBeenCalledExactlyOnceWith({
      kind: 'prepared',
      hostCommandActionId: ACTION_ID,
      threadId: IDENTITY.threadId,
      durablePromptAndStartPersisted: true,
      start: { kind: 'solo', runId: IDENTITY.runId },
      effectRefs: [
        { family: 'thread', entityId: IDENTITY.threadId },
        { family: 'run', entityId: IDENTITY.runId }
      ]
    })
    expect(h.adapter.get(ACTION_ID)?.phase).toBe('prepared')
    expect(h.abort).not.toHaveBeenCalled()
    expect(h.settled).not.toHaveBeenCalled()
  })

  it('publishes before a full provider turn completes and deduplicates observer delivery', async () => {
    const h = harness()
    const handle = observation(h)
    expect(h.producer.observeDispatch(IDENTITY)).toBe(handle)
    handle.observer.onAdapterInvoked?.(INVOCATION)
    handle.observer.onAdapterInvoked?.(INVOCATION)
    await h.producer.drain()
    expect(h.prepared).toHaveBeenCalledOnce()
    expect(h.awaitPromptAndStartDurable).toHaveBeenCalledOnce()
    // A later provider failure cannot rewrite a proven start.
    handle.dispatchRejected()
    expect(h.abort).not.toHaveBeenCalled()
    expect(h.settled).not.toHaveBeenCalled()
  })

  it.each(Object.keys(RECORDED_RUN_STATUSES))(
    'accepts a legitimate status transition to %s while awaiting the journal',
    async (status) => {
      const barrier = deferred()
      const h = harness({ awaitPromptAndStartDurable: () => barrier.promise })
      observation(h).observer.onAdapterInvoked?.(INVOCATION)
      expect(h.verifyPromptAndStart).toHaveBeenCalledOnce()
      h.stored.runs![0].status = status
      barrier.resolve()
      await h.producer.drain()
      expect(h.verifyPromptAndStart).toHaveBeenCalledTimes(2)
      expect(h.prepared).toHaveBeenCalledOnce()
      expect(h.abort).not.toHaveBeenCalled()
      expect(h.settled).not.toHaveBeenCalled()
    }
  )

  it.each(['run', 'provider'] as const)(
    'abandons proof for mismatched invocation %s without settling failure',
    async (mismatch) => {
      const h = harness()
      observation(h).observer.onAdapterInvoked?.({
        ...INVOCATION,
        ...(mismatch === 'run' ? { appRunId: 'other-run' } : { provider: 'claude' as const })
      })
      await h.producer.drain()
      expect(h.abort).toHaveBeenCalledExactlyOnceWith(COMMAND_ID)
      expect(h.prepared).not.toHaveBeenCalled()
      expect(h.settled).not.toHaveBeenCalled()
      expect(h.awaitPromptAndStartDurable).not.toHaveBeenCalled()
    }
  )

  it('validates the original queue reservation and refuses a second run for one command', async () => {
    const h = harness()
    await h.adapter.queued({
      kind: 'queued',
      hostCommandActionId: ACTION_ID,
      threadId: IDENTITY.threadId,
      queueId: IDENTITY.runId,
      reservedRunId: IDENTITY.runId
    })
    expect(h.producer.observeDispatch({ ...IDENTITY, runId: 'other-run' })).toBeUndefined()
    expect(h.abort).toHaveBeenCalledExactlyOnceWith(COMMAND_ID)
    const duplicate = harness()
    const handle = observation(duplicate)
    expect(
      duplicate.producer.observeDispatch({ ...IDENTITY, promptMessageId: 'other-prompt' })
    ).toBeUndefined()
    handle.observer.onAdapterInvoked?.(INVOCATION)
    await duplicate.producer.drain()
    expect(duplicate.abort).toHaveBeenCalledExactlyOnceWith(COMMAND_ID)
    expect(duplicate.prepared).not.toHaveBeenCalled()
  })

  it.each(['disabled', 'barrier-rejected', 'missing-row', 'verifier-threw'] as const)(
    'never publishes unproven %s state',
    async (failure) => {
      const h = harness({
        ...(failure === 'disabled' ? { persistenceEnabled: () => false } : {}),
        ...(failure === 'barrier-rejected'
          ? {
              awaitPromptAndStartDurable: async () => {
                throw new Error('disk failed')
              }
            }
          : {}),
        ...(failure === 'verifier-threw'
          ? {
              verifyPromptAndStart: () => {
                throw new Error('read failed')
              }
            }
          : {})
      })
      if (failure === 'missing-row') h.stored.messages = []
      observation(h).observer.onAdapterInvoked?.(INVOCATION)
      await h.producer.drain()
      expect(h.abort).toHaveBeenCalledExactlyOnceWith(COMMAND_ID)
      expect(h.prepared).not.toHaveBeenCalled()
      expect(h.settled).not.toHaveBeenCalled()
    }
  )

  it('rechecks persistence and exact rows after an asynchronous barrier', async () => {
    const barrier = deferred()
    const h = harness({ awaitPromptAndStartDurable: () => barrier.promise })
    observation(h).observer.onAdapterInvoked?.(INVOCATION)
    h.persistenceEnabled.mockReturnValue(false)
    barrier.resolve()
    await h.producer.drain()
    expect(h.abort).toHaveBeenCalledOnce()
    expect(h.prepared).not.toHaveBeenCalled()
    const second = deferred()
    const cleared = harness({ awaitPromptAndStartDurable: () => second.promise })
    observation(cleared).observer.onAdapterInvoked?.(INVOCATION)
    cleared.stored.runs = []
    second.resolve()
    await cleared.producer.drain()
    expect(cleared.prepared).not.toHaveBeenCalled()
    expect(cleared.abort).toHaveBeenCalledOnce()
  })

  it('does not infer invocation from a dispatched return value', async () => {
    const h = harness()
    observation(h).dispatchSettled({ dispatched: true, appRunId: IDENTITY.runId })
    await h.producer.drain()
    expect(h.abort).toHaveBeenCalledExactlyOnceWith(COMMAND_ID)
    expect(h.prepared).not.toHaveBeenCalled()
    expect(h.settled).not.toHaveBeenCalled()
  })

  it('rejects rows absent before the barrier even if they appear before a later read', async () => {
    const h = harness()
    const handle = observation(h)
    h.stored.messages = []
    handle.observer.onAdapterInvoked?.(INVOCATION)
    h.stored.messages = startRecord().messages
    await h.producer.drain()
    expect(h.awaitPromptAndStartDurable).not.toHaveBeenCalled()
    expect(h.verifyPromptAndStart).toHaveBeenCalledOnce()
    expect(h.prepared).not.toHaveBeenCalled()
    expect(h.abort).toHaveBeenCalledExactlyOnceWith(COMMAND_ID)
  })

  it('settles a proven no-dispatch result once', async () => {
    const h = harness()
    const handle = observation(h)
    handle.dispatchSettled({ dispatched: false, appRunId: IDENTITY.runId })
    handle.dispatchSettled({ dispatched: false, appRunId: IDENTITY.runId })
    handle.observer.onAdapterInvoked?.(INVOCATION)
    await h.producer.drain()
    expect(h.settled).toHaveBeenCalledExactlyOnceWith({
      kind: 'settled',
      hostCommandActionId: ACTION_ID,
      threadId: IDENTITY.threadId,
      status: 'failed',
      errorCode: 'dispatch_declined'
    })
    expect(h.abort).not.toHaveBeenCalled()
    expect(h.prepared).not.toHaveBeenCalled()
  })

  it('does not settle a no-dispatch result carrying another run identity', async () => {
    const h = harness()
    observation(h).dispatchSettled({ dispatched: false, appRunId: 'other-run' })
    await h.producer.drain()
    expect(h.abort).toHaveBeenCalledExactlyOnceWith(COMMAND_ID)
    expect(h.settled).not.toHaveBeenCalled()
    expect(h.prepared).not.toHaveBeenCalled()
  })

  it.each(['dispatchDeclined', 'queueCancelled', 'queueDeclined'] as const)(
    'retires confirmed %s evidence before shutdown without another abort',
    async (outcome) => {
      const h = harness()
      const handle = observation(h)
      if (outcome === 'dispatchDeclined') {
        handle.dispatchSettled({ dispatched: false, appRunId: IDENTITY.runId })
      } else {
        h.producer[outcome](IDENTITY)
      }
      await h.producer.drain()
      h.producer.beginShutdown()
      await h.producer.drain()
      handle.observer.onAdapterInvoked?.(INVOCATION)
      handle.dispatchRejected()
      h.producer.unproven(IDENTITY)
      expect(h.abort).not.toHaveBeenCalled()
      expect(h.settled).toHaveBeenCalledOnce()
      expect(h.prepared).not.toHaveBeenCalled()
      expect(h.producer.observeDispatch(IDENTITY)).toBeUndefined()
    }
  )

  it.each([false, true])(
    'treats rejection as uncertain with observed invocation=%s',
    async (invoked) => {
      const barrier = deferred()
      const h = harness({ awaitPromptAndStartDurable: () => barrier.promise })
      const handle = observation(h)
      if (invoked) handle.observer.onAdapterInvoked?.(INVOCATION)
      handle.dispatchRejected()
      handle.dispatchRejected()
      barrier.resolve()
      await h.producer.drain()
      expect(h.abort).toHaveBeenCalledExactlyOnceWith(COMMAND_ID)
      expect(h.prepared).not.toHaveBeenCalled()
      expect(h.settled).not.toHaveBeenCalled()
    }
  )

  it.each(['queueCancelled', 'queueDeclined'] as const)(
    '%s settles only proven pre-dispatch outcomes',
    async (method) => {
      const h = harness()
      h.producer[method](IDENTITY)
      h.producer[method](IDENTITY)
      await h.producer.drain()
      expect(h.adapter.get(ACTION_ID)?.settled?.status).toBe(
        method === 'queueCancelled' ? 'cancelled' : 'failed'
      )
      expect(h.settled).toHaveBeenCalledOnce()
      expect(h.abort).not.toHaveBeenCalled()
      const barrier = deferred()
      const invoked = harness({ awaitPromptAndStartDurable: () => barrier.promise })
      observation(invoked).observer.onAdapterInvoked?.(INVOCATION)
      invoked.producer[method](IDENTITY)
      barrier.resolve()
      await invoked.producer.drain()
      expect(invoked.abort).toHaveBeenCalledOnce()
      expect(invoked.settled).not.toHaveBeenCalled()
      expect(invoked.prepared).not.toHaveBeenCalled()
    }
  )

  it('unproven abandons a queue once without emitting a settlement or later proof', async () => {
    const h = harness()
    h.producer.unproven(IDENTITY)
    h.producer.unproven(IDENTITY)
    h.producer.queueCancelled(IDENTITY)
    h.producer.queueDeclined(IDENTITY)
    expect(h.producer.observeDispatch(IDENTITY)).toBeUndefined()
    await h.producer.drain()
    expect(h.abort).toHaveBeenCalledExactlyOnceWith(COMMAND_ID)
    expect(h.settled).not.toHaveBeenCalled()
  })

  it.each(['prepared-refused', 'prepared-threw', 'settled-refused', 'settled-threw'] as const)(
    'abandons proof for %s',
    async (failure) => {
      const h = harness()
      if (failure.startsWith('prepared')) {
        h.prepared.mockImplementation(async () => {
          if (failure.endsWith('threw')) throw new Error('port failed')
          return { kind: 'refused', reason: 'shutting_down' }
        })
        observation(h).observer.onAdapterInvoked?.(INVOCATION)
      } else {
        h.settled.mockImplementation(async () => {
          if (failure.endsWith('threw')) throw new Error('port failed')
          return { kind: 'refused', reason: 'shutting_down' }
        })
        h.producer.queueCancelled(IDENTITY)
      }
      await h.producer.drain()
      expect(h.abort).toHaveBeenCalledExactlyOnceWith(COMMAND_ID)
    }
  )

  it('contains an abort that mutates then throws, without retrying or claiming failure', async () => {
    const h = harness()
    h.abort.mockImplementation(() => {
      throw new Error('after mutation')
    })
    expect(() => h.producer.unproven(IDENTITY)).not.toThrow()
    h.producer.unproven(IDENTITY)
    await h.producer.drain()
    expect(h.abort).toHaveBeenCalledOnce()
    expect(h.settled).not.toHaveBeenCalled()
  })

  it('shutdown releases a never-resolving persistence tail and fences later evidence', async () => {
    const barrier = deferred()
    const h = harness({ awaitPromptAndStartDurable: () => barrier.promise })
    const handle = observation(h)
    handle.observer.onAdapterInvoked?.(INVOCATION)
    h.producer.beginShutdown()
    expect(h.abort).toHaveBeenCalledExactlyOnceWith(COMMAND_ID)
    // Deliberately leave the journal unresolved until drain returns. Waiting
    // for it would hang shutdown; resolving it later must not publish proof.
    await h.producer.drain()
    barrier.resolve()
    await Promise.resolve()
    handle.dispatchSettled({ dispatched: true, appRunId: IDENTITY.runId })
    expect(h.prepared).not.toHaveBeenCalled()
    expect(h.settled).not.toHaveBeenCalled()
  })

  it('contains a detached journal rejection after shutdown already drained', async () => {
    const barrier = deferred()
    const h = harness({ awaitPromptAndStartDurable: () => barrier.promise })
    observation(h).observer.onAdapterInvoked?.(INVOCATION)
    h.producer.beginShutdown()
    await h.producer.drain()
    barrier.reject(new Error('late journal failure'))
    await Promise.resolve()
    expect(h.abort).toHaveBeenCalledExactlyOnceWith(COMMAND_ID)
    expect(h.prepared).not.toHaveBeenCalled()
    expect(h.settled).not.toHaveBeenCalled()
  })

  it('shutdown does not await a full provider turn and fences a late invocation', async () => {
    const h = harness()
    const handle = observation(h)
    h.producer.beginShutdown()
    await h.producer.drain()
    handle.observer.onAdapterInvoked?.(INVOCATION)
    expect(h.producer.observeDispatch(IDENTITY)).toBeUndefined()
    expect(h.abort).toHaveBeenCalledExactlyOnceWith(COMMAND_ID)
    expect(h.awaitPromptAndStartDurable).not.toHaveBeenCalled()
    expect(h.prepared).not.toHaveBeenCalled()
  })

  it('late queue decisions cannot enqueue new settlements after shutdown drained', async () => {
    const h = harness()
    h.producer.beginShutdown()
    await h.producer.drain()
    h.producer.queueCancelled(IDENTITY)
    h.producer.queueDeclined(IDENTITY)
    expect(h.abort).toHaveBeenCalledExactlyOnceWith(COMMAND_ID)
    expect(h.settled).not.toHaveBeenCalled()
  })
})
