import type { TranscriptWidth } from '../../../main/store/types'

export type { TranscriptWidth }

/**
 * Transcript width — the setting that does NOT carry its own number.
 *
 * `lib/transcriptTextSize` is the shape this file deliberately is not. There
 * the setting IS the number: `large` means 1.25, one resolution in one `const`,
 * handed to the CSS variable and to the layout epoch so the two cannot
 * disagree. A width cannot work that way, because the number the virtualiser
 * needs is not a property of the setting at all — it is the width
 * `.transcript-inner` ENDS UP at, which is the setting composed with the
 * window size, the pane, and that pane's own ceiling. `narrow` is 640px in the
 * main pane and 348px in a phone-narrow side chat, and both are correct.
 *
 * So this module owns exactly four things and refuses the fifth:
 *
 *   1. the NAME, resolved once (`resolveTranscriptWidth`);
 *   2. the ATTRIBUTE the transcript stylesheets key off
 *      (`TRANSCRIPT_WIDTH_ATTRIBUTE`), stamped on `.transcript-inner` itself
 *      rather than on `:root`, for the `transcriptTextSize` reason — a `:root`
 *      attribute is written by `useAppearance.applyToDocument`, which runs in
 *      the MAIN WINDOW ONLY, so a popped-out chat would silently keep the
 *      default; and because a per-element attribute is the only form that can
 *      be different in two panes of one Multiview at once;
 *   3. the CSS caps, as STRINGS (`TRANSCRIPT_WIDTH_COLUMN_CAPS`), so a guard
 *      can derive the declaration it expects instead of re-typing it;
 *   4. WHETHER the measured column reaches the estimator at all
 *      (`transcriptWidthLayoutBucket`) — Medium is byte-identical by decision,
 *      and that gate is derived from 2 so the CSS and the estimator cannot
 *      disagree about which render is "the untouched one".
 *
 * And the fifth, refused: a px NUMBER. Nothing here is arithmetic-capable on
 * purpose. If `640` were exported as a number, the next reasonable-looking edit
 * is to feed it to `widthBucket()` and mint the epoch from the SETTING — which
 * is the two-numbers defect this whole seam was repaired from, in its most
 * plausible disguise: it would be right in the main pane and wrong in every
 * other scope, silently. The epoch's width bucket has exactly one producer, the
 * ResizeObserver in `TranscriptPanel`, and that is enforced by counting
 * `widthBucket(` call sites, not by this comment.
 */

/**
 * The width an install that has never chosen one renders at.
 *
 * `medium` must stamp NOTHING. The whole byte-identity claim for users who
 * never open the control is that `.transcript-inner` carries no
 * `data-transcript-width`, so the single `max-width` declaration falls through
 * to the pane ceiling it always used.
 */
export const DEFAULT_TRANSCRIPT_WIDTH: TranscriptWidth = 'medium'

/**
 * The attribute `.transcript-inner` carries and the transcript stylesheets
 * scope to.
 *
 * Exported so the CSS guards derive the selector rather than re-typing it:
 * renaming one side of an attribute selector is invisible to TypeScript and to
 * the browser alike — every column simply stays at Medium, which looks correct
 * to anyone who has not chosen a width.
 */
export const TRANSCRIPT_WIDTH_ATTRIBUTE = 'data-transcript-width'

/**
 * What each name caps the column at, as a CSS VALUE STRING.
 *
 * Strings, not numbers, for the reason in the module note: these are CSS
 * lengths that CSS composes against the pane, never quantities JS may compute
 * with. `medium` is `null` rather than `'850px'` because Medium emits no rule
 * at all — writing `850px` here would be a second copy of
 * `--composer-content-max-width`, and re-tuning the composer would then move
 * the transcript only until somebody noticed the two had drifted.
 *
 * `wide` is `100%` of `.transcript-scroll`'s CONTENT box, which is already
 * inset by `--chat-side-gutter` on both sides. That gutter is the lane the
 * message-navigation rail lives in (`TranscriptUserMessageGutter` positions
 * itself at `contentRect.left - 34`), so "uncapped, leaving room for the
 * side-rail" needs no explicit reserve: `clamp(24px, 4.4vw, 72px)` is at or
 * above the rail's 34px everywhere the rail is eligible at all, because the
 * rail also hides itself below a 720px scroller.
 *
 * Every OTHER overlay anchored to that gutter owes the same 34px discipline,
 * and the jump-to-latest pill did not have it: at `right: var(--chat-side-gutter)`
 * its right edge lands exactly on the column's right edge, which is empty space
 * at Medium and text at Wide. It is now a 34px square centred in the lane under
 * `[data-transcript-width='wide']` (`03-composer-welcome-activity.css`). A new
 * overlay in this lane is a Wide question before it is anything else.
 */
export const TRANSCRIPT_WIDTH_COLUMN_CAPS: Readonly<Record<TranscriptWidth, string | null>> =
  Object.freeze({
    narrow: '640px',
    medium: null,
    wide: '100%'
  })

/**
 * Narrow a persisted, transferred or absent value to a width the renderer can
 * carry.
 *
 * Absence is the COMMON case — every settings file written before this setting
 * existed, and a chat popout whose window opened before the sender captured
 * anything — and it must mean "the column everything already renders at", never
 * a reflow the user did not ask for.
 */
export function resolveTranscriptWidth(value: unknown): TranscriptWidth {
  return value === 'narrow' || value === 'medium' || value === 'wide'
    ? value
    : DEFAULT_TRANSCRIPT_WIDTH
}

/**
 * The attribute VALUE `.transcript-inner` carries, or `undefined` at Medium.
 *
 * `undefined` is the load-bearing half, exactly as it is for
 * `transcriptFontScaleStyle`: React emits no attribute at all, so the
 * transcript's markup at Medium is byte-identical to the build before this
 * setting existed and no `[data-transcript-width]` rule can match.
 *
 * Compared against the literal `'medium'` rather than against
 * `DEFAULT_TRANSCRIPT_WIDTH`, and that is not redundancy. The value that may be
 * elided is the one the STYLESHEET has no rule for; reading it from the default
 * instead would mean re-pointing the default to `wide` silently stopped
 * stamping `wide`, and every transcript would render Medium while Settings
 * showed Wide.
 */
export function transcriptWidthAttribute(value: unknown): TranscriptWidth | undefined {
  const width = resolveTranscriptWidth(value)
  return width === 'medium' ? undefined : width
}

/**
 * The width bucket the LAYOUT EPOCH is minted from — the measured one at Narrow
 * and Wide, and 0 (identity, "not measured") at Medium.
 *
 * Medium is byte-identical, by decision. `.transcript-inner` renders at Medium
 * exactly as it did before this setting existed — no attribute, no
 * `--transcript-column-max-width`, the same pane ceiling — so the estimator is
 * told the same thing it was told then: nothing. `transcriptLayoutScales` and
 * `transcriptLayoutEpochKeySuffix` both short-circuit on bucket 0, so at Medium
 * every estimate and every height-cache key is the pre-setting one, to the byte,
 * for the users who never open the control and for the ones who choose Medium
 * back again.
 *
 * Expressed through `transcriptWidthAttribute` rather than through a second
 * `=== 'medium'` test, and that is the whole point of the function existing.
 * The two halves it ties together are the CSS one ("no attribute is stamped, so
 * no `[data-transcript-width]` rule matches and the column falls through to the
 * pane ceiling") and the JS one ("no width correction is applied"). Those are
 * the SAME claim about the same render, and a second comparison is how they
 * come apart: re-point the default, add a fourth name, spell `medium`
 * differently in one of the two, and the transcript renders at one column while
 * the virtualiser sizes history for another — with nothing on screen to say so.
 * Here it is structurally impossible: whatever stamps no attribute applies no
 * correction, for every input, including the junk ones.
 *
 * The measured bucket is still MEASURED at Narrow and Wide — this function
 * gates it, it never derives it. A width the setting could compute for itself
 * is the defect this module's header refuses; see `TRANSCRIPT_WIDTH_COLUMN_CAPS`.
 */
export function transcriptWidthLayoutBucket(value: unknown, measuredBucket: number): number {
  if (transcriptWidthAttribute(value) === undefined) return 0
  if (!Number.isFinite(measuredBucket) || measuredBucket <= 0) return 0
  return Math.floor(measuredBucket)
}
