import { describe, expect, it, vi } from 'vitest'
import { EnsembleTailBroadcastScheduler } from './ensembleTailBroadcastScheduler'

function fakeTimers() {
  const timers: Array<{ callback: () => void; delayMs: number; cleared: boolean }> = []
  return {
    timers,
    setTimer: (callback: () => void, delayMs: number): ReturnType<typeof setTimeout> => {
      const timer = { callback, delayMs, cleared: false }
      timers.push(timer)
      return timer as unknown as ReturnType<typeof setTimeout>
    },
    clearTimer: (handle: ReturnType<typeof setTimeout>) => {
      ;(handle as unknown as { cleared: boolean }).cleared = true
    }
  }
}

describe('EnsembleTailBroadcastScheduler', () => {
  it('coalesces several runs for one chat into a single timer', () => {
    const { timers, setTimer, clearTimer } = fakeTimers()
    const onBroadcast = vi.fn()
    const scheduler = new EnsembleTailBroadcastScheduler({
      delayMs: 40,
      onBroadcast,
      setTimer,
      clearTimer
    })
    scheduler.schedule('chat-a', 'run-1')
    scheduler.schedule('chat-a', 'run-2')
    expect(timers).toHaveLength(1)
    expect(timers[0].delayMs).toBe(40)
    timers[0].callback()
    expect(onBroadcast).toHaveBeenCalledTimes(1)
    expect(onBroadcast).toHaveBeenCalledWith('chat-a', ['run-1', 'run-2'])
    expect(scheduler.isArmed('chat-a')).toBe(false)
  })

  it('keeps chats independent and cancels per run and per chat', () => {
    const { timers, setTimer, clearTimer } = fakeTimers()
    const onBroadcast = vi.fn()
    const scheduler = new EnsembleTailBroadcastScheduler({ onBroadcast, setTimer, clearTimer })
    scheduler.schedule('chat-a', 'run-1')
    scheduler.schedule('chat-b', 'run-2')
    expect(timers).toHaveLength(2)
    scheduler.cancelRun('chat-a', 'run-1')
    expect(timers[0].cleared).toBe(true)
    expect(scheduler.isArmed('chat-a')).toBe(false)
    scheduler.schedule('chat-a', 'run-1')
    scheduler.schedule('chat-a', 'run-3')
    scheduler.cancelChat('chat-a')
    expect(scheduler.isArmed('chat-a')).toBe(false)
    expect(scheduler.pendingRunIds('chat-a')).toEqual([])
    timers[1].callback()
    expect(onBroadcast).toHaveBeenCalledWith('chat-b', ['run-2'])
  })

  it('ignores empty identifiers and clears everything for teardown', () => {
    const { timers, setTimer, clearTimer } = fakeTimers()
    const onBroadcast = vi.fn()
    const scheduler = new EnsembleTailBroadcastScheduler({ onBroadcast, setTimer, clearTimer })
    scheduler.schedule('', 'run-1')
    scheduler.schedule('chat-a', '')
    expect(timers).toHaveLength(0)
    scheduler.schedule('chat-a', 'run-1')
    scheduler.clearAll()
    expect(scheduler.isArmed('chat-a')).toBe(false)
    expect(onBroadcast).not.toHaveBeenCalled()
  })
})
