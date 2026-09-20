import {
  MAX_MULTIVIEW_PANES,
  MULTIVIEW_LAYOUT_IDS,
  getMultiviewLayoutSpec,
  parseGridAreaMatrix,
  type MultiviewLayout,
  type MultiviewPaneRecord
} from '../../../shared/multiviewLayouts'
import type { MultiviewCoreState, MultiviewLayoutTracks } from '../hooks/useMultiviewState'

export type MultiviewDropZone = 'left' | 'right' | 'top' | 'bottom' | 'center'
export interface MultiviewThreadDropRequest {
  chatId: string
  targetPaneId: string
  zone: MultiviewDropZone
  /** The single-view host owns its selection until the first split. */
  visibleChatId: string | null
}

export interface MultiviewPlacementRect {
  left: number
  top: number
  width: number
  height: number
}

export interface MultiviewThreadPlacement {
  base: MultiviewCoreState
  request: MultiviewThreadDropRequest
  next: MultiviewCoreState | null
  destinationIndex: number
  label: string
  kind: 'split' | 'replace' | 'fill' | 'focus' | 'blocked'
}

export function multiviewPlacementTracks(
  state: Pick<MultiviewCoreState, 'trackSizes'>,
  layout: MultiviewLayout
): MultiviewLayoutTracks {
  const matrix = parseGridAreaMatrix(getMultiviewLayoutSpec(layout).gridTemplateAreas)
  const stored = state.trackSizes[layout]
  return {
    columns: stored?.columns.length === matrix[0].length ? stored.columns : matrix[0].map(() => 1),
    rows: stored?.rows.length === matrix.length ? stored.rows : matrix.map(() => 1)
  }
}

export function multiviewPlacementRects(
  state: Pick<MultiviewCoreState, 'layout' | 'trackSizes'>
): MultiviewPlacementRect[] {
  const spec = getMultiviewLayoutSpec(state.layout)
  const matrix = parseGridAreaMatrix(spec.gridTemplateAreas)
  const tracks = multiviewPlacementTracks(state, state.layout)
  const boundaries = (weights: number[]) => {
    const total = weights.reduce((sum, weight) => sum + weight, 0)
    const result = [0]
    for (const weight of weights) result.push(result[result.length - 1] + weight / total)
    return result
  }
  const xs = boundaries(tracks.columns)
  const ys = boundaries(tracks.rows)
  return spec.cellAreas.map((area) => {
    let left = 1
    let top = 1
    let right = 0
    let bottom = 0
    matrix.forEach((row, y) => {
      row.forEach((cell, x) => {
        if (cell !== area) return
        left = Math.min(left, xs[x])
        top = Math.min(top, ys[y])
        right = Math.max(right, xs[x + 1])
        bottom = Math.max(bottom, ys[y + 1])
      })
    })
    return { left, top, width: right - left, height: bottom - top }
  })
}

export function multiviewDropZoneAt(x: number, y: number): MultiviewDropZone {
  const edges = [
    ['left', x],
    ['right', 1 - x],
    ['top', y],
    ['bottom', 1 - y]
  ] as const
  const nearest = [...edges].sort((a, b) => a[1] - b[1])[0]
  return nearest[1] < 0.25 ? nearest[0] : 'center'
}

const isEmpty = (pane: MultiviewPaneRecord) => !pane.chatId && !pane.canvasId && !pane.mediaRef
const withChat = (pane: MultiviewPaneRecord, chatId: string | null): MultiviewPaneRecord =>
  pane.chatId === chatId && !pane.canvasId && !pane.mediaRef
    ? pane
    : { ...pane, chatId, canvasId: null, mediaRef: null }

function adjacent(
  anchor: MultiviewPlacementRect,
  incoming: MultiviewPlacementRect,
  zone: Exclude<MultiviewDropZone, 'center'>
): boolean {
  const near = (a: number, b: number) => Math.abs(a - b) < 0.00001
  const overlapsX =
    Math.min(anchor.left + anchor.width, incoming.left + incoming.width) >
    Math.max(anchor.left, incoming.left) + 0.00001
  const overlapsY =
    Math.min(anchor.top + anchor.height, incoming.top + incoming.height) >
    Math.max(anchor.top, incoming.top) + 0.00001
  if (zone === 'left') return overlapsY && near(incoming.left + incoming.width, anchor.left)
  if (zone === 'right') return overlapsY && near(anchor.left + anchor.width, incoming.left)
  if (zone === 'top') return overlapsX && near(incoming.top + incoming.height, anchor.top)
  return overlapsX && near(anchor.top + anchor.height, incoming.top)
}

function movement(a: MultiviewPlacementRect, b: MultiviewPlacementRect): number {
  return (
    (a.left + a.width / 2 - b.left - b.width / 2) ** 2 +
    (a.top + a.height / 2 - b.top - b.height / 2) ** 2 +
    0.15 * ((a.width - b.width) ** 2 + (a.height - b.height) ** 2)
  )
}

/** Small assignment problem (at most eight cells), cached by occupied-slot mask. */
function assignSurvivors(
  oldRects: MultiviewPlacementRect[],
  newRects: MultiviewPlacementRect[],
  survivors: number[],
  used: number
): { cost: number; slots: number[] } {
  const cache = new Map<number, { cost: number; slots: number[] }>()
  const solve = (index: number, mask: number): { cost: number; slots: number[] } => {
    if (index === survivors.length) return { cost: 0, slots: [] }
    const cached = cache.get(mask)
    if (cached) return cached
    let best = { cost: Infinity, slots: [] as number[] }
    newRects.forEach((rect, slot) => {
      if (mask & (1 << slot)) return
      const tail = solve(index + 1, mask | (1 << slot))
      const cost = movement(oldRects[survivors[index]], rect) + tail.cost
      if (cost < best.cost) best = { cost, slots: [slot, ...tail.slots] }
    })
    cache.set(mask, best)
    return best
  }
  return solve(0, used)
}

/** Pure preview. No focus, layout, draft, or transcript changes occur on hover. */
export function planMultiviewThreadPlacement(
  base: MultiviewCoreState,
  request: MultiviewThreadDropRequest
): MultiviewThreadPlacement {
  const blocked = (label: string): MultiviewThreadPlacement => ({
    base,
    request,
    next: null,
    destinationIndex: -1,
    label,
    kind: 'blocked'
  })
  if (!request.chatId) return blocked('Thread unavailable')
  const targetIndex = base.panes.findIndex((pane) => pane.id === request.targetPaneId)
  if (targetIndex < 0) return blocked('View changed — drag again')
  const state =
    base.layout === 'single'
      ? { ...base, panes: [withChat(base.panes[0], request.visibleChatId)] }
      : base
  const finish = (
    next: MultiviewCoreState,
    destinationIndex: number,
    kind: MultiviewThreadPlacement['kind'],
    label: string
  ): MultiviewThreadPlacement => ({ base, request, next, destinationIndex, kind, label })

  const existing = state.panes.findIndex((pane) => pane.chatId === request.chatId)
  if (existing >= 0) {
    return finish(
      { ...state, focusedPaneIndex: existing },
      existing,
      'focus',
      'Focus existing view'
    )
  }
  const target = state.panes[targetIndex]
  if (isEmpty(target) || (request.zone === 'center' && state.layout !== 'single')) {
    const panes = state.panes.slice()
    panes[targetIndex] = withChat(target, request.chatId)
    const empty = isEmpty(target)
    return finish(
      { ...state, panes },
      targetIndex,
      empty ? 'fill' : 'replace',
      empty ? 'Open in this view' : 'Replace this view'
    )
  }

  // A central drop on the single transcript defaults to opening beside it.
  const zone = request.zone === 'center' ? 'right' : request.zone
  const oldRects = multiviewPlacementRects(state)
  const emptySlots = state.panes.flatMap((pane, index) => (isEmpty(pane) ? [index] : []))
  // A spare adjacent cell already provides the requested split, even at eight panes.
  const spare = emptySlots.find((index) => adjacent(oldRects[targetIndex], oldRects[index], zone))
  if (spare !== undefined) {
    const panes = state.panes.slice()
    panes[spare] = withChat(panes[spare], request.chatId)
    return finish({ ...state, panes }, spare, 'fill', `Open ${zone}`)
  }
  if (state.panes.length >= MAX_MULTIVIEW_PANES) {
    return blocked(
      emptySlots.length ? 'Drop into an empty view' : `Maximum ${MAX_MULTIVIEW_PANES} panes`
    )
  }
  const nextCount = Math.min(
    ...MULTIVIEW_LAYOUT_IDS.map((layout) => getMultiviewLayoutSpec(layout).paneCount).filter(
      (count) => count > state.panes.length
    )
  )
  const survivors = state.panes.flatMap((_, index) => (index === targetIndex ? [] : [index]))
  let best:
    | { cost: number; layout: MultiviewLayout; anchor: number; incoming: number; slots: number[] }
    | undefined
  for (const layout of MULTIVIEW_LAYOUT_IDS) {
    if (getMultiviewLayoutSpec(layout).paneCount !== nextCount) continue
    const newRects = multiviewPlacementRects({ ...state, layout })
    newRects.forEach((anchorRect, anchor) => {
      newRects.forEach((incomingRect, incoming) => {
        if (!adjacent(anchorRect, incomingRect, zone)) return
        const assignment = assignSurvivors(
          oldRects,
          newRects,
          survivors,
          (1 << anchor) | (1 << incoming)
        )
        const union = {
          left: Math.min(anchorRect.left, incomingRect.left),
          top: Math.min(anchorRect.top, incomingRect.top),
          width:
            Math.max(anchorRect.left + anchorRect.width, incomingRect.left + incomingRect.width) -
            Math.min(anchorRect.left, incomingRect.left),
          height:
            Math.max(anchorRect.top + anchorRect.height, incomingRect.top + incomingRect.height) -
            Math.min(anchorRect.top, incomingRect.top)
        }
        const cost = assignment.cost + movement(oldRects[targetIndex], union)
        if (!best || cost < best.cost) {
          best = { cost, layout, anchor, incoming, slots: assignment.slots }
        }
      })
    })
  }
  if (!best) return blocked('Choose another edge or use the layout picker')

  let nextPaneSeq = state.nextPaneSeq
  const panes = new Array<MultiviewPaneRecord>(nextCount)
  panes[best.anchor] = target
  survivors.forEach((oldIndex, index) => {
    panes[best!.slots[index]] = state.panes[oldIndex]
  })
  // Parked records stay parked: a drag must never silently restore/replace hidden views.
  for (let index = 0; index < nextCount; index += 1) {
    if (!panes[index]) {
      panes[index] = {
        id: `pane-${nextPaneSeq++}`,
        chatId: index === best.incoming ? request.chatId : null
      }
    }
  }
  const focusedId = state.panes[state.focusedPaneIndex].id
  return finish(
    {
      ...state,
      layout: best.layout,
      panes,
      focusedPaneIndex: panes.findIndex((pane) => pane.id === focusedId),
      nextPaneSeq
    },
    best.incoming,
    'split',
    `Open ${zone} · ${getMultiviewLayoutSpec(best.layout).label}`
  )
}

/** A release commits only the exact state the user previewed. */
export function applyMultiviewThreadPlacement(
  current: MultiviewCoreState,
  placement: MultiviewThreadPlacement
): MultiviewCoreState {
  return current === placement.base && placement.next ? placement.next : current
}
