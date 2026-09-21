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
  DEFERRED_HOST_MATERIALIZE_MUTATION_THRESHOLD_BYTES,
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
    minMutationBytes?: number
    getPendingMutationBytes?: (chatId: string) => number
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
    ...(options.minMutationBytes !== undefined
      ? { minMutationBytes: options.minMutationBytes }
      : {}),
    ...(options.getPendingMutationBytes !== undefined
      ? { getPendingMutationBytes: options.getPendingMutationBytes }
      : {}),
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

  it('does not materialize below-threshold deltas and reschedules the trailing timer', () => {
    const { deferral, timers, materialized } = harness({ minMutationBytes: 1000 })
    const scheduled = deferral.schedule('chat-a', {
      existingBytes: DEFERRED_HOST_MATERIALIZE_MIN_BYTES,
      flushReason: 'terminal',
      durabilityFallback: false,
      mutationBytes: 500
    })
    expect(scheduled).toBe(true)
    expect(deferral.pendingChatIds).toEqual(['chat-a'])
    expect(deferral.accumulatedMutationBytes('chat-a')).toBe(500)
    expect(timers).toHaveLength(1)

    // Fire timer: below threshold (500 < 1000), so it reschedules instead of materializing
    timers[0].callback()
    expect(materialized).toEqual([])
    expect(timers).toHaveLength(2)
    expect(timers[1].cleared).toBe(false)
    expect(deferral.pendingChatIds).toEqual(['chat-a'])
    expect(deferral.accumulatedMutationBytes('chat-a')).toBe(500)
  })

  it('materializes when delta mutation volume meets or exceeds the threshold', () => {
    const { deferral, timers, materialized } = harness({ minMutationBytes: 1000 })
    const scheduled = deferral.schedule('chat-a', {
      existingBytes: DEFERRED_HOST_MATERIALIZE_MIN_BYTES,
      flushReason: 'terminal',
      durabilityFallback: false,
      mutationBytes: 1500
    })
    expect(scheduled).toBe(true)
    expect(timers).toHaveLength(1)

    // Fire timer: meets threshold (1500 >= 1000), so it materializes
    timers[0].callback()
    expect(materialized).toEqual(['chat-a'])
    expect(deferral.pendingChatIds).toEqual([])
    expect(deferral.accumulatedMutationBytes('chat-a')).toBe(0)
  })

  it('coalesces rapid saves into a single trailing timer while accumulating volume', () => {
    const { deferral, timers, materialized } = harness({ minMutationBytes: 1000 })
    deferral.schedule('chat-a', {
      existingBytes: DEFERRED_HOST_MATERIALIZE_MIN_BYTES,
      flushReason: 'terminal',
      durabilityFallback: false,
      mutationBytes: 300
    })
    deferral.schedule('chat-a', {
      existingBytes: DEFERRED_HOST_MATERIALIZE_MIN_BYTES,
      flushReason: 'terminal',
      durabilityFallback: false,
      mutationBytes: 400
    })
    deferral.schedule('chat-a', {
      existingBytes: DEFERRED_HOST_MATERIALIZE_MIN_BYTES,
      flushReason: 'terminal',
      durabilityFallback: false,
      mutationBytes: 500
    })

    expect(timers).toHaveLength(3)
    expect(timers[0].cleared).toBe(true)
    expect(timers[1].cleared).toBe(true)
    expect(timers[2].cleared).toBe(false)
    expect(deferral.accumulatedMutationBytes('chat-a')).toBe(1200)

    // Fire coalesced timer (1200 >= 1000): materializes once
    timers[2].callback()
    expect(materialized).toEqual(['chat-a'])
    expect(deferral.pendingChatIds).toEqual([])
  })

  it('accumulates repeated small deltas across reschedule windows until crossing threshold', () => {
    const { deferral, timers, materialized } = harness({ minMutationBytes: 1000 })

    // Delta 1: 400 bytes
    deferral.schedule('chat-a', {
      existingBytes: DEFERRED_HOST_MATERIALIZE_MIN_BYTES,
      flushReason: 'terminal',
      durabilityFallback: false,
      mutationBytes: 400
    })
    expect(timers).toHaveLength(1)
    timers[0].callback() // below threshold -> reschedules
    expect(materialized).toEqual([])
    expect(timers).toHaveLength(2)
    expect(deferral.accumulatedMutationBytes('chat-a')).toBe(400)

    // Delta 2: 300 bytes arrives during the rescheduled window
    deferral.schedule('chat-a', {
      existingBytes: DEFERRED_HOST_MATERIALIZE_MIN_BYTES,
      flushReason: 'terminal',
      durabilityFallback: false,
      mutationBytes: 300
    })
    // Timer 1 was cleared by new schedule, timer 2 created
    expect(timers[1].cleared).toBe(true)
    expect(timers).toHaveLength(3)
    expect(deferral.accumulatedMutationBytes('chat-a')).toBe(700)
    timers[2].callback() // 700 < 1000 -> reschedules
    expect(materialized).toEqual([])
    expect(timers).toHaveLength(4)

    // Delta 3: 400 bytes arrives. Total = 700 + 400 = 1100 >= 1000
    deferral.schedule('chat-a', {
      existingBytes: DEFERRED_HOST_MATERIALIZE_MIN_BYTES,
      flushReason: 'terminal',
      durabilityFallback: false,
      mutationBytes: 400
    })
    expect(timers[3].cleared).toBe(true)
    expect(timers).toHaveLength(5)
    expect(deferral.accumulatedMutationBytes('chat-a')).toBe(1100)

    timers[4].callback() // 1100 >= 1000 -> materializes!
    expect(materialized).toEqual(['chat-a'])
    expect(deferral.pendingChatIds).toEqual([])
    expect(deferral.accumulatedMutationBytes('chat-a')).toBe(0)
  })

  it('uses the default 512 KB mutation threshold when not explicitly specified', () => {
    const { deferral, timers, materialized } = harness()
    expect(deferral.mutationThresholdBytes).toBe(DEFERRED_HOST_MATERIALIZE_MUTATION_THRESHOLD_BYTES)

    // 500 KB < 512 KB
    deferral.schedule('chat-a', {
      existingBytes: DEFERRED_HOST_MATERIALIZE_MIN_BYTES,
      flushReason: 'terminal',
      durabilityFallback: false,
      mutationBytes: 500 * 1024
    })
    timers[0].callback()
    expect(materialized).toEqual([])
    expect(timers).toHaveLength(2)

    // Additional 20 KB: 500 KB + 20 KB = 520 KB >= 512 KB
    deferral.schedule('chat-a', {
      existingBytes: DEFERRED_HOST_MATERIALIZE_MIN_BYTES,
      flushReason: 'terminal',
      durabilityFallback: false,
      mutationBytes: 20 * 1024
    })
    timers[2].callback()
    expect(materialized).toEqual(['chat-a'])
    expect(deferral.pendingChatIds).toEqual([])
  })

  it('supports querying pending mutation volume via getPendingMutationBytes callback', () => {
    let pendingBytes = 100
    const { deferral, timers, materialized } = harness({
      minMutationBytes: 1000,
      getPendingMutationBytes: () => pendingBytes
    })
    deferral.schedule('chat-a', {
      existingBytes: DEFERRED_HOST_MATERIALIZE_MIN_BYTES,
      flushReason: 'terminal',
      durabilityFallback: false
    })
    timers[0].callback() // 100 < 1000 -> reschedules
    expect(materialized).toEqual([])
    expect(timers).toHaveLength(2)

    pendingBytes = 1200
    timers[1].callback() // 1200 >= 1000 -> materializes
    expect(materialized).toEqual(['chat-a'])
    expect(deferral.pendingChatIds).toEqual([])
  })
})
