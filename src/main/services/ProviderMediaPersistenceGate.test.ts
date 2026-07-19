import { describe, expect, it, vi } from 'vitest'
import { persistAuthorizedProviderMedia } from './ProviderMediaPersistenceGate'

describe('persistAuthorizedProviderMedia', () => {
  it('does not write bytes or grants for a late frame after destructive clear', () => {
    const persist = vi.fn(() => ['ref'])
    const revokeOnLostAuthority = vi.fn()

    expect(
      persistAuthorizedProviderMedia({
        isAuthorized: () => false,
        persist,
        revokeOnLostAuthority
      })
    ).toEqual([])
    expect(persist).not.toHaveBeenCalled()
    expect(revokeOnLostAuthority).not.toHaveBeenCalled()
  })

  it('revokes persisted ownership and publishes nothing when authority is lost', () => {
    let checks = 0
    const revokeOnLostAuthority = vi.fn()

    expect(
      persistAuthorizedProviderMedia({
        isAuthorized: () => ++checks === 1,
        persist: () => ['ref'],
        revokeOnLostAuthority
      })
    ).toEqual([])
    expect(revokeOnLostAuthority).toHaveBeenCalledOnce()
  })

  it('publishes an authorized persisted batch', () => {
    const revokeOnLostAuthority = vi.fn()
    expect(
      persistAuthorizedProviderMedia({
        isAuthorized: () => true,
        persist: () => ['ref-a', 'ref-b'],
        revokeOnLostAuthority
      })
    ).toEqual(['ref-a', 'ref-b'])
    expect(revokeOnLostAuthority).not.toHaveBeenCalled()
  })
})
