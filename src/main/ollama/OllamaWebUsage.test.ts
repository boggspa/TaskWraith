import { describe, expect, it, vi } from 'vitest'
import {
  buildOllamaWebUsageSnapshot,
  createOllamaWebUsageFetcher,
  resetDescriptionToIso
} from './OllamaWebUsage'
import type { OllamaWebSubscriptionResult } from './OllamaWebSubscriptionClient'

const NOW = new Date('2026-08-18T12:00:00.000Z')

const RESULT: OllamaWebSubscriptionResult = {
  sessionUsedPercent: 37.5,
  sessionResetDescription: 'Resets in 3h',
  weeklyUsedPercent: 62,
  weeklyResetDescription: 'Resets in 4d'
}

describe('resetDescriptionToIso', () => {
  it('converts hour and day descriptions into instants', () => {
    expect(resetDescriptionToIso('Resets in 3h', NOW)).toBe('2026-08-18T15:00:00.000Z')
    expect(resetDescriptionToIso('Resumes in 2d', NOW)).toBe('2026-08-20T12:00:00.000Z')
  })

  it('carries no date for unparseable descriptions', () => {
    expect(resetDescriptionToIso('Weekly limit reached', NOW)).toBeUndefined()
    expect(resetDescriptionToIso(undefined, NOW)).toBeUndefined()
  })
})

describe('buildOllamaWebUsageSnapshot', () => {
  it('maps both meters onto the Session/Weekly windows the card expects', () => {
    const snapshot = buildOllamaWebUsageSnapshot(RESULT, NOW)
    expect(snapshot.provider).toBe('ollama')
    expect(snapshot.configured).toBe(true)
    expect(snapshot.windows).toEqual([
      {
        id: 'ollama-session-5h',
        label: 'Session usage',
        runs: 0,
        totalTokens: 0,
        limitLabel: '38% used · Resets in 3h',
        resetAt: '2026-08-18T15:00:00.000Z',
        trackingOnly: false,
        usedPercent: 37.5,
        windowKind: 'session'
      },
      {
        id: 'ollama-weekly',
        label: 'Weekly usage',
        runs: 0,
        totalTokens: 0,
        limitLabel: '62% used · Resets in 4d',
        resetAt: '2026-08-22T12:00:00.000Z',
        trackingOnly: false,
        usedPercent: 62,
        windowKind: 'weekly'
      }
    ])
  })

  it('falls back to the window-kind subtitles when the page gave no reset phrase', () => {
    const snapshot = buildOllamaWebUsageSnapshot(
      { sessionUsedPercent: 5, weeklyUsedPercent: 10 },
      NOW
    )
    expect(snapshot.windows?.[0]?.limitLabel).toBe('5% used · 5-hour sliding window')
    expect(snapshot.windows?.[1]?.limitLabel).toBe('10% used · Weekly rolling window')
  })
})

describe('createOllamaWebUsageFetcher', () => {
  function fetcher(overrides: {
    cookie?: () => { status: string; value?: string }
    fetchResults?: Array<OllamaWebSubscriptionResult | null>
  }) {
    let nowMs = NOW.getTime()
    const fetchSubscription = vi.fn(
      async () => (overrides.fetchResults ?? [RESULT]).shift() ?? null
    )
    const fetch = createOllamaWebUsageFetcher({
      loadCookie: overrides.cookie ?? (() => ({ status: 'ok', value: '__Secure-session=abc' })),
      fetchSubscription,
      now: () => new Date(nowMs)
    })
    return {
      fetch,
      fetchSubscription,
      advance: (ms: number) => {
        nowMs += ms
      }
    }
  }

  it('serves an explicit unconfigured tombstone when no session is stored', async () => {
    const t = fetcher({ cookie: () => ({ status: 'missing' }) })
    const snapshot = await t.fetch()
    expect(snapshot).toMatchObject({ provider: 'ollama', configured: false, windows: [] })
    expect(t.fetchSubscription).not.toHaveBeenCalled()
  })

  it('caches a good read for the TTL and lets force bypass it after the floor', async () => {
    const t = fetcher({ fetchResults: [RESULT, RESULT, RESULT] })
    const first = await t.fetch()
    expect(first.windows).toHaveLength(2)
    await t.fetch()
    expect(t.fetchSubscription).toHaveBeenCalledTimes(1)

    // Force within the floor is still coalesced; past the floor it refetches.
    await t.fetch({ force: true })
    expect(t.fetchSubscription).toHaveBeenCalledTimes(1)
    t.advance(6 * 1000)
    await t.fetch({ force: true })
    expect(t.fetchSubscription).toHaveBeenCalledTimes(2)

    // And the ordinary TTL expiry refetches too.
    t.advance(5 * 60 * 1000 + 1)
    await t.fetch()
    expect(t.fetchSubscription).toHaveBeenCalledTimes(3)
  })

  it('keeps serving the last good read, marked stale, across a failed refresh', async () => {
    const t = fetcher({ fetchResults: [RESULT, null] })
    await t.fetch()
    t.advance(5 * 60 * 1000 + 1)
    const stale = await t.fetch()
    expect(stale.stale).toBe(true)
    expect(stale.windows).toHaveLength(2)
    expect(stale.configured).toBe(true)
  })

  it('explains a configured-but-unreadable session instead of pretending 0%', async () => {
    const t = fetcher({ fetchResults: [null] })
    const snapshot = await t.fetch()
    expect(snapshot.configured).toBe(true)
    expect(snapshot.windows).toEqual([])
    expect(snapshot.error).toContain('Re-import')
  })

  it('drops the previous session’s cache the moment the cookie changes', async () => {
    let cookieValue = '__Secure-session=first'
    const t = fetcher({
      cookie: () => ({ status: 'ok', value: cookieValue }),
      fetchResults: [RESULT, { sessionUsedPercent: 1, weeklyUsedPercent: 2 }]
    })
    await t.fetch()
    expect(t.fetchSubscription).toHaveBeenCalledTimes(1)

    cookieValue = '__Secure-session=second'
    const fresh = await t.fetch()
    expect(t.fetchSubscription).toHaveBeenCalledTimes(2)
    expect(fresh.windows?.[0]?.usedPercent).toBe(1)
  })
})
