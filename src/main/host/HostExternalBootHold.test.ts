import { afterEach, describe, expect, it, vi, type Mock } from 'vitest'

import {
  hasExternalHostBootHold,
  holdExternalHostForBoot,
  releaseExternalHostBootHold
} from './HostExternalBootHold'

function connection(): { close: Mock<() => void> } {
  return { close: vi.fn<() => void>() }
}

describe('HostExternalBootHold', () => {
  afterEach(() => {
    releaseExternalHostBootHold()
  })

  it('keeps a held connection open until main lets it go, then closes it exactly once', () => {
    const held = connection()
    holdExternalHostForBoot({}, held)
    expect(hasExternalHostBootHold()).toBe(true)
    expect(held.close).not.toHaveBeenCalled()

    expect(releaseExternalHostBootHold()).toBe(true)
    expect(held.close).toHaveBeenCalledTimes(1)
    expect(hasExternalHostBootHold()).toBe(false)
    // A second release, or a late owner-scoped one, finds nothing to close.
    expect(releaseExternalHostBootHold()).toBe(false)
    expect(held.close).toHaveBeenCalledTimes(1)
  })

  it('lets only its owner release a hold by owner', () => {
    const owner = {}
    const held = connection()
    holdExternalHostForBoot(owner, held)
    expect(releaseExternalHostBootHold({})).toBe(false)
    expect(held.close).not.toHaveBeenCalled()
    expect(hasExternalHostBootHold()).toBe(true)
    expect(releaseExternalHostBootHold(owner)).toBe(true)
    expect(held.close).toHaveBeenCalledTimes(1)
  })

  it('closes an earlier hold that a later one replaces, and never the one it keeps', () => {
    const first = connection()
    const second = connection()
    const owner = {}
    holdExternalHostForBoot(owner, first)
    holdExternalHostForBoot(owner, first)
    expect(first.close).not.toHaveBeenCalled()
    holdExternalHostForBoot({}, second)
    expect(first.close).toHaveBeenCalledTimes(1)
    expect(second.close).not.toHaveBeenCalled()
    // The replaced owner no longer owns the hold.
    expect(releaseExternalHostBootHold(owner)).toBe(false)
    expect(second.close).not.toHaveBeenCalled()
  })

  it('drops the hold even when its connection throws on close', () => {
    holdExternalHostForBoot(
      {},
      {
        close: () => {
          throw new Error('already gone')
        }
      }
    )
    expect(() => releaseExternalHostBootHold()).not.toThrow()
    expect(hasExternalHostBootHold()).toBe(false)
  })
})
