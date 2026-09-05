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

  it('never cuts a paired grid band at either edge or at a forced jump target', () => {
    const rows = Array.from({ length: 20 }, (_, index) => ({ rowKey: `row-${index}` }))
    const fanoutLaneSlots = new Map(
      rows.map((row, index) => [row.rowKey, index % 2 === 0 ? 'lead' : 'trail'] as const)
    )
    const heights = rows.map((_, index) => (index % 2 === 0 ? 0 : 400))
    for (const scrollTop of [0, 300, 800, 1200, 3000]) {
      for (const forceIndex of [null, 4, 5, 17]) {
        const window = selectTranscriptWindow({
          heights,
          rows,
          fanoutLaneSlots,
          scrollTop,
          forceIndex,
          viewportHeight: 500,
          overscanPx: 0
        })
        expect(window.startIndex % 2).toBe(0)
        expect(window.endIndex % 2).toBe(0)
        if (forceIndex !== null) {
          expect(window.startIndex).toBeLessThanOrEqual(forceIndex)
          expect(window.endIndex).toBeGreaterThan(forceIndex)
        }
      }
    }
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
