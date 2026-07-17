import { describe, expect, it, vi } from 'vitest'
import {
  flushKimiThinkingChunks,
  KIMI_THINKING_BATCH_MS,
  queueKimiThinkingChunk,
  type KimiThinkingBatchState
} from './KimiThinkingBatcher'

describe('KimiThinkingBatcher', () => {
  it('coalesces token-sized chunks into one timed update', async () => {
    vi.useFakeTimers()
    try {
      const state: KimiThinkingBatchState = {}
      const emit = vi.fn()
      queueKimiThinkingChunk(state, 'one ', emit)
      queueKimiThinkingChunk(state, 'two', emit)

      expect(emit).not.toHaveBeenCalled()
      await vi.advanceTimersByTimeAsync(KIMI_THINKING_BATCH_MS)
      expect(emit).toHaveBeenCalledOnce()
      expect(emit).toHaveBeenCalledWith('one two')
    } finally {
      vi.useRealTimers()
    }
  })

  it('flushes a pending suffix synchronously before visible output', () => {
    const state: KimiThinkingBatchState = {}
    const emit = vi.fn()
    const timer = {} as NodeJS.Timeout
    const clearTimeoutFn = vi.fn()
    queueKimiThinkingChunk(state, 'final thought', emit, {
      setTimeoutFn: () => timer
    })

    flushKimiThinkingChunks(state, emit, { clearTimeoutFn })

    expect(clearTimeoutFn).toHaveBeenCalledWith(timer)
    expect(emit).toHaveBeenCalledWith('final thought')
    expect(state.kimiThinkingPendingText).toBe('')
    expect(state.kimiThinkingFlushTimer).toBeUndefined()
  })
})
