import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createRelayServer } from '../src/server'
import { createApnsGateway } from '../src/apnsGateway'
import { createResolveDirectoryState } from '../src/resolve'

// Every timer a relay owns must die with it: the room sweeper, the owned
// resolve-directory sweep, and — in the gateway topology — the shared
// resolve-state sweep the directory deliberately disowns. Fake timers make
// the pending-timer count exact, and none of these tests binds a socket.

describe('relay timer teardown', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('releases owned timers when startup fails before listening', async () => {
    const baseline = vi.getTimerCount()
    // listen() validates synchronously: no socket is bound, and the caller
    // never receives a handle — the same position as an async bind failure.
    await expect(createRelayServer({ port: -1 })).rejects.toThrow()
    expect(vi.getTimerCount()).toBe(baseline)
  })

  it('releases a shared resolve-state sweep timer on gateway teardown', () => {
    const baseline = vi.getTimerCount()
    const resolveState = createResolveDirectoryState({})
    const gateway = createApnsGateway({ resolveState })
    expect(vi.getTimerCount()).toBeGreaterThan(baseline)
    gateway.close()
    expect(vi.getTimerCount()).toBe(baseline)
  })
})
