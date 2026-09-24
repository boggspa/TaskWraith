import { describe, expect, it } from 'vitest'
import {
  COMPOSER_SELECTION_CLAIM_TTL_MS,
  ComposerSelectionWriteClaims
} from './composerSelectionWriteClaims'

function claimsAt(clock: { now: number }): ComposerSelectionWriteClaims {
  return new ComposerSelectionWriteClaims({ now: () => clock.now })
}

describe('ComposerSelectionWriteClaims', () => {
  it('holds nothing until a pick raises a claim', () => {
    const clock = { now: 0 }
    const claims = claimsAt(clock)
    expect(claims.held('chat-1')).toBe(false)
    expect(claims.current('chat-1')).toBeNull()
    claims.raise('chat-1')
    expect(claims.held('chat-1')).toBe(true)
  })

  it('releases the claim its own persist answered', () => {
    const clock = { now: 0 }
    const claims = claimsAt(clock)
    const token = claims.raise('chat-1')
    claims.settle('chat-1', token)
    expect(claims.held('chat-1')).toBe(false)
  })

  // The queue coalesces, so a pick made while an earlier persist is in flight
  // is NOT covered by that persist's answer. Releasing on it would drop the
  // newer pick's protection for exactly the window it needs — which is the
  // original defect, one pick later.
  it('keeps a newer pick claimed when an older persist answers', () => {
    const clock = { now: 0 }
    const claims = claimsAt(clock)
    const first = claims.raise('chat-1')
    claims.raise('chat-1')
    claims.settle('chat-1', first)
    expect(claims.held('chat-1')).toBe(true)
  })

  it('keeps claims per chat', () => {
    const clock = { now: 0 }
    const claims = claimsAt(clock)
    const token = claims.raise('chat-1')
    claims.raise('chat-2')
    claims.settle('chat-1', token)
    expect(claims.held('chat-1')).toBe(false)
    expect(claims.held('chat-2')).toBe(true)
  })

  it('settles nothing for a chat that holds no claim', () => {
    const clock = { now: 0 }
    const claims = claimsAt(clock)
    const token = claims.raise('chat-1')
    claims.settle('chat-2', token)
    expect(claims.held('chat-1')).toBe(true)
  })

  // The patch IPC waits on a write gate that has no timeout and no rejection,
  // so a blocked chat settles its claim never. An unbounded claim would then
  // show a selection that is not in effect for the life of the process.
  it('expires a claim whose persist never answered', () => {
    const clock = { now: 1_000 }
    const claims = claimsAt(clock)
    claims.raise('chat-1')
    clock.now += COMPOSER_SELECTION_CLAIM_TTL_MS - 1
    expect(claims.held('chat-1')).toBe(true)
    clock.now += 1
    expect(claims.held('chat-1')).toBe(false)
  })

  it('re-arms the lease from the newest pick, not the first', () => {
    const clock = { now: 0 }
    const claims = claimsAt(clock)
    claims.raise('chat-1')
    clock.now += COMPOSER_SELECTION_CLAIM_TTL_MS - 1
    claims.raise('chat-1')
    clock.now += COMPOSER_SELECTION_CLAIM_TTL_MS - 1
    expect(claims.held('chat-1')).toBe(true)
  })

  it('drops every claim when the renderer tears its queue down', () => {
    const clock = { now: 0 }
    const claims = claimsAt(clock)
    claims.raise('chat-1')
    claims.raise('chat-2')
    claims.clear()
    expect(claims.held('chat-1')).toBe(false)
    expect(claims.held('chat-2')).toBe(false)
  })
})
