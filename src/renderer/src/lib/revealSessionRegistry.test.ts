import { beforeEach, describe, expect, it } from 'vitest'
import { toGraphemes } from './advanceReveal'
import { createAdaptiveRevealState } from './adaptiveReveal'
import {
  REVEAL_SESSION_TTL_MS,
  readRevealSession,
  resetRevealSessionRegistryForTest,
  revealSessionKey,
  writeRevealSession
} from './revealSessionRegistry'

describe('reveal session registry', () => {
  beforeEach(resetRevealSessionRegistryForTest)

  it('resumes the painted cursor and controller across a virtualized remount', () => {
    const key = revealSessionKey({ chatId: 'chat-1', messageId: 'message-1' })
    const state = { ...createAdaptiveRevealState(12), credit: 0.7, velocity: 90 }
    writeRevealSession(key, 'hello smooth', state, 10, 1_000)

    const resumed = readRevealSession(key, 'hello smoother', toGraphemes('hello smoother'), 1_100)
    expect(resumed?.revealed).toBe(10)
    expect(resumed?.state.revealed).toBe(12)
    expect(resumed?.state.velocity).toBe(90)
  })

  it('rewinds safely to the painted common prefix after a rewrite', () => {
    const key = revealSessionKey({ chatId: 'chat-1', messageId: 'message-1' })
    writeRevealSession(key, 'hello world', createAdaptiveRevealState(11), 9, 1_000)

    const resumed = readRevealSession(key, 'hello there', toGraphemes('hello there'), 1_100)
    expect(resumed?.revealed).toBe(6)
    expect(resumed?.state.revealed).toBe(6)
  })

  it('expires stale snapshots and requires a stable identity', () => {
    expect(revealSessionKey({})).toBeNull()
    const key = revealSessionKey({ messageId: 'message-1' })
    writeRevealSession(key, 'hello', createAdaptiveRevealState(3), 3, 1_000)

    expect(
      readRevealSession(key, 'hello', toGraphemes('hello'), 1_000 + REVEAL_SESSION_TTL_MS + 1)
    ).toBeUndefined()
  })
})
