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
  const queue = new RawLogPresentationQueue({ present, schedule, cancel })
  return { callbacks, cancel, present, queue, schedule }
}

describe('RawLogPresentationQueue', () => {
  it('folds a provider-event burst into one latest-state presentation', () => {
    const { callbacks, present, queue, schedule } = harness()

    for (let index = 0; index < 1_000; index += 1) {
      queue.enqueue({ chatId: 'chat-a', logs: logs(String(index)) })
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
    const { callbacks, present, queue, schedule } = harness()
    queue.enqueue({ chatId: 'chat-a', logs: logs('first') })
    callbacks[0]()

    queue.enqueue({ chatId: 'chat-a', logs: logs('second') })
    expect(schedule).toHaveBeenCalledTimes(2)
    callbacks[1]()

    expect(present.mock.calls.map(([snapshot]) => snapshot.logs[0].content)).toEqual([
      'first',
      'second'
    ])
  })

  it('can flush interaction-driven state immediately and cancel the timer', () => {
    const { cancel, present, queue } = harness()
    const snapshot = { chatId: 'chat-a', logs: logs('now') }
    queue.enqueue(snapshot)

    queue.flushNow()

    expect(cancel).toHaveBeenCalledTimes(1)
    expect(present).toHaveBeenCalledWith(snapshot)
    expect(queue.hasPending()).toBe(false)
  })

  it('drops a stale pending projection when selection or clearing takes ownership', () => {
    const { callbacks, cancel, present, queue } = harness()
    queue.enqueue({ chatId: 'chat-a', logs: logs('stale') })

    queue.cancelPending()
    callbacks[0]()

    expect(cancel).toHaveBeenCalledTimes(1)
    expect(present).not.toHaveBeenCalled()
    expect(queue.hasPending()).toBe(false)
  })
})
