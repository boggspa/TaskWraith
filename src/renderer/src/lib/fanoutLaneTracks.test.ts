import { describe, expect, it } from 'vitest'
import { widthBucket, WIDTH_BUCKET_PX } from './TranscriptVirtualWindow'
import {
  DEFAULT_TRANSCRIPT_LAYOUT_EPOCH,
  FANOUT_LANE_COLUMN_GAP_PX,
  FANOUT_LANE_MIN_PX,
  LAYOUT_EPOCH_CALIBRATION_WIDTH_PX,
  fanoutLaneTracksForColumnPx,
  transcriptLayoutColumnWidthPx,
  transcriptLayoutLaneTracks
} from './transcriptLayoutEpoch'

/**
 * HOW MANY LANE CARDS FIT SIDE BY SIDE — the one number the N-across lane model
 * is derived from, and the gate the slice that introduced it had to pass before
 * touching the estimator.
 *
 * MEDIUM MUST STAY BYTE-IDENTICAL. Every lane estimate is divided by this
 * count, so if it were anything but 2 at Medium the slice would have shipped a
 * changed default to every user who never opens the width control. The
 * arithmetic is pinned here at BOTH the gated-Medium assumed column (the 980px
 * calibration width the epoch resolves bucket 0 to) and at every real Medium
 * column the app produces — 850px in the main pane, 760px in General Chat, and
 * a split Multiview pane below both.
 *
 * Every expectation is a LITERAL. Re-deriving one from `fanoutLaneTracksForColumnPx`
 * would pass for any formula, including the constant 2 the whole slice exists to
 * stop being.
 */
describe('the lane grid track count', () => {
  it('is 2 at Medium — at the assumed column and at every real one', () => {
    // GATED MEDIUM. `transcriptWidthLayoutBucket` returns 0 at Medium by
    // design, and bucket 0 resolves to the calibration width rather than to the
    // measured column, so this is the number every Medium install estimates at.
    expect(LAYOUT_EPOCH_CALIBRATION_WIDTH_PX).toBe(980)
    expect(transcriptLayoutColumnWidthPx(DEFAULT_TRANSCRIPT_LAYOUT_EPOCH)).toBe(980)
    expect(transcriptLayoutLaneTracks(DEFAULT_TRANSCRIPT_LAYOUT_EPOCH)).toBe(2)
    // floor((980 + 12) / (360 + 12)) = floor(2.666…) = 2
    expect(fanoutLaneTracksForColumnPx(980)).toBe(2)

    // REAL MEDIUM COLUMNS, each through the bucket the ResizeObserver would
    // commit for it — the path a Narrow or Wide transcript takes, evaluated at
    // Medium's widths so the gate is checked on both sides of the gate.
    expect(widthBucket(850)).toBe(10)
    expect(transcriptLayoutLaneTracks({ widthBucket: 10, fontScale: 1 })).toBe(2)
    expect(fanoutLaneTracksForColumnPx(850)).toBe(2)

    expect(widthBucket(760)).toBe(9)
    expect(transcriptLayoutLaneTracks({ widthBucket: 9, fontScale: 1 })).toBe(2)
    expect(fanoutLaneTracksForColumnPx(760)).toBe(2)

    // A split Multiview pane at Medium: `min(850px, calc(100% - 28px))`.
    expect(fanoutLaneTracksForColumnPx(822)).toBe(2)
    expect(fanoutLaneTracksForColumnPx(500)).toBe(1)
  })

  it('reads 1 at Narrow, which is the half-estimate bug the model inherited', () => {
    // A 640px Narrow column renders ONE track (it is below the 732px two-track
    // threshold) while the shipped model halved every lane row regardless — a
    // 2x under-estimate on every fan-out and return row at Narrow.
    expect(widthBucket(640)).toBe(8)
    expect(transcriptLayoutColumnWidthPx({ widthBucket: 8, fontScale: 1 })).toBe(720)
    expect(transcriptLayoutLaneTracks({ widthBucket: 8, fontScale: 1 })).toBe(1)
    // A phone-narrow side chat.
    expect(widthBucket(348)).toBe(4)
    expect(transcriptLayoutLaneTracks({ widthBucket: 4, fontScale: 1 })).toBe(1)
  })

  it('opens up at Wide, which is what the slice is for', () => {
    expect(widthBucket(1179)).toBe(14)
    expect(transcriptLayoutLaneTracks({ widthBucket: 14, fontScale: 1 })).toBe(3)
    expect(widthBucket(2156)).toBe(26)
    expect(transcriptLayoutLaneTracks({ widthBucket: 26, fontScale: 1 })).toBe(5)
    // 4K and 6K, the two display widths `transcriptWidthSetting.test.ts` pins.
    expect(widthBucket(3436)).toBe(42)
    expect(transcriptLayoutLaneTracks({ widthBucket: 42, fontScale: 1 })).toBe(9)
    expect(widthBucket(5488)).toBe(68)
    expect(transcriptLayoutLaneTracks({ widthBucket: 68, fontScale: 1 })).toBe(14)
  })

  it('pins the track boundaries, where dropping the gap term is visible', () => {
    // The effective column an epoch resolves to is always a multiple of 80 (or
    // 980), so it can never land ON a boundary — which is exactly why the
    // boundaries need their own table. `floor(column / (360 + gap))` agrees
    // with the real formula at every round number and disagrees here.
    expect(fanoutLaneTracksForColumnPx(731)).toBe(1)
    expect(fanoutLaneTracksForColumnPx(732)).toBe(2)
    expect(fanoutLaneTracksForColumnPx(1103)).toBe(2)
    expect(fanoutLaneTracksForColumnPx(1104)).toBe(3)
    expect(fanoutLaneTracksForColumnPx(1475)).toBe(3)
    expect(fanoutLaneTracksForColumnPx(1476)).toBe(4)
  })

  it('never returns zero, however degenerate the epoch', () => {
    // Bucket 1 is a 0-width pane mid-unmount: a 160px column, narrower than one
    // track. Zero tracks would make every lane estimate `Infinity` and the
    // bottom spacer unbounded — the class the epoch's scale clamps exist for.
    expect(transcriptLayoutColumnWidthPx({ widthBucket: 1, fontScale: 1 })).toBe(80 * 2)
    expect(transcriptLayoutLaneTracks({ widthBucket: 1, fontScale: 1 })).toBe(1)
    expect(fanoutLaneTracksForColumnPx(0)).toBe(1)
    expect(fanoutLaneTracksForColumnPx(-500)).toBe(1)
    expect(fanoutLaneTracksForColumnPx(Number.NaN)).toBe(1)
    expect(transcriptLayoutLaneTracks(null)).toBe(2)
    expect(transcriptLayoutLaneTracks(undefined)).toBe(2)
  })

  it('never under-counts the tracks CSS lays out, at any measurable column', () => {
    // THE DIRECTION ARGUMENT, executed rather than asserted in a comment. The
    // bucket resolves to its UPPER edge, so the count derived from the epoch is
    // never smaller than the count CSS derives from the real column — and the
    // estimator divides by it, so it can only ever under-estimate.
    let checked = 0
    for (let column = 120; column <= 6000; column += 1) {
      const derived = transcriptLayoutLaneTracks({
        widthBucket: widthBucket(column),
        fontScale: 1
      })
      expect(derived, `column ${column}`).toBeGreaterThanOrEqual(
        fanoutLaneTracksForColumnPx(column)
      )
      checked += 1
    }
    expect(checked).toBe(5881)
    // Positive control for the loop's matcher: the LOWER edge of the bucket
    // does under-count, so the assertion above is capable of failing.
    expect(fanoutLaneTracksForColumnPx(widthBucket(1104) * WIDTH_BUCKET_PX)).toBe(2)
    expect(fanoutLaneTracksForColumnPx(1104)).toBe(3)
  })

  it('states the two CSS numbers it re-types', () => {
    expect(FANOUT_LANE_MIN_PX).toBe(360)
    expect(FANOUT_LANE_COLUMN_GAP_PX).toBe(12)
  })
})
