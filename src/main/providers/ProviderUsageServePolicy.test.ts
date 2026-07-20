import { describe, expect, it } from 'vitest'
import {
  CURSOR_SQLITE_MAX_COPY_BYTES,
  decideUsageSnapshotServe,
  shouldCopyCursorStateDbForUsage
} from './ProviderUsageServePolicy'

describe('decideUsageSnapshotServe', () => {
  const base = {
    nowMs: 1_000_000,
    memoryFetchedAtMs: null as number | null,
    freshTtlMs: 10 * 60_000,
    staleTtlMs: 4 * 60 * 60_000,
    hasMemoryContent: false,
    hasPersistedContent: false
  }

  it('forces a live fetch on manual refresh', () => {
    expect(
      decideUsageSnapshotServe({
        ...base,
        force: true,
        hasMemoryContent: true,
        memoryFetchedAtMs: base.nowMs - 1_000,
        hasPersistedContent: true
      })
    ).toEqual({ action: 'fetch-live' })
  })

  it('returns fresh memory within the fresh TTL', () => {
    expect(
      decideUsageSnapshotServe({
        ...base,
        hasMemoryContent: true,
        memoryFetchedAtMs: base.nowMs - 30_000
      })
    ).toEqual({ action: 'return-fresh' })
  })

  it('serves stale memory and revalidates past the fresh TTL', () => {
    expect(
      decideUsageSnapshotServe({
        ...base,
        hasMemoryContent: true,
        memoryFetchedAtMs: base.nowMs - 15 * 60_000
      })
    ).toEqual({ action: 'return-stale-and-revalidate' })
  })

  it('serves disk-persisted content immediately on cold memory', () => {
    expect(
      decideUsageSnapshotServe({
        ...base,
        hasPersistedContent: true
      })
    ).toEqual({ action: 'return-stale-and-revalidate' })
  })

  it('blocks on a live fetch only when no cache exists', () => {
    expect(decideUsageSnapshotServe(base)).toEqual({ action: 'fetch-live' })
  })

  it('does not treat expired memory as still-stale past the stale TTL', () => {
    expect(
      decideUsageSnapshotServe({
        ...base,
        hasMemoryContent: true,
        memoryFetchedAtMs: base.nowMs - 5 * 60 * 60_000,
        hasPersistedContent: false
      })
    ).toEqual({ action: 'fetch-live' })
  })
})

describe('shouldCopyCursorStateDbForUsage', () => {
  it('allows a small DB copy fallback', () => {
    expect(shouldCopyCursorStateDbForUsage(4 * 1024 * 1024)).toBe(true)
  })

  it('refuses multi-GB Cursor state DBs (launch hang source)', () => {
    // Real local install measured ~2.4GB; never copy that on the usage path.
    expect(shouldCopyCursorStateDbForUsage(2.4 * 1024 * 1024 * 1024)).toBe(false)
    expect(shouldCopyCursorStateDbForUsage(CURSOR_SQLITE_MAX_COPY_BYTES + 1)).toBe(false)
  })

  it('refuses empty / non-finite sizes', () => {
    expect(shouldCopyCursorStateDbForUsage(0)).toBe(false)
    expect(shouldCopyCursorStateDbForUsage(-1)).toBe(false)
    expect(shouldCopyCursorStateDbForUsage(Number.NaN)).toBe(false)
  })
})
