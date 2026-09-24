/*
 * QuotaProgressBar — Phase L6 slice 2 (+ follow-up).
 *
 * Per-window progress bar with a provider-colored fill that warms
 * through amber → red as the fill approaches the limit. Visual
 * grammar lifted from another-project's `QuotaProgressBar`
 * (`Shared/Views/QuotaCardView.swift:880-959`):
 *
 *   - Bar fill width === `fraction` (0..1).
 *   - The gradient stops are positioned in ABSOLUTE TRACK
 *     coordinates (not relative to the fill width):
 *       0%   accent
 *       60%  accent     (hold)
 *       90%  amber  (#F59E0B)
 *       100% red    (#DC2626)
 *     The fill div is `fraction` of the track wide and shows only
 *     the leftmost `fraction` of that gradient. This means:
 *
 *       fraction ≤ 0.60 → bar is purely accent.
 *       0.60 < f ≤ 0.90 → bar starts accent, transitions toward
 *                          amber across the 60-90% band of the
 *                          track. Amber only fully arrives once
 *                          the bar passes 90% of the track.
 *       0.90 < f ≤ 1.00 → red mixes in across the last 10%.
 *
 *     Implementation note: we stretch the gradient over the full
 *     track by setting `backgroundSize: (100 / fraction)%` on the
 *     fill div. The fill div's own `width: fraction*100%` then
 *     clips the gradient to the correct slice.
 *
 * Pure presentational component. `pace` is wired in slice 3.
 */
import type { ReactElement, CSSProperties } from 'react'
import { paceColorHex, paceShouldSurface, type QuotaPace } from '../lib/QuotaPace'

interface QuotaProgressBarProps {
  /** Fill fraction, 0..1. Clamped to that range internally so
   * unexpected sentinel values (negative, NaN, >1) don't crash
   * the gradient calculation. */
  fraction: number
  /** CSS colour value for the accent stop at the start of the
   * gradient. Typically `var(--provider-{id}-color)`. */
  accent: string
  /** Optional className suffix for layout (e.g. nested inside a
   * differently-sized container). */
  className?: string
  /** When true, the bar takes a flatter, slightly taller treatment
   * so it reads cleanly inside heatmap headers / receipts etc.
   * Defaults to the standard 6px Model Usage Card bar. */
  emphasised?: boolean
  /** Phase L6 slice 3 — optional pace marker. When present and
   * `paceShouldSurface(pace) === true`, a small coloured tick paints
   * on the bar at `pace.expectedFraction`. Hidden silently for
   * `onTrack` windows. */
  pace?: QuotaPace | null
  /** Pass 1 dash markers (Limit Counter parity) — number of window
   * subdivisions. Renders `segmentCount - 1` divider ticks at
   * `(i + 1) / segmentCount`. `null` / non-finite / < 2 renders no
   * ticks. Resolved per window by `quotaSegmentCount` in
   * `../lib/quotaSegments` (the single source of truth). */
  segmentCount?: number | null
}

/**
 * Build the per-bar gradient style. Stops are positioned in
 * ABSOLUTE TRACK COORDINATES, not relative to the fill, so the
 * warning band lives at the same x-position regardless of how
 * full the bar is.
 *
 * Trick: we stretch the gradient over the full track by setting
 * `backgroundSize: (100 / fraction)%` on the fill div, which is
 * itself `fraction * 100%` wide. The fill div therefore shows
 * only the leftmost `fraction` of the gradient.
 *   fraction = 0.50 → backgroundSize 200% → fill shows the
 *                     first 50% of the gradient (= pure accent).
 *   fraction = 0.80 → backgroundSize 125% → fill shows 0-80%
 *                     of the gradient: accent through 60%, then
 *                     accent→amber to 80%. Red never appears.
 *   fraction = 0.95 → backgroundSize ~105% → fill shows 0-95%
 *                     of the gradient: accent / amber / amber→red.
 */
function buildProgressGradient(
  fraction: number,
  accent: string
): Pick<CSSProperties, 'background' | 'backgroundSize' | 'backgroundRepeat'> {
  if (fraction <= 0) {
    return { background: 'transparent', backgroundSize: 'auto', backgroundRepeat: 'no-repeat' }
  }
  return {
    background: [
      'linear-gradient(90deg, ',
      `${accent} 0%, `,
      `${accent} 60%, `,
      'var(--quota-warning-color, #F59E0B) 90%, ',
      'var(--quota-danger-color, #DC2626) 100%',
      ')'
    ].join(''),
    backgroundSize: `${(100 / fraction).toFixed(2)}% 100%`,
    backgroundRepeat: 'no-repeat'
  }
}

export function QuotaProgressBar({
  fraction,
  accent,
  className,
  emphasised = false,
  pace = null,
  segmentCount = null
}: QuotaProgressBarProps): ReactElement {
  const clampedFraction = Number.isFinite(fraction) ? Math.max(0, Math.min(1, fraction)) : 0
  // Render the fill at AT LEAST 3% width so a non-zero fraction
  // still produces a visible sliver. Pure-zero fractions render
  // an empty bar (no fill div).
  const renderFraction = clampedFraction > 0 && clampedFraction < 0.03 ? 0.03 : clampedFraction
  const widthPercent = renderFraction * 100
  // Drive the gradient off `renderFraction` so the absolute-track
  // stop positions stay correctly anchored even when we expand a
  // tiny fraction to the 3% visual floor.
  const fillStyle = buildProgressGradient(renderFraction, accent)
  const surfacePace = pace !== null && paceShouldSurface(pace)
  // Pass 1 dash markers: non-finite, null, or < 2 renders nothing.
  const segmentTotal =
    typeof segmentCount === 'number' && Number.isFinite(segmentCount) ? Math.floor(segmentCount) : 0
  const renderSegments = segmentTotal >= 2 ? segmentTotal : 0

  return (
    <div
      className={[
        'quota-progress-bar',
        emphasised ? 'quota-progress-bar-emphasised' : '',
        className ?? ''
      ]
        .filter(Boolean)
        .join(' ')}
    >
      {clampedFraction > 0 && (
        <div
          className="quota-progress-fill"
          style={{
            width: `${widthPercent.toFixed(2)}%`,
            ...fillStyle
          }}
        />
      )}
      {renderSegments >= 2 &&
        Array.from({ length: renderSegments - 1 }, (_, i) => (
          <span
            key={i}
            className="quota-segment-tick"
            aria-hidden
            style={{ left: `${(((i + 1) / renderSegments) * 100).toFixed(2)}%` }}
          />
        ))}
      {surfacePace && pace && (
        <span
          className="quota-pace-tick"
          aria-hidden
          style={{
            left: `${(pace.expectedFraction * 100).toFixed(2)}%`,
            background: paceColorHex(pace)
          }}
        />
      )}
    </div>
  )
}
