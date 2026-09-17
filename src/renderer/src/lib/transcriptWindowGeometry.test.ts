import { describe, expect, it } from 'vitest'
import { buildHeightOffsets, sumHeights } from './TranscriptVirtualWindow'
import { selectTranscriptWindow } from './transcriptWindowGeometry'

describe('transcript window geometry', () => {
  it('keeps the tail measurable when auto-follow outruns undelivered row measurements', () => {
    const heights = Array<number>(120).fill(116)
    const window = selectTranscriptWindow({
      heights,
      scrollTop: 20_000,
      viewportHeight: 900
    })
    expect(window.endIndex).toBe(120)
    expect(window.startIndex).toBeLessThan(120)
    expect(window.bottomSpacerPx).toBe(0)
  })

  it('retains mounted rows during growth while updating spacers from current heights', () => {
    const heights = Array<number>(120).fill(100)
    const previous = { startIndex: 90, endIndex: 115 }
    for (let index = 80; index < 120; index++) heights[index] = 500
    const offsets = buildHeightOffsets(heights)
    const window = selectTranscriptWindow({
      heights,
      heightOffsets: offsets,
      scrollTop: 10_000,
      viewportHeight: 900,
      previous
    })
    expect(window.startIndex).toBeLessThanOrEqual(previous.startIndex)
    expect(window.endIndex).toBeGreaterThanOrEqual(previous.endIndex)
    expect(window.topSpacerPx).toBe(offsets[window.startIndex])
    expect(
      window.topSpacerPx +
        sumHeights(heights, window.startIndex, window.endIndex) +
        window.bottomSpacerPx
    ).toBe(offsets.at(-1))
  })

  it('extends the band when a shrinking row exposes content, then trims on the next scroll', () => {
    const heights = Array<number>(100).fill(100)
    const input = { heights, scrollTop: 3000, viewportHeight: 800, overscanPx: 200 }
    const previous = { startIndex: 10, endIndex: 25 }
    const settling = selectTranscriptWindow({ ...input, previous })
    expect(settling.startIndex).toBe(10)
    expect(settling.endIndex).toBe(40)
    const scrolled = selectTranscriptWindow(input)
    expect(scrolled.startIndex).toBe(28)
    expect(scrolled.endIndex).toBe(40)
  })

  it('extends to the LAST grid row without cutting it, pinning the upper bound of the walk', () => {
    /*
     * The end-walk carries a bound — `endIndex < rowCount` — that the sweep
     * above cannot see, because none of its bands reach the final row: with
     * `endIndex < rowCount - 1` substituted, that whole sweep stays green while
     * the transcript's LAST lane grid row is cut in half. A bound nothing
     * exercises is the same guard-hole this seam has shipped before, so it gets
     * a case that lands exactly on the end.
     */
    const TRACKS = 3
    const LANES = 6
    const fanoutLaneSlots = new Map<string, 'lead' | 'trail' | 'solo'>()
    for (let index = 0; index < LANES; index += 1) {
      const position = index % TRACKS
      fanoutLaneSlots.set(`row-${index}`, position === TRACKS - 1 ? 'trail' : 'lead')
    }
    const rows = Array.from({ length: LANES }, (_, index) => ({ rowKey: `row-${index}` }))
    const heights = Array.from({ length: LANES }, (_, index) =>
      fanoutLaneSlots.get(`row-${index}`) === 'lead' ? 0 : 400
    )
    // A previous band that ENDS INSIDE the final grid row (indices 3,4,5). The
    // walk must carry it out to 6; a `rowCount - 1` bound stops it at 5 and
    // leaves index 5's `trail` — the cell that carries the whole grid row's
    // height — outside the band.
    // Forced to the FIRST cell of the final grid row, with a viewport too short
    // to reach it on its own. The band therefore has to be built around index 3,
    // and the end-walk is the only thing that can carry it past the two leads to
    // the trail at index 5 that actually carries the row height.
    const input = {
      heights,
      rows,
      scrollTop: 0,
      forceIndex: 3,
      viewportHeight: 1,
      overscanPx: 0
    }
    const window = selectTranscriptWindow({ ...input, fanoutLaneSlots })
    expect(window.endIndex, 'the band must reach the end of the last grid row').toBe(LANES)
    // The invariant, stated as the code means it: no `lead` may be left outside.
    for (let index = window.startIndex; index < window.endIndex; index += 1) {
      if (fanoutLaneSlots.get(`row-${index}`) === 'lead') {
        expect(
          window.endIndex,
          `a lead at ${index} must not be the band's last row`
        ).toBeGreaterThan(index + 1)
      }
    }
    // Positive control, on the SAME input: give the walk nothing to extend (no
    // cell is a `lead`) and the band stops at 5. So the 6 above is the walk's
    // doing and not what every selection returns for these offsets — without
    // this, a band that reached the end by itself would make the assertion
    // above true for the wrong reason.
    const noLeads = new Map<string, 'lead' | 'trail' | 'solo'>()
    for (let index = 0; index < LANES; index += 1) noLeads.set(`row-${index}`, 'solo')
    const control = selectTranscriptWindow({ ...input, fanoutLaneSlots: noLeads })
    expect(
      control.endIndex,
      'the control must stop short, or the walk proves nothing'
    ).toBeLessThan(LANES)
  })

  it('never cuts a lane grid row at either edge or at a forced jump target, at any track count', () => {
    /*
     * The N generalisation of "never cuts a PAIR". A `% 2` assertion cannot
     * express this: at three tracks a band can be cut mid-grid-row in a way
     * that satisfies parity, and at any even track count a group-straddle bug
     * satisfies `% 2` outright. So the invariant is stated the way the code
     * means it — a band edge must not land where a `lead` (a cell with a
     * sibling after it on its grid row) is left outside the band — and the
     * `% N` form is asserted alongside it for a list whose every group is full.
     */
    const LANES = 30
    const slotsFor = (tracks: number): Map<string, 'lead' | 'trail' | 'solo'> => {
      const map = new Map<string, 'lead' | 'trail' | 'solo'>()
      for (let index = 0; index < LANES; index += 1) {
        const group = Math.floor(index / tracks)
        const size = Math.min(tracks, LANES - group * tracks)
        const position = index - group * tracks
        map.set(`row-${index}`, size === 1 ? 'solo' : position === size - 1 ? 'trail' : 'lead')
      }
      return map
    }
    const rows = Array.from({ length: LANES }, (_, index) => ({ rowKey: `row-${index}` }))

    for (const tracks of [2, 3, 5]) {
      const fanoutLaneSlots = slotsFor(tracks)
      // 30 divides by 2, 3 and 5, so every group is full and every grid-row
      // boundary is a multiple of the track count.
      expect(LANES % tracks, `every group is full at ${tracks} tracks`).toBe(0)
      const slotAt = (index: number): string | undefined =>
        index < 0 || index >= LANES ? undefined : fanoutLaneSlots.get(`row-${index}`)
      // The band's height model: only the cell that CLOSES a grid row carries
      // the band, exactly as the DOM measures it.
      const heights = Array.from({ length: LANES }, (_, index) =>
        slotAt(index) === 'lead' ? 0 : 400
      )
      let cutsWithoutTheExtension = 0
      let cutsAtTheEndEdge = 0
      // `previous` is in the table because the band edges only ever land inside
      // a grid row when something OTHER than the height model puts them there:
      // a lead's height is 0, so a selection driven by offsets alone lands on
      // group boundaries on its own and the end-edge walk has nothing to do.
      // The retained band from a measurement pass is exactly that something.
      const previousBands = [null, { startIndex: 0, endIndex: 4 }, { startIndex: 4, endIndex: 7 }]
      for (const scrollTop of [0, 300, 800, 1200, 3000, 7000]) {
        for (const forceIndex of [null, 3, 4, 5, 7, 17, 22]) {
          for (const previous of previousBands) {
            const input = {
              heights,
              rows,
              scrollTop,
              forceIndex,
              viewportHeight: 500,
              overscanPx: 0,
              ...(previous ? { previous } : {})
            }
            const window = selectTranscriptWindow({ ...input, fanoutLaneSlots })
            const label = `tracks ${tracks}, scrollTop ${scrollTop}, force ${forceIndex}, previous ${JSON.stringify(previous)}`
            expect(slotAt(window.startIndex - 1), `${label}: start cuts a grid row`).not.toBe(
              'lead'
            )
            expect(slotAt(window.endIndex - 1), `${label}: end cuts a grid row`).not.toBe('lead')
            expect(window.startIndex % tracks, `${label}: start`).toBe(0)
            expect(window.endIndex % tracks, `${label}: end`).toBe(0)
            if (forceIndex !== null) {
              expect(window.startIndex).toBeLessThanOrEqual(forceIndex)
              expect(window.endIndex).toBeGreaterThan(forceIndex)
            }
            // POSITIVE CONTROL, evaluated over the same grid: with the slot map
            // withheld the selection is free to cut a grid row, and does. An
            // assertion that never fires would pass whatever the extension did.
            const unextended = selectTranscriptWindow(input)
            if (slotAt(unextended.startIndex - 1) === 'lead') cutsWithoutTheExtension += 1
            if (slotAt(unextended.endIndex - 1) === 'lead') cutsAtTheEndEdge += 1
          }
        }
      }
      expect(
        cutsAtTheEndEdge,
        `the END edge must actually be exercised at ${tracks} tracks`
      ).toBeGreaterThan(0)
      expect(
        cutsWithoutTheExtension,
        `the matcher must be able to fire at ${tracks} tracks`
      ).toBeGreaterThan(0)
    }
  })

  it('walks out to the grid-row boundary rather than stepping once', () => {
    // The shipped extension moved each edge by exactly ONE, which is sufficient
    // at two tracks and at no other count. A band that opens on the LAST cell
    // of a five-across row has to reach back four rows, not one.
    const rows = Array.from({ length: 10 }, (_, index) => ({ rowKey: `row-${index}` }))
    const fanoutLaneSlots = new Map<string, 'lead' | 'trail'>(
      rows.map((row, index) => [row.rowKey, index % 5 === 4 ? 'trail' : 'lead'] as const)
    )
    const heights = rows.map((_, index) => (index % 5 === 4 ? 400 : 0))
    const window = selectTranscriptWindow({
      heights,
      rows,
      fanoutLaneSlots,
      scrollTop: 400,
      viewportHeight: 100,
      overscanPx: 0
    })
    expect(window.startIndex).toBe(5)
    expect(window.endIndex).toBe(10)
    expect(window.topSpacerPx).toBe(400)
  })

  it('keeps an empty transcript empty and bounds large histories to the viewport', () => {
    expect(selectTranscriptWindow({ heights: [], scrollTop: 5000, viewportHeight: 900 })).toEqual({
      startIndex: 0,
      endIndex: 0,
      topSpacerPx: 0,
      bottomSpacerPx: 0
    })
    const window = selectTranscriptWindow({
      heights: Array<number>(10_000).fill(100),
      scrollTop: 500_000,
      viewportHeight: 900
    })
    expect(window.endIndex - window.startIndex).toBeLessThan(30)
  })
})
