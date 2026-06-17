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
    next.push(i < ids.length ? ids[i] ?? null : null)
  }
  return next
}

/** Keep a focused-pane index inside [0, paneCount) for the given layout. */
export function clampFocusedPaneIndex(index: number, layout: MultiviewLayout): number {
  const count = paneCountForLayout(layout)
  if (!Number.isInteger(index) || index < 0) return 0
  return index >= count ? count - 1 : index
}
