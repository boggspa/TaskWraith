import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { MuseSeatLeaseRegistry } from './MuseSeatLeaseRegistry'

const isolatedHomeSource = readFileSync(new URL('./MuseIsolatedHome.ts', import.meta.url), 'utf8')

describe('MuseSeatLeaseRegistry', () => {
  it('admits the first run to claim a seat', () => {
    const registry = new MuseSeatLeaseRegistry()
    registry.acquire('/seats/chat-a', 'run-1')
    expect(registry.holder('/seats/chat-a')).toBe('run-1')
  })

  it('refuses a second run while the first holds the seat', () => {
    const registry = new MuseSeatLeaseRegistry()
    registry.acquire('/seats/chat-a', 'run-1')
    expect(() => registry.acquire('/seats/chat-a', 'run-2')).toThrow(/already in use by run run-1/)
  })

  // The seat path is route data. A refusal reaches a provider warning and a
  // transcript row, so it must name the run and never the path.
  it('keeps the seat path out of the refusal message', () => {
    const registry = new MuseSeatLeaseRegistry()
    registry.acquire('/seats/9d2f-secret-chat-id', 'run-1')
    expect(() => registry.acquire('/seats/9d2f-secret-chat-id', 'run-2')).toThrow(
      expect.objectContaining({ message: expect.not.stringContaining('9d2f-secret-chat-id') })
    )
  })

  it('re-admits the holder, so one run re-attaching is not a collision', () => {
    const registry = new MuseSeatLeaseRegistry()
    registry.acquire('/seats/chat-a', 'run-1')
    expect(() => registry.acquire('/seats/chat-a', 'run-1')).not.toThrow()
  })

  it('frees the seat for the next turn on release', () => {
    const registry = new MuseSeatLeaseRegistry()
    registry.acquire('/seats/chat-a', 'run-1')
    registry.release('/seats/chat-a', 'run-1')
    expect(registry.holder('/seats/chat-a')).toBeUndefined()
    expect(() => registry.acquire('/seats/chat-a', 'run-2')).not.toThrow()
  })

  // A teardown that lands after the next turn already claimed the seat must not
  // hand that turn's seat to a third one.
  it('ignores a release from a run that no longer holds the seat', () => {
    const registry = new MuseSeatLeaseRegistry()
    registry.acquire('/seats/chat-a', 'run-1')
    registry.release('/seats/chat-a', 'run-1')
    registry.acquire('/seats/chat-a', 'run-2')
    registry.release('/seats/chat-a', 'run-1')
    expect(registry.holder('/seats/chat-a')).toBe('run-2')
  })

  it('scopes a claim to one seat, so another thread still runs', () => {
    const registry = new MuseSeatLeaseRegistry()
    registry.acquire('/seats/chat-a', 'run-1')
    expect(() => registry.acquire('/seats/chat-b', 'run-2')).not.toThrow()
  })

  it('treats the same seat spelled two ways as one seat', () => {
    const registry = new MuseSeatLeaseRegistry()
    registry.acquire('/seats/chat-a', 'run-1')
    expect(() => registry.acquire('/seats/nested/../chat-a', 'run-2')).toThrow(/already in use/)
  })
})

describe('durable seat lease wiring', () => {
  // The claim is taken before the seat is touched, because the attach scrub
  // that follows is what would strip a live turn's credentials.
  it('claims the seat before the attach establishes or scrubs it', () => {
    const claimIndex = isolatedHomeSource.indexOf('museSeatLeases.acquire(durableSeat.path, runId)')
    const establishIndex = isolatedHomeSource.indexOf('createdPath = establishMuseDurableSeat(')

    expect(claimIndex).toBeGreaterThanOrEqual(0)
    expect(establishIndex).toBeGreaterThan(claimIndex)
  })

  // A post-establish attach failure cannot be reached by any seed a test can
  // plant — every malformed seat shape the scrub is given, it repairs. The leak
  // it would cause is real though (one failed attach refusing every later turn
  // in that thread), so the release is pinned here by shape instead: in a
  // `finally`, gated on no lease having been issued.
  it('releases a claim on every attach exit that issued no lease', () => {
    expect(isolatedHomeSource).toContain('let leaseIssued = false')
    expect(isolatedHomeSource).toContain('    leaseIssued = true\n    return Object.freeze(lease)')
    expect(isolatedHomeSource).toContain(
      '  } finally {\n    // An attach that never handed out a lease leaves the seat free'
    )
    expect(isolatedHomeSource).toContain(
      'if (durableSeat && !leaseIssued) museSeatLeases.release(durableSeat.path, runId)'
    )
  })

  // The teardown release is what hands the seat to the thread's next turn.
  it('releases the seat when the lease is cleaned up', () => {
    const cleanupIndex = isolatedHomeSource.indexOf('      cleanup: () => {')
    const releaseIndex = isolatedHomeSource.indexOf(
      'if (durableSeat) museSeatLeases.release(durableSeat.path, runId)',
      cleanupIndex
    )
    const alreadyCleanedIndex = isolatedHomeSource.indexOf(
      'if (cleaned) return { ok: true, alreadyAbsent: true }',
      cleanupIndex
    )

    expect(cleanupIndex).toBeGreaterThanOrEqual(0)
    expect(releaseIndex).toBeGreaterThan(cleanupIndex)
    // Before the already-cleaned early return, so a second cleanup still frees
    // a claim the first one somehow left behind.
    expect(alreadyCleanedIndex).toBeGreaterThan(releaseIndex)
  })
})
