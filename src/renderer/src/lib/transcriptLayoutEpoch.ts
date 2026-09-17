/**
 * The transcript virtualiser's LAYOUT EPOCH — the layout inputs that change
 * every row's height without changing a single message.
 *
 * Why this exists. `estimatedHeightFor` takes no geometry at all: its whole
 * arithmetic is per-type base heights, one px-per-char rate and two px caps,
 * every one of them a constant measured at ONE column width and ONE text size.
 * The rate's own calibration comment factors it as "one ~980px-wide wrapped
 * line (~40px) per ~95 chars" — i.e. `(line box) / (columnWidth / glyph
 * advance)`. Both the line box and the advance scale with text size, so the
 * physically correct rate is
 *
 *     rate(W, F) = CONTENT_PX_PER_CHAR x F^2 x (CALIBRATION_WIDTH_PX / W)
 *
 * — QUADRATIC in the text scale and INVERSE in the column width. Chrome (the
 * per-type resting heights and the RunCard band) tracks text size only: it is
 * roughly width-invariant, and a single uniform multiplier over both would be
 * wrong on one of the two axes whichever value it took. Hence two scales, not
 * one.
 *
 * What the epoch deliberately does NOT scale: `VIEWPORT_CLAMPED_ESTIMATE_CAP_PX`.
 * The three clamped row types (`fanoutResult`, `return`, `threadMessage`) render
 * their entire body inside a CSS-px `max-height`, and a px max-height neither
 * grows with text size nor shrinks with column width. Multiplying that ceiling
 * would push those rows into the OVER-estimate direction, which
 * `TranscriptVirtualWindow.ts` documents at length as the dangerous one — an
 * inflated bottom spacer balloons `scrollHeight` and auto-follow's snap lurches
 * the reader into empty overscan. Under-estimating is absorbed by the
 * anchor-correction pass; over-estimating is a visible defect.
 *
 * The TEXT axis is LIVE. Settings -> Appearance -> Transcript text size feeds
 * it: `transcriptTextScale` resolves small/default/large to 0.85 / 1 / 1.25 and
 * `TranscriptPanel` mints the epoch from that one local, on the same render
 * that stamps `--transcript-font-scale` on `.transcript-inner`. At Large a
 * `fanoutResult` estimates 400 and the cache-key suffix is `|w0f1.25`.
 *
 * If you are about to change how `fontScale` reaches this module, that single
 * local is the invariant: the number the DOM renders at and the number the
 * estimator is told MUST be the same value, not two that happen to agree.
 * Scaling or offsetting it at the mint desyncs them silently — the estimator
 * then sizes history for a text size the transcript is not rendering.
 * `transcriptTextSizeSetting.test.ts` pins that expression EXACTLY (not by
 * containment, which every arithmetic form is a prefix of).
 *
 * The WIDTH axis is LIVE as of Transcript Width. `TranscriptPanel` runs the
 * only `widthBucket()` call in the transcript — a bucketed, settled
 * ResizeObserver on `.transcript-inner` — commits it to state, and mints the
 * epoch from it; `useTranscriptVirtualization` reads that same value back off
 * the epoch for `measurementKey` and `geometryKey`. It used to sample its own,
 * in a scroll handler, into a ref that triggers no render: the key carried a
 * measured ~10 while this module was handed a hardcoded 0, so every estimate
 * was calibrated for a 980px column the transcript never rendered at.
 *
 * Read that consequence carefully before calling the awakening a regression.
 * Between the seam landing and Width shipping, the width correction was not
 * "off", it was WRONG in the safe direction: the main pane's 850px column was
 * estimated as 980px, i.e. ~13% fewer wrapped lines than the DOM produces.
 * Waking the axis resolves that column to bucket 10's upper edge (880px) and
 * leaves a ~3% under-estimate — closer to the truth, still on the safe side,
 * and not byte-identical to the dormant build for anybody, including a user who
 * never opens the control. There is no third option: an epoch that kept
 * reporting 0 at Medium while the cache key reported 10 would be the two-number
 * lie again, and shipping Wide with the axis dormant is worse still — a 1400px
 * column estimated as 980px OVER-estimates by ~43%, which is the direction this
 * module documents as a visible defect.
 *
 * `DEFAULT_TRANSCRIPT_LAYOUT_EPOCH` remains exactly identity — first paint,
 * every `renderToStaticMarkup` suite, and every caller that passes no epoch at
 * all. That is a property of the DEFAULT epoch only, not of the app.
 */

/**
 * The column width, in CSS px, that every shipped estimate constant was
 * calibrated at.
 *
 * A MEASUREMENT of where the constants came from, not a tuning knob. It is not
 * a width `.transcript-inner` takes in any scope — the column runs 760px in
 * General Chat, 850px in the main pane at Medium, and whatever the pane allows
 * at Wide — and the correction for that difference is the width term below.
 * Re-pointing this constant to make one scope resolve to exactly 1 would be a
 * silent re-tune of `CONTENT_PX_PER_CHAR` for every other scope, and no single
 * value can make two scopes identity at once (850px buckets to 880, 760px to
 * 800). Nothing in the suite would catch it either: the only test that reads it
 * re-derives its expectation FROM it. If it ever does move, it owes a literal
 * pin and an estimate golden.
 *
 * It now decides a SECOND thing: the lane track count at Medium, which is 2
 * only because 980px fits exactly two 360px tracks. Re-pointing it to anything
 * at or above 1104 would make the estimator size Medium's lanes three-across
 * while the DOM still lays out two. `fanoutLaneTracks.test.ts` pins that with
 * literals rather than re-derivations, so the move would red.
 */
export const LAYOUT_EPOCH_CALIBRATION_WIDTH_PX = 980

/**
 * Widest and narrowest correction the epoch may ever apply. A pathological
 * epoch (a 0-width pane mid-unmount, a corrupt persisted setting) must not be
 * able to balloon the bottom spacer; clamping keeps the worst case bounded in
 * the direction that only costs an anchor correction.
 */
export const LAYOUT_EPOCH_MIN_SCALE = 0.25
export const LAYOUT_EPOCH_MAX_SCALE = 4

/** The estimate-affecting layout inputs, as one value. */
export type TranscriptLayoutEpoch = {
  /**
   * `widthBucket()` of the capped `.transcript-inner`, i.e. `floor(width / 80)`.
   * 0 means "not measured yet" (or a degenerate sub-80px column) and applies NO
   * width correction — the estimates then behave exactly as they always have.
   */
  widthBucket: number
  /**
   * Transcript text scale. 1 is the size every estimate constant was measured
   * at; 1.25 means "25% larger text".
   */
  fontScale: number
}

/** Identity. Produces `{ content: 1, chrome: 1 }` and an EMPTY key suffix. */
export const DEFAULT_TRANSCRIPT_LAYOUT_EPOCH: TranscriptLayoutEpoch = Object.freeze({
  widthBucket: 0,
  fontScale: 1
})

/**
 * The two physically distinct multipliers an epoch resolves to.
 *
 * `content` multiplies the per-char rate and the generic content ceiling — how
 * many px a wall of text costs. `chrome` multiplies the per-type base heights
 * and the run-boundary band — how tall a row's furniture is.
 */
export type TranscriptLayoutScales = {
  content: number
  chrome: number
}

export const IDENTITY_TRANSCRIPT_LAYOUT_SCALES: TranscriptLayoutScales = Object.freeze({
  content: 1,
  chrome: 1
})

function normalizedFontScale(epoch: TranscriptLayoutEpoch | null | undefined): number {
  const raw = epoch?.fontScale
  if (typeof raw !== 'number' || !Number.isFinite(raw) || raw <= 0) return 1
  return raw
}

function normalizedWidthBucket(epoch: TranscriptLayoutEpoch | null | undefined): number {
  const raw = epoch?.widthBucket
  if (typeof raw !== 'number' || !Number.isFinite(raw) || raw <= 0) return 0
  return Math.floor(raw)
}

function clampScale(value: number): number {
  if (!Number.isFinite(value)) return 1
  return Math.min(LAYOUT_EPOCH_MAX_SCALE, Math.max(LAYOUT_EPOCH_MIN_SCALE, value))
}

/**
 * The column width, in CSS px, that an epoch stands for.
 *
 * ONE resolution, read by both consumers — the content width term below and the
 * lane track count. A second spelling of `(bucket + 1) * widthBucketPx` is a
 * second effective column that can drift from the one the content rate uses,
 * and then the estimator divides a row by a track count derived from a width it
 * was not sized for.
 *
 * The bucket resolves to its UPPER edge — `(bucket + 1) * WIDTH_BUCKET_PX` — on
 * purpose. Every bucket spans 80px of real width, and assuming the widest
 * column in the bucket yields the SMALLEST rate, i.e. the under-estimate
 * direction the virtualiser calls safe. Bucket 0 is the "not measured" sentinel
 * (and the gated value at Medium) and resolves to the calibration width, which
 * is wider than every column Medium can produce — 850px in the main pane, 760px
 * in General Chat, `min(850px, calc(100% - 28px))` in a Multiview pane — so the
 * upper-edge argument holds there too.
 */
export function transcriptLayoutColumnWidthPx(
  epoch: TranscriptLayoutEpoch | null | undefined,
  widthBucketPx = 80
): number {
  const bucket = normalizedWidthBucket(epoch)
  return bucket > 0 ? (bucket + 1) * widthBucketPx : LAYOUT_EPOCH_CALIBRATION_WIDTH_PX
}

/**
 * The fan-out lane grid's track floor, in CSS px — the JS half of
 * `--fanout-lane-min` in `02-transcript-messages-fx.css`.
 *
 * A re-typed CSS number, which `transcriptWidth.ts` refuses to export for its
 * own caps and for a good reason. It is admitted here because the track count
 * has to be known at ESTIMATE time, where there is no element to measure and no
 * computed style to read (the renderer suites are `renderToStaticMarkup` with
 * no jsdom), and because the alternative — reading the count off the DOM — is
 * the second width sample the whole width seam exists to refuse. The pairing is
 * held by a CSS guard in `transcriptWidthSetting.test.ts` that DERIVES the
 * expected declaration from this constant rather than re-typing it.
 */
export const FANOUT_LANE_MIN_PX = 360

/**
 * The gap between lane tracks, in CSS px — `column-gap: var(--space-md)` on the
 * same grid rule.
 *
 * `--space-md` is 12px at `:root` and 8px under `[data-compact="true"]`, and
 * this models the 12px one. The epoch has no density axis and this slice does
 * not give it one, because the 80px width BUCKET dominates the 4px difference:
 * the two gap values disagree about the track count only for effective columns
 * inside [728,732), [1096,1104), [1464,1476), … and the effective column is
 * always a multiple of 80 (or the 980px calibration width), none of which lands
 * in any of those bands below ~2960px of column. Above that the two differ by
 * at most one track out of eight or more, which moves an estimate by ~12%.
 */
export const FANOUT_LANE_COLUMN_GAP_PX = 12

/**
 * How many fan-out lane cards the epoch's column fits side by side.
 *
 * The CSS grid is `repeat(auto-fit, minmax(min(100%, var(--fanout-lane-min)), 1fr))`
 * with `column-gap: var(--space-md)`, so `k` tracks need
 * `k * FANOUT_LANE_MIN_PX + (k - 1) * gap` of column, which inverts to
 * `floor((column + gap) / (FANOUT_LANE_MIN_PX + gap))`. The grid's own comment
 * confirms the forward form: two tracks at 732px, three at ~1104px, four at
 * ~1476px.
 *
 * DIRECTION. `transcriptLayoutColumnWidthPx` resolves the bucket to its upper
 * edge, so the effective column is never narrower than the real one and this
 * count is therefore never SMALLER than the number of tracks CSS lays out. The
 * estimator divides a lane row by it, so an over-count is an UNDER-estimate —
 * the direction `TranscriptVirtualWindow` calls safe and absorbs in one
 * anchor-correction pass. An under-count would inflate the bottom spacer, which
 * is the auto-follow lurch its caps exist to prevent. Deriving this from a
 * measured `clientWidth`, or from the bucket's LOWER edge, flips that.
 *
 * The floor of 1 is load-bearing: a degenerate epoch (bucket 1 — a 0-width pane
 * mid-unmount — resolves to a 160px column) would otherwise yield 0 tracks and
 * an estimate of `Infinity`, the unbounded bottom spacer `LAYOUT_EPOCH_MIN_SCALE`
 * and `LAYOUT_EPOCH_MAX_SCALE` were written against.
 */
export function transcriptLayoutLaneTracks(
  epoch: TranscriptLayoutEpoch | null | undefined,
  widthBucketPx = 80
): number {
  return fanoutLaneTracksForColumnPx(transcriptLayoutColumnWidthPx(epoch, widthBucketPx))
}

/**
 * The track count for a literal column width — the arithmetic half of
 * `transcriptLayoutLaneTracks`, split out so the track BOUNDARIES can be pinned
 * directly. The effective column an epoch resolves to is always a multiple of
 * the bucket step (or the calibration width), so no epoch can land exactly on
 * 732 / 1104 / 1476 and the off-by-one that drops the `+ gap` numerator term is
 * invisible from the epoch side.
 */
export function fanoutLaneTracksForColumnPx(columnPx: number): number {
  if (!Number.isFinite(columnPx) || columnPx <= 0) return 1
  return Math.max(
    1,
    Math.floor(
      (columnPx + FANOUT_LANE_COLUMN_GAP_PX) / (FANOUT_LANE_MIN_PX + FANOUT_LANE_COLUMN_GAP_PX)
    )
  )
}

/**
 * Resolve an epoch to its two multipliers. Exactly `{ content: 1, chrome: 1 }`
 * for the default epoch, and `content === chrome === 1` is what makes the
 * estimator byte-identical: `x * 1` is exact in IEEE-754 for every finite `x`,
 * and `Math.round(n) === n` for the integer bases and caps.
 *
 * The width term reads `transcriptLayoutColumnWidthPx`; see there for why the
 * bucket resolves to its upper edge.
 */
export function transcriptLayoutScales(
  epoch: TranscriptLayoutEpoch | null | undefined,
  widthBucketPx = 80
): TranscriptLayoutScales {
  const fontScale = normalizedFontScale(epoch)
  const bucket = normalizedWidthBucket(epoch)
  if (fontScale === 1 && bucket === 0) return IDENTITY_TRANSCRIPT_LAYOUT_SCALES
  const columnWidth = transcriptLayoutColumnWidthPx(epoch, widthBucketPx)
  const widthTerm = LAYOUT_EPOCH_CALIBRATION_WIDTH_PX / columnWidth
  return {
    /*
     * The floor applies to the TEXT term only; the width term multiplies
     * through and is bounded at the top alone.
     *
     * Clamping the PRODUCT from below was safe while the column was capped at
     * 850px, and stops being safe the moment Transcript Width uncaps it. The
     * floor's job is to stop a pathological epoch INFLATING the bottom spacer,
     * which is the over-estimate direction; on the width axis a large bucket
     * shrinks the term, which is the under-estimate direction the virtualiser
     * calls safe and absorbs in one anchor-correction pass. Flooring it there
     * therefore returns MORE than physics asks for — at Wide on a 4K display
     * with Small text (a ~3436px column, bucket 42) the true term is 0.206 and
     * a product floor returns 0.25, a 21% over-estimate on every content-scaled
     * row. Today's 850px cap makes that unreachable, which is why nothing has
     * ever exercised it.
     *
     * `clampScale(fontScale * fontScale)` keeps the floor exactly where it was
     * doing work: a corrupt or absurd persisted text scale still cannot drive
     * the content rate to zero. The top clamp still bounds the whole product,
     * so a 0-width pane mid-unmount (bucket 1, term 6.125) is still capped.
     */
    content: Math.min(LAYOUT_EPOCH_MAX_SCALE, clampScale(fontScale * fontScale) * widthTerm),
    chrome: clampScale(fontScale)
  }
}

/**
 * The content scale for rows whose content term COUNTS ITEMS rather than
 * measuring text — the text half of `content`, with the width term left off.
 *
 * `tool` is the one such type. `TranscriptVirtualWindow` synthesises its
 * `contentLength` as `activities.length * TOOL_ACTIVITY_ESTIMATE_CHARS` plus a
 * per-activity CAPPED output sum, precisely because an `ActivityStack`'s height
 * is driven by how many activities it has and not by how long their output is —
 * every body sits inside a bounded collapsed viewport or a click-to-expand row.
 * A row like that does not re-wrap when the column widens: one activity is one
 * line at 640px and one line at 2400px. Applying the width term to it is a
 * category error in both directions — at a 2156px Wide column the estimate drops
 * ~2.5x while the rendered height barely moves, and at Narrow it inflates by
 * ~1.36x, which is the bottom-spacer direction.
 *
 * Deliberately NOT a third field on `TranscriptLayoutScales`. That type is the
 * pair of physically distinct multipliers a LAYOUT resolves to, and both of its
 * members are exactly 1 at identity — a property three shipped assertions pin by
 * exact object shape. This is a per-ROW-TYPE selection between the two axes of
 * that pair, so it belongs at the call site that knows the row type.
 *
 * Identical to `content` whenever the width bucket is 0, which is every install
 * at Medium and every `renderToStaticMarkup` suite: the width term is then
 * exactly 1 and both reduce to `clampScale(fontScale * fontScale)`. So this
 * changes nothing at Medium, at any text size, by construction rather than by
 * arithmetic that happens to agree.
 */
export function transcriptLayoutWidthInvariantContentScale(
  epoch: TranscriptLayoutEpoch | null | undefined
): number {
  // `fontScale * fontScale`, spelled exactly as `transcriptLayoutScales` spells
  // it, not `** 2`: the two must be the same IEEE-754 product, not two forms
  // that round the same way for the three shipped scales.
  const fontScale = normalizedFontScale(epoch)
  return clampScale(fontScale * fontScale)
}

/**
 * Suffix appended to a height cache key.
 *
 * EMPTY for the default epoch, so every key stays byte-identical to the
 * pre-seam build. Otherwise it carries BOTH axes of the epoch.
 *
 * The text scale is the axis nothing else can see: a text-size change does not
 * move the column the bucket is read from, so without it a cache full of
 * heights measured at the old size would be reused wholesale.
 *
 * The width bucket is carried too, even though `measurementKey` / `geometryKey`
 * also take a `bucket` argument. An earlier draft omitted it, reasoning that
 * the argument "is the same number as `epoch.widthBucket`" — which was false in
 * that very draft, and enforced by nothing: the argument was a MEASURED
 * `widthBucket(el.clientWidth)` sampled in a scroll handler while the epoch was
 * minted in render. Transcript Width made that claim TRUE, and structurally so:
 * `TranscriptPanel` holds the only `widthBucket(` call in the transcript, and
 * the virtualiser passes `layoutEpoch.widthBucket` to both keys.
 *
 * The axis stays here anyway, and the redundancy is now the point. It costs a
 * few bytes in a non-default key, it is free at the default one, and it is what
 * makes the key correct on its OWN terms — so if somebody reintroduces a second
 * sample, the key separates the two layouts instead of serving one layout's
 * heights under the other's estimate. Do not remove it because the numbers
 * currently agree; they currently agree because a source-string guard refuses
 * the second call site, and guards are easier to delete than defects are to
 * find.
 */
export function transcriptLayoutEpochKeySuffix(
  epoch: TranscriptLayoutEpoch | null | undefined
): string {
  const fontScale = normalizedFontScale(epoch)
  const bucket = normalizedWidthBucket(epoch)
  if (fontScale === 1 && bucket === 0) return ''
  return `|w${bucket}f${fontScale}`
}

/**
 * Lossless, cheap encoding of an epoch — a stable dependency value for callers
 * that would otherwise have to compare objects.
 */
export function transcriptLayoutEpochToken(
  epoch: TranscriptLayoutEpoch | null | undefined
): string {
  return `w${normalizedWidthBucket(epoch)}f${normalizedFontScale(epoch)}`
}

/**
 * Compare epochs BY VALUE. The projection cache must never reuse a prefix
 * built under a different epoch, and a caller that re-creates its epoch object
 * every render would defeat an identity check silently — reuse would look fine
 * and the transcript's whole history would stay sized for the layout the user
 * just left.
 */
export function transcriptLayoutEpochsEqual(
  a: TranscriptLayoutEpoch | null | undefined,
  b: TranscriptLayoutEpoch | null | undefined
): boolean {
  if (a === b) return true
  if (!a || !b) return false
  return (
    normalizedWidthBucket(a) === normalizedWidthBucket(b) &&
    normalizedFontScale(a) === normalizedFontScale(b)
  )
}

/** True when this epoch resolves to identity — the pre-seam behaviour. */
export function isDefaultTranscriptLayoutEpoch(
  epoch: TranscriptLayoutEpoch | null | undefined
): boolean {
  return transcriptLayoutEpochsEqual(epoch, DEFAULT_TRANSCRIPT_LAYOUT_EPOCH)
}
