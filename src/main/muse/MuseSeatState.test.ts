import { describe, expect, it } from 'vitest'
import {
  LEGACY_MUSE_SEAT_STATE_DIRS,
  MUSE_SEAT_STATE_DIR,
  legacyMuseSeatStatePaths,
  legacyMuseSeatStateRoots,
  museSeatStatePath,
  museSeatStateRoot
} from './MuseSeatState'

const USER_DATA = '/tmp/userData'

describe('Muse seat state paths', () => {
  it('pins the versioned containment directory', () => {
    // A rename here is a containment change, not a refactor: seats written
    // under the old rule must never be visible to a new session/resume.
    expect(MUSE_SEAT_STATE_DIR).toBe('muse-seats-v1')
    expect(museSeatStateRoot(USER_DATA)).toBe('/tmp/userData/muse-seats-v1')
  })

  it('derives a stable opaque leaf that never contains the chat id', () => {
    const path = museSeatStatePath(USER_DATA, 'chat-a')
    expect(path).toBe(museSeatStatePath(USER_DATA, 'chat-a', 'solo'))
    expect(path.startsWith('/tmp/userData/muse-seats-v1/')).toBe(true)
    expect(path).not.toContain('chat-a')
    expect(path.slice('/tmp/userData/muse-seats-v1/'.length)).toMatch(/^[0-9a-f]{40}$/)
  })

  it('separates seats by chat and by participant', () => {
    const solo = museSeatStatePath(USER_DATA, 'chat-a', 'solo')
    const worker = museSeatStatePath(USER_DATA, 'chat-a', 'worker')
    const otherChat = museSeatStatePath(USER_DATA, 'chat-b', 'solo')
    expect(new Set([solo, worker, otherChat]).size).toBe(3)
  })

  it('does not collide when the id boundary is ambiguous', () => {
    // The NUL separator is why: without it "a" + "bc" and "ab" + "c" hash the
    // same, and two chats would resume into one Muse session.
    expect(museSeatStatePath(USER_DATA, 'a', 'bc')).not.toBe(
      museSeatStatePath(USER_DATA, 'ab', 'c')
    )
  })

  it('has no legacy roots to sweep yet', () => {
    expect([...LEGACY_MUSE_SEAT_STATE_DIRS]).toEqual([])
    expect(legacyMuseSeatStateRoots(USER_DATA)).toEqual([])
    expect(legacyMuseSeatStatePaths(USER_DATA, 'chat-a', 'solo')).toEqual([])
  })
})
