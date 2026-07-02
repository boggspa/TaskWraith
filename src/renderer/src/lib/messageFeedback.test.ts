import { describe, expect, it } from 'vitest'
import type { ChatMessage } from '../../../main/store/types'
import { applyChatMessageFeedback, readMessageFeedbackVote } from './messageFeedback'

function msg(overrides: Partial<ChatMessage> = {}): ChatMessage {
  return {
    id: 'm1',
    role: 'assistant',
    content: 'hi',
    timestamp: '2026-07-02T00:00:00.000Z',
    ...overrides
  } as ChatMessage
}

describe('messageFeedback', () => {
  it('reads no vote when absent', () => {
    expect(readMessageFeedbackVote(msg())).toBeNull()
    expect(readMessageFeedbackVote(undefined)).toBeNull()
  })

  it('sets a vote with the provided timestamp', () => {
    const next = applyChatMessageFeedback(msg(), 'up', 111)
    expect(next.metadata?.feedback).toEqual({ vote: 'up', at: 111 })
    expect(readMessageFeedbackVote(next)).toBe('up')
  })

  it('clears the vote when the same vote is applied again (toggle off)', () => {
    const up = applyChatMessageFeedback(msg(), 'up', 111)
    const cleared = applyChatMessageFeedback(up, 'up', 222)
    expect(cleared.metadata?.feedback).toBeUndefined()
    expect(readMessageFeedbackVote(cleared)).toBeNull()
  })

  it('flips from up to down (does not clear)', () => {
    const up = applyChatMessageFeedback(msg(), 'up', 111)
    const down = applyChatMessageFeedback(up, 'down', 222)
    expect(down.metadata?.feedback).toEqual({ vote: 'down', at: 222 })
  })

  it('carries an optional reason/note and keeps the vote set even on re-click', () => {
    const down = applyChatMessageFeedback(msg(), 'down', 111, { reason: 'incomplete', note: 'x' })
    expect(down.metadata?.feedback).toEqual({ vote: 'down', at: 111, reason: 'incomplete', note: 'x' })
    // re-applying 'down' WITH extra detail updates rather than clears.
    const updated = applyChatMessageFeedback(down, 'down', 222, { reason: 'broke-something' })
    expect(updated.metadata?.feedback).toMatchObject({ vote: 'down', reason: 'broke-something' })
  })

  it('preserves other metadata (e.g. pinnedAt) and drops metadata entirely when empty', () => {
    const pinned = msg({ metadata: { pinnedAt: 5 } })
    const voted = applyChatMessageFeedback(pinned, 'up', 111)
    expect(voted.metadata?.pinnedAt).toBe(5)
    expect(voted.metadata?.feedback?.vote).toBe('up')

    const onlyFeedback = applyChatMessageFeedback(msg(), 'up', 111)
    const cleared = applyChatMessageFeedback(onlyFeedback, 'up', 222)
    expect(cleared.metadata).toBeUndefined()
  })
})
