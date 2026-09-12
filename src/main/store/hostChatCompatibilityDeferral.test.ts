/**
 * Deferred materialization for large-chat Host compatibility checkpoints.
 *
 * Pins the policy that keeps a terminal save of a large record from
 * serializing the whole record synchronously inside AppStore.saveChat (the
 * 27.5 MB save wedge: main held ~2 s, the Host ~6.4 s, and the panel looked
 * frozen for ~25 s). The journal is already durable at save time; the
 * checkpoint moves to a short trailing timer, a barrier, or shutdown.
 */
import { describe, expect, it } from 'vitest'

import {
  DEFERRED_HOST_MATERIALIZE_DELAY_MS,
  DEFERRED_HOST_MATERIALIZE_MIN_BYTES,
  DeferredHostMaterialization
} from './hostChatCompatibilityDeferral'

interface FakeTimer {
  callback: () => void
  delayMs: number
  cleared: boolean
}

function harness(
  options: {
    minBytes?: number
    delayMs?: number
    isDeleted?: (chatId: string) => boolean
  } = {}
) {
  const timers: FakeTimer[] = []
  const materialized: string[] = []
  const deferral = new DeferredHostMaterialization({
    materialize: (chatId) => {
      materialized.push(chatId)
      return true
    },
    isDeleted: options.isDeleted ?? (() => false),
    ...(options.minBytes !== undefined ? { minBytes: options.minBytes } : {}),
    ...(options.delayMs !== undefined ? { delayMs: options.delayMs } : {}),
    setTimer: (callback, delayMs) => {
      const timer: FakeTimer = { callback, delayMs, cleared: false }
      timers.push(timer)
      return timer as unknown as ReturnType<typeof setTimeout>
    },
    clearTimer: (timer) => {
      ;(timer as unknown as FakeTimer).cleared = true
    }
  })
  return { deferral, timers, materialized }
}

describe('DeferredHostMaterialization', () => {
  it('defers a large terminal checkpoint and materializes it after the trailing delay', () => {
    const { deferral, timers, materialized } = harness()
    const scheduled = deferral.schedule('chat-a', {
      existingBytes: DEFERRED_HOST_MATERIALIZE_MIN_BYTES,
      flushReason: 'terminal',
      durabilityFallback: false
    })
    expect(scheduled).toBe(true)
    expect(deferral.pendingChatIds).toEqual(['chat-a'])
    expect(timers).toHaveLength(1)
    expect(timers[0].delayMs).toBe(DEFERRED_HOST_MATERIALIZE_DELAY_MS)
    expect(materialized).toEqual([])

    timers[0].callback()
    expect(materialized).toEqual(['chat-a'])
    expect(deferral.pendingChatIds).toEqual([])
  })

  it('coalesces a burst of saves into one checkpoint', () => {
    const { deferral, timers, materialized } = harness()
    for (let index = 0; index < 5; index += 1) {
      expect(
        deferral.schedule('chat-a', {
          existingBytes: DEFERRED_HOST_MATERIALIZE_MIN_BYTES + index,
          flushReason: 'terminal',
          durabilityFallback: false
        })
      ).toBe(true)
    }
    expect(timers).toHaveLength(5)
    expect(timers.slice(0, 4).every((timer) => timer.cleared)).toBe(true)
    expect(timers[4].cleared).toBe(false)

    timers[4].callback()
    expect(materialized).toEqual(['chat-a'])
  })

  it.each([
    [
      'a small record',
      {
        existingBytes: DEFERRED_HOST_MATERIALIZE_MIN_BYTES - 1,
        flushReason: 'terminal',
        durabilityFallback: false
      }
    ],
    [
      'a non-terminal flush',
      {
        existingBytes: DEFERRED_HOST_MATERIALIZE_MIN_BYTES + 1,
        flushReason: 'approval',
        durabilityFallback: false
      }
    ],
    [
      'a durability fallback',
      {
        existingBytes: DEFERRED_HOST_MATERIALIZE_MIN_BYTES + 1,
        flushReason: 'terminal',
        durabilityFallback: true
      }
    ]
  ])('never defers %s — the caller materializes synchronously', (_label, decision) => {
    const { deferral, timers, materialized } = harness()
    expect(deferral.schedule('chat-a', decision)).toBe(false)
    expect(timers).toEqual([])
    expect(materialized).toEqual([])
    expect(deferral.pendingChatIds).toEqual([])
  })

  it('does not materialize a chat deleted during the deferral window', () => {
    const { deferral, timers, materialized } = harness()
    deferral.schedule('chat-a', {
      existingBytes: DEFERRED_HOST_MATERIALIZE_MIN_BYTES,
      flushReason: 'terminal',
      durabilityFallback: false
    })
    // The delete lands while the checkpoint waits: the tombstone wins.
    deferral.cancel('chat-a')
    expect(timers[0].cleared).toBe(true)
    expect(deferral.pendingChatIds).toEqual([])
    expect(materialized).toEqual([])
  })

  it('a tombstone seen at fire time also wins over the checkpoint', () => {
    const deleted = new Set(['chat-a'])
    const { deferral, timers, materialized } = harness({
      isDeleted: (chatId) => deleted.has(chatId)
    })
    deferral.schedule('chat-a', {
      existingBytes: DEFERRED_HOST_MATERIALIZE_MIN_BYTES,
      flushReason: 'terminal',
      durabilityFallback: false
    })
    deleted.add('chat-a')
    timers[0].callback()
    expect(materialized).toEqual([])
  })

  it('a materialize failure leaves nothing pending but stays recoverable by the next flush', () => {
    let attempts = 0
    let fired: (() => void) | null = null
    const deferral = new DeferredHostMaterialization({
      materialize: () => {
        attempts += 1
        throw new Error('host lane closed')
      },
      isDeleted: () => false,
      setTimer: (callback) => {
        fired = callback
        return {} as ReturnType<typeof setTimeout>
      },
      clearTimer: () => {}
    })
    expect(
      deferral.schedule('chat-a', {
        existingBytes: DEFERRED_HOST_MATERIALIZE_MIN_BYTES,
        flushReason: 'terminal',
        durabilityFallback: false
      })
    ).toBe(true)
    expect(deferral.pendingChatIds).toEqual(['chat-a'])
    fired!()
    expect(attempts).toBe(1)
    expect(deferral.pendingChatIds).toEqual([])
  })

  it('honours a custom size floor and delay', () => {
    const { deferral, timers } = harness({ minBytes: 100, delayMs: 7 })
    expect(
      deferral.schedule('chat-a', {
        existingBytes: 100,
        flushReason: 'terminal',
        durabilityFallback: false
      })
    ).toBe(true)
    expect(timers[0].delayMs).toBe(7)
  })

  it('dispose clears every pending window', () => {
    const { deferral, timers } = harness()
    deferral.schedule('chat-a', {
      existingBytes: DEFERRED_HOST_MATERIALIZE_MIN_BYTES,
      flushReason: 'terminal',
      durabilityFallback: false
    })
    deferral.schedule('chat-b', {
      existingBytes: DEFERRED_HOST_MATERIALIZE_MIN_BYTES,
      flushReason: 'terminal',
      durabilityFallback: false
    })
    deferral.dispose()
    expect(timers.every((timer) => timer.cleared)).toBe(true)
    expect(deferral.pendingChatIds).toEqual([])
  })

  it('rejects a construction without callbacks', () => {
    expect(() => new DeferredHostMaterialization({} as never)).toThrow(TypeError)
  })
})
