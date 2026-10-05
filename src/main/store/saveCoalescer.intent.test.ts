import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  PerChatSaveIntentQueue,
  persistIdempotencyKeyFor,
  type ChatSaveIntent
} from '../../shared/chatSaveIntentQueue'
import type { ChatRecord } from './types'
import { createSaveCoalescer } from './saveCoalescer'

function intent(chatId: string, revision: number): ChatSaveIntent {
  const commandId = `cmd-${chatId}-${revision}`
  return {
    chatId,
    record: {
      appChatId: chatId,
      title: 't',
      persistenceRevision: revision,
      messages: []
    } as never as ChatRecord,
    authoredAt: revision,
    commandId,
    idempotencyKey: persistIdempotencyKeyFor(commandId)
  }
}

describe('saveCoalescer save intents', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('queues the intent before the write can touch anything', () => {
    const seen: Array<string | undefined> = []
    const coalescer = createSaveCoalescer(-1)
    coalescer.scheduleWithIntent(
      intent('a', 1),
      () => seen.push(coalescer.intentQueue.peek('a')[0]?.commandId),
      'normal'
    )
    expect(seen).toEqual(['cmd-a-1'])
  })

  it('queues the intent before a synchronous barrier write too', () => {
    const seen: Array<string | undefined> = []
    const coalescer = createSaveCoalescer(1000)
    coalescer.scheduleWithIntent(
      intent('a', 1),
      () => seen.push(coalescer.intentQueue.peek('a')[0]?.commandId),
      'terminal'
    )
    expect(seen).toEqual(['cmd-a-1'])
  })

  it('hands enqueueIntent to the queue it exposes, or to one it is given', () => {
    const queue = new PerChatSaveIntentQueue()
    const coalescer = createSaveCoalescer(100, 300, { intentQueue: queue })
    expect(coalescer.intentQueue).toBe(queue)
    coalescer.enqueueIntent(intent('a', 1))
    expect(queue.peek('a')).toHaveLength(1)
  })

  it('coalesces several intents for one chat into the latest record', () => {
    const coalescer = createSaveCoalescer(100)
    const write = vi.fn()
    for (const revision of [1, 2, 3]) {
      coalescer.scheduleWithIntent(intent('a', revision), write, 'normal')
    }
    const pending = coalescer.intentQueue.peek('a')
    expect(pending).toHaveLength(1)
    expect(pending[0].record.persistenceRevision).toBe(3)
    expect(pending[0].supersedes?.map((handle) => handle.commandId)).toEqual(['cmd-a-1', 'cmd-a-2'])
    vi.advanceTimersByTime(100)
    expect(write).toHaveBeenCalledTimes(1)
    // A write landing is not Host confirmation: the intent stays pending.
    expect(coalescer.intentQueue.peek('a')).toHaveLength(1)
  })

  it('keeps the max-latency ceiling: intents never push a write past it', () => {
    const coalescer = createSaveCoalescer(100, 300)
    const write = vi.fn()
    coalescer.scheduleWithIntent(intent('a', 1), write, 'normal')
    for (const revision of [2, 3, 4]) {
      vi.advanceTimersByTime(90)
      coalescer.scheduleWithIntent(intent('a', revision), write, 'normal')
    }
    expect(write).not.toHaveBeenCalled()
    vi.advanceTimersByTime(30)
    expect(write).toHaveBeenCalledTimes(1)
    expect(coalescer.stats().ceilingFlushes).toBe(1)
    expect(coalescer.intentQueue.peek('a')[0].record.persistenceRevision).toBe(4)
  })

  it('never delays or reorders a write: coalescing disabled still writes through', () => {
    const order: string[] = []
    const coalescer = createSaveCoalescer(-1)
    coalescer.scheduleWithIntent(intent('a', 1), () => order.push('first'), 'normal')
    coalescer.scheduleWithIntent(intent('a', 2), () => order.push('second'), 'normal')
    expect(order).toEqual(['first', 'second'])
    expect(coalescer.stats().scheduled).toBe(0)
  })

  it('discard forgets the chat intents along with its deferred write', () => {
    const coalescer = createSaveCoalescer(100)
    const write = vi.fn()
    coalescer.scheduleWithIntent(intent('a', 1), write, 'normal')
    coalescer.scheduleWithIntent(intent('b', 1), write, 'normal')
    expect(coalescer.discard('a')).toBe(true)
    expect(coalescer.intentQueue.peek('a')).toEqual([])
    expect(coalescer.intentQueue.admittedHead('a')).toBeNull()
    expect(coalescer.intentQueue.peek('b')).toHaveLength(1)
    // Even a chat with no deferred write has its intents forgotten.
    coalescer.enqueueIntent(intent('c', 1))
    expect(coalescer.discard('c')).toBe(false)
    expect(coalescer.intentQueue.peek('c')).toEqual([])
    coalescer.discardAll()
    expect(coalescer.intentQueue.peek('b')).toEqual([])
  })

  it('leaves the stats shape untouched', () => {
    const coalescer = createSaveCoalescer(100)
    expect(Object.keys(coalescer.stats()).sort()).toEqual(
      [
        'ceilingFlushes',
        'coalesced',
        'discarded',
        'flushed',
        'pending',
        'reasonMix',
        'scheduled',
        'urgentFlushes'
      ].sort()
    )
  })
})
