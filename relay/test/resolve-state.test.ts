import { describe, it, expect } from 'vitest'
import { createResolveDirectory, createResolveDirectoryState } from '../src/resolve'

// P2: registrations + the single-use nonce set are lifted out of
// createResolveDirectory's closure into a shareable ResolveDirectoryState, so
// the Tier-2 push-trigger handler can reuse the witnessed-pair registry + the
// shared anti-replay nonce set. The directory's own behaviour is unchanged
// (covered by resolve.test.ts); this pins the new seam.

describe('createResolveDirectoryState', () => {
  it('exposes the registry + nonce maps and sweeps expired entries', () => {
    const state = createResolveDirectoryState({ now: () => 1000 })
    try {
      state.registrations.set('mac1', {
        peers: new Map([['peer1', { sessionId: 's1', issuedAt: 0, expiresAt: 5000 }]])
      })
      state.seenNonces.set('n-live', 5000)
      state.seenNonces.set('n-dead', 500)

      state.sweep(1000)
      expect(state.seenNonces.has('n-dead')).toBe(false) // expiry <= now → swept
      expect(state.seenNonces.has('n-live')).toBe(true)
      expect(state.registrations.has('mac1')).toBe(true) // peer still live

      state.sweep(6000) // past the peer's expiresAt
      expect(state.registrations.has('mac1')).toBe(false) // empty peers → registration dropped
    } finally {
      state.close()
    }
  })
})

describe('createResolveDirectory with a shared state', () => {
  it('reads the shared registry and does not own/tear down a borrowed state', () => {
    let clock = 1000
    const state = createResolveDirectoryState({ now: () => clock })
    try {
      state.registrations.set('macA', {
        peers: new Map([['peerA', { sessionId: 's', issuedAt: 0, expiresAt: 5000 }]])
      })

      const dir = createResolveDirectory({ state, now: () => clock })
      expect(dir.registrationCount()).toBe(1) // the directory reads the SHARED registry

      // Closing a directory that borrowed the state must NOT drop the shared maps.
      dir.close()
      expect(state.registrations.has('macA')).toBe(true)

      // Sweeping through the shared state still works after the directory closed.
      clock = 6000
      state.sweep(clock)
      expect(state.registrations.has('macA')).toBe(false)
    } finally {
      state.close()
    }
  })
})
