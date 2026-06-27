/*
 * QuotaPace — Phase L6 slice 3.
 *
 * TypeScript port of another-project's `QuotaWindow.pace(...)` from
 * `Shared/Models/QuotaModels.swift:490-557`. Returns the pace state
 * for a usage window: whether actual usage is `ahead`, `behind`, or
 * `onTrack` relative to elapsed time within the window.
 *
 * Drives the tick marker the new `QuotaProgressBar` paints on the
 * bar: the marker's x-position is `expectedFraction`, its colour
 * encodes `state`, and `shouldSurface` decides whether to render
 * the marker at all (we hide it for on-track windows so the eye
 * only catches the marker when it's meaningful).
 *
 * Pure module — no React, no DOM. Easy to unit-test.
 */

import type { UsageWindowAggregate } from './usageAggregateTypes'

export type QuotaPaceState = 'ahead' | 'onTrack' | 'behind'

export interface QuotaPace {
  /** `0..1`. Where the marker should sit on the bar. */
  expectedFraction: number
  /** `0..1`. The actual fill fraction (matches the bar's fill). */
  actualFraction: number
  /** `actualFraction - expectedFraction`. Negative = ahead,
   * positive = behind. */
  deltaFraction: number
  state: QuotaPaceState
}

/** Whether the marker should be visible. Hidden for on-track
 * windows (within ±2% tolerance) so users only see the marker
 * when there's something worth flagging. */
export function paceShouldSurface(pace: QuotaPace): boolean {
  return pace.state !== 'onTrack'
}

/** Marker colour by state. Hex values match the Swift reference
 * so the TaskWraith card reads as a sibling of another-project. */
export function paceColorHex(pace: QuotaPace): string {
  switch (pace.state) {
    case 'ahead':
      return '#22C55E'
    case 'behind':
      return '#F97316'
    case 'onTrack':
    default:
      return '#94A3B8'
  }
}

/** Compact label like `Ahead 12%` / `Behind 4%` used by debugging
 * tooltips / a11y. */
export function paceCompactStatusText(pace: QuotaPace): string {
  const value = Math.max(1, Math.round(Math.abs(pace.deltaFraction) * 100))
  const title = pace.state === 'ahead' ? 'Ahead' : pace.state === 'behind' ? 'Behind' : 'On track'
  return `${title} ${value}%`
}

const PACE_TOLERANCE = 0.02
const MIN_EXPECTED_FRACTION = 0.03
const MAX_EXPECTED_FRACTION = 0.985

/**
 * Infer the window's full duration (in seconds) from its label when the
 * upstream snapshot does not provide an explicit `limitWindowSeconds`.
 * This fallback keeps older provider snapshots working while newer
 * providers can pass exact/known rollover durations for labels like
 * Cursor's "Included in Pro" that do not include "monthly".
 *
 * Returns `null` when the duration can't be inferred (e.g. an
 * unlabelled custom window) — pace calculation then returns `null`.
 */
function inferWindowDurationSeconds(label: string): number | null {
  const descriptor = label.toLowerCase()
  if (
    descriptor.includes('5h') ||
    descriptor.includes('5-hour') ||
    descriptor.includes('5 hour') ||
    descriptor.includes('session')
  ) {
    return 5 * 60 * 60
  }
  if (
    descriptor.includes('24h') ||
    descriptor.includes('24-hour') ||
    descriptor.includes('daily')
  ) {
    return 24 * 60 * 60
  }
  if (
    descriptor.includes('7d') ||
    descriptor.includes('7-day') ||
    descriptor.includes('weekly') ||
    descriptor.includes('week')
  ) {
    return 7 * 24 * 60 * 60
  }
  return null
}

/**
 * Compute the pace for a usage window. Returns `null` when:
 *   - the window has no explicit limit
 *   - no future reset date
 *   - we can't infer the window's duration from its label
 *   - elapsed fraction is outside the meaningful range (< 3% or
 *     > 98.5% — too close to either edge for the marker to be
 *     useful)
 *   - the bar is already at 100% — at that point the marker is
 *     redundant because the bar itself is screaming
 */
export function computeQuotaPace(
  window: UsageWindowAggregate,
  now: Date = new Date()
): QuotaPace | null {
  // Pull the used fraction from whichever percent field the
  // aggregator populated.
  const usedPercentRaw = Number.isFinite(window.usedPercent)
    ? (window.usedPercent as number)
    : Number.isFinite(window.remainingPercent)
      ? 100 - (window.remainingPercent as number)
      : null
  if (usedPercentRaw === null) return null

  const actualFraction = Math.max(0, Math.min(1, usedPercentRaw / 100))
  if (actualFraction >= 1) return null

  if (!window.resetAt) return null
  const resetDate = new Date(window.resetAt)
  if (Number.isNaN(resetDate.getTime())) return null
  const remainingMs = resetDate.getTime() - now.getTime()
  if (remainingMs <= 0) return null

  const explicitDurationSec = Number(window.limitWindowSeconds)
  const durationSec =
    Number.isFinite(explicitDurationSec) && explicitDurationSec > 0
      ? explicitDurationSec
      : inferWindowDurationSeconds(window.label)
  if (!durationSec || durationSec <= 0) return null
  const durationMs = durationSec * 1000

  const elapsedMs = Math.max(0, Math.min(durationMs, durationMs - remainingMs))
  const expectedFraction = Math.max(0, Math.min(1, elapsedMs / durationMs))

  if (expectedFraction < MIN_EXPECTED_FRACTION || expectedFraction > MAX_EXPECTED_FRACTION) {
    return null
  }

  const delta = actualFraction - expectedFraction
  const state: QuotaPaceState =
    delta > PACE_TOLERANCE ? 'behind' : delta < -PACE_TOLERANCE ? 'ahead' : 'onTrack'

  return {
    expectedFraction,
    actualFraction,
    deltaFraction: delta,
    state
  }
}
