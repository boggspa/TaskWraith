import { afterEach, describe, expect, it, vi } from 'vitest'

/**
 * BEHAVIOURAL tests for the shared tick registry — no jsdom required.
 *
 * The source guards in `useSharedNowTick.test.ts` can only pin the shape of the
 * code. They cannot notice that nothing actually ticks: deleting the try/catch,
 * or making `startTicking()` return early, ships every source guard green while
 * every clock in the app stops. These tests close that hole by stubbing the
 * realm, capturing the interval callback, and driving it by hand.
 *
 * The module keeps its registry in module scope, so each test re-imports it
 * after `vi.resetModules()` to get a clean set of listeners.
 */

type Realm = {
  window?: unknown
}

let restore: (() => void) | null = null

function installRealm(): { tick: () => void; cleared: () => boolean } {
  let callback: (() => void) | null = null
  let cleared = false
  const realm = globalThis as unknown as Realm
  const had = 'window' in realm
  const previous = realm.window

  realm.window = {
    setInterval: (fn: () => void) => {
      callback = fn
      return 1
    },
    clearInterval: () => {
      cleared = true
      callback = null
    }
  }

  restore = () => {
    if (had) realm.window = previous
    else delete realm.window
  }

  return {
    tick: () => {
      if (!callback) throw new Error('no interval was ever started')
      callback()
    },
    cleared: () => cleared
  }
}

afterEach(() => {
  restore?.()
  restore = null
  vi.resetModules()
})

async function loadModule(): Promise<typeof import('./useSharedNowTick')> {
  vi.resetModules()
  return import('./useSharedNowTick')
}

describe('shared now tick registry', () => {
  it('starts one interval on the first subscribe and clears it after the last unsubscribe', async () => {
    const realm = installRealm()
    const mod = await loadModule()

    expect(mod.sharedNowTickDiagnostics()).toEqual({ listeners: 0, ticking: false })

    const first = mod.subscribeToSharedNowTick(() => {})
    const second = mod.subscribeToSharedNowTick(() => {})
    // One shared cadence, not one per subscriber.
    expect(mod.sharedNowTickDiagnostics()).toEqual({ listeners: 2, ticking: true })

    first()
    expect(mod.sharedNowTickDiagnostics()).toEqual({ listeners: 1, ticking: true })
    expect(realm.cleared()).toBe(false)

    second()
    expect(mod.sharedNowTickDiagnostics()).toEqual({ listeners: 0, ticking: false })
    expect(realm.cleared()).toBe(true)
  })

  it('delivers the tick to every subscriber', async () => {
    const realm = installRealm()
    const mod = await loadModule()
    const seen: string[] = []

    mod.subscribeToSharedNowTick(() => seen.push('a'))
    mod.subscribeToSharedNowTick(() => seen.push('b'))
    realm.tick()

    expect(seen).toEqual(['a', 'b'])
  })

  /**
   * The regression this exists for: listeners run arbitrary component code now
   * (formatters, `toLocaleString`, DOM writes). Before the try/catch, one throw
   * aborted the loop, so every listener after it in the set silently missed
   * that second — a randomly-skipping clock, self-healing next tick.
   */
  it('keeps delivering to later subscribers when an earlier one throws', async () => {
    const realm = installRealm()
    const mod = await loadModule()
    const seen: string[] = []
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})

    mod.subscribeToSharedNowTick(() => seen.push('before'))
    mod.subscribeToSharedNowTick(() => {
      throw new Error('formatter blew up')
    })
    mod.subscribeToSharedNowTick(() => seen.push('after'))

    expect(() => realm.tick()).not.toThrow()
    expect(seen).toEqual(['before', 'after'])
    expect(errors).toHaveBeenCalled()

    errors.mockRestore()
  })

  it('keeps ticking on the next second after a listener throws', async () => {
    const realm = installRealm()
    const mod = await loadModule()
    const seen: string[] = []
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})

    mod.subscribeToSharedNowTick(() => {
      throw new Error('always throws')
    })
    mod.subscribeToSharedNowTick(() => seen.push('tick'))

    realm.tick()
    realm.tick()
    expect(seen).toEqual(['tick', 'tick'])

    errors.mockRestore()
  })
})
