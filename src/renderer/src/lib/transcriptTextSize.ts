import type { CSSProperties } from 'react'
import type { TranscriptTextSize } from '../../../main/store/types'

export type { TranscriptTextSize }

/**
 * Transcript text size — THE one place a size name becomes a number.
 *
 * Two things downstream have to agree on that number, and they travel by
 * completely separate paths: CSS renders the text at it, and the virtualiser's
 * layout epoch calibrates every height estimate and every height-cache key for
 * it. When they disagree the transcript is estimated for a size it is not
 * rendering — the bottom spacer is wrong, auto-follow lurches, and nothing on
 * screen says why. That is not hypothetical: the immediately preceding repair
 * in this subsystem was a cache key that carried a MEASURED bucket while the
 * estimate used a different one, excused by a comment asserting the two were
 * "the same number" when they were 0 and ~10.
 *
 * So the number is never threaded, published, persisted or stamped. Only the
 * NAME travels. `TranscriptPanel` resolves it exactly once, into one `const`,
 * and hands that same `const` to both consumers — `transcriptFontScaleStyle`
 * below (which becomes the inline `--transcript-font-scale` on
 * `.transcript-inner`) and the `TranscriptLayoutEpoch` it mints. Two consumers,
 * one local. A desync needs somebody to write a second expression, which is
 * what `transcriptTextSizeSetting.test.ts` refuses.
 *
 * Note what this shape deliberately does NOT do: stamp the scale on `:root`
 * from `useAppearance.applyToDocument`, the way `--transcript-font-family` is
 * delivered. That would put the CSS number in a different module, a different
 * function and a different call stack from the epoch number, coupled by nothing
 * — and `applyToDocument` runs in the main window only, so a popped-out chat
 * would render at one size while estimating at another.
 */

/**
 * The size an install that has never chosen one renders at.
 *
 * `default` must resolve to EXACTLY 1. `transcriptLayoutScales` short-circuits
 * to the frozen identity scales on `fontScale === 1`, and
 * `transcriptLayoutEpochKeySuffix` returns the empty string on the same exact
 * comparison — so 1 is what keeps every estimate and every cache key
 * byte-identical to the pre-setting build, and 0.9999999999 quietly is not.
 */
export const DEFAULT_TRANSCRIPT_TEXT_SIZE: TranscriptTextSize = 'default'

/**
 * The three scales, as exact numeric literals.
 *
 * Literals rather than anything computed (a percentage, `100 / 100`, a parsed
 * string) for the `=== 1` reason above, and frozen because the mapping is what
 * every other seam in this feature is pinned against.
 */
export const TRANSCRIPT_TEXT_SCALES: Readonly<Record<TranscriptTextSize, number>> = Object.freeze({
  small: 0.85,
  default: 1,
  large: 1.25
})

/**
 * Narrow a persisted, transferred or absent value to a size the renderer can
 * carry.
 *
 * Absence is the COMMON case — every settings file written before this setting
 * existed, and a chat popout whose window opened before the sender captured
 * anything — and it must mean "the size everything was calibrated at", never a
 * resize the user did not ask for.
 */
export function resolveTranscriptTextSize(value: unknown): TranscriptTextSize {
  return value === 'small' || value === 'default' || value === 'large'
    ? value
    : DEFAULT_TRANSCRIPT_TEXT_SIZE
}

/** The scale a size name renders and estimates at. Total, and always exact. */
export function transcriptTextScale(value: unknown): number {
  return TRANSCRIPT_TEXT_SCALES[resolveTranscriptTextSize(value)]
}

/**
 * The custom property `.transcript-inner` carries and the transcript
 * stylesheets read.
 *
 * Exported so the CSS guard derives the name rather than re-typing it: renaming
 * one side of a custom property is invisible to TypeScript and to the browser
 * alike — the `var(..., 1)` fallback simply makes every size look correct at
 * Default and frozen everywhere else.
 */
export const TRANSCRIPT_FONT_SCALE_PROPERTY = '--transcript-font-scale'

/**
 * The inline style `.transcript-inner` carries, or `undefined` at Default.
 *
 * `undefined` is the load-bearing half: React emits no `style` attribute at
 * all, so the transcript's markup at Default is byte-identical to the build
 * before this setting existed, and `var(--transcript-font-scale, 1)` resolves
 * through its fallback to the same `calc(<base> * 1)` the tokens always had.
 *
 * Takes the resolved SCALE, not the size name, on purpose. The caller has to
 * have the number already — it is the same `const` that becomes
 * `TranscriptLayoutEpoch.fontScale` — so there is no second lookup here that
 * could disagree with the first.
 */
export function transcriptFontScaleStyle(scale: number): CSSProperties | undefined {
  // The literal 1, NOT `TRANSCRIPT_TEXT_SCALES.default`. The number that may be
  // elided is the one the ESTIMATOR treats as identity — `transcriptLayoutScales`
  // and `transcriptLayoutEpochKeySuffix` both short-circuit on `fontScale === 1`
  // — and reading it from the catalogue instead would re-open the desync from the
  // other end: re-point Default at 1.0001 and this would still emit nothing, so
  // CSS would render through the `, 1` fallback while the epoch carried 1.0001.
  // Mutation-tested: that is exactly what happened before this line said 1.
  if (scale === 1) return undefined
  return { [TRANSCRIPT_FONT_SCALE_PROPERTY]: String(scale) } as CSSProperties
}
