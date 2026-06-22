import { REVEAL_PARAMS, type RevealParams } from '../../../shared/revealParams'

/*
 * advanceReveal — the pure reveal-cursor step function. Given the revealing
 * segment (the streaming TAIL — kept small by the block splitter) and the
 * current grapheme cursor, compute the next grapheme cursor for this frame.
 *
 * This is the convergence- and parity-critical core: it is a DISPLAY-ONLY
 * length over the byte-exact accumulated string and never writes anything back,
 * so it cannot regress the token-drop gate. The Swift twin reimplements this
 * exact algorithm; a golden-cadence test feeds both the same (prev, next, dt,
 * isComplete) trace and asserts identical cursor sequences.
 *
 * Units are GRAPHEME clusters (Intl.Segmenter) so the cursor never splits a
 * surrogate pair / ZWJ emoji and `revealedLen` means the same text on iOS.
 */

const GRAPHEME_SEGMENTER: Intl.Segmenter | null =
  typeof Intl !== 'undefined' && typeof Intl.Segmenter === 'function'
    ? new Intl.Segmenter(undefined, { granularity: 'grapheme' })
    : null

/** Split into grapheme clusters. Falls back to code points (Array.from) when
 * Intl.Segmenter is unavailable — still never splits a surrogate pair. */
export function toGraphemes(text: string): string[] {
  if (!text) return []
  if (GRAPHEME_SEGMENTER) {
    const out: string[] = []
    for (const seg of GRAPHEME_SEGMENTER.segment(text)) out.push(seg.segment)
    return out
  }
  return Array.from(text)
}

export function graphemeCount(text: string): number {
  return toGraphemes(text).length
}

/** First `n` grapheme clusters (n counted in graphemes, not UTF-16 units). */
export function sliceGraphemes(text: string, n: number): string {
  if (n <= 0) return ''
  const g = toGraphemes(text)
  if (n >= g.length) return text
  return g.slice(0, n).join('')
}

function isWhitespace(g: string): boolean {
  return g.length > 0 && /\s/.test(g)
}

/**
 * Snap a candidate grapheme cursor FORWARD to the next word boundary so the
 * rendered slice ends on a whole word — this reveals word-atomically (a
 * single-token markdown span like `**bold**` has no inner whitespace, so it is
 * revealed whole, never as a half-syntax sliver) and reads more naturally.
 * Look-ahead is capped at `maxLookahead` graphemes so a long unbroken run
 * (URL, long code token) still reveals progressively instead of dumping; in
 * that case we fall back to the raw grapheme cursor (never stalls, never
 * splits a grapheme). Multi-word spans (`**bold phrase**`, `[link text](url)`)
 * are the residual case, mitigated by the fade tail and the render-time
 * structure snap.
 */
export function snapForwardToWordBoundary(
  graphemes: string[],
  index: number,
  maxLookahead: number
): number {
  if (index >= graphemes.length) return graphemes.length
  if (index <= 0) return Math.max(0, index)
  const limit = Math.min(graphemes.length, index + Math.max(0, maxLookahead))
  for (let j = index; j < limit; j++) {
    if (isWhitespace(graphemes[j])) {
      return Math.min(graphemes.length, j + 1)
    }
  }
  // No word boundary within look-ahead → reveal to the raw grapheme cursor.
  return index
}

export interface AdvanceRevealInput {
  /** The revealing segment as of the previous frame (the tail). */
  prev: string
  /** The revealing segment now (the tail). */
  next: string
  /** Current reveal cursor, counted in GRAPHEMES of `next`. */
  revealed: number
  /** True on ANY terminal reason (complete / abort / error / switch / unmount). */
  isComplete: boolean
  /** Real seconds elapsed since the last advance. */
  dt: number
  params?: RevealParams
}

/**
 * Returns the next reveal cursor (grapheme count into `next`), in [0, target].
 * Always converges to the full length; on a terminal reason it drains the whole
 * backlog within completeDrainMs (bypassing the per-frame anti-slam clamp).
 */
export function advanceReveal(input: AdvanceRevealInput): number {
  const P = input.params ?? REVEAL_PARAMS
  // Clamp dt: a suspended tab can report seconds; never let one frame jump wild.
  const dt = Math.max(0, Math.min(input.dt, 0.1))

  const nextGraphemes = toGraphemes(input.next)
  const target = nextGraphemes.length

  // Divergence rewind: a cumulative-restatement provider (Cursor / a Claude
  // envelope) can REWRITE the segment. Rewind the cursor to the common grapheme
  // prefix so we never claim revealed text that changed underneath us.
  let revealed = input.revealed
  if (input.prev !== input.next) {
    const prevGraphemes = toGraphemes(input.prev)
    const max = Math.min(prevGraphemes.length, nextGraphemes.length)
    let common = 0
    while (common < max && prevGraphemes[common] === nextGraphemes[common]) common++
    if (revealed > common) revealed = common
  }
  if (revealed < 0) revealed = 0
  if (revealed > target) revealed = target

  const backlog = target - revealed
  if (backlog <= 0) return target

  let rate = Math.min(P.baseCharsPerSec + P.catchUpPerSec * backlog, P.maxCharsPerSec)
  let stepCap = P.maxCharsPerFrame
  if (input.isComplete) {
    // Drain to the end within completeDrainMs, and bypass the anti-slam clamp
    // so a large final burst still finishes in time (else completeDrainMs is
    // silently violated). Use `target` (frozen on terminal) — NOT `backlog` —
    // as the drain basis: a backlog-proportional rate decays geometrically and
    // never actually reaches the end within the window (Zeno). A target-based
    // constant rate drains linearly in at most completeDrainMs regardless of
    // where the cursor is, and finishes sooner the closer it already was.
    rate = Math.max(rate, target / (P.completeDrainMs / 1000))
    stepCap = Infinity
  }

  const step = Math.min(rate * dt, stepCap)
  let nextRevealed = Math.floor(revealed + step)
  if (nextRevealed <= revealed) {
    // Never stall while backlog remains: advance at least one grapheme.
    nextRevealed = revealed + 1
  }
  if (nextRevealed >= target) return target

  // Reveal word-atomically; on terminal we already returned the full drain
  // above when it reached target, otherwise snap the streaming frontier.
  return Math.min(target, snapForwardToWordBoundary(nextGraphemes, nextRevealed, P.fadeTailChars))
}
