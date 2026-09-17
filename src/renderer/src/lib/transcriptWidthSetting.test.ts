import { readdirSync, readFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  ESTIMATED_ROW_HEIGHT_PX,
  estimatedHeightFor,
  widthBucket,
  WIDTH_BUCKET_PX,
  type VirtualRowType
} from './TranscriptVirtualWindow'
import {
  FANOUT_LANE_COLUMN_GAP_PX,
  FANOUT_LANE_MIN_PX,
  LAYOUT_EPOCH_CALIBRATION_WIDTH_PX,
  LAYOUT_EPOCH_MIN_SCALE,
  fanoutLaneTracksForColumnPx,
  transcriptLayoutEpochKeySuffix,
  transcriptLayoutScales,
  type TranscriptLayoutEpoch
} from './transcriptLayoutEpoch'
import {
  DEFAULT_TRANSCRIPT_WIDTH,
  TRANSCRIPT_WIDTH_ATTRIBUTE,
  TRANSCRIPT_WIDTH_COLUMN_CAPS,
  resolveTranscriptWidth,
  transcriptWidthAttribute,
  transcriptWidthLayoutBucket,
  type TranscriptWidth
} from './transcriptWidth'
import { TRANSCRIPT_WIDTH_OPTIONS } from '../components/settings/settingsUiOptions'

/**
 * Settings → Appearance → "Transcript width".
 *
 * THREE jobs, and the first is why this file exists at all.
 *
 * 1. THE SINGLE SOURCE. The transcript needs one number for the column it is
 *    rendering at: the estimator calibrates every row height against it, and
 *    `measurementKey` / `geometryKey` record which layout a measured height was
 *    taken under. Before this slice there were TWO — a measured
 *    `widthBucket(el.clientWidth)` sampled in a scroll handler into a ref (~10)
 *    and a hardcoded `widthBucket` on the layout epoch (0) — behind a comment
 *    asserting they were the same number. Making a width a SETTING is exactly
 *    the change that turns that from a latent lie into a moving one, so the
 *    guards below do not check that two numbers agree. They check that only one
 *    exists: exactly ONE `widthBucket(` call in the panel, committed to state,
 *    read by the epoch mint, and read back off the epoch by both cache keys.
 *
 * 2. THE CSS COMPOSITION. `--composer-content-max-width` is declared on
 *    `.app-transcript`, which CONTAINS the composer, the workspace terminal and
 *    its drag divider, the provider tucked rows, the approval overlay and the
 *    welcome surfaces. Retuning it to serve a transcript setting moves all of
 *    them, and feeds back into the transcript's own bottom padding through
 *    `--composer-reserved-height`. So the token is READ and never written, and
 *    the column is capped by ONE declaration with three fallback terms. The
 *    failure mode is a SECOND `max-width` on `.transcript-inner` from a more
 *    specific rule — three of the four scopes shipped exactly that shape — so
 *    every CSS assertion here counts declarations rather than containing them.
 *
 * 3. THE CHAIN. Almost every registry a new appearance key joins fails OPEN.
 *    That half mirrors `transcriptTextSizeSetting.test.ts` stop for stop.
 *
 * No jsdom (these suites are `renderToStaticMarkup`), and that bites harder here
 * than for text size: with no ResizeObserver the width axis NEVER leaves 0 in
 * any renderer test, so nothing about this data flow is reachable by behaviour.
 * Every property of it is pinned by source string — comments stripped, value
 * expressions matched exactly, each negative carrying a positive control that
 * proves the matcher can fire.
 */
const RENDERER_SRC = join(__dirname, '..')
const MAIN_SRC = join(__dirname, '../../../main')

function renderer(relative: string): string {
  return readFileSync(join(RENDERER_SRC, relative), 'utf8')
}

function main(relative: string): string {
  return readFileSync(join(MAIN_SRC, relative), 'utf8')
}

/** Executable source only. A negative about what code DOES must not be
 * satisfiable — or defeated — by what its comments SAY. Both of this slice's
 * load-bearing negatives ("no second width sample", "no second max-width") are
 * spelled out verbatim in the comments that explain them.
 *
 * It is not only negatives. A POSITIVE `toContain` over raw source passes with
 * the line it names commented out, which for a JSX attribute, an `onChange`
 * handler or an `appearance.update(...)` call is not a compile error: the
 * control still renders, still binds, and does nothing. Everything in this file
 * that claims code EXISTS reads the stripped text too, and the raw text is used
 * for one thing only — locating an anchor whose position in the file is the
 * claim (ordering, "the last declaration before X"). */
function withoutComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')
}

/**
 * The VALUE EXPRESSION that follows `anchor`, up to the first terminator, with
 * whitespace collapsed — for asserting equality instead of containment.
 *
 * Every guard in this file that pins "this number is passed through untouched"
 * needs this. `toContain('const bucket = measuredWidthBucket')` is satisfied
 * by `const bucket = layoutEpoch.widthBucket + 1`, because the bare identifier
 * is a strict PREFIX of every arithmetic form of itself — and `+ 1` on either
 * epoch read site ran GREEN through the whole renderer suite, 883 files and
 * 9,319 tests, while the estimator was calibrated for a column 80px wider than
 * the one the cache keys recorded.
 */
function valueExpressionAfter(source: string, anchor: string, terminators = ['\n']): string {
  const at = source.indexOf(anchor)
  expect(at, `anchor not found: ${anchor}`).toBeGreaterThan(-1)
  expect(source.indexOf(anchor, at + 1), `anchor is not unique in this slice: ${anchor}`).toBe(-1)
  const rest = source.slice(at + anchor.length)
  const end = Math.min(
    ...terminators.map((token) => {
      const index = rest.indexOf(token)
      return index === -1 ? rest.length : index
    })
  )
  return rest.slice(0, end).replace(/\s+/g, ' ').trim()
}

/**
 * The balanced argument list of the first `name(` call, plus the two characters
 * that follow its closing paren.
 *
 * "Called with exactly these arguments" and "and nothing done to the result"
 * are separate claims, and only the second one refuses `f(a, b) + 1` — the
 * mutation that survives every containment check ever written about a call.
 */
function balancedCall(source: string, name: string): { args: string; tail: string } {
  const open = source.indexOf(`${name}(`)
  expect(open, `no call to ${name}`).toBeGreaterThan(-1)
  let depth = 0
  for (let index = open + name.length; index < source.length; index += 1) {
    if (source[index] === '(') depth += 1
    else if (source[index] === ')') {
      depth -= 1
      if (depth === 0) {
        return {
          args: source
            .slice(open + name.length + 1, index)
            .replace(/\s+/g, ' ')
            .trim(),
          tail: source.slice(index + 1, index + 3).trim()
        }
      }
    }
  }
  throw new Error(`unbalanced call: ${name}`)
}

type CssRule = { file: string; selector: string; body: string }

function rulesOf(file: string, css: string): CssRule[] {
  return [...css.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/([^{}]+)\{([^{}]*)\}/g)].map(
    (match) => ({
      file,
      selector: match[1].replace(/\s+/g, ' ').trim(),
      body: match[2].replace(/\s+/g, ' ').trim()
    })
  )
}

/**
 * EVERY stylesheet the renderer ships, found by walking the tree — not the
 * shard directory plus a hand-listed token sheet.
 *
 * The hand-listed set read `assets/css/*.css` and `styles/theme.css` and stopped
 * there, which left out the ~24 `components/*.css` sheets. Those are not inert:
 * each is `import`ed by its own component, so the bundler emits them AFTER
 * `assets/main.css`, and at equal specificity a later rule WINS. Appending
 * `.transcript-inner { max-width: 500px }` to a sheet outside the scanned set
 * silently defeated "exactly one max-width for this element anywhere in the
 * sheets" — the guard the whole width control rests on, because a second
 * `max-width` from any rule is how this setting ships doing nothing.
 *
 * Walking is the repair rather than a longer list: the next sheet somebody adds
 * is covered without anyone remembering this file exists. The roster test below
 * is the non-vacuity check — a walk that found nothing would satisfy every
 * negative in here.
 */
function cssFiles(): string[] {
  const found: string[] = []
  const walk = (dir: string): void => {
    const entries = readdirSync(dir, { withFileTypes: true })
    entries.sort((a, b) => a.name.localeCompare(b.name))
    for (const entry of entries) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) walk(full)
      else if (entry.name.endsWith('.css')) found.push(full)
    }
  }
  walk(RENDERER_SRC)
  return found
}

/** Every renderer stylesheet — the shards, the token sheet, and every
 * component-local sheet that loads after them. Labelled by BASENAME, which is
 * unique across the tree and is what every expectation in this file spells. */
function allCssRules(): CssRule[] {
  const rules: CssRule[] = []
  for (const path of cssFiles()) {
    rules.push(...rulesOf(basename(path), readFileSync(path, 'utf8')))
  }
  return rules
}

/** Whitespace-immune declaration count. CSS permits `--x : 1` and a multi-line
 * `min(\n 100%,\n …)`, so a literal-substring count is defeated by formatting
 * alone — and the base column rule IS multi-line. */
function declares(body: string, property: string): number {
  const escaped = property.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return [...body.matchAll(new RegExp(`(^|[;{])\\s*${escaped}\\s*:`, 'g'))].length
}

const PANEL = renderer('components/TranscriptPanel.tsx')
const PANEL_CODE = withoutComments(PANEL)

/**
 * The width ResizeObserver effect, comment-stripped — from the state that holds
 * the measurement to the local the mint is gated on.
 *
 * Scoping matters for more than tidiness: `const next =` is not a unique string
 * in a 7,900-line file, and an exactness guard that silently matched a
 * DIFFERENT `const next` would be worse than the containment check it replaced.
 * Both ends are anchors this file asserts exist in their own right.
 */
function widthObserverEffect(): string {
  const start = PANEL_CODE.indexOf('const [transcriptMeasuredWidthBucket')
  expect(start, 'the measured-bucket state must exist').toBeGreaterThan(-1)
  const end = PANEL_CODE.indexOf('const transcriptWidthAttributeValue', start)
  expect(end, 'the width gate must follow the observer').toBeGreaterThan(start)
  return PANEL_CODE.slice(start, end)
}

describe('one width name, no width number', () => {
  it('resolves absence and junk to the column everything already renders', () => {
    expect(resolveTranscriptWidth(undefined)).toBe(DEFAULT_TRANSCRIPT_WIDTH)
    expect(resolveTranscriptWidth(null)).toBe(DEFAULT_TRANSCRIPT_WIDTH)
    expect(resolveTranscriptWidth('huge')).toBe(DEFAULT_TRANSCRIPT_WIDTH)
    expect(resolveTranscriptWidth(640)).toBe(DEFAULT_TRANSCRIPT_WIDTH)
    expect(resolveTranscriptWidth('narrow')).toBe('narrow')
    expect(resolveTranscriptWidth('wide')).toBe('wide')
    expect(DEFAULT_TRANSCRIPT_WIDTH).toBe('medium')
  })

  it('stamps nothing at Medium, and the chosen name otherwise', () => {
    // `undefined` is what keeps the markup byte-identical: React writes no
    // attribute at all, so no `[data-transcript-width]` rule can match and the
    // single `max-width` falls through to the pane ceiling it always used.
    expect(transcriptWidthAttribute('medium')).toBeUndefined()
    expect(transcriptWidthAttribute(undefined)).toBeUndefined()
    expect(transcriptWidthAttribute('narrow')).toBe('narrow')
    expect(transcriptWidthAttribute('wide')).toBe('wide')
  })

  it('keeps the caps as CSS STRINGS, never as numbers JS could compute with', () => {
    // The type is the guard. A `640` here is one edit away from
    // `widthBucket(640)` and an epoch minted from the SETTING — which would be
    // right in the main pane and silently wrong in the four other scopes, where
    // `narrow` is bounded by the pane instead. The measured box is the only
    // honest source, so this module must not be able to offer a rival one.
    for (const [name, cap] of Object.entries(TRANSCRIPT_WIDTH_COLUMN_CAPS)) {
      expect(typeof cap === 'string' || cap === null, name).toBe(true)
      expect(typeof cap, name).not.toBe('number')
    }
    // Medium is `null`, not '850px': it emits no rule, and restating the
    // composer's token here is how the two drift apart unnoticed.
    expect(TRANSCRIPT_WIDTH_COLUMN_CAPS.medium).toBeNull()
    expect(TRANSCRIPT_WIDTH_COLUMN_CAPS.narrow).toBe('640px')
    expect(TRANSCRIPT_WIDTH_COLUMN_CAPS.wide).toBe('100%')
  })

  it('offers exactly the three widths, each naming its own cap', () => {
    expect(TRANSCRIPT_WIDTH_OPTIONS.map((option) => option.value)).toEqual([
      'narrow',
      'medium',
      'wide'
    ])
    for (const option of TRANSCRIPT_WIDTH_OPTIONS) {
      expect(option.cap, option.value).toBe(TRANSCRIPT_WIDTH_COLUMN_CAPS[option.value])
      expect(option.helper.length).toBeGreaterThan(0)
    }
  })
})

describe('the estimate and the cache keys read ONE width', () => {
  it('quantises the column in exactly one place in the transcript', () => {
    // THE structural guard, and the only one that makes the rest of this
    // describe() mean anything. Two samples of the same box are two numbers as
    // soon as they are taken at different times — which is precisely how the
    // previous pair diverged to ~10 and 0 while a comment held them equal.
    expect(
      PANEL_CODE.split('widthBucket(').length - 1,
      'the transcript may quantise its column exactly once'
    ).toBe(1)
    // Positive control: the matcher fires on the real call, and the call is the
    // observer's — reading the ELEMENT, not a scroller or a setting.
    //
    // EXACT, not `toContain`. This is the single PRODUCER of the number, and
    // `const next = widthBucket(el.clientWidth)` is a strict prefix of
    // `... + 1`, `... * 0.9` and every other arithmetic form — all of which ran
    // green across six guard suites. The producer's value expression is matched
    // whole, to its line terminator.
    expect(valueExpressionAfter(widthObserverEffect(), 'const next =')).toBe(
      'widthBucket(el.clientWidth)'
    )
    // Committed to STATE. The old sample lived in a ref, which triggers no
    // render, so nothing ever re-minted the epoch from it — the entire reason
    // the two numbers could diverge without anything looking wrong.
    expect(PANEL_CODE).toContain(
      'setTranscriptMeasuredWidthBucket((current) => (current === next ? current : next))'
    )
    // And the ref that used to hold it is gone, by name.
    expect(PANEL_CODE, 'bucketRef was the second source; it must not come back').not.toContain(
      'bucketRef'
    )
  })

  it('mints the epoch from that local, untouched', () => {
    // COMMENT-STRIPPED, and that was the hole this guard's own comment claimed
    // it did not have. `PANEL` is the raw file; the mint carries a long
    // rationale block, and a `/* widthBucket: … */` inside it satisfied
    // `mint.indexOf('widthBucket:')` — so the value read back was the one in the
    // PROSE while the executable line did `* 2`. An exactness guard over raw
    // source is not an exactness guard.
    const mintAt = PANEL_CODE.indexOf(
      'const transcriptLayoutEpoch = useMemo<TranscriptLayoutEpoch>('
    )
    expect(mintAt).toBeGreaterThan(-1)
    const mint = PANEL_CODE.slice(mintAt, PANEL_CODE.indexOf('const projectedRows =', mintAt))
    // EXACT, not `toContain`. `widthBucket: transcriptLayoutWidthBucket` is a
    // strict PREFIX of every arithmetic form — `+ 1`, `* 0.9`,
    // `widthBucket(...)` — so a containment check passes while the estimate is
    // calibrated for a column the cache keys never recorded.
    expect(valueExpressionAfter(mint, 'widthBucket:', [',', '}'])).toBe(
      'transcriptLayoutWidthBucket'
    )
    // Positive control for the strip, as the mutation it exists to catch: a
    // commented `widthBucket:` is invisible to the stripped read and would have
    // been the answer to the raw one.
    expect(
      valueExpressionAfter(
        withoutComments('{ /* widthBucket: 10 */ widthBucket: real }'),
        'widthBucket:',
        [',', '}']
      )
    ).toBe('real')
  })

  it('reports bucket 0 at Medium, so Medium is byte-identical', () => {
    // THE DECISION. Waking the width axis at Medium is not free: the main pane's
    // 850px column resolves to bucket 10 and moves every content estimate by
    // +11.4%, General Chat's 760px column by +22.5%. Medium keeps today's
    // numbers — the epoch carries widthBucket 0 there, which
    // `transcriptLayoutScales` and `transcriptLayoutEpochKeySuffix` both treat as
    // "not measured", so the estimates and the cache keys are the ones the build
    // before this setting produced. The correction is spent only where the
    // column genuinely leaves the ceiling it always had.
    //
    // Behavioural, because the gate is a pure function — the panel cannot be
    // mounted here and its ResizeObserver never runs, so a source guard alone
    // would pin the spelling of a rule nothing ever executed.
    expect(transcriptWidthLayoutBucket('medium', 27)).toBe(0)
    expect(transcriptWidthLayoutBucket(undefined, 27)).toBe(0)
    expect(transcriptWidthLayoutBucket('gigantic', 27)).toBe(0)
    // …and the measurement passes through at the two widths that move the
    // column off that ceiling.
    expect(transcriptWidthLayoutBucket('narrow', 27)).toBe(27)
    expect(transcriptWidthLayoutBucket('wide', 27)).toBe(27)
    // The gate is DERIVED from the attribute, not a second `=== 'medium'`: for
    // every input, "stamps no attribute" and "applies no correction" are the
    // same answer. A second comparison is how the CSS column and the estimator
    // come apart — one of them re-pointed, the other not.
    for (const value of ['narrow', 'medium', 'wide', undefined, null, 640, 'huge']) {
      expect(transcriptWidthLayoutBucket(value, 27) === 0, String(value)).toBe(
        transcriptWidthAttribute(value) === undefined
      )
    }
    // A measured bucket is still the sentinel-free number the epoch expects: an
    // absent or degenerate measurement is 0, never a fractional or negative
    // bucket the scales would take a reciprocal of.
    expect(transcriptWidthLayoutBucket('wide', 0)).toBe(0)
    expect(transcriptWidthLayoutBucket('wide', -3)).toBe(0)
    expect(transcriptWidthLayoutBucket('wide', Number.NaN)).toBe(0)
    expect(transcriptWidthLayoutBucket('wide', 27.9)).toBe(27)
    // And bucket 0 IS identity, at both consumers — the claim "byte-identical"
    // actually rests on these two, not on the gate.
    expect(transcriptLayoutScales({ widthBucket: 0, fontScale: 1 })).toEqual({
      content: 1,
      chrome: 1
    })
    expect(transcriptLayoutEpochKeySuffix({ widthBucket: 0, fontScale: 1 })).toBe('')
  })

  it('gates the mint on the width name, through the same local the DOM is stamped from', () => {
    // The two halves, spelled once each, in the panel. `transcriptWidthAttribute`
    // is called ONCE — a second call is a second resolution, and the whole point
    // of the gate is that the attribute and the correction cannot disagree.
    expect(PANEL_CODE.split('transcriptWidthAttribute(').length - 1).toBe(1)
    expect(valueExpressionAfter(PANEL_CODE, 'const transcriptWidthAttributeValue =')).toBe(
      'transcriptWidthAttribute(transcriptWidth)'
    )
    // And the JSX stamps THAT local rather than calling the function a second
    // time, so the attribute React writes and the bucket the epoch is gated on
    // are one value.
    expect(PANEL_CODE).toContain(`${TRANSCRIPT_WIDTH_ATTRIBUTE}={transcriptWidthAttributeValue}`)
    // The gate's arguments matched WHOLE, and its result used unchanged: the
    // tail assertion is what refuses `transcriptWidthLayoutBucket(...) + 1`,
    // which a containment check on the call cannot see.
    expect(PANEL_CODE).toContain('const transcriptLayoutWidthBucket = transcriptWidthLayoutBucket(')
    const gate = balancedCall(PANEL_CODE, 'transcriptWidthLayoutBucket')
    expect(gate.args).toBe('transcriptWidth, transcriptMeasuredWidthBucket')
    expect(gate.tail, 'the gate result must reach the mint untouched').toBe('')
    // THREE roles, each pinned by name: declared, read by the gate, and handed
    // to the virtualiser for the CACHE KEYS. That third role is deliberate and
    // is not a second source — the keys need the real column at every setting,
    // including Medium, or a height measured at one column is served under
    // another. What it must NOT do is reach the MINT, because that is what the
    // gate exists to intercept: Medium would then carry a live bucket and stop
    // being byte-identical.
    expect(PANEL_CODE).toContain(
      'const [transcriptMeasuredWidthBucket, setTranscriptMeasuredWidthBucket]'
    )
    expect(gate.args).toContain('transcriptMeasuredWidthBucket')
    expect(PANEL_CODE).toContain('measuredWidthBucket: transcriptMeasuredWidthBucket,')
    expect(
      PANEL_CODE.split('transcriptMeasuredWidthBucket').length - 1,
      'declared, gated, and handed to the virtualiser — a fourth use is a path to account for'
    ).toBe(3)
    const mint = PANEL_CODE.slice(
      PANEL_CODE.indexOf('const transcriptLayoutEpoch = useMemo<TranscriptLayoutEpoch>(')
    )
    expect(
      mint.slice(0, mint.indexOf('const projectedRows =')),
      'the measured bucket must never reach the mint — the gate is the only way in'
    ).not.toContain('transcriptMeasuredWidthBucket')
  })

  it('has the virtualiser read that same value back for BOTH height maps', () => {
    // Two sites: the `heights` memo that ESTIMATES, and the pre-paint pass that
    // WRITES `measurementKey` / `geometryKey`. Both used to read the ref. If
    // either one keeps its own sample the estimate and the cache disagree about
    // which layout a row was measured at, which is the whole defect class.
    // The MEASURED bucket, not the epoch's. Two numbers, two jobs: the epoch's
    // bucket is the ESTIMATE correction and is gated to 0 at Medium so the
    // default keeps its shipped calibration; this one is cache INVALIDATION and
    // must track the real column at EVERY setting. Routing the keys through the
    // gated epoch deleted the width dimension from both key spaces at the
    // default width and made `bucketChanged` unfireable, so a Medium column
    // that tracks its box served heights measured at the previous column.
    expect(
      PANEL_CODE.split('const bucket = measuredWidthBucket\n').length - 1,
      'both the estimate and the key writer must take the MEASURED bucket'
    ).toBe(2)
    // And the gated epoch must NOT be the key's bucket, or the regression above
    // is one edit away from returning.
    expect(
      PANEL_CODE.includes(`const bucket = layoutEpoch.${'widthBucket'}`),
      'the cache key must never be built from the gated estimate bucket'
    ).toBe(false)
    // Anchored, so "twice, somewhere in a 7,700-line file" is not the claim.
    const readStart = PANEL.indexOf('const heights = useMemo(() => {')
    expect(readStart).toBeGreaterThan(-1)
    const readSite = withoutComments(
      PANEL.slice(readStart, PANEL.indexOf('heightsRef.current = heights', readStart))
    )
    const writeStart = PANEL.indexOf('// Phase 2 — measure mounted slot heights')
    expect(writeStart).toBeGreaterThan(-1)
    const writeSite = withoutComments(
      PANEL.slice(writeStart, PANEL.indexOf('const prev = measurements.get(key)', writeStart))
    )
    // EXACT VALUE EXPRESSIONS at BOTH sites, and this is the guard the previous
    // build did not have. `toContain('const bucket = measuredWidthBucket')`
    // and the bare count above are both strict-PREFIX anchored: `+ 1` on either
    // site satisfied them, and ran green through the entire renderer suite —
    // 883 files, 9,319 tests — while the estimate was calibrated for one column
    // and the cache keys recorded another. That is the exact two-numbers defect
    // this whole file exists to make unrepresentable, reintroduced under the
    // guard written to forbid it.
    for (const [label, site] of [
      ['the estimate', readSite],
      ['the key writer', writeSite]
    ] as const) {
      expect(valueExpressionAfter(site, 'const bucket ='), label).toBe('measuredWidthBucket')
    }
    // Positive control for the exactness: the matcher really does distinguish
    // the bare read from an arithmetic form of it, so the two assertions above
    // are not passing because the extractor returns the same thing for both.
    expect(
      valueExpressionAfter('const bucket = layoutEpoch.widthBucket + 1\n', 'const bucket =')
    ).toBe('layoutEpoch.widthBucket + 1')
    // Positive control for the anchors: these really are the key call sites.
    expect(writeSite).toContain('const key = measurementKey(')
    expect(writeSite).toContain('geometryKey(')
    expect(readSite).toContain('getRowHeight(')
  })

  it('does not sample a width on a programmatic scroll any more', () => {
    // `syncScrollPosition` held the SECOND write to the old ref and is the one
    // a reviewer misses: it re-sampled on every jump-to-message, so a
    // programmatic scroll could move the cache-key bucket while the estimate's
    // stayed put.
    const at = PANEL.indexOf('const syncScrollPosition = useCallback(')
    expect(at).toBeGreaterThan(-1)
    const body = withoutComments(PANEL.slice(at, PANEL.indexOf('\n  // Slot heights', at)))
    expect(body).not.toContain('widthBucket')
    // Positive control: the slice is the real function and still reads the
    // metric it is allowed to read.
    expect(body).toContain('viewportRef.current = scroller.clientHeight')
  })

  it('observes the element CSS sized, above the projection, and settles a drag', () => {
    const at = PANEL.indexOf(
      'const [transcriptMeasuredWidthBucket, setTranscriptMeasuredWidthBucket]'
    )
    expect(at).toBeGreaterThan(-1)
    // Above the projection. Below it the observer cannot feed the epoch at all,
    // which is exactly where the old sample lived.
    expect(at).toBeLessThan(PANEL.indexOf('const projectedRows ='))
    const effect = withoutComments(PANEL.slice(at, PANEL.indexOf('const projectedRows =', at)))
    // The element the stylesheets cap, not the scroller: a scrollbar
    // appear/disappear moves the scroller's clientWidth and must not be able to
    // flip the bucket and invalidate every cached height.
    expect(effect).toContain('const el = contentRef.current')
    expect(effect).toContain('observer.observe(el)')
    // Guarded, because there is no ResizeObserver in any renderer test.
    expect(effect).toContain("typeof ResizeObserver === 'undefined'")
    // Settled. At Wide the column is uncapped, so one window drag sweeps ~21
    // bucket boundaries and each committed bucket discards the projection cache
    // whole and re-walks every message.
    expect(effect).toContain('USER_SCROLL_GESTURE_WINDOW_MS')
    // …but the FIRST measurement commits on the leading edge, or a resting pane
    // waits out a timer before it is ever calibrated.
    expect(effect).toContain('if (!transcriptWidthMeasuredRef.current)')
    // Cleaned up, both timers.
    expect(effect).toContain('observer.disconnect()')
    expect(effect).toContain('cancelAnimationFrame(transcriptWidthRafRef.current)')
    expect(effect).toContain('clearTimeout(transcriptWidthSettleRef.current)')
  })

  it('starts at 0, which is identity, because no renderer test can advance it', () => {
    // Load-bearing rather than incidental: 0 is
    // `DEFAULT_TRANSCRIPT_LAYOUT_EPOCH.widthBucket`, so first paint applies no
    // width correction at all — and ~251 `renderToStaticMarkup` suites have no
    // ResizeObserver, so the axis never leaves 0 in ANY of them. Anything about
    // this data flow that is not pinned by source string is not pinned.
    expect(PANEL_CODE).toContain(
      'const [transcriptMeasuredWidthBucket, setTranscriptMeasuredWidthBucket] = useState(0)'
    )
    expect(transcriptLayoutScales({ widthBucket: 0, fontScale: 1 })).toEqual({
      content: 1,
      chrome: 1
    })
  })

  it('refuses a boxless measurement instead of quantising it to the sentinel', () => {
    // A REAL DEFECT, not a hypothetical. `.transcript-inner` keeps its whole
    // subtree mounted while it loses its layout box: the Settings takeover
    // (`.app-transcript.transcript-hidden-for-settings { display: none }`),
    // welcome mode, and a suspended Multiview pane. The observer fires on that
    // transition with a 0x0 box and `isConnected` still true, so the existing
    // guard passes it through — and `widthBucket(0)` is 0, which is not "a very
    // narrow column" but the sentinel for NEVER MEASURED. The epoch flips to
    // identity, `transcriptLayoutEpochsEqual` reports a change, and the whole
    // projection cache plus BOTH height-cache key spaces are discarded. On
    // opening Settings. At ~10,000 accumulated turns.
    const at = PANEL_CODE.indexOf('const [transcriptMeasuredWidthBucket')
    expect(at).toBeGreaterThan(-1)
    const effect = PANEL_CODE.slice(at, PANEL_CODE.indexOf('const transcriptWidthAttributeValue'))
    // The predicate exists, requires a POSITIVE width, and is not satisfied by
    // `isConnected` alone.
    expect(effect).toContain(
      'const hasLayoutBox = (): boolean => el.isConnected && el.clientWidth > 0'
    )
    // It gates the only writer…
    const commitAt = effect.indexOf('const commit = ')
    expect(commitAt).toBeGreaterThan(-1)
    const commit = effect.slice(commitAt, effect.indexOf('const observer =', commitAt))
    expect(commit).toContain('if (!hasLayoutBox()) return')
    expect(commit).toContain('const next = widthBucket(el.clientWidth)')
    // …and it is checked BEFORE the leading-edge flag is consumed, or a panel
    // first observed while boxless burns its one leading-edge commit and then
    // waits out a settle timer the first time it is actually shown.
    const rafAt = effect.indexOf('requestAnimationFrame(')
    expect(rafAt).toBeGreaterThan(-1)
    // PRESENCE FIRST, then order. `indexOf` returns -1 when the needle is
    // ABSENT, and -1 is less than every real index — so a bare
    // `toBeLessThan(...)` passes when the guarded line is DELETED, which is
    // exactly the defect this assertion is named for. Deleting the RAF-level
    // check leaves the copy inside `commit()` satisfying every other assertion
    // here, so nothing else catches it either.
    const rafGuardAt = effect.indexOf('if (!hasLayoutBox()) return', rafAt)
    expect(
      rafGuardAt,
      'the boxless check must exist INSIDE the rAF, not only inside commit()'
    ).toBeGreaterThan(-1)
    const flagAt = effect.indexOf('transcriptWidthMeasuredRef.current = true')
    expect(flagAt, 'the leading-edge flag must exist to be ordered against').toBeGreaterThan(-1)
    expect(rafGuardAt, 'the check must come BEFORE the flag is consumed').toBeLessThan(flagAt)
    // And the raw `isConnected` test that used to stand alone in the settle
    // timer is gone: it is the one that reads like a guard and is not.
    expect(
      effect.includes('if (el.isConnected) commit()'),
      'isConnected is true for a display:none element; it cannot gate a measurement'
    ).toBe(false)
    // Positive control for that negative: the matcher fires on the shape being
    // refused, so an empty result is a repair and not a misread slice.
    expect('if (el.isConnected) commit()\n'.includes('if (el.isConnected) commit()')).toBe(true)
    expect(effect).toContain('commit()')
  })
})

describe('the width axis resolves to the column the CSS produced', () => {
  it('corrects the estimate towards the real column, always from above', () => {
    // GOLDENS, not re-derivations. `LAYOUT_EPOCH_CALIBRATION_WIDTH_PX` decides
    // every content estimate in the app and its only other test re-derives its
    // expectation FROM it, so nothing in the suite reds if it moves. These
    // literals are that pin.
    //
    // Narrow in the main pane is a 640px column -> bucket 8 -> the bucket's
    // upper edge, 720px -> 980/720.
    expect(widthBucket(640)).toBe(8)
    expect(transcriptLayoutScales({ widthBucket: 8, fontScale: 1 }).content).toBeCloseTo(1.3611, 4)
    // Narrow in a phone-narrow side chat is a 348px column -> bucket 4 -> 400px.
    // One NAME, two columns, two different corrections: this is why the setting
    // carries no number of its own and the box is measured.
    expect(widthBucket(348)).toBe(4)
    expect(transcriptLayoutScales({ widthBucket: 4, fontScale: 1 }).content).toBeCloseTo(2.45, 4)
    // And the columns the MEDIUM scopes rest at — 850px in the main pane, 760px
    // in General Chat — are corrections this module can compute and the panel
    // never asks it for. Medium reports bucket 0 (see "reports bucket 0 at
    // Medium"), so these two numbers are what the decision declined: they would
    // have moved every content estimate in those scopes by +11.4% and +22.5%.
    expect(widthBucket(850)).toBe(10)
    expect(transcriptLayoutScales({ widthBucket: 10, fontScale: 1 }).content).toBeCloseTo(1.1136, 4)
    expect(widthBucket(760)).toBe(9)
    expect(transcriptLayoutScales({ widthBucket: 9, fontScale: 1 }).content).toBeCloseTo(1.225, 4)

    // The direction, at every width: the bucket resolves to its UPPER edge, so
    // the assumed column is never narrower than the real one and the rate is
    // never higher than physics. Under-estimating is absorbed by one anchor
    // correction; over-estimating inflates the bottom spacer and lurches
    // auto-follow into empty overscan.
    for (const realColumn of [640, 760, 850, 1179, 2480, 3436]) {
      const bucket = widthBucket(realColumn)
      const assumedColumn = (bucket + 1) * WIDTH_BUCKET_PX
      expect(assumedColumn, `column ${realColumn}`).toBeGreaterThanOrEqual(realColumn)
      expect(
        transcriptLayoutScales({ widthBucket: bucket, fontScale: 1 }).content,
        `column ${realColumn}`
      ).toBeLessThanOrEqual(LAYOUT_EPOCH_CALIBRATION_WIDTH_PX / realColumn)
    }
  })

  it('cannot be pushed into the OVER-estimate direction by an uncapped column', () => {
    // The hazard Wide creates and the 850px cap made unreachable: the scale
    // floor used to clamp the PRODUCT, so a wide column with Small text
    // returned MORE than physics asked for. A 4K display at Wide is a ~3436px
    // column (bucket 42) and Small is 0.85.
    const wideSmall: TranscriptLayoutEpoch = { widthBucket: widthBucket(3436), fontScale: 0.85 }
    const scales = transcriptLayoutScales(wideSmall)
    expect(scales.content).toBeLessThan(LAYOUT_EPOCH_MIN_SCALE)
    // Positive control: the floor is still there and still does its own job —
    // a corrupt persisted TEXT scale cannot drive the rate to nothing.
    expect(transcriptLayoutScales({ widthBucket: 0, fontScale: 0.01 }).content).toBe(
      LAYOUT_EPOCH_MIN_SCALE
    )
    // And the estimate really moves with it, rather than the scale being a
    // number nothing reads.
    expect(estimatedHeightFor('assistant', false, 4000, false, wideSmall)).toBeLessThan(
      estimatedHeightFor('assistant', false, 4000, false, { widthBucket: 0, fontScale: 0.85 })
    )
  })

  it('never lets the content ceiling fall below the row it is capping', () => {
    // A REGRESSION the last slice introduced and nothing caught. Moving the
    // scale floor from the product to the TEXT term was right — a floor on a
    // wide column returns MORE than physics asks for — but it left the GENERIC
    // content ceiling, `CONTENT_SCALE_CAP_PX * content`, with no lower bound at
    // all. `estimatedHeightFor` then computes
    // `Math.min(scaleCap, Math.max(base, …))`, so once `scaleCap` drops under
    // `base` the row is pinned BELOW its own furniture at EVERY content length,
    // with the content scale silently dead. That is the exact inversion the
    // CLAMPED branch has floored against since the text axis landed.
    //
    // Sampled BEYOND the width the test above uses. 3436px (a 4K display at
    // Wide) is nowhere near the threshold and proves nothing about it: the
    // inversion starts at roughly a 5300px column at Small text — a 6K display
    // at Wide. 5488px buckets to 68, whose upper edge 5520 gives a width term of
    // 0.1775 and a content scale of 0.1283, so the unfloored ceiling was
    // round(1400 * 0.1283) = 180 against an `assistant` base of
    // round(220 * 0.85) = 187.
    const sixKWideSmall: TranscriptLayoutEpoch = { widthBucket: widthBucket(5488), fontScale: 0.85 }
    expect(sixKWideSmall.widthBucket).toBe(68)
    expect(Math.round(1400 * transcriptLayoutScales(sixKWideSmall).content)).toBe(180)
    const chromeBase = Math.round(220 * transcriptLayoutScales(sixKWideSmall).chrome)
    expect(chromeBase).toBe(187)
    // The estimate must be the row's own furniture, not the collapsed ceiling.
    expect(estimatedHeightFor('assistant', false, 40000, false, sixKWideSmall)).toBe(chromeBase)
    // And it must not be a CONSTANT across content lengths, which is what the
    // inversion produced: a row with almost no text and a row with 40,000
    // characters both returned 180.
    expect(estimatedHeightFor('assistant', false, 1, false, sixKWideSmall)).toBe(chromeBase)
    // Positive control, at a width where the ceiling is doing real work: the cap
    // still bites, so the floor above is a floor and not a removal of the cap.
    const wideDefault: TranscriptLayoutEpoch = { widthBucket: widthBucket(2156), fontScale: 1 }
    const capped = estimatedHeightFor('assistant', false, 400000, false, wideDefault)
    expect(capped).toBe(Math.round(1400 * transcriptLayoutScales(wideDefault).content))
    expect(capped).toBeGreaterThan(Math.round(220 * transcriptLayoutScales(wideDefault).chrome))
    // Identity is untouched by the floor: the cap is 1400 and every base is
    // under it, so this changes nothing for anyone at Medium.
    expect(estimatedHeightFor('assistant', false, 400000, false)).toBe(1400)
  })

  it('does not apply the WIDTH correction to rows whose content is a count', () => {
    // `tool` rows are content-scaled, but their `contentLength` is synthesised
    // by `projectRow` from `activities.length * TOOL_ACTIVITY_ESTIMATE_CHARS`
    // plus a per-activity CAPPED output sum — an activity COUNT in disguise, as
    // the estimator's own constants say ("their height is driven by activity
    // count, not text length"). An activity is one line at 640px and one line at
    // 2400px, so the width term is wrong for it in both directions: at a 2156px
    // Wide column it cut the estimate ~2.5x against a height that barely moves,
    // and at Narrow it inflated it, which is the bottom-spacer direction.
    const wide: TranscriptLayoutEpoch = { widthBucket: widthBucket(2156), fontScale: 1 }
    const narrow: TranscriptLayoutEpoch = { widthBucket: widthBucket(640), fontScale: 1 }
    const identity: TranscriptLayoutEpoch = { widthBucket: 0, fontScale: 1 }
    for (const epoch of [wide, narrow]) {
      expect(estimatedHeightFor('tool', false, 1800, false, epoch)).toBe(
        estimatedHeightFor('tool', false, 1800, false, identity)
      )
    }
    // EXHAUSTIVE over every row type, so the exemption set cannot GROW in
    // silence. Pinning only `tool` (exempt) and `assistant` (not exempt) leaves
    // ten types unobserved: adding any content-scaled one to the set strips the
    // width correction from those rows, so the estimator sizes them for the
    // 980px calibration while the DOM renders Narrow or Wide, and no test in
    // the repo reacts.
    const EXEMPT: ReadonlySet<VirtualRowType> = new Set<VirtualRowType>(['tool'])
    // DERIVED behaviourally, not imported: a type is content-scaled iff its
    // estimate moves with contentLength at identity. Reading the product's own
    // private set would make this guard agree with whatever that set says,
    // which is the tautology it exists to avoid.
    const CONTENT_SCALED_TYPES_FOR_TEST = new Set<VirtualRowType>(
      (Object.keys(ESTIMATED_ROW_HEIGHT_PX) as VirtualRowType[]).filter(
        (rowType) =>
          estimatedHeightFor(rowType, false, 20000, false, identity) !==
          estimatedHeightFor(rowType, false, 0, false, identity)
      )
    )
    // Non-vacuity: the derivation must actually find some, and not all.
    expect(CONTENT_SCALED_TYPES_FOR_TEST.size).toBeGreaterThan(1)
    expect(CONTENT_SCALED_TYPES_FOR_TEST.size).toBeLessThan(
      Object.keys(ESTIMATED_ROW_HEIGHT_PX).length
    )
    expect(CONTENT_SCALED_TYPES_FOR_TEST.has('assistant')).toBe(true)
    for (const rowType of Object.keys(ESTIMATED_ROW_HEIGHT_PX) as VirtualRowType[]) {
      const moves =
        estimatedHeightFor(rowType, false, 1800, false, wide) !==
        estimatedHeightFor(rowType, false, 1800, false, identity)
      if (EXEMPT.has(rowType)) {
        expect(moves, `${rowType} is width-EXEMPT and must not move with the column`).toBe(false)
      } else if (CONTENT_SCALED_TYPES_FOR_TEST.has(rowType)) {
        // Only content-scaled types can move at all; a flat-estimate type is
        // width-invariant for a different reason and is not evidence either way.
        expect(moves, `${rowType} is content-scaled and MUST take the width term`).toBe(true)
      }
    }

    // Positive control, twice over: the width term is real and DOES move a
    // text-driven row at those same two epochs, so the equalities above are the
    // exemption and not a dead axis.
    expect(estimatedHeightFor('assistant', false, 1800, false, wide)).toBeLessThan(
      estimatedHeightFor('assistant', false, 1800, false, identity)
    )
    expect(estimatedHeightFor('assistant', false, 1800, false, narrow)).toBeGreaterThan(
      estimatedHeightFor('assistant', false, 1800, false, identity)
    )
    // The TEXT axis still reaches tool rows — they are text, and text gets
    // taller. Only the width half is exempt.
    expect(
      estimatedHeightFor('tool', false, 1800, false, { widthBucket: 0, fontScale: 1.25 })
    ).toBeGreaterThan(estimatedHeightFor('tool', false, 1800, false, identity))
    // And a tool row at Wide with Large text is the same as at Medium with Large
    // text: the exemption is the WIDTH term only, at every text size.
    expect(
      estimatedHeightFor('tool', false, 1800, false, { widthBucket: 26, fontScale: 1.25 })
    ).toBe(estimatedHeightFor('tool', false, 1800, false, { widthBucket: 0, fontScale: 1.25 }))
  })
})

describe('the stylesheet scan covers every sheet that can win the cascade', () => {
  it('reads the component-local sheets, not just the shard directory', () => {
    // NON-VACUITY for every CSS negative in this file. The scanner used to read
    // `assets/css/*.css` plus `styles/theme.css` and nothing else, so the ~24
    // `components/*.css` sheets — each imported by its own component, each
    // emitted AFTER `assets/main.css`, each therefore winning at equal
    // specificity — were invisible to "exactly one max-width anywhere in the
    // sheets". A `.transcript-inner { max-width: 500px }` appended to one of
    // them was green.
    const files = cssFiles().map((path) => basename(path))
    expect(files).toEqual(expect.arrayContaining(['02-transcript-messages-fx.css', 'theme.css']))
    // The directories the old set could not reach, by name rather than by count,
    // so this fails when a sheet moves out of view rather than when one is
    // added.
    const outsideTheShards = cssFiles().filter((path) => !path.includes('/assets/css/'))
    expect(outsideTheShards.some((path) => path.includes('/components/'))).toBe(true)
    expect(outsideTheShards.some((path) => path.includes('/styles/'))).toBe(true)
    // BASENAMES must stay unique, because that is the label every expectation in
    // this file compares against: two sheets called the same thing would make
    // `'<file> <selector>'` ambiguous and could hide an owner behind a
    // same-named twin.
    expect(new Set(files).size, 'stylesheet basenames must be unique').toBe(files.length)
    // And the scan must actually yield rules — an empty parse satisfies every
    // negative in this file.
    expect(allCssRules().length).toBeGreaterThan(1000)
  })
})

describe('the jump-to-latest pill fits the gutter lane at Wide', () => {
  const pillRules = (): CssRule[] =>
    allCssRules().filter((rule) => rule.selector.includes('.transcript-jump-to-latest-pill'))

  it('anchors the base pill to the gutter, exactly once', () => {
    // The base position, unchanged: at Narrow and Medium the column is capped
    // well inside the pane, so a pill whose RIGHT edge sits at the gutter sits
    // in empty space.
    const base = pillRules().filter((rule) => rule.selector === '.transcript-jump-to-latest-pill')
    expect(base.map((rule) => rule.file)).toEqual(['03-composer-welcome-activity.css'])
    expect(declares(base[0].body, 'right')).toBe(1)
    expect(base[0].body.replace(/\s+/g, '')).toContain('right:var(--chat-side-gutter,24px);')
    expect(base[0].body.replace(/\s+/g, '')).toContain('position:absolute;')
  })

  it('collapses the pill into the 34px lane when the column takes the gutter', () => {
    // THE DEFECT. At Wide `--transcript-column-max-width: 100%` makes the column
    // the whole of `.transcript-scroll`'s content box, which is inset by exactly
    // `--chat-side-gutter` — the same offset the pill's right edge is pinned to.
    // The two edges coincide, so the ~130px pill lies on the text: measured at a
    // 2300px pane it covered ~67px of the line being read, in the main pane, in
    // a Multiview pane and in a popout, and not at Medium.
    //
    // There is no horizontal escape at Wide, so the pill becomes an overlay that
    // FITS the lane, at the same 34px `TranscriptUserMessageGutter` uses — the
    // budget the Wide rule's own note is written around.
    const scoped = pillRules().filter((rule) =>
      rule.selector.includes(`${TRANSCRIPT_WIDTH_ATTRIBUTE}='wide'`)
    )
    expect(scoped.map((rule) => `${rule.file} ${rule.selector}`)).toEqual([
      `03-composer-welcome-activity.css .app-transcript:has(.transcript-inner[${TRANSCRIPT_WIDTH_ATTRIBUTE}='wide']) .transcript-jump-to-latest-pill`,
      `03-composer-welcome-activity.css .app-transcript:has(.transcript-inner[${TRANSCRIPT_WIDTH_ATTRIBUTE}='wide']) .transcript-jump-to-latest-pill .transcript-jump-to-latest-text`
    ])
    const squashed = scoped[0].body.replace(/\s+/g, '')
    // The offset centres a 34px square in the gutter and floors at 2px, so a
    // hard-clamped 24px gutter pushes it flush rather than off the pane edge.
    expect(squashed).toContain('right:max(2px,calc((var(--chat-side-gutter,24px)-34px)/2));')
    expect(squashed).toContain('width:34px;')
    expect(squashed).toContain('height:34px;')
    // ONE `right`, because CSS is last-wins and this rule exists to override the
    // base one.
    expect(declares(scoped[0].body, 'right')).toBe(1)
    expect(declares(scoped[0].body, 'width')).toBe(1)
    // The label is what makes room for it; the count and the full text stay in
    // `aria-label` and `title`, which the component renders unconditionally.
    expect(scoped[1].body.replace(/\s+/g, '')).toBe('display:none;')
    // Comments STRIPPED: this is the compensating control for hiding the visible
    // count at Wide, so a commented-out `aria-label` must not satisfy it — that
    // would leave the number carried by nothing at all.
    const pill = withoutComments(renderer('components/TranscriptJumpToLatestPill.tsx'))
    expect(pill).toContain('aria-label={')
    expect(pill).toContain('`Jump to latest — ${messageLabel}`')
  })

  it('leaves the gutter-anchored offset to the base rule alone', () => {
    // The shape this must not regress to: a Wide scope that keeps the pill's
    // right edge on the column's right edge and merely restyles it.
    const scoped = pillRules().filter((rule) =>
      rule.selector.includes(`${TRANSCRIPT_WIDTH_ATTRIBUTE}='wide'`)
    )
    for (const rule of scoped) {
      expect(
        rule.body.replace(/\s+/g, '').includes('right:var(--chat-side-gutter'),
        rule.selector
      ).toBe(false)
    }
    // Positive control for that negative: the matcher fires on the exact shape
    // being refused, and the base rule really does still use it.
    expect('right:var(--chat-side-gutter,24px);'.includes('right:var(--chat-side-gutter')).toBe(
      true
    )
    expect(scoped.length).toBeGreaterThan(0)
  })
})

describe('the column composes over the pane caps, and the composer never moves', () => {
  const columnRule = (): CssRule => {
    const rules = allCssRules().filter(
      (rule) =>
        rule.file === '02-transcript-messages-fx.css' && rule.selector === '.transcript-inner'
    )
    expect(rules.length, 'exactly one base .transcript-inner rule').toBe(1)
    return rules[0]
  }

  it('caps the column with ONE declaration and three fallback terms', () => {
    const rule = columnRule()
    expect(rule.body.replace(/\s+/g, '')).toContain(
      'max-width:min(100%,var(--transcript-column-max-width,var(--transcript-pane-max-width,var(--composer-content-max-width))));'
    )
    expect(
      declares(rule.body, 'max-width'),
      'CSS is last-wins: a second max-width here silently overrides the first'
    ).toBe(1)
  })

  it('leaves exactly one max-width for this element anywhere in the sheets', () => {
    // The real failure mode, and three of the four scopes shipped it: General
    // Chat, side chat and the popout each wrote their OWN `max-width` onto
    // `.transcript-inner`, every one of them more specific than the base rule.
    // A width control added to the base rule alone would have been inert in
    // three of the four places a transcript renders, with every guard green.
    const owners = allCssRules().filter(
      (rule) => rule.selector.includes('.transcript-inner') && declares(rule.body, 'max-width') > 0
    )
    expect(owners.map((rule) => `${rule.file} ${rule.selector}`)).toEqual([
      '02-transcript-messages-fx.css .transcript-inner'
    ])
    // Positive control for that emptiness: the pane scopes still cap the
    // column, through the TERM instead — so this is one declaration and four
    // ceilings, not a cap that was deleted.
    const terms = allCssRules().filter(
      (rule) => declares(rule.body, '--transcript-pane-max-width') > 0
    )
    expect(terms.map((rule) => `${rule.file} ${rule.selector}`).sort()).toEqual([
      '02-transcript-messages-fx.css .app-transcript.chat-scope-global:not(.welcome-mode) .transcript-inner',
      '03-composer-welcome-activity.css .popout-chat-transcript .transcript-inner',
      '11-side-chat.css .side-chat-pane .transcript-inner'
    ])
  })

  it('declares the user term ONLY from the two attribute rules', () => {
    const declarers = allCssRules().filter(
      (rule) => declares(rule.body, '--transcript-column-max-width') > 0
    )
    expect(declarers.map((rule) => `${rule.file} ${rule.selector}`)).toEqual([
      `02-transcript-messages-fx.css .transcript-inner[${TRANSCRIPT_WIDTH_ATTRIBUTE}='narrow']`,
      `02-transcript-messages-fx.css .transcript-inner[${TRANSCRIPT_WIDTH_ATTRIBUTE}='wide']`
    ])
    // Each rule carries the cap the module exports, derived rather than
    // re-typed: renaming one side of a custom property or an attribute is
    // invisible to TypeScript and to the browser alike — every column simply
    // stays at Medium, which looks correct to anyone who has not chosen one.
    for (const [index, name] of (['narrow', 'wide'] as TranscriptWidth[]).entries()) {
      expect(declarers[index].body.replace(/\s+/g, ''), name).toBe(
        `--transcript-column-max-width:${TRANSCRIPT_WIDTH_COLUMN_CAPS[name]};`
      )
    }
    // MEDIUM EMITS NOTHING. The whole byte-identity claim for a user who never
    // opens the control is that no rule exists to match.
    expect(
      allCssRules().filter((rule) =>
        rule.selector.includes(`${TRANSCRIPT_WIDTH_ATTRIBUTE}='medium'`)
      )
    ).toEqual([])
    // Positive control for that emptiness: the selector shape is real and the
    // matcher finds the two rules that do use it.
    expect(
      allCssRules().filter((rule) => rule.selector.includes(`${TRANSCRIPT_WIDTH_ATTRIBUTE}='wide'`))
        .length
    ).toBeGreaterThan(0)
  })

  it('never writes the composer token — the same four scopes declare it as before', () => {
    // THE trap. `--composer-content-max-width` lives on `.app-transcript`, which
    // contains the composer, the workspace terminal AND its drag divider, the
    // Codex/ChatGPT/Grok tucked rows, the approval overlay (pinned at cap +
    // 96px) and the welcome surfaces — and through `--composer-reserved-height`
    // it feeds back into this scroller's own bottom padding. Retuning it for a
    // width setting is not a width change, it is a layout change with a loop.
    const declarers = allCssRules().filter(
      (rule) => declares(rule.body, '--composer-content-max-width') > 0
    )
    expect(declarers.map((rule) => `${rule.file} ${rule.selector}`)).toEqual([
      '02-transcript-messages-fx.css .app-transcript',
      '03-composer-welcome-activity.css .chat-popout-window .app-transcript',
      '11-side-chat.css .side-chat-pane .composer-area',
      '14-multiview.css .multiview-pane-transcript'
    ])
    // The four values, unchanged, so "the same four scopes" is not satisfied by
    // four scopes carrying different numbers.
    const valueOf = (selector: string): string => {
      const rule = declarers.find((candidate) => candidate.selector === selector)
      expect(rule, selector).toBeDefined()
      const match = /--composer-content-max-width:\s*([^;]+);/.exec((rule as CssRule).body)
      expect(match, selector).not.toBeNull()
      return (match as RegExpExecArray)[1].trim()
    }
    expect(valueOf('.app-transcript')).toBe('850px')
    expect(valueOf('.chat-popout-window .app-transcript')).toBe('min(850px, calc(100vw - 32px))')
    expect(valueOf('.side-chat-pane .composer-area')).toBe('100%')
    expect(valueOf('.multiview-pane-transcript')).toBe('min(850px, calc(100% - 28px))')
    // And no new rule may set it under a width scope, which is the shape a
    // "just make Wide work everywhere" fix takes.
    expect(declarers.filter((rule) => rule.selector.includes(TRANSCRIPT_WIDTH_ATTRIBUTE))).toEqual(
      []
    )
  })

  it('lets the fan-out lane grid use the whole Wide column, from ONE floor', () => {
    /*
     * The two-across containment this replaces. Wide used to override
     * `--fanout-lane-min` to half the column so a third track could never be
     * satisfied, because nothing downstream could place, window, measure or
     * estimate a third cell. All four now derive the track count from the
     * layout epoch, so the override is gone — and the thing worth guarding
     * flipped from "the override exists, exactly so" to "no width-scoped
     * declarer exists at all, and the one floor there is says what JS thinks it
     * says".
     */
    const declarers = allCssRules().filter((rule) => declares(rule.body, '--fanout-lane-min') > 0)
    // NON-VACUITY FIRST. An empty `declarers` would satisfy the negative below
    // for the wrong reason — a renamed property, a moved sheet, a broken walk.
    expect(declarers.map((rule) => `${rule.file} ${rule.selector}`)).toEqual([
      "02-transcript-messages-fx.css :root[data-fanout-lane-layout='paired'] .transcript-inner"
    ])
    // THE NEGATIVE: no rule may re-floor the tracks under a width scope, which
    // is the shape a "put the containment back" change takes.
    expect(
      declarers.filter((rule) => rule.selector.includes(TRANSCRIPT_WIDTH_ATTRIBUTE)),
      'a width-scoped lane floor is the two-across containment, reintroduced'
    ).toEqual([])

    const grid = declarers[0]
    // EXACTLY ONCE, matched whole. CSS is last-wins, so a second declaration in
    // the same rule would be the live one while this assertion read the first,
    // and `toContain('--fanout-lane-min: 360px')` is satisfied by
    // `--fanout-lane-min: 360px000` and by a second declaration after it.
    expect(declares(grid.body, '--fanout-lane-min')).toBe(1)
    expect(/--fanout-lane-min:\s*([^;]+);/.exec(grid.body)?.[1].trim()).toBe(
      // DERIVED from the JS constant, not re-typed beside it. The estimator and
      // the slot classifier compute the track count from `FANOUT_LANE_MIN_PX`;
      // if the two halves part company the grid lays out a different number of
      // cards than every row was estimated and slotted for.
      `${FANOUT_LANE_MIN_PX}px`
    )
    expect(declares(grid.body, 'grid-template-columns')).toBe(1)
    expect(/grid-template-columns:\s*([^;]+);/.exec(grid.body)?.[1].trim()).toBe(
      'repeat(auto-fit, minmax(min(100%, var(--fanout-lane-min)), 1fr))'
    )
    // The gap term of the same arithmetic. JS models the `:root` value.
    expect(declares(grid.body, 'column-gap')).toBe(1)
    expect(/column-gap:\s*([^;]+);/.exec(grid.body)?.[1].trim()).toBe('var(--space-md)')
    const rootSpace = allCssRules().find(
      (rule) => rule.file === 'theme.css' && rule.selector === ':root'
    )
    expect(rootSpace, 'theme.css :root').toBeDefined()
    expect(/(^|[;{])\s*--space-md:\s*([^;]+);/.exec((rootSpace as CssRule).body)?.[2].trim()).toBe(
      `${FANOUT_LANE_COLUMN_GAP_PX}px`
    )
  })

  it('agrees with the grid about where each track boundary is', () => {
    // The CSS comment states the forward form (two tracks at 732px, three at
    // ~1104px, four at ~1476px); `fanoutLaneTracksForColumnPx` states the
    // inverse. Both are pinned as literals in `fanoutLaneTracks.test.ts`; this
    // is the crossing check that the numbers are the SAME numbers.
    for (const tracks of [1, 2, 3, 4, 5]) {
      const exact = tracks * FANOUT_LANE_MIN_PX + (tracks - 1) * FANOUT_LANE_COLUMN_GAP_PX
      expect(fanoutLaneTracksForColumnPx(exact), `${tracks} tracks at ${exact}px`).toBe(tracks)
      expect(fanoutLaneTracksForColumnPx(exact - 1), `${tracks - 1} tracks at ${exact - 1}px`).toBe(
        Math.max(1, tracks - 1)
      )
    }
  })
})

describe('the width reaches every transcript', () => {
  it('is threaded into the panel by a prop that carries the NAME', () => {
    expect(PANEL).toContain('transcriptWidth?: TranscriptWidth')
    expect(PANEL).toContain('\n    transcriptWidth,\n')
  })

  it('stamps the attribute on the element the stylesheets scope to', () => {
    const at = PANEL_CODE.indexOf('className={`transcript-inner${')
    expect(at).toBeGreaterThan(-1)
    // Anchored to the element's own attribute list. Unanchored, this passes
    // with the attribute moved to any other element in a ~7,900-line file — the
    // bug shape the Default-view slice shipped — and here that would also point
    // the ResizeObserver at a box the width rules never reached.
    //
    // COMMENT-STRIPPED, which is the half this guard did not have. This one line
    // is what makes the ENTIRE CSS side of the setting work — it is the only
    // thing that can match `[data-transcript-width]`, and those two rules are
    // the only declarers of `--transcript-column-max-width`. Replacing it with a
    // JSX block comment is not a type error and not a render error: the control
    // still renders, still persists, still round-trips through four registries
    // and a popout, and every column stays at Medium. Over the RAW file that
    // mutation was green everywhere.
    //
    // The source guard is also not the whole pin any more.
    // `TranscriptWidthRendering.test.tsx` renders the panel and reads the
    // attribute off `.transcript-inner` in the emitted markup, because "the
    // right text is in the file" and "the right attribute reaches the DOM" are
    // different claims and only the second one is the feature.
    const element = PANEL_CODE.slice(at, PANEL_CODE.indexOf('>', at))
    expect(element).toContain(`${TRANSCRIPT_WIDTH_ATTRIBUTE}={transcriptWidthAttributeValue}`)
    // The SAME element the observer measures and the font scale is stamped on.
    expect(element).toContain('ref={contentRef}')
    expect(element).toContain('style={transcriptFontScaleVariables}')
    // Positive control for the strip: a commented-out attribute really does
    // vanish from the text this assertion reads, so passing means the line is
    // executable and not merely present.
    expect(
      withoutComments('<div {/* data-transcript-width={x} */} ref={contentRef}>')
    ).not.toContain(TRANSCRIPT_WIDTH_ATTRIBUTE)
  })

  it('reaches the main pane, the side chat and the settings panel', () => {
    // COMMENT-STRIPPED. A textual count over the raw file is satisfied by three
    // occurrences wherever they are: comment ONE of the three mounts out and the
    // commented copy still counts, so the guard reads 3 while one of the three
    // transcripts renders at the wrong column. The sibling count in
    // `TranscriptLayoutEpochPlumbing.test.ts` was upgraded for exactly this
    // reason; this one was missed.
    const layout = withoutComments(renderer('app/views/MainAppLayout.tsx'))
    expect(
      layout.split('transcriptWidth={appearance.transcriptWidth}').length - 1,
      'the main pane, the side chat and the settings preview each mount one'
    ).toBe(3)
    // Positive control for the strip: a commented mount really does leave the
    // count, so 3 here is three live mounts.
    expect(
      withoutComments('/* transcriptWidth={appearance.transcriptWidth} */').split(
        'transcriptWidth={appearance.transcriptWidth}'
      ).length - 1
    ).toBe(0)
  })

  it('reaches a multiview pane through the builder and the pane props', () => {
    const app = withoutComments(renderer('App.tsx'))
    const paneAt = app.indexOf('<ChatViewPane')
    expect(paneAt).toBeGreaterThan(-1)
    const paneTag = app.slice(paneAt, app.indexOf('/>', paneAt))
    expect(paneTag).toContain('transcriptWidth={appearance.transcriptWidth}')
    const builder = renderer('lib/buildChatViewProps.ts')
    expect(builder).toContain("transcriptWidth?: TranscriptPanelProps['transcriptWidth']")
    // The output forward is the silent half: the target prop is optional, so
    // declaring the input field alone compiles and drops the value. Comments
    // STRIPPED and the value matched EXACTLY — `toContain` over the raw file
    // passes when the line is merely commented out, and an exact match also
    // rejects the inert `transcriptWidth: undefined` spelling.
    const forward = withoutComments(builder)
    const forwardAt = forward.indexOf('transcriptWidth:')
    expect(forwardAt, 'the builder must forward the width').toBeGreaterThan(-1)
    const forwarded = forward.slice(forwardAt + 'transcriptWidth:'.length)
    expect(forwarded.slice(0, forwarded.indexOf(',')).trim()).toBe('input.transcriptWidth')
  })

  it('is compared by BOTH hand-written memo chains', () => {
    // Neither is compile-caught: the panel comparable types every field as
    // `unknown`, and the pane prop is inherited from the builder's input type.
    // Unlisted, the width changes in Settings and the panel never re-renders —
    // and the Settings takeover HIDES `.app-transcript` rather than unmounting
    // it, so nothing else forces the render either.
    //
    // The entries are pinned BEHAVIOURALLY, and that is a repair rather than a
    // preference. Both comparators used to be pinned here by raw-source
    // containment — which a comment satisfies, and which cannot tell `&&` from
    // `||`, and which was a regression from the text-size slice that pinned the
    // same seam by CALLING the comparators. They are called in
    // `transcriptPanelMemoProps.test.ts` ("invalidates when the Appearance
    // transcript WIDTH changes") and `ChatViewPane.test.tsx` ("re-renders when
    // the Appearance transcript width changes"), each with a positive control
    // and with absence distinguished from a chosen width.
    //
    // What is left here is the one thing calling them cannot show: that the
    // field is DECLARED on the panel comparable's hand-written shape, so the
    // `unknown` typing does not silently accept a key nothing compares.
    const memo = withoutComments(renderer('lib/transcriptPanelMemoProps.ts'))
    expect(memo).toContain('transcriptWidth?: unknown')
    expect(memo).toContain('previous.transcriptWidth === next.transcriptWidth &&')
    const pane = withoutComments(renderer('components/ChatViewPane.tsx'))
    expect(pane).toContain('a.transcriptWidth === b.transcriptWidth &&')
  })

  it('is declared on the appearance union MainAppLayout picks from', () => {
    expect(withoutComments(renderer('app/views/MainAppLayout.types.ts'))).toContain(
      "| 'transcriptWidth'\n"
    )
  })
})

describe('the write path persists the choice', () => {
  it('gives the key its own block in handleSettingsChange', () => {
    // No spread in that function: every key is its own `if`, and a missing one
    // compiles and simply never persists.
    const app = withoutComments(renderer('App.tsx'))
    const at = app.indexOf('if (next.transcriptWidth !== undefined) {')
    expect(at).toBeGreaterThan(-1)
    const block = app.slice(at, app.indexOf('\n    }', at))
    // Newline terminator: the bare assignment is a PREFIX of longer forms.
    expect(block).toContain('settingsPatch.transcriptWidth = next.transcriptWidth\n')
    // COMMENT-STRIPPED, like its neighbour. This is the LIVE half of the write
    // path — `settingsPatch` persists the choice, `appearance.update` is what
    // moves the running app — and commenting it out is not a type error: the
    // setting saves, survives a restart, and does nothing until one.
    expect(block).toContain('appearance.update({ transcriptWidth: next.transcriptWidth })')
    // Positive control for the strip over THIS file, not over a synthetic
    // string: the raw source really does differ from the stripped source here,
    // so `withoutComments` is doing work rather than returning its input.
    expect(renderer('App.tsx').length).toBeGreaterThan(app.length)
  })

  it('is declared on the update type App actually receives', () => {
    // SettingsPanel's own `onChange` literal is a separate hand-written copy, so
    // adding the key there alone compiles while the value never reaches App.
    expect(withoutComments(renderer('lib/settingsPanelUpdate.ts'))).toContain(
      "transcriptWidth?: AppSettings['transcriptWidth']"
    )
  })

  it('joins all four useAppearance lists it has to join', () => {
    const hook = withoutComments(renderer('hooks/useAppearance.ts'))
    // Interface + initial state are compile-caught (the field is REQUIRED on
    // AppearanceState); hydrate and persist are silent when missed.
    expect(hook).toContain('transcriptWidth: TranscriptWidth\n')
    expect(hook).toContain('transcriptWidth: DEFAULT_TRANSCRIPT_WIDTH,')
    // Hydrate: missed, `...prev` retains the mount default and the stored width
    // never loads — "works until I restart the app". Comments stripped: with
    // the raw file, commenting this line out leaves the guard green and
    // produces exactly that symptom.
    expect(withoutComments(hook)).toContain(
      'transcriptWidth: resolveTranscriptWidth(settings.transcriptWidth),'
    )
    // Persist: anchored on the literal's FIRST key, because the hydrate path
    // issues its own one-key `updateSettings` earlier in the file.
    const persistAt = hook.indexOf('.updateSettings({\n            appearanceMode: next.mode,')
    expect(persistAt).toBeGreaterThan(-1)
    const persistEnd = hook.indexOf('\n          })', persistAt)
    expect(persistEnd).toBeGreaterThan(persistAt)
    expect(withoutComments(hook.slice(persistAt, persistEnd))).toContain(
      'transcriptWidth: next.transcriptWidth,'
    )
  })

  it('is NOT stamped on :root by applyToDocument, which is the main window only', () => {
    // A `:root` attribute is the anti-pattern here for two reasons, not one:
    // `applyToDocument` never runs for a popped-out chat, and one document
    // cannot carry two values at once — which a Multiview of panes at different
    // widths would need. It also has to be the element the observer measures.
    const hook = renderer('hooks/useAppearance.ts')
    const at = hook.indexOf('const applyToDocument = useCallback(')
    expect(at).toBeGreaterThan(-1)
    const body = withoutComments(hook.slice(at, hook.indexOf('\n  }, [])', at)))
    // Positive control: this really is the stamping function, and it really
    // does stamp the setting whose attribute IS delivered this way.
    expect(body).toContain("root.setAttribute('data-fanout-lane-layout', next.fanoutLaneLayout)")
    expect(body).not.toContain(TRANSCRIPT_WIDTH_ATTRIBUTE)
    expect(body).not.toContain('transcriptWidth')
  })
})

describe('the Appearance control', () => {
  it('sits after Transcript text size and reads the shared catalogue', () => {
    // COMMENT-STRIPPED. `onChange` is the whole write path out of this control,
    // and a controlled `<select>` with no `onChange` is NOT a TypeScript error —
    // React only warns at runtime, and not in a `renderToStaticMarkup` suite.
    // Commented out, the control renders, binds its `value`, shows the right
    // option, and is inert. Over the raw file that mutation was green.
    const panel = withoutComments(renderer('components/SettingsPanel.tsx'))
    const sizeAt = panel.indexOf(
      '<span className="settings-field-label">Transcript text size</span>'
    )
    const widthAt = panel.indexOf('<span className="settings-field-label">Transcript width</span>')
    expect(sizeAt).toBeGreaterThan(-1)
    expect(widthAt).toBeGreaterThan(sizeAt)
    // Adjacent, extending the Fan-out lanes -> Default transcript view ->
    // Transcript text size chain the two sibling suites pin. It is also the
    // only placement that reds neither of them.
    expect(panel.slice(sizeAt + 1, widthAt)).not.toContain(
      '<span className="settings-field-label">'
    )
    const control = panel.slice(widthAt, panel.indexOf('</label>', widthAt))
    expect(control).toContain('value={resolveTranscriptWidth(transcriptWidth)}')
    expect(control).toContain('onChange({ transcriptWidth: e.target.value as TranscriptWidth })')
    expect(control).toContain('TRANSCRIPT_WIDTH_OPTIONS.map(')
    // Positive control for the strip over THIS file: the raw source really is
    // longer than the stripped source, so the assertions above read code.
    expect(renderer('components/SettingsPanel.tsx').length).toBeGreaterThan(panel.length)
    // The catalogue exists so the control cannot describe a column the
    // transcript does not render at; the positive above proves it is
    // referenced, this proves the wording is not a second hard-coded copy.
    expect(control).not.toContain('A tighter reading column')
  })

  it('declares the prop on BOTH hand-written prop shapes in that file', () => {
    // The read path (interface) and the write path (the separate `onChange`
    // literal) are independent copies: one alone compiles green, and the
    // control then moves while nothing in the app does.
    const panel = withoutComments(renderer('components/SettingsPanel.tsx'))
    expect(panel).toContain('\n  transcriptWidth?: TranscriptWidth\n')
    expect(panel).toContain('\n    transcriptWidth?: TranscriptWidth\n')
    expect(panel).toContain('\n  transcriptWidth,\n')
  })
})

describe('the main-process half', () => {
  it('declares the field optional and leaves it out of defaultSettings', () => {
    // Absence IS the contract: a value in defaultSettings would give every
    // install an explicit pin that beats a later user choice.
    expect(withoutComments(main('store/types.ts'))).toContain('transcriptWidth?: TranscriptWidth\n')
    const store = withoutComments(main('store/index.ts'))
    const at = store.indexOf('const defaultSettings: AppSettings = {')
    expect(at).toBeGreaterThan(-1)
    const literal = store.slice(at, store.indexOf('\n}', at))
    // Control: this really is the defaults literal, and it really is populated.
    expect(literal).toContain("promptSurfaceStyle: 'liquid_glass',")
    expect(literal).not.toContain('transcriptWidth')
  })

  it('is allowlisted for persistence, the only gate there is', () => {
    // Unlisted, `sanitizeSettingsPatch` drops it with a bare `continue` — and
    // it is a `Set<keyof AppSettings>`, so a missing entry is not a type error.
    expect(withoutComments(main('settings/MainSanitizers.ts'))).toContain("'transcriptWidth',")
  })

  it('is forwarded by the only projection popouts and utility windows have', () => {
    // The `as AppSettings` cast at the end of this function is why an omission
    // here never type-errors.
    const handlers = withoutComments(main('ipc/settingsHandlers.ts'))
    const at = handlers.indexOf('function rendererAppearanceSettings(')
    expect(at).toBeGreaterThan(-1)
    const projection = withoutComments(handlers.slice(at, handlers.indexOf('} as AppSettings', at)))
    expect(projection).toContain('transcriptWidth: settings.transcriptWidth,')
    // Control: the projection really is the populated one.
    expect(projection).toContain('transcriptTextSize: settings.transcriptTextSize,')
  })
})

describe('the types stay narrow', () => {
  it('names exactly three widths', () => {
    const widths: TranscriptWidth[] = ['narrow', 'medium', 'wide']
    expect(Object.keys(TRANSCRIPT_WIDTH_COLUMN_CAPS).sort()).toEqual([...widths].sort())
  })
})
