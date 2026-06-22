/*
 * revealParams — the single source of truth for the type-out / reveal cadence,
 * shared by BOTH platforms. The Swift twin (ios/.../RevealParams.swift) mirrors
 * these EXACT values and is kept honest by a drift-guard test (same pattern as
 * src/shared/iconVariants.ts + its Swift twin).
 *
 * Design invariants (from the 13-agent design pass):
 *   - The reveal is DISPLAY-ONLY: a length cursor over the byte-exact
 *     accumulated string. It is strictly downstream of accumulation and NEVER
 *     writes back into chat records / chatByIdRef, so it cannot affect the
 *     token-drop gate (see lib/reconcileChatRefMap + streamingTokenDrop.test).
 *     The final rendered text always equals the full content by construction.
 *   - All rates are TIME-BASED (chars per SECOND), never per-frame, so a 60Hz
 *     Mac and a 120Hz ProMotion phone produce the same wall-clock cadence.
 *   - The cursor unit is the GRAPHEME cluster on both platforms
 *     (Intl.Segmenter('grapheme') on web / Swift `Character` on iOS), so the
 *     same `revealedLen` means the same text and a surrogate pair / ZWJ emoji
 *     is never split.
 *
 * This module is intentionally node-free and dependency-free.
 */

export interface RevealParams {
  /** Steady reveal floor (chars/sec) when there is little backlog. */
  baseCharsPerSec: number
  /** Proportional catch-up: rate grows by this per backlog-char/sec. */
  catchUpPerSec: number
  /** Hard ceiling (chars/sec) so a big burst never strobes. */
  maxCharsPerSec: number
  /**
   * Anti-slam clamp (max graphemes advanced in a single frame) for a resumed
   * backgrounded tab / suspended app that reports a huge dt. BYPASSED on the
   * terminal drain so a large final burst still finishes within completeDrainMs.
   */
  maxCharsPerFrame: number
  /** Rate (chars/sec) at which the fade tail solidifies while idle. */
  settleCharsPerSec: number
  /** Soft fade-band length, in graphemes, AND the word-boundary look-ahead cap. */
  fadeTailChars: number
  /** On any terminal reason, drain the remaining backlog within this window. */
  completeDrainMs: number
  /** Belt-and-suspenders: a stuck reveal can never pin a bubble open past this. */
  clearCeilingMs: number
  /**
   * Mid-run reattach / history-load snap threshold (graphemes). When content
   * is already present because the run predates this view, snap instant past
   * this size instead of animating. Scoped to reattach ONLY — a fresh run
   * always animates via the catch-up clock.
   */
  coldSnapChars: number
}

/** The cross-platform contract. The Swift twin mirrors these exact values. */
export const REVEAL_PARAMS: RevealParams = {
  baseCharsPerSec: 55,
  catchUpPerSec: 3.0,
  maxCharsPerSec: 900,
  maxCharsPerFrame: 96,
  settleCharsPerSec: 170,
  fadeTailChars: 26,
  completeDrainMs: 250,
  clearCeilingMs: 300,
  coldSnapChars: 220
}

/** smoothstep(t) = 3t^2 - 2t^3, clamped to [0,1]. */
export function smoothstep(t: number): number {
  const x = t < 0 ? 0 : t > 1 ? 1 : t
  return x * x * (3 - 2 * x)
}

/**
 * The SHARED opacity-ramp curve. Given a revealed grapheme's distance (in
 * graphemes) BACK from the reveal frontier, return its opacity in [0,1]:
 *   distance 0            → newest grapheme, fully faded-in-progress (~0)
 *   distance fadeTailChars → fully solid (1)
 * Both platforms evaluate THIS function so the fade easing matches — identical
 * cursor params alone are not enough (the feel is dominated by this curve).
 */
export function fadeOpacity(
  distanceFromFrontier: number,
  fadeTailChars: number = REVEAL_PARAMS.fadeTailChars
): number {
  if (fadeTailChars <= 0) return 1
  return smoothstep(distanceFromFrontier / fadeTailChars)
}
