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
 * Today nothing produces a non-default epoch: the transcript has no text-size
 * setting, and the measured column bucket lives inside
 * `useTranscriptVirtualization`, below the projection that would need it. This
 * module is the seam those two settings plug into, and
 * `DEFAULT_TRANSCRIPT_LAYOUT_EPOCH` is exactly identity — every estimate and
 * every cache key is byte-identical to the pre-seam build.
 */

/**
 * The column width, in CSS px, that every shipped estimate constant was
 * calibrated at. Note this is NOT a width `.transcript-inner` actually takes:
 * the column is capped at `--composer-content-max-width` (850px). Correcting
 * that calibration is a behaviour CHANGE and is deliberately not attempted
 * here — it belongs with the setting that makes width an input.
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
 * Resolve an epoch to its two multipliers. Exactly `{ content: 1, chrome: 1 }`
 * for the default epoch, and `content === chrome === 1` is what makes the
 * estimator byte-identical: `x * 1` is exact in IEEE-754 for every finite `x`,
 * and `Math.round(n) === n` for the integer bases and caps.
 *
 * The bucket resolves to its UPPER edge — `(bucket + 1) * WIDTH_BUCKET_PX` — on
 * purpose. Every bucket spans 80px of real width, and assuming the widest
 * column in the bucket yields the SMALLEST rate, i.e. the under-estimate
 * direction the virtualiser calls safe.
 */
export function transcriptLayoutScales(
  epoch: TranscriptLayoutEpoch | null | undefined,
  widthBucketPx = 80
): TranscriptLayoutScales {
  const fontScale = normalizedFontScale(epoch)
  const bucket = normalizedWidthBucket(epoch)
  if (fontScale === 1 && bucket === 0) return IDENTITY_TRANSCRIPT_LAYOUT_SCALES
  const columnWidth = bucket > 0 ? (bucket + 1) * widthBucketPx : LAYOUT_EPOCH_CALIBRATION_WIDTH_PX
  const widthTerm = LAYOUT_EPOCH_CALIBRATION_WIDTH_PX / columnWidth
  return {
    content: clampScale(fontScale * fontScale * widthTerm),
    chrome: clampScale(fontScale)
  }
}

/**
 * Suffix appended to a height cache key.
 *
 * EMPTY for the default epoch, so every key stays byte-identical to the
 * pre-seam build. Otherwise it carries BOTH axes of the epoch.
 *
 * The text scale is the axis nothing else can see: the bucket is read off
 * `.transcript-inner`, whose `max-width` is an absolute 850px, so no text-size
 * change can move it, and a cache full of heights measured at the old size
 * would be reused wholesale.
 *
 * The width bucket is carried too, even though `measurementKey` / `geometryKey`
 * also take a `bucket` argument. An earlier draft omitted it, reasoning that
 * the argument "is the same number as `epoch.widthBucket`" — which was false in
 * that very draft, and enforced by nothing. The two come from different places:
 * the argument is a MEASURED `widthBucket(el.clientWidth)` sampled in a scroll
 * handler, while the epoch is minted in render. Nothing makes them agree, and
 * when they disagree the estimate moves while the key does not — a row then
 * reads back a height measured at the other layout. Repeating the axis here
 * costs a few bytes in a non-default key and makes the key correct on its own
 * terms rather than on an invariant held only by a comment.
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
