import { describe, expect, it } from 'vitest'
import {
  classifyMistralLimit,
  isMistralRateLimitText,
  mistralStopIsQuotaWall,
  type MistralLimitSignals
} from './MistralRateLimitPatience'
import { estimateQuota, startCycle, type MistralQuotaEstimate } from './MistralQuotaEstimate'

const T0 = new Date('2026-07-01T00:00:00.000Z')

/** A meter reading at a chosen fraction of a $15 ceiling. */
function quotaAt(spentUsd: number): MistralQuotaEstimate {
  return estimateQuota({ ...startCycle(T0), spentUsd, learnedCeilingUsd: 15 }, 'pro', T0)
}

function signals(over: Partial<MistralLimitSignals> = {}): MistralLimitSignals {
  return {
    errorText:
      'API error from mistral (model: mistral-vibe-cli-latest): Rate limit exceeded. Please wait a moment before trying again.',
    consecutiveAttempts: 0,
    ...over
  }
}

describe('isMistralRateLimitText', () => {
  it('matches the exact string Vibe emits', () => {
    expect(
      isMistralRateLimitText('Rate limit exceeded. Please wait a moment before trying again.')
    ).toBe(true)
  })

  it('matches structured tokens and bare 429s', () => {
    expect(isMistralRateLimitText('{"type":"rate_limit_error"}')).toBe(true)
    expect(isMistralRateLimitText('HTTP 429 Too Many Requests')).toBe(true)
  })

  it('does not match unrelated failures', () => {
    expect(isMistralRateLimitText('')).toBe(false)
    expect(isMistralRateLimitText('metadata value cannot be empty')).toBe(false)
    expect(isMistralRateLimitText('ECONNRESET')).toBe(false)
  })
})

describe('classifyMistralLimit', () => {
  it('ignores text that is not a rate-limit stop', () => {
    const v = classifyMistralLimit(signals({ errorText: 'Traceback: KeyError' }))
    expect(v.kind).toBe('unknown')
    expect(v.retryAfterMs).toBe(0)
    expect(v.reason).toBe('not-a-rate-limit')
  })

  it('calls it a throttle when spend is nowhere near the ceiling', () => {
    // $1 of a $15 ceiling. A monthly budget is not a credible explanation.
    const v = classifyMistralLimit(signals({ quota: quotaAt(1) }))
    expect(v.kind).toBe('throttle')
    expect(v.retryAfterMs).toBeGreaterThan(0)
    expect(v.shouldRecordLimitEvent).toBe(false)
    expect(v.userMessage).toContain('not your monthly limit')
  })

  it('stays a throttle even after many attempts when spend is far below the ceiling', () => {
    // The key anti-failover guarantee: a stubborn throttle on a barely-used
    // account must never be reclassified as an exhausted budget.
    const v = classifyMistralLimit(signals({ consecutiveAttempts: 99, quota: quotaAt(1) }))
    expect(v.kind).toBe('throttle')
    expect(v.shouldRecordLimitEvent).toBe(false)
    expect(v.reason).toBe('spend-far-below-ceiling')
  })

  it('calls it budget when spend has reached the estimated ceiling', () => {
    const v = classifyMistralLimit(signals({ quota: quotaAt(13) }))
    expect(v.kind).toBe('budget')
    expect(v.retryAfterMs).toBe(0)
    expect(v.shouldRecordLimitEvent).toBe(true)
    expect(v.userMessage).toContain('billing cycle resets')
  })

  it('gives the throttle reading the whole ladder when the signal is ambiguous', () => {
    // Mid-range spend: could be either. Patience is the house policy.
    for (let attempt = 0; attempt < 5; attempt++) {
      const v = classifyMistralLimit(signals({ consecutiveAttempts: attempt, quota: quotaAt(7) }))
      expect(v.kind).toBe('throttle')
      expect(v.shouldRecordLimitEvent).toBe(false)
    }
  })

  it('escalates backoff across the ladder rather than hammering', () => {
    const delays = [0, 1, 2, 3, 4].map(
      (a) =>
        classifyMistralLimit(signals({ consecutiveAttempts: a, quota: quotaAt(7) })).retryAfterMs
    )
    expect(delays).toEqual([5_000, 15_000, 30_000, 60_000, 90_000])
    for (let i = 1; i < delays.length; i++) expect(delays[i]).toBeGreaterThan(delays[i - 1])
  })

  it('concedes to budget once the ladder is exhausted, but refuses to teach the meter', () => {
    const v = classifyMistralLimit(signals({ consecutiveAttempts: 5, quota: quotaAt(7) }))
    expect(v.kind).toBe('budget')
    expect(v.reason).toBe('retry-ladder-exhausted')
    // Suggestive, not conclusive — could equally be a long outage.
    expect(v.shouldRecordLimitEvent).toBe(false)
  })

  it('works with no meter at all, as on a first-ever run', () => {
    const v = classifyMistralLimit(signals({ quota: undefined }))
    expect(v.kind).toBe('throttle')
    expect(v.retryAfterMs).toBe(5_000)
  })

  it('ignores a corrupt ceiling instead of dividing by zero', () => {
    const broken = { ...quotaAt(5), estimatedCeilingUsd: 0 }
    const v = classifyMistralLimit(signals({ quota: broken }))
    expect(v.kind).toBe('throttle')
    expect(Number.isFinite(v.retryAfterMs)).toBe(true)
  })

  it('always supplies a user-facing explanation for a real stop', () => {
    // Issue #275's complaint was the absence of any feedback. Every limit
    // verdict must say something.
    for (const spent of [1, 7, 13]) {
      expect(
        classifyMistralLimit(signals({ quota: quotaAt(spent) })).userMessage.length
      ).toBeGreaterThan(0)
    }
  })
})

describe('mistralStopIsQuotaWall', () => {
  it('lets only a budget verdict reach the generic wall machinery', () => {
    expect(mistralStopIsQuotaWall(classifyMistralLimit(signals({ quota: quotaAt(13) })))).toBe(true)
  })

  it('shields a throttle from triggering failover', () => {
    expect(mistralStopIsQuotaWall(classifyMistralLimit(signals({ quota: quotaAt(1) })))).toBe(false)
  })

  it('shields a non-limit error too', () => {
    expect(mistralStopIsQuotaWall(classifyMistralLimit(signals({ errorText: 'boom' })))).toBe(false)
  })
})
