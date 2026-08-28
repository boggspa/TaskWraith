import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  clearInProcessProfileAuthority,
  getInProcessProfileAuthority,
  publishInProcessProfileAuthority
} from './HostInProcessProfileAuthorityState'

afterEach(() => {
  clearInProcessProfileAuthority()
})

describe('HostInProcessProfileAuthorityState', () => {
  it('hands main only an assertion port backed by the exact bootstrap lease', () => {
    const assertHeld = vi.fn()
    const lease = { path: '/private/profile-a', assertHeld }
    const published = publishInProcessProfileAuthority({
      profilePath: '/private/profile-a',
      lease
    })

    expect(getInProcessProfileAuthority('/private/profile-a')).toBe(published)
    published.assertProfileAuthority()
    expect(assertHeld).toHaveBeenCalledTimes(3)
    expect(clearInProcessProfileAuthority(lease)).toBe(true)
    expect(getInProcessProfileAuthority('/private/profile-a')).toBeNull()
  })

  it('rejects a profile mismatch and will not clear a foreign lease', () => {
    const lease = { path: '/private/profile-a', assertHeld: vi.fn() }
    publishInProcessProfileAuthority({ profilePath: '/private/profile-a', lease })

    expect(() => getInProcessProfileAuthority('/private/profile-b')).toThrow(/does not match/)
    expect(
      clearInProcessProfileAuthority({ path: '/private/profile-a', assertHeld: vi.fn() })
    ).toBe(false)
    expect(getInProcessProfileAuthority('/private/profile-a')).not.toBeNull()
  })
})
