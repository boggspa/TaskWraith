import { describe, expect, it } from 'vitest'

import { Ansi, mixHex, stripAnsi, visibleWidth } from './ansi'
import { GHOST_BANNER_COLUMNS, GHOST_BANNER_ROWS, ghostBannerArt } from './ghostBanner'
import { ghostBannerSweepLoopLength, sweepGhostBanner } from './ghostBannerSweep'
import { TUI_MOTION, TUI_TONE } from './theme'

const ART = ghostBannerArt('unicode')
const LOOP = ghostBannerSweepLoopLength(ART)
const PEAK = mixHex(TUI_TONE.ensemble, TUI_TONE.highlight, TUI_MOTION.shimmerPeak)
const MID = mixHex(TUI_TONE.ensemble, TUI_TONE.highlight, TUI_MOTION.shimmerMid)

function sweep(frame: number, ansi = new Ansi('truecolor'), enabled = true): string[] {
  return sweepGhostBanner({ lines: ART, ansi, frame, enabled })
}

/**
 * The foreground hex active at each visible column of a rendered row. Written
 * out rather than regex-scraped because the tests below assert *where* the
 * highlight sits, and that question is meaningless without a column index.
 */
function columnTones(rendered: string): (string | undefined)[] {
  const tones: (string | undefined)[] = []
  let current: string | undefined
  let index = 0
  while (index < rendered.length) {
    const escape = /^\u001b\[([0-9;]*)m/.exec(rendered.slice(index))
    if (escape) {
      const code = escape[1]
      if (code.startsWith('38;2;')) {
        const channels = code.slice(5).split(';').map(Number)
        current = `#${channels.map((channel) => channel.toString(16).padStart(2, '0')).join('')}`
      } else if (code === '39') {
        current = undefined
      }
      index += escape[0].length
      continue
    }
    const character = String.fromCodePoint(rendered.codePointAt(index) as number)
    tones.push(current)
    index += character.length
  }
  return tones
}

/** Columns of one rendered row painted at the sweep's brightest blend. */
function litColumns(rendered: string): number[] {
  return columnTones(rendered).flatMap((tone, column) => (tone === PEAK ? [column] : []))
}

describe('ghost banner sweep', () => {
  it('never changes a row of the mark, only its colour', () => {
    // render.ts centres the banner as a block by centring each row on its own
    // visible width. A sweep that added or dropped one visible cell would shear
    // the mark apart, and it would do so only on the frames where it happened.
    for (let frame = 0; frame < LOOP; frame += 1) {
      const painted = sweep(frame)
      expect(painted).toHaveLength(GHOST_BANNER_ROWS)
      painted.forEach((row, index) => {
        expect(stripAnsi(row)).toBe(ART[index])
        expect(visibleWidth(row)).toBe(GHOST_BANNER_COLUMNS)
      })
    }
  })

  it('travels on a diagonal rather than as a full-height bar', () => {
    // The distinguishing property: each row's highlight sits one column left of
    // the row above it. A `column`-only phase lights identical columns on every
    // row, which is the vertical-scanner shape this exists to avoid.
    const painted = sweep(GHOST_BANNER_ROWS - 1)
    const perRow = painted.map(litColumns)
    expect(perRow.every((columns) => columns.length > 0)).toBe(true)
    for (let row = 1; row < perRow.length; row += 1) {
      expect(perRow[row][0]).toBe(perRow[row - 1][0] - 1)
    }
    // ...and the rows genuinely differ, so the assertion above is not comparing
    // an empty band against itself.
    expect(new Set(perRow.map((columns) => columns[0])).size).toBe(GHOST_BANNER_ROWS)
  })

  it('carries a leading peak and a trailing midtone, not a hard edge', () => {
    const tones = columnTones(sweep(6)[0])
    const peaks = tones.flatMap((tone, column) => (tone === PEAK ? [column] : []))
    const mids = tones.flatMap((tone, column) => (tone === MID ? [column] : []))
    expect(peaks).toHaveLength(2)
    expect(mids).toHaveLength(1)
    // The falloff trails the head; a sweep whose midtone led it would read as
    // travelling in the opposite direction to the one it advances in.
    expect(mids[0]).toBe(peaks[peaks.length - 1] + 1)
    expect(tones.filter((tone) => tone === TUI_TONE.ensemble).length).toBe(GHOST_BANNER_COLUMNS - 3)
  })

  it('advances every frame and returns to where it started after one loop', () => {
    const first = sweep(0)
    expect(sweep(1)).not.toEqual(first)
    expect(sweep(LOOP)).toEqual(first)
    expect(LOOP).toBe(
      GHOST_BANNER_COLUMNS + GHOST_BANNER_ROWS - 1 + TUI_MOTION.bannerSweepTailPadding
    )
  })

  it('rests the whole mark for part of every loop', () => {
    // The tail is what makes this a sweep rather than a permanently scanned
    // surface. Without it the mark is never once at rest.
    const resting = Array.from({ length: LOOP }, (_, frame) =>
      sweep(frame).every((row) => litColumns(row).length === 0)
    ).filter(Boolean).length
    expect(resting).toBeGreaterThan(0)
  })

  it('spends at most four colour escapes on a row', () => {
    // Three blend buckets can appear in at most four runs along one row. A
    // per-cell implementation looks identical and emits twenty-one, which at
    // the home frame's repaint rate is kilobytes per second at an idle
    // terminal.
    for (let frame = 0; frame < LOOP; frame += 1) {
      for (const row of sweep(frame)) {
        expect(row.split('\u001b[38;2;').length - 1).toBeLessThanOrEqual(4)
      }
    }
  })

  it('stands still under --no-animation and under NO_COLOR', () => {
    const still = ART.map((line) => new Ansi('truecolor').provider(line, TUI_TONE.ensemble))
    expect(sweep(0, new Ansi('truecolor'), false)).toEqual(still)
    expect(sweep(9, new Ansi('truecolor'), false)).toEqual(still)

    const plain = new Ansi('none')
    expect(sweep(0, plain)).toEqual([...ART])
    expect(sweep(9, plain)).toEqual([...ART])
  })

  it('rests rather than blanking when handed a frame that is not a number', () => {
    // `animationFrame` is typed `number`, but a state built by a cast can omit
    // it. NaN fails both bucket comparisons, so without the guard the sweep
    // silently renders as if it had never been wired up.
    const stray = sweepGhostBanner({
      lines: ART,
      ansi: new Ansi('truecolor'),
      frame: Number.NaN,
      enabled: true
    })
    stray.forEach((row, index) => expect(stripAnsi(row)).toBe(ART[index]))
    expect(stray).toEqual(sweep(0))
  })

  it('sweeps the ASCII mark on the same geometry', () => {
    const ascii = ghostBannerArt('ascii')
    const painted = sweepGhostBanner({
      lines: ascii,
      ansi: new Ansi('truecolor'),
      frame: 12,
      enabled: true
    })
    painted.forEach((row, index) => expect(stripAnsi(row)).toBe(ascii[index]))
    expect(ghostBannerSweepLoopLength(ascii)).toBe(LOOP)
  })
})
