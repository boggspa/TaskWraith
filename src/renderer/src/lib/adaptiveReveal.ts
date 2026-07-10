import { snapForwardToWordBoundary, toGraphemes } from './advanceReveal'

/**
 * A transport-agnostic estimate of how this exact assistant stream is arriving
 * at the renderer. Provider/model identity is used only to seed later messages;
 * live samples always take precedence so a "fast" model on a slow relay (or a
 * local model on faster hardware) still gets the right cadence.
 */
export interface RevealCadence {
  sourceCharsPerSec: number
  averageChunkChars: number
  averageGapMs: number
  jitterMs: number
  sampleCount: number
}

export interface RevealCadenceTracker extends RevealCadence {
  lastTargetLength: number
  lastArrivalAtMs: number | null
  /**
   * A cumulative rewrite/shrink makes the next growth ambiguous: it may only
   * be the provider restating text we have already seen. Skip that one sample
   * and resume measuring once append-only delivery is established again.
   */
  rebaselineNextGrowth: boolean
}

export type RevealSpeedBand = 'slow' | 'steady' | 'fast' | 'burst'

export interface AdaptiveRevealPresentation {
  band: RevealSpeedBand
  /** CSS token fade duration. Faster/burstier streams use a shorter veil. */
  fadeDurationMs: number
  /** Bound the animated DOM to the newest words in the active block. */
  animatedWordWindow: number
  /** React paint ceiling; the controller itself remains time-based. */
  maxPaintFps: number
}

export interface AdaptiveRevealState {
  revealed: number
  /** Fractional grapheme budget. May be negative after a word-boundary loan. */
  credit: number
  velocity: number
  terminalElapsedMs: number
}

export interface AdvanceAdaptiveRevealInput {
  state: AdaptiveRevealState
  target: string
  /** Cached segmentation for `target`; avoids re-segmenting on every rAF. */
  targetGraphemes?: string[]
  cadence: RevealCadence
  dt: number
  isComplete: boolean
}

const DEFAULT_SOURCE_CHARS_PER_SEC = 78
const DEFAULT_CHUNK_CHARS = 8
const DEFAULT_GAP_MS = 70
const CADENCE_ALPHA = 0.28
const VELOCITY_TIME_CONSTANT_SEC = 0.08
const TERMINAL_DRAIN_MS = 250

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value))
}

function finiteOr(value: number, fallback: number): number {
  return Number.isFinite(value) ? value : fallback
}

function ewma(previous: number, next: number, alpha = CADENCE_ALPHA): number {
  return previous + (next - previous) * alpha
}

export function createRevealCadenceTracker(
  targetLength = 0,
  prior?: Partial<RevealCadence>
): RevealCadenceTracker {
  return {
    sourceCharsPerSec: clamp(
      finiteOr(
        prior?.sourceCharsPerSec ?? DEFAULT_SOURCE_CHARS_PER_SEC,
        DEFAULT_SOURCE_CHARS_PER_SEC
      ),
      1,
      2_000
    ),
    averageChunkChars: clamp(
      finiteOr(prior?.averageChunkChars ?? DEFAULT_CHUNK_CHARS, DEFAULT_CHUNK_CHARS),
      1,
      2_000
    ),
    averageGapMs: clamp(finiteOr(prior?.averageGapMs ?? DEFAULT_GAP_MS, DEFAULT_GAP_MS), 4, 2_000),
    jitterMs: clamp(finiteOr(prior?.jitterMs ?? 0, 0), 0, 2_000),
    sampleCount: Math.max(0, Math.floor(finiteOr(prior?.sampleCount ?? 0, 0))),
    lastTargetLength: Math.max(0, Math.floor(finiteOr(targetLength, 0))),
    lastArrivalAtMs: null,
    rebaselineNextGrowth: false
  }
}

/**
 * Observe one renderer-visible target update. Rewrites/shrinks re-baseline the
 * tracker but are deliberately excluded from rate estimation: a cumulative
 * provider restatement is not evidence that the model emitted thousands of
 * new characters in one frame.
 */
export function observeRevealTarget(
  tracker: RevealCadenceTracker,
  targetLength: number,
  nowMs: number,
  options: { appendOnly?: boolean } = {}
): RevealCadenceTracker {
  const nextLength = Math.max(0, Math.floor(finiteOr(targetLength, tracker.lastTargetLength)))
  const now = finiteOr(nowMs, tracker.lastArrivalAtMs ?? 0)
  const added = nextLength - tracker.lastTargetLength

  if (options.appendOnly === false) {
    return {
      ...tracker,
      lastTargetLength: nextLength,
      lastArrivalAtMs: now,
      rebaselineNextGrowth: true
    }
  }

  if (added <= 0) {
    return {
      ...tracker,
      lastTargetLength: nextLength,
      ...(added < 0 ? { lastArrivalAtMs: now, rebaselineNextGrowth: true } : {})
    }
  }

  if (tracker.rebaselineNextGrowth) {
    return {
      ...tracker,
      lastTargetLength: nextLength,
      lastArrivalAtMs: now,
      rebaselineNextGrowth: false
    }
  }

  if (tracker.lastArrivalAtMs === null || now <= tracker.lastArrivalAtMs) {
    return {
      ...tracker,
      averageChunkChars: ewma(tracker.averageChunkChars, added, 0.4),
      lastTargetLength: nextLength,
      lastArrivalAtMs: now,
      rebaselineNextGrowth: false
    }
  }

  const gapMs = clamp(now - tracker.lastArrivalAtMs, 4, 2_000)
  const instantaneousRate = clamp((added * 1_000) / gapMs, 1, 2_000)
  const alpha = tracker.sampleCount < 3 ? 0.48 : CADENCE_ALPHA
  const nextAverageGap = ewma(tracker.averageGapMs, gapMs, alpha)

  return {
    sourceCharsPerSec: ewma(tracker.sourceCharsPerSec, instantaneousRate, alpha),
    averageChunkChars: ewma(tracker.averageChunkChars, added, alpha),
    averageGapMs: nextAverageGap,
    jitterMs: ewma(tracker.jitterMs, Math.abs(gapMs - nextAverageGap), alpha),
    sampleCount: tracker.sampleCount + 1,
    lastTargetLength: nextLength,
    lastArrivalAtMs: now,
    rebaselineNextGrowth: false
  }
}

export function revealCadenceSnapshot(tracker: RevealCadenceTracker): RevealCadence {
  return {
    sourceCharsPerSec: tracker.sourceCharsPerSec,
    averageChunkChars: tracker.averageChunkChars,
    averageGapMs: tracker.averageGapMs,
    jitterMs: tracker.jitterMs,
    sampleCount: tracker.sampleCount
  }
}

export function resolveAdaptiveRevealPresentation(
  cadence: RevealCadence
): AdaptiveRevealPresentation {
  const rate = clamp(finiteOr(cadence.sourceCharsPerSec, DEFAULT_SOURCE_CHARS_PER_SEC), 1, 2_000)
  const chunk = clamp(finiteOr(cadence.averageChunkChars, DEFAULT_CHUNK_CHARS), 1, 2_000)
  const jitter = clamp(finiteOr(cadence.jitterMs, 0), 0, 2_000)

  let band: RevealSpeedBand
  if (rate < 55 && chunk < 20) band = 'slow'
  else if (rate < 180 && chunk < 48 && jitter < 90) band = 'steady'
  else if (rate < 480 && chunk < 96) band = 'fast'
  else band = 'burst'

  switch (band) {
    case 'slow':
      return {
        band,
        fadeDurationMs: 220,
        animatedWordWindow: 48,
        maxPaintFps: 28
      }
    case 'steady':
      return {
        band,
        fadeDurationMs: 170,
        animatedWordWindow: 48,
        maxPaintFps: 32
      }
    case 'fast':
      return {
        band,
        fadeDurationMs: 125,
        animatedWordWindow: 48,
        maxPaintFps: 36
      }
    case 'burst':
      return {
        band,
        fadeDurationMs: 90,
        animatedWordWindow: 48,
        maxPaintFps: 40
      }
  }
}

export function createAdaptiveRevealState(revealed = 0): AdaptiveRevealState {
  return {
    revealed: Math.max(0, Math.floor(finiteOr(revealed, 0))),
    credit: 0,
    velocity: 0,
    terminalElapsedMs: 0
  }
}

export function commonGraphemePrefixLength(
  left: readonly string[],
  right: readonly string[]
): number {
  const limit = Math.min(left.length, right.length)
  let index = 0
  while (index < limit && left[index] === right[index]) index += 1
  return index
}

/**
 * Continuous, time-based reveal controller. Unlike the legacy cursor it keeps
 * fractional credit, so 30/60/120 Hz traces converge to the same wall-clock
 * position instead of forcing one grapheme on every display refresh.
 */
export function advanceAdaptiveReveal(input: AdvanceAdaptiveRevealInput): AdaptiveRevealState {
  const graphemes = input.targetGraphemes ?? toGraphemes(input.target)
  const target = graphemes.length
  let revealed = clamp(Math.floor(finiteOr(input.state.revealed, 0)), 0, target)
  const backlog = target - revealed

  if (backlog <= 0) {
    return {
      revealed: target,
      credit: 0,
      velocity: 0,
      terminalElapsedMs: input.isComplete ? input.state.terminalElapsedMs : 0
    }
  }

  const dt = clamp(finiteOr(input.dt, 0), 0, 0.1)
  const sourceRate = clamp(
    finiteOr(input.cadence.sourceCharsPerSec, DEFAULT_SOURCE_CHARS_PER_SEC),
    1,
    2_000
  )
  const averageGapMs = clamp(finiteOr(input.cadence.averageGapMs, DEFAULT_GAP_MS), 4, 2_000)
  const jitterMs = clamp(finiteOr(input.cadence.jitterMs, 0), 0, 2_000)
  const averageChunk = clamp(
    finiteOr(input.cadence.averageChunkChars, DEFAULT_CHUNK_CHARS),
    1,
    2_000
  )

  // Keep a small time reserve so relay bursts become a continuous stream. The
  // reserve expands for jittery/chunky transports, but is bounded so the UI
  // never feels conspicuously behind the model.
  const reserveMs = clamp(75 + averageGapMs * 0.22 + jitterMs * 0.4 + averageChunk * 0.28, 75, 170)
  const reserve = clamp((sourceRate * reserveMs) / 1_000, 2, 48)
  // Credit is distance already earned but not yet painted. Including it in
  // pressure keeps 30/60/120 Hz clocks from applying different catch-up force
  // merely because one display has accumulated a larger fractional remainder.
  const earnedPosition = revealed + finiteOr(input.state.credit, 0)
  const pressure = Math.max(0, target - earnedPosition - reserve)
  const baseRate = clamp(sourceRate * 0.92, 42, 300)
  const catchUpGain = clamp(2.2 + averageChunk / 34 + jitterMs / 150, 2.2, 6.5)
  let desiredVelocity = clamp(baseRate * 0.78 + pressure * catchUpGain, 36, 1_600)

  const terminalElapsedMs = input.isComplete ? input.state.terminalElapsedMs + dt * 1_000 : 0
  if (input.isComplete) {
    const remainingMs = Math.max(16, TERMINAL_DRAIN_MS - terminalElapsedMs)
    desiredVelocity = Math.max(desiredVelocity, (backlog * 1_000) / remainingMs)
  }

  const previousVelocity = Math.max(0, finiteOr(input.state.velocity, 0))
  const decay = dt <= 0 ? 1 : Math.exp(-dt / VELOCITY_TIME_CONSTANT_SEC)
  const velocity = desiredVelocity + (previousVelocity - desiredVelocity) * decay
  // Exact integral of the exponential velocity response over this frame.
  // Using only the end velocity (`velocity * dt`) made coarse and ProMotion
  // clocks accumulate measurably different distance during acceleration.
  const frameProgress =
    desiredVelocity * dt +
    (previousVelocity - desiredVelocity) * VELOCITY_TIME_CONSTANT_SEC * (1 - decay)
  let credit = finiteOr(input.state.credit, 0) + Math.max(0, frameProgress)
  let step = Math.floor(Math.max(0, credit))

  if (input.isComplete && terminalElapsedMs >= TERMINAL_DRAIN_MS) {
    step = backlog
  }

  if (step <= 0) {
    return { revealed, credit, velocity, terminalElapsedMs }
  }

  const rawRevealed = Math.min(target, revealed + step)
  // Word snapping is a small readability loan, not free extra throughput: the
  // extra graphemes are deducted from credit so refresh rate and word length do
  // not make the reveal run faster over wall-clock time.
  const wordLookahead = Math.max(2, Math.min(8, Math.ceil(step * 0.65)))
  const snapped =
    rawRevealed >= target
      ? target
      : snapForwardToWordBoundary(graphemes, rawRevealed, wordLookahead)
  const consumed = snapped - revealed
  credit -= consumed
  revealed = snapped

  return {
    revealed,
    credit: clamp(credit, -16, 16),
    velocity,
    terminalElapsedMs
  }
}

export const ADAPTIVE_REVEAL_TERMINAL_DRAIN_MS = TERMINAL_DRAIN_MS
