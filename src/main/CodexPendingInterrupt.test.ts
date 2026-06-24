import { describe, expect, it } from 'vitest'
import { decideCancelInterrupt, shouldFlushPendingInterrupt } from './CodexPendingInterrupt'

describe('decideCancelInterrupt', () => {
  it('interrupts NOW when the turnId is already known', () => {
    expect(decideCancelInterrupt({ threadId: 't1', turnId: 'turn1' })).toEqual({
      interruptNow: true,
      deferThreadId: null
    })
  })

  it('DEFERS (records the threadId) when the turn has not started yet', () => {
    expect(decideCancelInterrupt({ threadId: 't1' })).toEqual({
      interruptNow: false,
      deferThreadId: 't1'
    })
  })

  it('does nothing when there is no threadId (run never reached a thread)', () => {
    expect(decideCancelInterrupt({})).toEqual({ interruptNow: false, deferThreadId: null })
    expect(decideCancelInterrupt(null)).toEqual({ interruptNow: false, deferThreadId: null })
    expect(decideCancelInterrupt(undefined)).toEqual({ interruptNow: false, deferThreadId: null })
  })
})

describe('shouldFlushPendingInterrupt', () => {
  it('flushes when a turnId arrives for a pending thread', () => {
    expect(shouldFlushPendingInterrupt(new Set(['t1']), { threadId: 't1', turnId: 'turn1' })).toBe(
      true
    )
  })

  it('does not flush a thread that was not pending', () => {
    expect(shouldFlushPendingInterrupt(new Set(['t2']), { threadId: 't1', turnId: 'turn1' })).toBe(
      false
    )
  })

  it('does not flush before a turnId exists', () => {
    expect(shouldFlushPendingInterrupt(new Set(['t1']), { threadId: 't1' })).toBe(false)
  })

  it('does not flush with no threadId', () => {
    expect(shouldFlushPendingInterrupt(new Set(['t1']), {})).toBe(false)
  })
})
