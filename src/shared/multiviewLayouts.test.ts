import { describe, expect, it } from 'vitest'
import {
  DEFAULT_MULTIVIEW_LAYOUT,
  MAX_MULTIVIEW_PANES,
  MULTIVIEW_LAYOUTS,
  MULTIVIEW_LAYOUT_IDS,
  clampFocusedPaneIndex,
  clampPaneChatIds,
  computeGutterSegments,
  defaultColumnFractions,
  defaultRowFractions,
  fractionsToTrackList,
  getMultiviewLayoutSpec,
  isMultiviewLayout,
  normalizeMultiviewLayout,
  paneCountForLayout,
  parseGridAreaMatrix,
  parseTrackFractions,
  type MultiviewLayout
} from './multiviewLayouts'

/** Parse a grid-template-areas value into a row-major grid of area tokens. */
function parseGridAreas(value: string): string[][] {
  const rows = value.match(/"([^"]*)"/g) ?? []
  return rows.map((row) => row.replace(/"/g, '').trim().split(/\s+/))
}

/** True when every named area in the grid forms a filled rectangle (valid CSS). */
function everyAreaIsRectangle(grid: string[][]): boolean {
  const coords = new Map<string, Array<[number, number]>>()
  grid.forEach((cols, r) =>
    cols.forEach((name, c) => {
      const list = coords.get(name) ?? []
      list.push([r, c])
      coords.set(name, list)
    })
  )
  for (const [, cells] of coords) {
    const rowsIdx = cells.map(([r]) => r)
    const colsIdx = cells.map(([, c]) => c)
    const minR = Math.min(...rowsIdx)
    const maxR = Math.max(...rowsIdx)
    const minC = Math.min(...colsIdx)
    const maxC = Math.max(...colsIdx)
    const area = (maxR - minR + 1) * (maxC - minC + 1)
    if (area !== cells.length) return false
  }
  return true
}

describe('multiviewLayouts catalogue', () => {
  it('exposes exactly the eight requested layouts', () => {
    expect([...MULTIVIEW_LAYOUT_IDS]).toEqual([
      'single',
      'vertical-2',
      'horizontal-2',
      'two-top-one-bottom',
      'one-top-two-bottom',
      'one-left-two-right',
      'two-left-one-right',
      'quad'
    ])
  })

  it('defaults to single and caps panes at four', () => {
    expect(DEFAULT_MULTIVIEW_LAYOUT).toBe('single')
    expect(MAX_MULTIVIEW_PANES).toBe(4)
    expect(paneCountForLayout('single')).toBe(1)
    expect(paneCountForLayout('quad')).toBe(4)
  })

  it('keeps cellAreas length aligned with paneCount and within the cap', () => {
    for (const id of MULTIVIEW_LAYOUT_IDS) {
      const spec = MULTIVIEW_LAYOUTS[id]
      expect(spec.id).toBe(id)
      expect(spec.cellAreas).toHaveLength(spec.paneCount)
      expect(spec.paneCount).toBeGreaterThanOrEqual(1)
      expect(spec.paneCount).toBeLessThanOrEqual(MAX_MULTIVIEW_PANES)
      expect(new Set(spec.cellAreas).size).toBe(spec.paneCount)
    }
  })

  it('grid-template-areas references exactly the cell areas, with equal columns per row', () => {
    for (const id of MULTIVIEW_LAYOUT_IDS) {
      const spec = MULTIVIEW_LAYOUTS[id]
      const grid = parseGridAreas(spec.gridTemplateAreas)
      const widths = new Set(grid.map((row) => row.length))
      expect(widths.size, `${id} rows must be equal width`).toBe(1)
      const tokens = new Set(grid.flat())
      expect(tokens).toEqual(new Set(spec.cellAreas))
      expect(grid).toHaveLength(spec.gridTemplateRows.trim().split(/\s+/).length)
      expect(grid[0]).toHaveLength(spec.gridTemplateColumns.trim().split(/\s+/).length)
    }
  })

  it('every named grid area forms a rectangle (valid CSS grid-template-areas)', () => {
    for (const id of MULTIVIEW_LAYOUT_IDS) {
      const grid = parseGridAreas(MULTIVIEW_LAYOUTS[id].gridTemplateAreas)
      expect(everyAreaIsRectangle(grid), `${id} has a non-rectangular area`).toBe(true)
    }
  })
})

describe('multiviewLayouts helpers', () => {
  it('guards and normalizes layout values', () => {
    expect(isMultiviewLayout('quad')).toBe(true)
    expect(isMultiviewLayout('nope')).toBe(false)
    expect(isMultiviewLayout(undefined)).toBe(false)
    expect(isMultiviewLayout(3)).toBe(false)
    expect(normalizeMultiviewLayout('vertical-2')).toBe('vertical-2')
    expect(normalizeMultiviewLayout('garbage')).toBe(DEFAULT_MULTIVIEW_LAYOUT)
    expect(normalizeMultiviewLayout(null)).toBe(DEFAULT_MULTIVIEW_LAYOUT)
  })

  it('getMultiviewLayoutSpec returns the matching spec', () => {
    expect(getMultiviewLayoutSpec('horizontal-2').gridTemplateRows).toBe('1fr 1fr')
    expect(getMultiviewLayoutSpec('horizontal-2').gridTemplateColumns).toBe('1fr')
  })

  it('clampPaneChatIds pads empty cells with null', () => {
    expect(clampPaneChatIds(['x'], 'quad')).toEqual(['x', null, null, null])
    expect(clampPaneChatIds([], 'vertical-2')).toEqual([null, null])
  })

  it('clampPaneChatIds truncates extra ids and preserves order', () => {
    expect(clampPaneChatIds(['a', 'b', 'c', 'd'], 'vertical-2')).toEqual(['a', 'b'])
    expect(clampPaneChatIds(['a', 'b', 'c'], 'single')).toEqual(['a'])
  })

  it('clampPaneChatIds coerces undefined holes to null', () => {
    const sparse: Array<string | null> = ['a']
    sparse[2] = 'c' // index 1 is a hole -> undefined
    expect(clampPaneChatIds(sparse, 'two-top-one-bottom')).toEqual(['a', null, 'c'])
  })

  it('clampFocusedPaneIndex keeps the index inside the layout', () => {
    expect(clampFocusedPaneIndex(0, 'single')).toBe(0)
    expect(clampFocusedPaneIndex(3, 'single')).toBe(0)
    expect(clampFocusedPaneIndex(9, 'quad')).toBe(3)
    expect(clampFocusedPaneIndex(-2, 'vertical-2')).toBe(0)
    expect(clampFocusedPaneIndex(1.5, 'quad')).toBe(0)
    expect(clampFocusedPaneIndex(2, 'two-left-one-right')).toBe(2)
  })

  it('every layout id round-trips through the catalogue', () => {
    const ids: MultiviewLayout[] = [...MULTIVIEW_LAYOUT_IDS]
    for (const id of ids) {
      expect(getMultiviewLayoutSpec(id)).toBe(MULTIVIEW_LAYOUTS[id])
    }
  })
})

describe('grid parsing helpers', () => {
  it('parseGridAreaMatrix builds a row-major matrix', () => {
    expect(parseGridAreaMatrix('"a b" "a c"')).toEqual([
      ['a', 'b'],
      ['a', 'c']
    ])
    expect(parseGridAreaMatrix('"a"')).toEqual([['a']])
    expect(parseGridAreaMatrix('   ')).toEqual([])
  })

  it('parseTrackFractions reads fr (and bare number) tracks, rejecting others', () => {
    expect(parseTrackFractions('1fr 1fr')).toEqual([1, 1])
    expect(parseTrackFractions('2fr 1fr')).toEqual([2, 1])
    expect(parseTrackFractions('1.5fr 0.5fr')).toEqual([1.5, 0.5])
    expect(parseTrackFractions('2 1')).toEqual([2, 1])
    expect(parseTrackFractions('1fr 200px')).toBeNull()
    expect(parseTrackFractions('')).toBeNull()
  })

  it('fractionsToTrackList serialises back to a fr list', () => {
    expect(fractionsToTrackList([1, 1])).toBe('1fr 1fr')
    expect(fractionsToTrackList([1.2, 0.8])).toBe('1.2fr 0.8fr')
  })

  it('default*Fractions derive equal tracks from each spec', () => {
    expect(defaultColumnFractions('vertical-2')).toEqual([1, 1])
    expect(defaultRowFractions('vertical-2')).toEqual([1])
    expect(defaultColumnFractions('horizontal-2')).toEqual([1])
    expect(defaultRowFractions('horizontal-2')).toEqual([1, 1])
    expect(defaultColumnFractions('quad')).toEqual([1, 1])
    expect(defaultRowFractions('quad')).toEqual([1, 1])
  })
})

describe('computeGutterSegments', () => {
  it('single layout has no gutters', () => {
    expect(computeGutterSegments('single')).toEqual([])
  })

  it('vertical-2: one full-height column gutter, no row gutters', () => {
    const segs = computeGutterSegments('vertical-2')
    expect(segs).toHaveLength(1)
    expect(segs[0]).toMatchObject({
      orientation: 'column',
      trackIndex: 0,
      gridColumn: '2',
      gridRow: '1 / 2'
    })
  })

  it('horizontal-2: one full-width row gutter, no column gutters', () => {
    const segs = computeGutterSegments('horizontal-2')
    expect(segs).toHaveLength(1)
    expect(segs[0]).toMatchObject({
      orientation: 'row',
      trackIndex: 0,
      gridRow: '2',
      gridColumn: '1 / 2'
    })
  })

  it('quad: a full-height column gutter and a full-width row gutter', () => {
    const segs = computeGutterSegments('quad')
    const cols = segs.filter((s) => s.orientation === 'column')
    const rows = segs.filter((s) => s.orientation === 'row')
    expect(cols).toHaveLength(1)
    expect(cols[0]).toMatchObject({ trackIndex: 0, gridColumn: '2', gridRow: '1 / 3' })
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ trackIndex: 0, gridRow: '2', gridColumn: '1 / 3' })
  })

  it('one-left-two-right ("a b" / "a c"): full-height col gutter; row gutter only in the right column', () => {
    const segs = computeGutterSegments('one-left-two-right')
    const cols = segs.filter((s) => s.orientation === 'column')
    const rows = segs.filter((s) => s.orientation === 'row')
    // Vertical line separates a|b (row1) and a|c (row2) -> full height.
    expect(cols).toHaveLength(1)
    expect(cols[0]).toMatchObject({ trackIndex: 0, gridColumn: '2', gridRow: '1 / 3' })
    // Horizontal line: col1 is a/a (same -> no gutter), col2 is b/c (diff).
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ trackIndex: 0, gridRow: '2', gridColumn: '2 / 3' })
  })

  it('two-left-one-right ("a c" / "b c"): full-height col gutter; row gutter only in the left column', () => {
    const segs = computeGutterSegments('two-left-one-right')
    const cols = segs.filter((s) => s.orientation === 'column')
    const rows = segs.filter((s) => s.orientation === 'row')
    expect(cols).toHaveLength(1)
    expect(cols[0]).toMatchObject({ trackIndex: 0, gridColumn: '2', gridRow: '1 / 3' })
    // Horizontal line: col1 a/b (diff), col2 c/c (same) -> gutter spans only col1.
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ trackIndex: 0, gridRow: '2', gridColumn: '1 / 2' })
  })

  it('two-top-one-bottom ("a b" / "c c"): full-width row gutter; col gutter only in the top row', () => {
    const segs = computeGutterSegments('two-top-one-bottom')
    const cols = segs.filter((s) => s.orientation === 'column')
    const rows = segs.filter((s) => s.orientation === 'row')
    // Vertical line: row1 a|b (diff), row2 c|c (same) -> gutter spans only row1.
    expect(cols).toHaveLength(1)
    expect(cols[0]).toMatchObject({ trackIndex: 0, gridColumn: '2', gridRow: '1 / 2' })
    // Horizontal line: col1 a/c (diff), col2 b/c (diff) -> full width.
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ trackIndex: 0, gridRow: '2', gridColumn: '1 / 3' })
  })

  it('one-top-two-bottom ("a a" / "b c"): full-width row gutter; col gutter only in the bottom row', () => {
    const segs = computeGutterSegments('one-top-two-bottom')
    const cols = segs.filter((s) => s.orientation === 'column')
    const rows = segs.filter((s) => s.orientation === 'row')
    // Vertical line: row1 a|a (same), row2 b|c (diff) -> gutter spans only row2.
    expect(cols).toHaveLength(1)
    expect(cols[0]).toMatchObject({ trackIndex: 0, gridColumn: '2', gridRow: '2 / 3' })
    // Horizontal line: col1 a/b (diff), col2 a/c (diff) -> full width.
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ trackIndex: 0, gridRow: '2', gridColumn: '1 / 3' })
  })

  it('every split layout produces at least one gutter and unique segment keys', () => {
    for (const id of MULTIVIEW_LAYOUT_IDS) {
      if (id === 'single') continue
      const segs = computeGutterSegments(id)
      expect(segs.length, `${id} should have gutters`).toBeGreaterThan(0)
      const keys = segs.map((s) => s.key)
      expect(new Set(keys).size, `${id} segment keys must be unique`).toBe(keys.length)
    }
  })
})
