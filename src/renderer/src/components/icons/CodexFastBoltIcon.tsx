/*
 * CodexFastBoltIcon — monoline Fast-tier lightning bolt used in the
 * Codex composer shell model chip and picker affordances.
 *
 * Real Codex renders a thin-stroke outline bolt (not a filled accent
 * glyph) beside the model label when Fast mode is active.
 */

/** Centerline path traced from Codex's filled bolt silhouette (16×16). */
export const CODEX_FAST_BOLT_PATH = 'M9 1.75 4.25 8.25H7.25L6.35 13.75 12.15 7.75H9.35L9 1.75Z'

/** Real Codex bolt proportions — slightly taller than wide (≈11×13 at chip scale). */
export const CODEX_FAST_BOLT_STROKE_WIDTH = 1.1
export const CODEX_FAST_BOLT_PICKER_WIDTH = 11
export const CODEX_FAST_BOLT_PICKER_HEIGHT = 13

/** Sized via CSS on `.codex-fast-bolt-icon` / `.composer-combined-picker-trigger-fast-bolt`.
 * `preserveAspectRatio="none"` is required so unequal width/height warp the path
 * instead of letterboxing (default xMidYMid meet only adds padding). */
export function CodexFastBoltIcon({ className }: { className?: string }): React.JSX.Element {
  return (
    <svg
      className={className}
      viewBox="0 0 16 16"
      preserveAspectRatio="none"
      fill="none"
      aria-hidden
      focusable="false"
    >
      <path
        d={CODEX_FAST_BOLT_PATH}
        stroke="currentColor"
        strokeWidth={CODEX_FAST_BOLT_STROKE_WIDTH}
        strokeLinecap="round"
        strokeLinejoin="round"
        vectorEffect="nonScalingStroke"
      />
    </svg>
  )
}
