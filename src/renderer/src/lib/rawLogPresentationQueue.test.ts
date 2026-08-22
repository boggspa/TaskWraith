import { describe, expect, it, vi } from 'vitest'

import type { RawLogEntry } from './rawLogEntry'
import {
  RAW_LOG_PRESENTATION_INTERVAL_MS,
  RawLogPresentationQueue,
  type RawLogPresentationSnapshot
} from './rawLogPresentationQueue'

function logs(content: string): RawLogEntry[] {
  return [{ type: 'stdout', content }]
}

function harness() {
  const callbacks: Array<() => void> = []
  const present = vi.fn<(snapshot: RawLogPresentationSnapshot) => void>()
  const schedule = vi.fn((callback: () => void) => {
    callbacks.push(callback)
    return callbacks.length
  })
  const cancel = vi.fn()
  const latestByChat = new Map<string, RawLogEntry[]>()
  const queue = new RawLogPresentationQueue({
    present,
    resolve: (chatId) => latestByChat.get(chatId) || [],
    schedule,
    cancel
  })
  return { callbacks, cancel, latestByChat, present, queue, schedule }
}

describe('RawLogPresentationQueue', () => {
  it('folds a provider-event burst into one latest-state presentation', () => {
    const { callbacks, latestByChat, present, queue, schedule } = harness()

    for (let index = 0; index < 1_000; index += 1) {
      latestByChat.set('chat-a', logs(String(index)))
      queue.enqueue('chat-a')
    }

    expect(schedule).toHaveBeenCalledTimes(1)
    expect(schedule).toHaveBeenCalledWith(expect.any(Function), RAW_LOG_PRESENTATION_INTERVAL_MS)
    expect(present).not.toHaveBeenCalled()

    callbacks[0]()
    expect(present).toHaveBeenCalledTimes(1)
    expect(present).toHaveBeenLastCalledWith({ chatId: 'chat-a', logs: logs('999') })
    expect(queue.hasPending()).toBe(false)
  })

  it('schedules a fresh presentation after the prior window drains', () => {
    const { callbacks, latestByChat, present, queue, schedule } = harness()
    latestByChat.set('chat-a', logs('first'))
    queue.enqueue('chat-a')
    callbacks[0]()

    latestByChat.set('chat-a', logs('second'))
    queue.enqueue('chat-a')
    expect(schedule).toHaveBeenCalledTimes(2)
    callbacks[1]()

    expect(present.mock.calls.map(([snapshot]) => snapshot.logs[0].content)).toEqual([
      'first',
      'second'
    ])
  })

  it('can flush interaction-driven state immediately and cancel the timer', () => {
    const { cancel, latestByChat, present, queue } = harness()
    const snapshot = { chatId: 'chat-a', logs: logs('now') }
    latestByChat.set('chat-a', snapshot.logs)
    queue.enqueue('chat-a')

    queue.flushNow()

    expect(cancel).toHaveBeenCalledTimes(1)
    expect(present).toHaveBeenCalledWith(snapshot)
    expect(queue.hasPending()).toBe(false)
  })

  it('drops a stale pending projection when selection or clearing takes ownership', () => {
    const { callbacks, cancel, latestByChat, present, queue } = harness()
    latestByChat.set('chat-a', logs('stale'))
    queue.enqueue('chat-a')

    queue.cancelPending()
    callbacks[0]()

    expect(cancel).toHaveBeenCalledTimes(1)
    expect(present).not.toHaveBeenCalled()
    expect(queue.hasPending()).toBe(false)
  })
})
