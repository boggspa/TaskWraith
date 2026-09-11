import { describe, expect, it } from 'vitest'
import { ChatDispatchLatch } from './chatDispatchLatch'

describe('ChatDispatchLatch', () => {
  it('admits the first submit for a chat', () => {
    const latch = new ChatDispatchLatch()
    expect(latch.claim('chat-1', 'run-1')).toBe(true)
    expect(latch.holderRunId('chat-1')).toBe('run-1')
  })

  // The 2026-09-11 burst: nine submits 75ms apart, all of which saw an idle
  // chat because the first had not registered its run yet.
  it('refuses every repeat while the first submit is still dispatching', () => {
    const latch = new ChatDispatchLatch()
    expect(latch.claim('chat-1', 'run-1')).toBe(true)
    const repeats = ['run-2', 'run-3', 'run-4', 'run-5', 'run-6', 'run-7', 'run-8', 'run-9']
    expect(repeats.map((runId) => latch.claim('chat-1', runId))).toEqual(repeats.map(() => false))
  })

  it('admits the next submit once the dispatch settles', () => {
    const latch = new ChatDispatchLatch()
    latch.claim('chat-1', 'run-1')
    latch.release('run-1')
    expect(latch.holderRunId('chat-1')).toBeUndefined()
    expect(latch.claim('chat-1', 'run-2')).toBe(true)
  })

  // Release is keyed by run so a late settle cannot free a newer claim. Without
  // this the latch would open exactly when a repeat is most likely: the moment
  // the first dispatch finishes unwinding.
  it('ignores a release from a run that no longer holds the chat', () => {
    const latch = new ChatDispatchLatch()
    latch.claim('chat-1', 'run-1')
    latch.release('run-1')
    latch.claim('chat-1', 'run-2')
    latch.release('run-1')
    expect(latch.holderRunId('chat-1')).toBe('run-2')
  })

  it('latches per chat, so a second thread still dispatches', () => {
    const latch = new ChatDispatchLatch()
    latch.claim('chat-1', 'run-1')
    expect(latch.claim('chat-2', 'run-2')).toBe(true)
  })

  it('lets one request re-claim its own chat', () => {
    const latch = new ChatDispatchLatch()
    latch.claim('chat-1', 'run-1')
    expect(latch.claim('chat-1', 'run-1')).toBe(true)
  })

  // Fail open: an unidentifiable submit is dispatched, never blocked.
  it('never blocks a submit it cannot identify', () => {
    const latch = new ChatDispatchLatch()
    latch.claim('chat-1', 'run-1')
    expect(latch.claim('chat-1', undefined)).toBe(true)
    expect(latch.claim(null, 'run-2')).toBe(true)
    expect(latch.holderRunId('chat-1')).toBe('run-1')
  })
})
