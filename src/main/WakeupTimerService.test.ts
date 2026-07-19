import { describe, expect, it, vi } from 'vitest'

import { WakeupTimerService, classifyWakeupRecovery } from './WakeupTimerService'
import type { EnsembleWakeupRecord } from './store/types'

function wakeup(overrides: Partial<EnsembleWakeupRecord> = {}): EnsembleWakeupRecord {
  return {
    wakeupId: 'wake-1',
    chatId: 'chat-1',
    roundId: 'round-1',
    participantId: 'participant-1',
    provider: 'codex',
    role: 'Worker',
    scheduledAt: '2026-05-27T00:00:00.000Z',
    wakeAt: '2026-05-27T00:01:00.000Z',
    status: 'pending',
    ...overrides
  }
}

describe('WakeupTimerService', () => {
  it('schedules and fires a pending wakeup', () => {
    vi.useFakeTimers()
    try {
      const onFire = vi.fn()
      const service = new WakeupTimerService({
        now: () => new Date('2026-05-27T00:00:00.000Z').getTime(),
        onFire
      })
      service.schedule(wakeup())
      expect(service.has('wake-1')).toBe(true)

      vi.advanceTimersByTime(59_999)
      expect(onFire).not.toHaveBeenCalled()
      vi.advanceTimersByTime(1)
      expect(onFire).toHaveBeenCalledWith('wake-1')
      expect(service.has('wake-1')).toBe(false)
    } finally {
      vi.useRealTimers()
    }
  })

  it('replace cancels the previous timer for the same wakeup id', () => {
    vi.useFakeTimers()
    try {
      let now = new Date('2026-05-27T00:00:00.000Z').getTime()
      const onFire = vi.fn()
      const service = new WakeupTimerService({ now: () => now, onFire })
      service.schedule(wakeup({ wakeAt: '2026-05-27T00:01:00.000Z' }))
      service.replace(wakeup({ wakeAt: '2026-05-27T00:02:00.000Z' }))

      vi.advanceTimersByTime(60_000)
      now += 60_000
      expect(onFire).not.toHaveBeenCalled()
      vi.advanceTimersByTime(60_000)
      expect(onFire).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('cancels a scheduled wakeup', () => {
    vi.useFakeTimers()
    try {
      const onFire = vi.fn()
      const service = new WakeupTimerService({
        now: () => new Date('2026-05-27T00:00:00.000Z').getTime(),
        onFire
      })
      service.schedule(wakeup())
      expect(service.cancel('wake-1')).toBe(true)
      expect(service.has('wake-1')).toBe(false)

      vi.advanceTimersByTime(60_000)
      expect(onFire).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })

  it('contains a synchronous fire-handler throw inside the detached timer boundary', () => {
    vi.useFakeTimers()
    try {
      const failure = new Error('prepared history rejected the wakeup write')
      const onFireError = vi.fn()
      const service = new WakeupTimerService({
        now: () => new Date('2026-05-27T00:00:00.000Z').getTime(),
        onFire: () => {
          throw failure
        },
        onFireError
      })
      service.schedule(wakeup())

      expect(() => vi.advanceTimersByTime(60_000)).not.toThrow()
      expect(onFireError).toHaveBeenCalledWith(failure, 'wake-1')
      expect(service.has('wake-1')).toBe(false)
    } finally {
      vi.useRealTimers()
    }
  })

  it('observes an asynchronous fire-handler rejection without an unhandled promise', async () => {
    vi.useFakeTimers()
    try {
      const failure = new Error('solo wakeup persistence rejected')
      const onFireError = vi.fn()
      const service = new WakeupTimerService({
        now: () => new Date('2026-05-27T00:00:00.000Z').getTime(),
        onFire: async () => {
          throw failure
        },
        onFireError
      })
      service.schedule(wakeup())

      await vi.advanceTimersByTimeAsync(60_000)
      expect(onFireError).toHaveBeenCalledWith(failure, 'wake-1')
      expect(service.has('wake-1')).toBe(false)
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('classifyWakeupRecovery', () => {
  it('re-arms future wakeups', () => {
    const actions = classifyWakeupRecovery([wakeup()], {
      nowMs: new Date('2026-05-27T00:00:30.000Z').getTime()
    })
    expect(actions).toEqual([{ action: 'arm', wakeup: wakeup() }])
  })

  it('fires recently overdue wakeups within the grace window', () => {
    const pending = wakeup({ wakeAt: '2026-05-27T00:00:00.000Z' })
    const actions = classifyWakeupRecovery([pending], {
      nowMs: new Date('2026-05-27T00:30:00.000Z').getTime()
    })
    expect(actions).toEqual([{ action: 'fire', wakeup: pending }])
  })

  it('expires old overdue wakeups', () => {
    const pending = wakeup({ wakeAt: '2026-05-27T00:00:00.000Z' })
    const actions = classifyWakeupRecovery([pending], {
      nowMs: new Date('2026-05-27T02:00:01.000Z').getTime(),
      nowIso: '2026-05-27T02:00:01.000Z'
    })
    expect(actions).toEqual([
      { action: 'expire', wakeup: pending, expiredAt: '2026-05-27T02:00:01.000Z' }
    ])
  })

  it('ignores non-pending wakeups', () => {
    const actions = classifyWakeupRecovery(
      [wakeup({ status: 'cancelled', cancelledAt: '2026-05-27T00:00:30.000Z' })],
      {
        nowMs: new Date('2026-05-27T00:01:00.000Z').getTime()
      }
    )
    expect(actions).toEqual([])
  })
})
