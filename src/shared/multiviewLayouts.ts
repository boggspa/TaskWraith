/**
 * Multiview layout catalogue — the pure, node-free contract shared by the
 * renderer (useMultiviewState, the pane grid, the composer picker) and by
 * settings validation. No imports from main/renderer; data + pure helpers only.
 *
 * Multiview splits ONLY the central chat pane into 1-4 panes. It is distinct
 * from the existing side-chats feature and never touches either sidebar.
 */

export const MULTIVIEW_LAYOUT_IDS = [
  'single',
  'vertical-2',
  'horizontal-2',
  'two-top-one-bottom',
  'one-top-two-bottom',
  'one-left-two-right',
  'two-left-one-right',
  'quad'
] as const

export type MultiviewLayout = (typeof MULTIVIEW_LAYOUT_IDS)[number]

/**
 * A single Multiview pane (grid cell) as a STABLE record rather than a bare
 * array slot. `id` is a per-pane identity that survives layout changes, focus
 * moves, and the compaction that follows closing another pane — so per-pane
 * settings (FX overrides today; preview target / device / platform later) key
 * off `id`, NOT the array index, and are never misattributed when indices
 * shift. `chatId` is the chat shown in the pane (null = an empty cell).
 *
 * Lives in this node-free contract module so the renderer (useMultiviewState,
 * the pane grid) and any future persistence/validation share one shape.
 */
export interface MultiviewPaneRecord {
  id: string
  chatId: string | null
}

export interface MultiviewLayoutSpec {
  id: MultiviewLayout
  /** Human label for the layout picker. */
  label: string
  /** Number of panes this layout renders (1-4). */
  paneCount: number
  /** pane-index -> CSS grid-area name; length always equals paneCount. */
  cellAreas: string[]
  /** CSS grid-template-areas value (rows quoted, columns space-separated). */
  gridTemplateAreas: string
  gridTemplateColumns: string
  gridTemplateRows: string
}

export const DEFAULT_MULTIVIEW_LAYOUT: MultiviewLayout = 'single'

export const MAX_MULTIVIEW_PANES = 4

/**
 * Every layout, keyed by id. cellAreas[index] is the grid-area for pane
 * `index`; each named area forms a rectangle so the grid-template-areas value
 * is valid CSS.
 */
export const MULTIVIEW_LAYOUTS: Record<MultiviewLayout, MultiviewLayoutSpec> = {
  single: {
    id: 'single',
    label: 'Single',
    paneCount: 1,
    cellAreas: ['a'],
    gridTemplateAreas: '"a"',
    gridTemplateColumns: '1fr',
    gridTemplateRows: '1fr'
  },
  'vertical-2': {
    id: 'vertical-2',
    label: 'Vertical split',
    paneCount: 2,
    cellAreas: ['a', 'b'],
    gridTemplateAreas: '"a b"',
    gridTemplateColumns: '1fr 1fr',
    gridTemplateRows: '1fr'
  },
  'horizontal-2': {
    id: 'horizontal-2',
    label: 'Horizontal split',
    paneCount: 2,
    cellAreas: ['a', 'b'],
    gridTemplateAreas: '"a" "b"',
    gridTemplateColumns: '1fr',
    gridTemplateRows: '1fr 1fr'
  },
  'two-top-one-bottom': {
    id: 'two-top-one-bottom',
    label: '2 top, 1 bottom',
    paneCount: 3,
    cellAreas: ['a', 'b', 'c'],
    gridTemplateAreas: '"a b" "c c"',
    gridTemplateColumns: '1fr 1fr',
    gridTemplateRows: '1fr 1fr'
  },
  'one-top-two-bottom': {
    id: 'one-top-two-bottom',
    label: '1 top, 2 bottom',
    paneCount: 3,
    cellAreas: ['a', 'b', 'c'],
    gridTemplateAreas: '"a a" "b c"',
    gridTemplateColumns: '1fr 1fr',
    gridTemplateRows: '1fr 1fr'
  },
  'one-left-two-right': {
    id: 'one-left-two-right',
    label: '1 left, 2 right',
    paneCount: 3,
    cellAreas: ['a', 'b', 'c'],
    gridTemplateAreas: '"a b" "a c"',
    gridTemplateColumns: '1fr 1fr',
    gridTemplateRows: '1fr 1fr'
  },
  'two-left-one-right': {
    id: 'two-left-one-right',
    label: '2 left, 1 right',
    paneCount: 3,
    cellAreas: ['a', 'b', 'c'],
    gridTemplateAreas: '"a c" "b c"',
    gridTemplateColumns: '1fr 1fr',
    gridTemplateRows: '1fr 1fr'
  },
  quad: {
    id: 'quad',
    label: 'Quad',
    paneCount: 4,
    cellAreas: ['a', 'b', 'c', 'd'],
    gridTemplateAreas: '"a b" "c d"',
    gridTemplateColumns: '1fr 1fr',
    gridTemplateRows: '1fr 1fr'
  }
}

export function isMultiviewLayout(value: unknown): value is MultiviewLayout {
  return typeof value === 'string' && (MULTIVIEW_LAYOUT_IDS as readonly string[]).includes(value)
}

/** Coerce an unknown (e.g. a persisted setting) to a valid layout. */
export function normalizeMultiviewLayout(value: unknown): MultiviewLayout {
  return isMultiviewLayout(value) ? value : DEFAULT_MULTIVIEW_LAYOUT
}

export function getMultiviewLayoutSpec(layout: MultiviewLayout): MultiviewLayoutSpec {
  return MULTIVIEW_LAYOUTS[layout]
}

export function paneCountForLayout(layout: MultiviewLayout): number {
  return MULTIVIEW_LAYOUTS[layout].paneCount
}

/**
 * Pad with null / truncate so the assignment array length matches the layout's
 * pane count. Index = grid cell; null = an empty cell. Order is preserved.
 */
export function clampPaneChatIds(
  ids: ReadonlyArray<string | null>,
  layout: MultiviewLayout
): (string | null)[] {
  const count = paneCountForLayout(layout)
  const next: (string | null)[] = []
  for (let i = 0; i < count; i++) {
    next.push(i < ids.length ? (ids[i] ?? null) : null)
  }
  return next
}

/** Keep a focused-pane index inside [0, paneCount) for the given layout. */
export function clampFocusedPaneIndex(index: number, layout: MultiviewLayout): number {
  const count = paneCountForLayout(layout)
  if (!Number.isInteger(index) || index < 0) return 0
  return index >= count ? count - 1 : index
}

/* ============================================================
   Gutter geometry — pure, node-free helpers used by the pane
   grid to draw draggable dividers and by useMultiviewState to
   seed/clamp per-layout track fractions. All derived from the
   layout spec's grid-template-areas / -columns / -rows strings.
   ============================================================ */

/**
 * Parse a CSS grid-template-areas value into a row-major matrix of area names.
 * `'"a b" "a c"'` -> `[['a','b'],['a','c']]`. Tolerant of extra whitespace.
 * Returns `[]` for an empty/unparseable value. Assumes a rectangular grid
 * (every row has the same column count), which all catalogue layouts satisfy.
 */
export function parseGridAreaMatrix(gridTemplateAreas: string): string[][] {
  const rows = gridTemplateAreas.match(/"([^"]*)"/g)
  if (!rows) return []
  return rows
    .map((row) => row.slice(1, -1).trim().split(/\s+/).filter(Boolean))
    .filter((cells) => cells.length > 0)
}

/**
 * Split a single CSS track list (e.g. `'1fr 1fr'` or `'2fr 1fr'`) into numeric
 * fractions. Only plain `<number>fr` (or a bare number) tracks are understood;
 * anything else yields `null` so callers fall back to the literal spec string
 * rather than guessing. The catalogue only ever uses `fr` tracks.
 */
export function parseTrackFractions(trackList: string): number[] | null {
  const parts = trackList.trim().split(/\s+/).filter(Boolean)
  if (parts.length === 0) return null
  const fractions: number[] = []
  for (const part of parts) {
    const match = /^(\d+(?:\.\d+)?)fr$/.exec(part) ?? /^(\d+(?:\.\d+)?)$/.exec(part)
    if (!match) return null
    fractions.push(Number(match[1]))
  }
  return fractions
}

/** Render an array of fractions back into a CSS `fr` track list. */
export function fractionsToTrackList(fractions: ReadonlyArray<number>): string {
  return fractions.map((f) => `${f}fr`).join(' ')
}

/**
 * The default column / row fractions for a layout, parsed from its spec. Used
 * as the reset target and the initial stateful value. Falls back to N equal
 * tracks if the spec string isn't a clean `fr` list.
 */
export function defaultColumnFractions(layout: MultiviewLayout): number[] {
  const spec = MULTIVIEW_LAYOUTS[layout]
  const matrix = parseGridAreaMatrix(spec.gridTemplateAreas)
  const cols = matrix[0]?.length ?? 1
  return parseTrackFractions(spec.gridTemplateColumns) ?? new Array(cols).fill(1)
}

export function defaultRowFractions(layout: MultiviewLayout): number[] {
  const spec = MULTIVIEW_LAYOUTS[layout]
  const matrix = parseGridAreaMatrix(spec.gridTemplateAreas)
  const rows = matrix.length || 1
  return parseTrackFractions(spec.gridTemplateRows) ?? new Array(rows).fill(1)
}

export type MultiviewGutterOrientation = 'column' | 'row'

/**
 * One draggable divider segment. `trackIndex` is the index of the track BEFORE
 * the boundary (so a column gutter resizes columns[trackIndex] and
 * columns[trackIndex+1]). `gridColumn` / `gridRow` are CSS grid-line ranges
 * (1-based, `start / end` form) that place the segment exactly on the boundary
 * and span only the cells where it separates two different areas.
 */
export interface MultiviewGutterSegment {
  orientation: MultiviewGutterOrientation
  /** Index of the track immediately before the boundary line. */
  trackIndex: number
  /** Stable key (orientation + boundary + segment span). */
  key: string
  /** CSS `grid-column` value placing the segment across the boundary. */
  gridColumn: string
  /** CSS `grid-row` value placing the segment across the boundary. */
  gridRow: string
}

/**
 * Compute the draggable gutter segments for a layout from its area matrix.
 *
 * For every internal vertical line (between column c and c+1) we walk the rows
 * and emit a gutter only across the maximal contiguous run(s) of rows where the
 * left and right cells belong to DIFFERENT areas — so an area that spans the
 * line (e.g. `a` in `'"a b" "a c"'`) produces no gutter there, while the broken
 * line on the right yields a segment spanning only its rows. Horizontal lines
 * are handled symmetrically across columns. A line that never separates two
 * different areas (an area spans it everywhere) yields no segment and stays
 * fixed.
 */
export function computeGutterSegments(layout: MultiviewLayout): MultiviewGutterSegment[] {
  const spec = MULTIVIEW_LAYOUTS[layout]
  const matrix = parseGridAreaMatrix(spec.gridTemplateAreas)
  const rowCount = matrix.length
  const colCount = matrix[0]?.length ?? 0
  if (rowCount === 0 || colCount === 0) return []

  const segments: MultiviewGutterSegment[] = []

  // Vertical lines: between column c (0-based) and c+1, for c in [0, colCount-2].
  for (let c = 0; c < colCount - 1; c += 1) {
    let runStart = -1
    for (let r = 0; r <= rowCount; r += 1) {
      const separates = r < rowCount && matrix[r][c] !== matrix[r][c + 1]
      if (separates && runStart === -1) {
        runStart = r
      } else if (!separates && runStart !== -1) {
        // Close the run [runStart, r). Grid lines are 1-based.
        segments.push({
          orientation: 'column',
          trackIndex: c,
          key: `col-${c}-rows-${runStart}-${r}`,
          gridColumn: `${c + 2}`,
          gridRow: `${runStart + 1} / ${r + 1}`
        })
        runStart = -1
      }
    }
  }

  // Horizontal lines: between row r and r+1, for r in [0, rowCount-2].
  for (let r = 0; r < rowCount - 1; r += 1) {
    let runStart = -1
    for (let c = 0; c <= colCount; c += 1) {
      const separates = c < colCount && matrix[r][c] !== matrix[r + 1][c]
      if (separates && runStart === -1) {
        runStart = c
      } else if (!separates && runStart !== -1) {
        segments.push({
          orientation: 'row',
          trackIndex: r,
          key: `row-${r}-cols-${runStart}-${c}`,
          gridRow: `${r + 2}`,
          gridColumn: `${runStart + 1} / ${c + 1}`
        })
        runStart = -1
      }
    }
  }

  return segments
}
