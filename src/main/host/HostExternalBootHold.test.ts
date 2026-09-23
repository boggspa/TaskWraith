import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it, vi, type Mock } from 'vitest'

import {
  hasExternalHostBootHold,
  holdExternalHostForBoot,
  releaseAllExternalHostBootHolds,
  releaseExternalHostBootHold
} from './HostExternalBootHold'

// resolve() keeps the fixtures canonical on win32 too.
const PROFILE_A = resolve('/profiles/a')
const PROFILE_B = resolve('/profiles/b')

function connection(): { close: Mock<() => void> } {
  return { close: vi.fn<() => void>() }
}

describe('HostExternalBootHold', () => {
  afterEach(() => {
    releaseAllExternalHostBootHolds()
  })

  it("keeps a held connection open until main's lease lets it go, then closes it exactly once", () => {
    const held = connection()
    holdExternalHostForBoot(PROFILE_A, {}, held)
    expect(hasExternalHostBootHold(PROFILE_A)).toBe(true)
    expect(held.close).not.toHaveBeenCalled()

    expect(releaseExternalHostBootHold(PROFILE_A)).toBe(true)
    expect(held.close).toHaveBeenCalledTimes(1)
    expect(hasExternalHostBootHold(PROFILE_A)).toBe(false)
    // A second release, or a late owner-scoped one, finds nothing to close.
    expect(releaseExternalHostBootHold(PROFILE_A)).toBe(false)
    expect(held.close).toHaveBeenCalledTimes(1)
  })

  it('lets only its owner release a hold by owner', () => {
    const owner = {}
    const held = connection()
    holdExternalHostForBoot(PROFILE_A, owner, held)
    expect(releaseExternalHostBootHold(PROFILE_A, {})).toBe(false)
    expect(held.close).not.toHaveBeenCalled()
    expect(hasExternalHostBootHold(PROFILE_A)).toBe(true)
    expect(releaseExternalHostBootHold(PROFILE_A, owner)).toBe(true)
    expect(held.close).toHaveBeenCalledTimes(1)
  })

  it('closes an earlier hold on the same profile that a later one replaces, and never the one it keeps', () => {
    const first = connection()
    const second = connection()
    const owner = {}
    holdExternalHostForBoot(PROFILE_A, owner, first)
    holdExternalHostForBoot(PROFILE_A, owner, first)
    expect(first.close).not.toHaveBeenCalled()
    holdExternalHostForBoot(PROFILE_A, {}, second)
    expect(first.close).toHaveBeenCalledTimes(1)
    expect(second.close).not.toHaveBeenCalled()
    // The replaced owner no longer owns the hold.
    expect(releaseExternalHostBootHold(PROFILE_A, owner)).toBe(false)
    expect(second.close).not.toHaveBeenCalled()
  })

  /** S1a re-review RN2: one process-wide slot let a second profile close the first's hold. */
  it('keeps one hold per profile: another profile neither replaces nor releases it', () => {
    const a = connection()
    const b = connection()
    holdExternalHostForBoot(PROFILE_A, {}, a)
    holdExternalHostForBoot(PROFILE_B, {}, b)
    expect(a.close).not.toHaveBeenCalled()
    expect(hasExternalHostBootHold(PROFILE_A)).toBe(true)
    expect(hasExternalHostBootHold(PROFILE_B)).toBe(true)

    // Main's lease on B is held: only B's hold goes.
    expect(releaseExternalHostBootHold(PROFILE_B)).toBe(true)
    expect(b.close).toHaveBeenCalledTimes(1)
    expect(a.close).not.toHaveBeenCalled()
    expect(hasExternalHostBootHold(PROFILE_A)).toBe(true)
    expect(hasExternalHostBootHold()).toBe(true)
  })

  it('keys a profile by its canonical path, so a symlinked spelling reaches the same hold', () => {
    const root = mkdtempSync(join(tmpdir(), 'boot-hold-canonical-'))
    try {
      const real = join(root, 'real-profile')
      mkdirSync(real)
      const link = join(root, 'linked-profile')
      // A junction needs no privilege on Windows; elsewhere the type is ignored.
      symlinkSync(real, link, 'junction')
      const held = connection()
      holdExternalHostForBoot(real, {}, held)
      expect(hasExternalHostBootHold(link)).toBe(true)
      expect(releaseExternalHostBootHold(link)).toBe(true)
      expect(held.close).toHaveBeenCalledTimes(1)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('drops the hold even when its connection throws on close', () => {
    holdExternalHostForBoot(
      PROFILE_A,
      {},
      {
        close: () => {
          throw new Error('already gone')
        }
      }
    )
    expect(() => releaseExternalHostBootHold(PROFILE_A)).not.toThrow()
    expect(hasExternalHostBootHold(PROFILE_A)).toBe(false)
  })
})
