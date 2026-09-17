import { describe, expect, it } from 'vitest'
import type { ChatMessage } from '../../../main/store/types'
import {
  DEFAULT_TRANSCRIPT_LAYOUT_EPOCH,
  IDENTITY_TRANSCRIPT_LAYOUT_SCALES,
  LAYOUT_EPOCH_CALIBRATION_WIDTH_PX,
  LAYOUT_EPOCH_MAX_SCALE,
  LAYOUT_EPOCH_MIN_SCALE,
  isDefaultTranscriptLayoutEpoch,
  transcriptLayoutEpochKeySuffix,
  transcriptLayoutEpochToken,
  transcriptLayoutEpochsEqual,
  transcriptLayoutScales,
  type TranscriptLayoutEpoch
} from './transcriptLayoutEpoch'
import {
  // Imported ONLY as the positive control in the clamped-ceiling test, never to
  // derive an expected value — a golden that re-derives from the constant it
  // pins is tautological.
  CONTENT_SCALE_CAP_PX as CONTENT_SCALE_CAP_PX_FOR_CONTROL,
  WIDTH_BUCKET_PX,
  estimatedHeightFor,
  geometryKey,
  getRowHeight,
  measurementKey,
  projectRow,
  projectRows,
  projectRowsAfterSharedPrefix
} from './TranscriptVirtualWindow'

const NARROW: TranscriptLayoutEpoch = { widthBucket: 4, fontScale: 1 }
const LARGE_TEXT: TranscriptLayoutEpoch = { widthBucket: 0, fontScale: 1.25 }

/**
 * The fixtures above cannot see a rounding MODE. 1.25 against the integer
 * bases (88/220/320) and the run-boundary band (44) lands on 110/275/400/55 —
 * all exact — so round, ceil, floor and no rounding at all are the same
 * number and every rounding mutation survives. 1.1 is the discriminator:
 * 220 * 1.1 = 242.00000000000003, 44 * 1.1 = 48.400000000000006,
 * 88 * 1.1 = 96.80000000000001.
 */
const AWKWARD_TEXT: TranscriptLayoutEpoch = { widthBucket: 0, fontScale: 1.1 }

function assistantAt(id: string, length: number): ChatMessage {
  return { id, role: 'assistant', content: 'x'.repeat(length) } as ChatMessage
}

describe('transcriptLayoutScales', () => {
  it('is exactly identity for the default epoch', () => {
    // Identity is what makes the seam behaviour-preserving: `x * 1` is exact in
    // IEEE-754 and Math.round(n) === n for the integer bases, so every estimate
    // stays byte-identical while nothing produces a non-default epoch.
    expect(transcriptLayoutScales(DEFAULT_TRANSCRIPT_LAYOUT_EPOCH)).toEqual({
      content: 1,
      chrome: 1
    })
    expect(transcriptLayoutScales(DEFAULT_TRANSCRIPT_LAYOUT_EPOCH)).toBe(
      IDENTITY_TRANSCRIPT_LAYOUT_SCALES
    )
  })

  it('treats a missing, degenerate or unmeasured epoch as identity', () => {
    for (const epoch of [
      null,
      undefined,
      { widthBucket: 0, fontScale: 1 },
      { widthBucket: -3, fontScale: 1 },
      { widthBucket: Number.NaN, fontScale: Number.NaN },
      { widthBucket: 0, fontScale: 0 }
    ] as Array<TranscriptLayoutEpoch | null | undefined>) {
      expect(transcriptLayoutScales(epoch)).toEqual({ content: 1, chrome: 1 })
    }
  })

  it('scales the content rate QUADRATICALLY in text size and INVERSELY in width', () => {
    // The rate is (line box) / (chars per line): the box scales with the text
    // size, the chars per line scale with width / glyph advance, and the advance
    // also scales with the text size. Hence fontScale^2 / columnWidth.
    expect(transcriptLayoutScales(LARGE_TEXT).content).toBe(1.5625)
    // A bucket resolves to its UPPER edge — the widest column it can hold —
    // because that yields the SMALLEST rate, i.e. the under-estimate direction
    // the virtualiser calls safe.
    expect(transcriptLayoutScales(NARROW).content).toBe(
      LAYOUT_EPOCH_CALIBRATION_WIDTH_PX / ((4 + 1) * WIDTH_BUCKET_PX)
    )
  })

  it('scales chrome by the text size ALONE, never by the column width', () => {
    // Per-type resting heights and the RunCard band are furniture: they grow
    // with the text but do not shrink when the column narrows.
    expect(transcriptLayoutScales(LARGE_TEXT).chrome).toBe(1.25)
    expect(transcriptLayoutScales(NARROW).chrome).toBe(1)
  })

  it('clamps a pathological epoch rather than letting it balloon the spacer', () => {
    expect(transcriptLayoutScales({ widthBucket: 1, fontScale: 8 }).content).toBe(
      LAYOUT_EPOCH_MAX_SCALE
    )
    expect(transcriptLayoutScales({ widthBucket: 400, fontScale: 1 }).content).toBe(
      LAYOUT_EPOCH_MIN_SCALE
    )
    expect(transcriptLayoutScales({ widthBucket: 0, fontScale: 9 }).chrome).toBe(
      LAYOUT_EPOCH_MAX_SCALE
    )
  })

  it('uses the virtualiser`s own width bucket size by default', () => {
    // Guards against the default drifting away from WIDTH_BUCKET_PX, which the
    // epoch module cannot import without a cycle.
    expect(transcriptLayoutScales(NARROW)).toEqual(transcriptLayoutScales(NARROW, WIDTH_BUCKET_PX))
    expect(WIDTH_BUCKET_PX).toBe(80)
  })
})

describe('transcriptLayoutEpoch identity helpers', () => {
  it('compares BY VALUE so a re-created object is not treated as a new epoch', () => {
    // The projection cache compares with this. An identity check would silently
    // discard the whole prefix on every render for a caller that rebuilds its
    // epoch object — and, worse, a value-equal-but-new object must NOT be
    // treated as a change.
    expect(transcriptLayoutEpochsEqual({ widthBucket: 4, fontScale: 1 }, { ...NARROW })).toBe(true)
    expect(transcriptLayoutEpochsEqual(NARROW, LARGE_TEXT)).toBe(false)
    expect(transcriptLayoutEpochsEqual(NARROW, null)).toBe(false)
    expect(transcriptLayoutEpochsEqual(null, null)).toBe(true)
  })

  it('normalises degenerate inputs to the default epoch', () => {
    expect(isDefaultTranscriptLayoutEpoch({ widthBucket: -1, fontScale: 0 })).toBe(true)
    expect(isDefaultTranscriptLayoutEpoch(NARROW)).toBe(false)
    expect(isDefaultTranscriptLayoutEpoch(LARGE_TEXT)).toBe(false)
  })

  it('tokenises losslessly', () => {
    expect(transcriptLayoutEpochToken(DEFAULT_TRANSCRIPT_LAYOUT_EPOCH)).toBe('w0f1')
    expect(transcriptLayoutEpochToken(NARROW)).toBe('w4f1')
    expect(transcriptLayoutEpochToken(LARGE_TEXT)).toBe('w0f1.25')
    expect(transcriptLayoutEpochToken(NARROW)).not.toBe(transcriptLayoutEpochToken(LARGE_TEXT))
  })
})

describe('the epoch reaches the estimate', () => {
  it('leaves every estimate untouched at the default epoch', () => {
    for (const rowType of ['assistant', 'user', 'tool', 'fanoutResult', 'delegation'] as const) {
      for (const length of [0, 524, 525, 2000, 100000]) {
        expect(estimatedHeightFor(rowType, true, length, false, DEFAULT_TRANSCRIPT_LAYOUT_EPOCH)) //
          .toBe(estimatedHeightFor(rowType, true, length))
      }
    }
  })

  it('grows a text row`s content estimate as the column narrows', () => {
    expect(estimatedHeightFor('assistant', false, 2000)).toBe(840)
    expect(estimatedHeightFor('assistant', false, 2000, false, NARROW)).toBe(2058)
  })

  it('raises the generic content ceiling with the content scale', () => {
    // CONTENT_SCALE_CAP_PX is a sanity ceiling on the SCALED height, so it has
    // to move with the rate. Left unscaled it would start truncating at 1400px
    // — at a narrow column that is reached at ~1360 chars instead of ~3333, and
    // past it the estimate is a constant against a real height that keeps
    // growing: the flat-estimate regime the 1.0.7 content scale was introduced
    // to escape.
    expect(estimatedHeightFor('assistant', false, 10000)).toBe(1400)
    expect(estimatedHeightFor('assistant', false, 10000, false, NARROW)).toBe(3430)
  })

  it('grows the flat chrome estimate with the text size', () => {
    expect(estimatedHeightFor('assistant', false, 0)).toBe(220)
    expect(estimatedHeightFor('assistant', false, 0, false, LARGE_TEXT)).toBe(275)
  })

  it('grows the run-boundary band with the text size', () => {
    // RunCard chrome, added unconditionally to boundary rows. Unscaled it is a
    // fixed shortfall on every run boundary in the thread.
    const band =
      estimatedHeightFor('assistant', true, 0, false, LARGE_TEXT) -
      estimatedHeightFor('assistant', false, 0, false, LARGE_TEXT)
    expect(band).toBe(55)
    expect(estimatedHeightFor('assistant', true, 0) - estimatedHeightFor('assistant', false, 0)) //
      .toBe(44)
  })

  it('grows the content estimate quadratically with the text size', () => {
    expect(estimatedHeightFor('assistant', false, 2000, false, LARGE_TEXT)).toBe(1313)
  })

  it('never lets CONTENT inflate a viewport-clamped row, on either axis', () => {
    // fanoutResult / return / threadMessage render their whole body behind a
    // CSS px max-height. A px clamp does not grow with the text size or shrink
    // with the column, so scaling their ceiling by the CONTENT rate would be
    // the phantom bottom-spacer / auto-follow lurch
    // VIEWPORT_CLAMPED_ESTIMATE_CAP_PX exists to prevent — the OVER-estimate
    // direction the module calls dangerous.
    //
    // Sampled at the SATURATED length, which is the half this test can speak
    // to. It deliberately no longer asserts a flat 360 on every axis: the
    // ceiling is floored at the row's own scaled furniture, because a bare 360
    // inverts once the scaled base passes it (fanoutResult at fontScale 1.125)
    // and pins the estimate BELOW the header. The short-length half of that is
    // pinned by 'a viewport-clamped row never estimates below its own
    // furniture' below.
    const FURNITURE = { fanoutResult: 320, return: 280, threadMessage: 300 } as const
    for (const rowType of ['fanoutResult', 'return', 'threadMessage'] as const) {
      // A narrower column scales CONTENT only, so the ceiling must not move.
      expect(estimatedHeightFor(rowType, false, 100000, false, NARROW)).toBe(360)
      expect(estimatedHeightFor(rowType, false, 100000, false, NARROW)).toBe(
        estimatedHeightFor(rowType, false, 100000)
      )
      // A larger text scale raises it to the FURNITURE and no further — never
      // toward the content scale, which at 1.25 would be 1.5625x.
      for (const fontScale of [1.25, 2]) {
        const epoch = { widthBucket: 0, fontScale }
        const expected = Math.max(360, Math.round(FURNITURE[rowType] * fontScale))
        expect(estimatedHeightFor(rowType, false, 100000, false, epoch), rowType).toBe(expected)
        // Positive control: the content scale really is larger, so "no further"
        // is a claim about a reachable alternative rather than a tautology.
        expect(
          Math.round(CONTENT_SCALE_CAP_PX_FOR_CONTROL * fontScale * fontScale)
        ).toBeGreaterThan(expected)
      }
    }
  })
})

describe('the epoch reaches BOTH projection paths', () => {
  const messages = [assistantAt('a', 2000), assistantAt('b', 2000), assistantAt('c', 2000)]

  it('threads through projectRow', () => {
    const row = projectRow(messages[0], 0, null, false, false, 0, NARROW)
    expect(row?.estimatedHeight).toBe(2058)
    expect(projectRow(messages[0], 0, null, false, false, 0)?.estimatedHeight).toBe(840)
  })

  it('threads through projectRows (the full walk)', () => {
    const scaled = projectRows(messages, null, false, false, NARROW)
    expect(scaled.map((row) => row.estimatedHeight)).toEqual([2058, 2058, 2058])
    expect(projectRows(messages, null, false, false).map((row) => row.estimatedHeight)).toEqual([
      840, 840, 840
    ])
  })

  it('threads through projectRowsAfterSharedPrefix (the streaming walk)', () => {
    // The prefix function is a SECOND, independent call path into projectRow.
    // Adding an estimate input to only one of the two splits the height model
    // between full re-projections and streaming re-projections.
    const cached = projectRows(messages.slice(0, 2), null, false, false, NARROW)
    const rows = projectRowsAfterSharedPrefix(cached, messages, 2, null, false, false, NARROW)
    expect(rows).toHaveLength(3)
    expect(rows[2].estimatedHeight).toBe(2058)
  })

  it('cannot re-estimate the REUSED prefix, which is why the caller must discard', () => {
    // This is the whole reason the cacheRef needs an epoch field. The prefix
    // rows come back BY REFERENCE at their old estimate no matter what epoch is
    // passed, and the tail loop runs zero times when nothing was appended — so
    // a caller that reuses a prefix across an epoch change keeps the entire
    // transcript sized for the layout the user just left, permanently.
    const cached = projectRows(messages, null, false, false, DEFAULT_TRANSCRIPT_LAYOUT_EPOCH)
    const rows = projectRowsAfterSharedPrefix(cached, messages, 3, null, false, false, NARROW)
    expect(rows.map((row) => row.estimatedHeight)).toEqual([840, 840, 840])
  })
})

describe('the epoch reaches the height caches', () => {
  it('adds NOTHING to either key at the default epoch', () => {
    expect(measurementKey('r#0', 'v1', 7, false, DEFAULT_TRANSCRIPT_LAYOUT_EPOCH)).toBe(
      'r#0|v1|7|0'
    )
    expect(geometryKey('r#0', 7, false, DEFAULT_TRANSCRIPT_LAYOUT_EPOCH)).toBe('r#0|7|0')
    expect(transcriptLayoutEpochKeySuffix(DEFAULT_TRANSCRIPT_LAYOUT_EPOCH)).toBe('')
  })

  it('distinguishes MEASUREMENTS taken at different text sizes', () => {
    // The width bucket cannot stand in for this. It is read off
    // `.transcript-inner`, whose max-width is an absolute 850px, so no text-size
    // change can move it — every cached height would otherwise be reused at the
    // wrong size.
    expect(measurementKey('r#0', 'v1', 7, false, LARGE_TEXT)).toBe('r#0|v1|7|0|w0f1.25')
    expect(measurementKey('r#0', 'v1', 7, false, LARGE_TEXT)).not.toBe(
      measurementKey('r#0', 'v1', 7, false)
    )
  })

  it('distinguishes the GEOMETRY fallback taken at different text sizes', () => {
    // The worse of the two to serve stale: geometryKey has no content version,
    // so without the epoch it keeps returning the old-size height even for rows
    // whose content has since changed.
    expect(geometryKey('r#0', 7, false, LARGE_TEXT)).toBe('r#0|7|0|w0f1.25')
    expect(geometryKey('r#0', 7, false, LARGE_TEXT)).not.toBe(geometryKey('r#0', 7, false))
  })

  it('DOES carry the width bucket, because the key argument is a different number', () => {
    // This test previously asserted the opposite, on the rationale that
    // `bucket` IS `epoch.widthBucket` so repeating it would only lengthen the
    // key. That was false in the very code it shipped with: `bucket` is a
    // MEASURED widthBucket(clientWidth) sampled in a scroll handler (~10 for
    // the 850px column) while the epoch is minted in render (0). Nothing makes
    // them agree, so a key holding only the measured one cannot tell two
    // estimates apart — see 'the cache key suffix carries BOTH axes'.
    expect(measurementKey('r#0', 'v1', 4, false, NARROW)).not.toBe(
      measurementKey('r#0', 'v1', 4, false)
    )
    expect(geometryKey('r#0', 4, false, NARROW)).not.toBe(geometryKey('r#0', 4, false))
    // The default epoch is still byte-identical, which is the property that
    // actually had to be preserved.
    expect(measurementKey('r#0', 'v1', 4, false, DEFAULT_TRANSCRIPT_LAYOUT_EPOCH)).toBe(
      measurementKey('r#0', 'v1', 4, false)
    )
    expect(geometryKey('r#0', 4, false, DEFAULT_TRANSCRIPT_LAYOUT_EPOCH)).toBe(
      geometryKey('r#0', 4, false)
    )
  })

  it('falls getRowHeight through to the estimate when the text size changed', () => {
    const row = projectRow(assistantAt('a', 2000), 0, null, false, false, 0, LARGE_TEXT)
    if (!row) throw new Error('projectRow returned null')
    const measurements = new Map<string, number>()
    const geometryHeights = new Map<string, number>()
    measurements.set(measurementKey(row.rowKey, row.contentVersion, 7, false), 999)
    geometryHeights.set(geometryKey(row.rowKey, 7, false), 888)
    // Same bucket, same content, same expansion — only the text size differs.
    expect(
      getRowHeight(row, measurements, 7, false, row.contentVersion, geometryHeights, LARGE_TEXT)
    ).toBe(row.estimatedHeight)
    expect(
      getRowHeight(
        row,
        measurements,
        7,
        false,
        row.contentVersion,
        geometryHeights,
        DEFAULT_TRANSCRIPT_LAYOUT_EPOCH
      )
    ).toBe(999)
  })
})

describe('the estimator arithmetic is pinned to a rounding MODE', () => {
  it('rounds the scaled chrome base half-up, not ceil / floor / not at all', () => {
    // 220 * 1.1 = 242.00000000000003 -> round 242, ceil 243, raw 242.00000000000003.
    // An integer result is also what keeps every height a whole pixel.
    const assistant = estimatedHeightFor('assistant', false, 0, false, AWKWARD_TEXT)
    expect(assistant).toBe(242)
    expect(Number.isInteger(assistant)).toBe(true)
    // 88 * 1.1 = 96.80000000000001 -> round 97, floor 96. Distinguishes floor
    // from round, which the assistant case alone cannot.
    expect(estimatedHeightFor('user', false, 0, false, AWKWARD_TEXT)).toBe(97)
  })

  it('rounds the scaled run-boundary band the same way', () => {
    // 44 * 1.1 = 48.400000000000006 -> round 48, ceil 49. The band is added
    // AFTER the row, so a separate rounding site with its own mutation surface.
    const withBand = estimatedHeightFor('assistant', true, 0, false, AWKWARD_TEXT)
    const withoutBand = estimatedHeightFor('assistant', false, 0, false, AWKWARD_TEXT)
    expect(withBand - withoutBand).toBe(48)
  })
})

describe('a viewport-clamped row never estimates below its own furniture', () => {
  it('floors the clamped ceiling at the scaled base instead of inverting', () => {
    // `Math.min(360, Math.max(base, content))` inverts once the scaled base
    // passes the fixed 360: fanoutResult at fontScale 1.125 (320 * 1.125 = 360),
    // threadMessage at 1.2, return at ~1.286. Past that the row returns exactly
    // 360 at EVERY content length — chrome scaling silently dead, and the
    // estimate pinned below the header it is meant to cover. Sampled at SHORT
    // lengths on purpose: the saturated length is 360 either way, which is why
    // a cap-only test gives false confidence.
    const big: TranscriptLayoutEpoch = { widthBucket: 0, fontScale: 2 }
    for (const [rowType, base] of [
      ['fanoutResult', 320],
      ['threadMessage', 300],
      ['return', 280]
    ] as const) {
      const empty = estimatedHeightFor(rowType, false, 0, false, big)
      expect(empty, `${rowType} must not fall below its scaled furniture`).toBe(base * 2)
      // And it is not merely bigger — it still tracks the scale rather than
      // sitting on a constant, which is what "dead" looked like.
      const atIdentity = estimatedHeightFor(
        rowType,
        false,
        0,
        false,
        DEFAULT_TRANSCRIPT_LAYOUT_EPOCH
      )
      expect(atIdentity, `${rowType} identity must be unchanged`).toBe(base)
    }
  })

  it('still refuses to let CONTENT inflate a clamped row past its ceiling', () => {
    // The other half, unchanged: the clamped body is a CSS px max-height, so a
    // huge message must not scale it. At identity the ceiling is the bare 360.
    for (const rowType of ['fanoutResult', 'threadMessage', 'return'] as const) {
      expect(
        estimatedHeightFor(rowType, false, 100000, false, DEFAULT_TRANSCRIPT_LAYOUT_EPOCH)
      ).toBe(360)
      // At a large text scale the ceiling rises only to the furniture, never to
      // the content scale (which at fontScale 2 would be 4x).
      const big: TranscriptLayoutEpoch = { widthBucket: 0, fontScale: 2 }
      const base = { fanoutResult: 320, threadMessage: 300, return: 280 }[rowType]
      expect(estimatedHeightFor(rowType, false, 100000, false, big)).toBe(base * 2)
    }
  })
})

describe('the width bucket is normalised by FLOOR', () => {
  it('floors a fractional bucket rather than ceiling or truncating toward zero', () => {
    // `widthBucket()` returns integers today, so every existing fixture agrees
    // under floor, ceil and trunc. The module accepts an arbitrary number and
    // its doc sells the floor as meaningful, so it needs one fractional case.
    // Flooring is the conservative direction: a lower bucket means a narrower
    // assumed column, hence a LARGER content rate.
    const fractional: TranscriptLayoutEpoch = { widthBucket: 4.9, fontScale: 1 }
    const floored: TranscriptLayoutEpoch = { widthBucket: 4, fontScale: 1 }
    expect(transcriptLayoutScales(fractional)).toEqual(transcriptLayoutScales(floored))
    // Positive control: bucket 5 really is a different scale, so the assertion
    // above is not passing because every bucket resolves the same way.
    const ceiled: TranscriptLayoutEpoch = { widthBucket: 5, fontScale: 1 }
    expect(transcriptLayoutScales(fractional)).not.toEqual(transcriptLayoutScales(ceiled))
    // And the key/token encodings floor it too, or two epochs that scale
    // identically would occupy different cache slots.
    expect(transcriptLayoutEpochKeySuffix(fractional)).toBe(transcriptLayoutEpochKeySuffix(floored))
    expect(transcriptLayoutEpochToken(fractional)).toBe(transcriptLayoutEpochToken(floored))
    expect(transcriptLayoutEpochsEqual(fractional, floored)).toBe(true)
    expect(transcriptLayoutEpochsEqual(fractional, ceiled)).toBe(false)
  })
})

describe('the cache key suffix carries BOTH axes', () => {
  it('separates epochs that differ only in width bucket', () => {
    // The suffix originally carried only fontScale, on the rationale that
    // `measurementKey`'s own `bucket` argument already covered width and "is
    // the same number as epoch.widthBucket". It is not: that argument is a
    // MEASURED widthBucket(clientWidth) sampled in a scroll handler, while the
    // epoch is minted in render, and nothing makes them agree. With the axis
    // missing, a width change moved the estimate while the key stayed put and
    // the row read back a height measured at the other layout.
    const wide: TranscriptLayoutEpoch = { widthBucket: 10, fontScale: 1 }
    const narrow: TranscriptLayoutEpoch = { widthBucket: 6, fontScale: 1 }
    expect(transcriptLayoutEpochKeySuffix(wide)).not.toBe(transcriptLayoutEpochKeySuffix(narrow))
    // Held at ONE bucket argument, exactly as the panel does it — this is the
    // scenario the missing axis made indistinguishable.
    expect(measurementKey('r#0', 'v1', 10, false, wide)).not.toBe(
      measurementKey('r#0', 'v1', 10, false, narrow)
    )
    expect(geometryKey('r#0', 10, false, wide)).not.toBe(geometryKey('r#0', 10, false, narrow))
    // The estimate really does differ between them, so the keys are not being
    // separated for nothing.
    expect(estimatedHeightFor('assistant', false, 2000, false, wide)).not.toBe(
      estimatedHeightFor('assistant', false, 2000, false, narrow)
    )
  })

  it('is still EMPTY at the default epoch, so pre-seam keys are byte-identical', () => {
    expect(transcriptLayoutEpochKeySuffix(DEFAULT_TRANSCRIPT_LAYOUT_EPOCH)).toBe('')
    expect(measurementKey('r#0', 'v1', 10, false, DEFAULT_TRANSCRIPT_LAYOUT_EPOCH)).toBe(
      'r#0|v1|10|0'
    )
    expect(geometryKey('r#0', 10, false, DEFAULT_TRANSCRIPT_LAYOUT_EPOCH)).toBe('r#0|10|0')
  })
})
