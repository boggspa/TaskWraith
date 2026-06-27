import { describe, expect, it } from 'vitest'
import type { UsageWindowAggregate } from './usageAggregateTypes'
import {
  computeQuotaPace,
  paceColorHex,
  paceCompactStatusText,
  paceShouldSurface
} from './QuotaPace'

/*
 * Pins the QuotaPace state machine against representative window
 * shapes. The implementation is a TS port of the Swift reference at
 * `another-project/Shared/Models/QuotaModels.swift:490-557`; these
 * tests pin the AHEAD / ON-TRACK / BEHIND classification plus the
 * null-return guards so a future refactor that drifts away from
 * the reference's contract trips immediately.
 */

function makeWindow(overrides: Partial<UsageWindowAggregate> = {}): UsageWindowAggregate {
  return {
    id: 'w1',
    label: '5H',
    runs: 0,
    totalTokens: 0,
    limitLabel: '500K / 1M tokens',
    resetAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    usedPercent: 50,
    ...overrides
  }
}

describe('computeQuotaPace', () => {
  it('classifies on-track usage (delta within ±2% tolerance) as onTrack', () => {
    // 5h window, 50% elapsed, 51% used → delta +0.01 → onTrack.
    const fakeStart = new Date('2026-05-22T10:00:00Z')
    const fakeReset = new Date('2026-05-22T15:00:00Z') // 5 hours after start
    const now = new Date('2026-05-22T12:30:00Z') // 2.5 hours in (50% elapsed)
    const pace = computeQuotaPace(
      makeWindow({
        label: '5H',
        resetAt: fakeReset.toISOString(),
        usedPercent: 51
      }),
      now
    )
    expect(pace).not.toBeNull()
    expect(pace?.state).toBe('onTrack')
    expect(paceShouldSurface(pace!)).toBe(false)
    expect(fakeStart.toISOString()).toBe('2026-05-22T10:00:00.000Z') // sanity-pin the fixture
  })

  it('classifies fast burn as behind (used outpaces elapsed time)', () => {
    // 5h window, 50% elapsed, 75% used → delta +0.25 → behind.
    const fakeReset = new Date('2026-05-22T15:00:00Z')
    const now = new Date('2026-05-22T12:30:00Z')
    const pace = computeQuotaPace(
      makeWindow({
        label: '5H',
        resetAt: fakeReset.toISOString(),
        usedPercent: 75
      }),
      now
    )
    expect(pace?.state).toBe('behind')
    expect(paceShouldSurface(pace!)).toBe(true)
    expect(paceColorHex(pace!)).toBe('#F97316')
    expect(paceCompactStatusText(pace!)).toBe('Behind 25%')
  })

  it('classifies slow burn as ahead (used lags elapsed time)', () => {
    // 5h window, 50% elapsed, 20% used → delta -0.30 → ahead.
    const fakeReset = new Date('2026-05-22T15:00:00Z')
    const now = new Date('2026-05-22T12:30:00Z')
    const pace = computeQuotaPace(
      makeWindow({
        label: '5H',
        resetAt: fakeReset.toISOString(),
        usedPercent: 20
      }),
      now
    )
    expect(pace?.state).toBe('ahead')
    expect(paceShouldSurface(pace!)).toBe(true)
    expect(paceColorHex(pace!)).toBe('#22C55E')
  })

  it('returns null when the window has no resetAt', () => {
    const pace = computeQuotaPace(makeWindow({ resetAt: undefined }))
    expect(pace).toBeNull()
  })

  it('returns null when the window has already reset (resetAt in the past)', () => {
    const pace = computeQuotaPace(
      makeWindow({ resetAt: new Date(Date.now() - 1000).toISOString() })
    )
    expect(pace).toBeNull()
  })

  it('returns null when actual usage is already at 100%', () => {
    const fakeReset = new Date('2026-05-22T15:00:00Z')
    const now = new Date('2026-05-22T12:30:00Z')
    const pace = computeQuotaPace(
      makeWindow({
        label: '5H',
        resetAt: fakeReset.toISOString(),
        usedPercent: 100
      }),
      now
    )
    expect(pace).toBeNull()
  })

  it('returns null when the window duration cannot be inferred from the label', () => {
    const fakeReset = new Date('2026-05-22T15:00:00Z')
    const now = new Date('2026-05-22T12:30:00Z')
    const pace = computeQuotaPace(
      makeWindow({
        label: 'CustomThing',
        resetAt: fakeReset.toISOString(),
        usedPercent: 50
      }),
      now
    )
    expect(pace).toBeNull()
  })

  it('uses an explicit duration for labels that cannot be inferred', () => {
    // 30-day monthly window, 50% elapsed, 10% used → ahead.
    const fakeReset = new Date('2026-06-16T00:00:00Z')
    const now = new Date('2026-06-01T00:00:00Z')
    const pace = computeQuotaPace(
      makeWindow({
        label: 'Included in Pro',
        resetAt: fakeReset.toISOString(),
        usedPercent: 10,
        limitWindowSeconds: 30 * 24 * 60 * 60
      }),
      now
    )
    expect(pace?.state).toBe('ahead')
    expect(pace?.expectedFraction).toBeCloseTo(0.5, 1)
  })

  it('returns null when elapsed fraction is below the 3% floor (too early in the window)', () => {
    // 5h window, 0.5% elapsed → expectedFraction below floor.
    const start = Date.now()
    const fakeReset = new Date(start + 5 * 60 * 60 * 1000)
    const now = new Date(start + 30 * 1000) // 30 seconds in
    const pace = computeQuotaPace(
      makeWindow({ label: '5H', resetAt: fakeReset.toISOString(), usedPercent: 30 }),
      now
    )
    expect(pace).toBeNull()
  })

  it('infers weekly window duration from the "Weekly" label', () => {
    // 7-day window, 50% elapsed (3.5 days in), 75% used → behind.
    const start = Date.now()
    const fakeReset = new Date(start + 3.5 * 24 * 60 * 60 * 1000)
    const now = new Date(start)
    const pace = computeQuotaPace(
      makeWindow({
        label: 'Weekly',
        resetAt: fakeReset.toISOString(),
        usedPercent: 75
      }),
      now
    )
    expect(pace?.state).toBe('behind')
    expect(pace?.expectedFraction).toBeCloseTo(0.5, 1)
  })
})
