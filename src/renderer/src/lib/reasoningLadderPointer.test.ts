import { describe, expect, it } from 'vitest'
import {
  buildLadderMarks,
  ladderDeadbandFraction,
  ladderPointerFraction,
  ladderStopFraction,
  resolveLadderPointerStop,
  stepLadderDrag
} from './reasoningLadderPointer'

const MAX = 7
const FULL = [1, 2, 3, 4, 5, 6, 7]
const KIMI = [1, 3, 5]
const at = (index: number): number => ladderStopFraction(index, MAX)
// A 172px track with the shipped 11px inset: 150px of travel, so 1px ≈ 0.0067.
const px = (n: number): number => n / 150
const DEADBAND = ladderDeadbandFraction(172, 11)

describe('ladder rail geometry', () => {
  it('spreads the eight stops evenly from bottom to top', () => {
    expect(at(0)).toBe(0)
    expect(at(7)).toBe(1)
    expect(at(3)).toBeCloseTo(3 / 7)
  })

  it('maps pointer y onto the usable rail and clamps outside it', () => {
    const rail = { top: 100, height: 172 }
    expect(ladderPointerFraction(111, rail, 11)).toBeCloseTo(1)
    expect(ladderPointerFraction(261, rail, 11)).toBeCloseTo(0)
    expect(ladderPointerFraction(186, rail, 11)).toBeCloseTo(0.5)
    expect(ladderPointerFraction(40, rail, 11)).toBe(1)
    expect(ladderPointerFraction(400, rail, 11)).toBe(0)
  })

  it('expresses the 3px deadband against the usable travel', () => {
    expect(DEADBAND).toBeCloseTo(3 / 150)
  })
})

describe('resolveLadderPointerStop', () => {
  it('lands on the nearest enabled stop by true distance', () => {
    expect(
      resolveLadderPointerStop({ fraction: at(2) + px(4), enabledIndices: FULL, maxIndex: MAX })
    ).toBe(2)
    expect(resolveLadderPointerStop({ fraction: 0, enabledIndices: FULL, maxIndex: MAX })).toBe(1)
    expect(resolveLadderPointerStop({ fraction: 1, enabledIndices: KIMI, maxIndex: MAX })).toBe(5)
  })

  it('centres the boundary across a gap and breaks the exact tie upward', () => {
    // Kimi skips Extra (4): High (3) and Max (5) meet exactly at Extra's height.
    expect(
      resolveLadderPointerStop({ fraction: at(4) - px(1), enabledIndices: KIMI, maxIndex: MAX })
    ).toBe(3)
    expect(resolveLadderPointerStop({ fraction: at(4), enabledIndices: KIMI, maxIndex: MAX })).toBe(
      5
    )
    expect(
      resolveLadderPointerStop({ fraction: at(4) + px(1), enabledIndices: KIMI, maxIndex: MAX })
    ).toBe(5)
  })

  it('holds the current stop until the pointer is past the midpoint by the deadband', () => {
    const mid = (at(3) + at(4)) / 2
    const hold = (fraction: number) =>
      resolveLadderPointerStop({
        fraction,
        enabledIndices: FULL,
        maxIndex: MAX,
        currentIndex: 3,
        deadbandFraction: DEADBAND
      })
    expect(hold(mid + px(1))).toBe(3)
    expect(hold(mid + px(2.9))).toBe(3)
    expect(hold(mid + px(3.5))).toBe(4)
    // …and symmetrically from the other side once 4 is held.
    const back = (fraction: number) =>
      resolveLadderPointerStop({
        fraction,
        enabledIndices: FULL,
        maxIndex: MAX,
        currentIndex: 4,
        deadbandFraction: DEADBAND
      })
    expect(back(mid - px(2))).toBe(4)
    expect(back(mid - px(4))).toBe(3)
  })

  it('never returns a stop the model does not offer', () => {
    for (let step = 0; step <= 100; step += 1) {
      const stop = resolveLadderPointerStop({
        fraction: step / 100,
        enabledIndices: KIMI,
        maxIndex: MAX,
        currentIndex: 3,
        deadbandFraction: DEADBAND
      })
      expect(KIMI).toContain(stop)
    }
  })

  it('ignores a held stop that is no longer enabled', () => {
    expect(
      resolveLadderPointerStop({
        fraction: at(3),
        enabledIndices: KIMI,
        maxIndex: MAX,
        currentIndex: 4,
        deadbandFraction: DEADBAND
      })
    ).toBe(3)
  })

  it('returns null when nothing is enabled', () => {
    expect(
      resolveLadderPointerStop({ fraction: 0.5, enabledIndices: [], maxIndex: MAX })
    ).toBeNull()
  })
})

describe('stepLadderDrag', () => {
  const rail = { enabledIndices: FULL, maxIndex: MAX, deadbandFraction: DEADBAND }

  it('jumps straight to the pressed stop, with no deadband to beat', () => {
    expect(stepLadderDrag(null, { type: 'press', fraction: at(6) - px(9) }, rail)).toEqual({
      dragIndex: 6,
      commitIndex: null
    })
  })

  it('commits exactly the stop on screen on release, never the release point', () => {
    const mid = (at(3) + at(4)) / 2
    const pressed = stepLadderDrag(null, { type: 'press', fraction: at(3) }, rail)
    // The pointer ends 2px past the midpoint: inside the deadband, so the
    // thumb still shows High. A release that re-read the pointer would pick
    // Extra and move the thumb after the user let go.
    const moved = stepLadderDrag(pressed.dragIndex, { type: 'move', fraction: mid + px(2) }, rail)
    expect(moved.dragIndex).toBe(3)
    expect(stepLadderDrag(moved.dragIndex, { type: 'release' }, rail)).toEqual({
      dragIndex: null,
      commitIndex: 3
    })
  })

  it('commits nothing on cancel or on a release without a press', () => {
    expect(stepLadderDrag(5, { type: 'cancel' }, rail)).toEqual({
      dragIndex: null,
      commitIndex: null
    })
    expect(stepLadderDrag(null, { type: 'release' }, rail)).toEqual({
      dragIndex: null,
      commitIndex: null
    })
    expect(stepLadderDrag(null, { type: 'move', fraction: 0.9 }, rail)).toEqual({
      dragIndex: null,
      commitIndex: null
    })
  })
})

describe('buildLadderMarks', () => {
  it('marks every stop, flags the offered ones, and splits them at the thumb', () => {
    const marks = buildLadderMarks(KIMI, 3, MAX)
    expect(marks).toHaveLength(8)
    expect(marks.filter((mark) => mark.enabled).map((mark) => mark.index)).toEqual([1, 3, 5])
    expect(marks.filter((mark) => mark.reached).map((mark) => mark.index)).toEqual([1])
    expect(marks.filter((mark) => mark.current).map((mark) => mark.index)).toEqual([3])
    // An unsupported level is never reached or current, even below the thumb.
    expect(marks[2]).toEqual({ index: 2, enabled: false, reached: false, current: false })
  })

  it('draws nothing for a model whose reasoning is not configurable', () => {
    expect(buildLadderMarks([], 0, MAX)).toEqual([])
  })
})
