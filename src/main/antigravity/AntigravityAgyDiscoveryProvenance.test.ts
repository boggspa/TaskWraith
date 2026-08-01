import { afterEach, describe, expect, it } from 'vitest'
import {
  AGY_CACHED_AUTH_EVIDENCE_TTL_MS,
  agyProvenanceProvesAuthenticatedConnection,
  readAgyDiscoveryProvenance,
  recordAgyDiscoveryProvenance,
  resetAgyDiscoveryProvenanceForTests,
  seedAgyDiscoveryProvenanceFromCache
} from './AntigravityAgyDiscoveryProvenance'

const NOW_MS = Date.parse('2026-07-30T00:00:00.000Z')

afterEach(() => {
  resetAgyDiscoveryProvenanceForTests()
})

describe('AntigravityAgyDiscoveryProvenance store', () => {
  it('defaults to no evidence before any discovery has run', () => {
    expect(readAgyDiscoveryProvenance()).toEqual({ source: 'none', cachedAtMs: null })
    expect(agyProvenanceProvesAuthenticatedConnection(readAgyDiscoveryProvenance(), NOW_MS)).toBe(
      false
    )
  })

  it('round-trips a recorded source', () => {
    recordAgyDiscoveryProvenance({ source: 'live', cachedAtMs: null })
    expect(readAgyDiscoveryProvenance()).toEqual({ source: 'live', cachedAtMs: null })
  })

  it('drops a cachedAtMs that does not belong to a cached source', () => {
    // Otherwise a stray timestamp on a floor record could later be read as if
    // it were cache evidence.
    recordAgyDiscoveryProvenance({ source: 'floor', cachedAtMs: NOW_MS })
    expect(readAgyDiscoveryProvenance().cachedAtMs).toBeNull()
  })

  it('normalizes a non-finite cachedAtMs to null', () => {
    recordAgyDiscoveryProvenance({ source: 'cached', cachedAtMs: Number.NaN })
    expect(readAgyDiscoveryProvenance().cachedAtMs).toBeNull()
  })

  it('reset restores the no-evidence default', () => {
    recordAgyDiscoveryProvenance({ source: 'live', cachedAtMs: null })
    resetAgyDiscoveryProvenanceForTests()
    expect(readAgyDiscoveryProvenance().source).toBe('none')
  })
})

describe('agyProvenanceProvesAuthenticatedConnection', () => {
  it('accepts a live probe', () => {
    expect(
      agyProvenanceProvesAuthenticatedConnection({ source: 'live', cachedAtMs: null }, NOW_MS)
    ).toBe(true)
  })

  it('accepts a cache inside the evidence window and rejects one outside it', () => {
    const inside = {
      source: 'cached' as const,
      cachedAtMs: NOW_MS - AGY_CACHED_AUTH_EVIDENCE_TTL_MS + 1
    }
    const outside = {
      source: 'cached' as const,
      cachedAtMs: NOW_MS - AGY_CACHED_AUTH_EVIDENCE_TTL_MS
    }
    expect(agyProvenanceProvesAuthenticatedConnection(inside, NOW_MS)).toBe(true)
    // Exactly at the boundary is already too old — the window is exclusive.
    expect(agyProvenanceProvesAuthenticatedConnection(outside, NOW_MS)).toBe(false)
  })

  it('rejects the floor — this is the forgery it exists to stop', () => {
    // The hardcoded floor's rows are bare ids, so the previous shape-based test
    // read them as proof of a live agy session on machines that had never
    // signed in, and that gate is what permits a /usage probe.
    expect(
      agyProvenanceProvesAuthenticatedConnection({ source: 'floor', cachedAtMs: null }, NOW_MS)
    ).toBe(false)
  })

  it('fails closed on absent provenance and unknown cache age', () => {
    expect(agyProvenanceProvesAuthenticatedConnection(null, NOW_MS)).toBe(false)
    expect(agyProvenanceProvesAuthenticatedConnection(undefined, NOW_MS)).toBe(false)
    expect(
      agyProvenanceProvesAuthenticatedConnection({ source: 'none', cachedAtMs: null }, NOW_MS)
    ).toBe(false)
    // An unreadable/absent updatedAt cannot be shown to be inside the window.
    expect(
      agyProvenanceProvesAuthenticatedConnection({ source: 'cached', cachedAtMs: null }, NOW_MS)
    ).toBe(false)
  })

  it('rejects a future-dated cache', () => {
    // Clock change or an edited file. A negative age is not usable evidence,
    // and must not read as "0ms old, therefore fresh".
    expect(
      agyProvenanceProvesAuthenticatedConnection(
        { source: 'cached', cachedAtMs: NOW_MS + 60_000 },
        NOW_MS
      )
    ).toBe(false)
  })
})

describe('seedAgyDiscoveryProvenanceFromCache', () => {
  const CACHE_AT = 1_760_000_000_000
  const record = (over: Record<string, unknown> = {}) => ({
    models: [{ id: 'gemini-3-pro' }],
    updatedAtMs: CACHE_AT,
    ...over
  })

  it('seeds cached provenance when discovery has not run this session', async () => {
    // The defect this closes: the slot is process-local and starts `none`, and
    // only discovery writes it — so signing in and refreshing quota could never
    // clear "no authenticated agy connection was detected".
    expect(readAgyDiscoveryProvenance().source).toBe('none')
    const seeded = await seedAgyDiscoveryProvenanceFromCache(async () => record())
    expect(seeded).toEqual({ source: 'cached', cachedAtMs: CACHE_AT })
    expect(readAgyDiscoveryProvenance()).toEqual({ source: 'cached', cachedAtMs: CACHE_AT })
    expect(agyProvenanceProvesAuthenticatedConnection(seeded, CACHE_AT + 1_000)).toBe(true)
  })

  it('never downgrades live provenance', async () => {
    recordAgyDiscoveryProvenance({ source: 'live', cachedAtMs: null })
    await seedAgyDiscoveryProvenanceFromCache(async () => record())
    expect(readAgyDiscoveryProvenance()).toEqual({ source: 'live', cachedAtMs: null })
  })

  it('fails closed on an empty catalogue, a missing timestamp, or a throwing read', async () => {
    // An age without models is not evidence of anything, and an unreadable
    // cache must never be treated as proof of a sign-in.
    for (const reader of [
      async () => record({ models: [] }),
      async () => record({ updatedAtMs: null }),
      async () => record({ updatedAtMs: Number.NaN }),
      async () => null,
      async () => {
        throw new Error('unreadable')
      }
    ]) {
      resetAgyDiscoveryProvenanceForTests()
      await seedAgyDiscoveryProvenanceFromCache(reader as never)
      expect(readAgyDiscoveryProvenance().source).toBe('none')
    }
  })

  it('leaves an expired cache unable to open the gate', async () => {
    const stale = CACHE_AT - AGY_CACHED_AUTH_EVIDENCE_TTL_MS - 1
    const seeded = await seedAgyDiscoveryProvenanceFromCache(async () =>
      record({ updatedAtMs: stale })
    )
    // Seeding still records it — expiry is the predicate's job, not the seed's,
    // so the two stay independently testable.
    expect(seeded.source).toBe('cached')
    expect(agyProvenanceProvesAuthenticatedConnection(seeded, CACHE_AT)).toBe(false)
  })
})
