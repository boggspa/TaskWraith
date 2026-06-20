import { useCallback, useMemo, useRef, useState } from 'react'
import type { RefObject } from 'react'
import {
  DEFAULT_MULTIVIEW_LAYOUT,
  MAX_MULTIVIEW_PANES,
  clampFocusedPaneIndex,
  clampPaneChatIds,
  defaultColumnFractions,
  defaultRowFractions,
  paneCountForLayout,
  type MultiviewGutterOrientation,
  type MultiviewLayout
} from '../../../shared/multiviewLayouts'

/**
 * useMultiviewState — owns the renderer-only Multiview state (which layout,
 * which chat is in each pane, and which pane is focused). It writes NO App.tsx
 * singleton; the focused pane is wired to the existing currentChat machinery in
 * a later slice. All the real logic lives in the pure `apply*` transitions
 * below so they can be unit-tested without a DOM (the repo avoids jsdom).
 */

/** Per-layout column/row track fractions (the `fr` weights the grid uses). */
export interface MultiviewLayoutTracks {
  columns: number[]
  rows: number[]
}

/**
 * Stateful track fractions keyed by layout id. Absent entries fall back to the
 * spec defaults, so an un-dragged layout renders byte-identical to the spec.
 * Session-only (in-memory): toggling layouts within a session preserves a
 * layout's dragged sizes; an app restart resets to defaults. Cross-session
 * persistence is a deliberate follow-up (NOT wired into AppSettings).
 */
export type MultiviewTrackSizes = Partial<Record<MultiviewLayout, MultiviewLayoutTracks>>

/**
 * Per-pane FX overrides keyed by pane index. A missing entry (or a missing
 * `sky`/`ghost` field) means "follow the app-global FX flag" — App resolves the
 * effective value as `paneFx[i]?.sky ?? globalSky`. In-memory / session-only:
 * NOT persisted (cross-session Multiview persistence is a deliberate follow-up).
 * Keyed by index, so entries left behind by a close/reorder are harmless — they
 * are simply re-resolved against the new `paneChatIds` on the next render.
 */
export type MultiviewPaneFxOverride = { sky?: boolean; ghost?: boolean }
export type MultiviewPaneFxFlag = keyof MultiviewPaneFxOverride

export interface MultiviewCoreState {
  layout: MultiviewLayout
  /** index = grid cell; null = an empty cell. Length always === paneCount. */
  paneChatIds: (string | null)[]
  focusedPaneIndex: number
  /** Per-layout dragged track fractions; missing => use the spec defaults. */
  trackSizes: MultiviewTrackSizes
}

/** Minimum size (px) any pane may be shrunk to while dragging a gutter. */
export const MULTIVIEW_MIN_PANE_PX = 240

/**
 * Closing a pane downgrades the layout by exactly one pane. Each step reduces
 * paneCount by one: quad(4) -> two-top-one-bottom(3) -> vertical-2(2) ->
 * single(1). The four 3-pane variants all collapse to vertical-2.
 */
const DOWNGRADE_LAYOUT: Record<MultiviewLayout, MultiviewLayout> = {
  single: 'single',
  'vertical-2': 'single',
  'horizontal-2': 'single',
  'two-top-one-bottom': 'vertical-2',
  'one-top-two-bottom': 'vertical-2',
  'one-left-two-right': 'vertical-2',
  'two-left-one-right': 'vertical-2',
  quad: 'two-top-one-bottom'
}

/**
 * Inverse of DOWNGRADE_LAYOUT: grow the layout by exactly one pane
 * (single -> vertical-2 -> two-top-one-bottom -> quad). Used when opening a
 * chat in a new pane and no spare cell is free.
 */
const UPGRADE_LAYOUT: Record<MultiviewLayout, MultiviewLayout> = {
  single: 'vertical-2',
  'vertical-2': 'two-top-one-bottom',
  'horizontal-2': 'two-top-one-bottom',
  'two-top-one-bottom': 'quad',
  'one-top-two-bottom': 'quad',
  'one-left-two-right': 'quad',
  'two-left-one-right': 'quad',
  quad: 'quad'
}

export function createInitialMultiviewState(
  initialPaneChatId: string | null = null
): MultiviewCoreState {
  return {
    layout: DEFAULT_MULTIVIEW_LAYOUT,
    paneChatIds: clampPaneChatIds([initialPaneChatId], DEFAULT_MULTIVIEW_LAYOUT),
    focusedPaneIndex: 0,
    trackSizes: {}
  }
}

/**
 * The effective column/row fractions for a layout: the dragged values if the
 * user has resized this layout in this session, else the spec defaults. The
 * length always matches the layout's grid (defensive against stale entries).
 */
export function getLayoutTracks(
  trackSizes: MultiviewTrackSizes,
  layout: MultiviewLayout
): MultiviewLayoutTracks {
  const defaults: MultiviewLayoutTracks = {
    columns: defaultColumnFractions(layout),
    rows: defaultRowFractions(layout)
  }
  const stored = trackSizes[layout]
  if (!stored) return defaults
  const columns =
    stored.columns.length === defaults.columns.length ? stored.columns : defaults.columns
  const rows = stored.rows.length === defaults.rows.length ? stored.rows : defaults.rows
  return { columns, rows }
}

export interface ApplySetLayoutOptions {
  /**
   * When supplied by the interactive layout picker, pin the currently visible
   * chat into the focused pane and use it to hydrate newly-created panes.
   */
  seedChatId?: string | null
}

/** Switch layout, re-clamping pane assignments and the focused index to fit. */
export function applySetLayout(
  state: MultiviewCoreState,
  next: MultiviewLayout,
  options: ApplySetLayoutOptions = {}
): MultiviewCoreState {
  const seedChatId = options.seedChatId ?? null
  if (next === state.layout) {
    return seedChatId ? applySetPaneChat(state, state.focusedPaneIndex, seedChatId) : state
  }
  const previousPaneCount = paneCountForLayout(state.layout)
  const nextPaneCount = paneCountForLayout(next)
  const sourcePaneChatIds = state.paneChatIds.slice()
  if (seedChatId) sourcePaneChatIds[state.focusedPaneIndex] = seedChatId
  const paneChatIds = clampPaneChatIds(sourcePaneChatIds, next)
  if (seedChatId && nextPaneCount > previousPaneCount) {
    for (let i = 0; i < paneChatIds.length; i += 1) {
      if (paneChatIds[i] == null) paneChatIds[i] = seedChatId
    }
  }
  return {
    layout: next,
    paneChatIds,
    focusedPaneIndex: clampFocusedPaneIndex(state.focusedPaneIndex, next),
    // Track fractions are keyed by layout id, so they survive switching layouts
    // within a session (and a return to a previously-dragged layout restores it).
    trackSizes: state.trackSizes
  }
}

/** Put a chat (or null) into a specific pane cell. */
export function applySetPaneChat(
  state: MultiviewCoreState,
  index: number,
  chatId: string | null
): MultiviewCoreState {
  if (index < 0 || index >= state.paneChatIds.length) return state
  if (state.paneChatIds[index] === chatId) return state
  const paneChatIds = state.paneChatIds.slice()
  paneChatIds[index] = chatId
  return { ...state, paneChatIds }
}

/** Move focus to a pane (clamped into the current layout's range). */
export function applySetFocusedPane(state: MultiviewCoreState, index: number): MultiviewCoreState {
  const focusedPaneIndex = clampFocusedPaneIndex(index, state.layout)
  if (focusedPaneIndex === state.focusedPaneIndex) return state
  return { ...state, focusedPaneIndex }
}

/**
 * Focus a pane while first recording the chat currently visible in the outgoing
 * focused pane. This keeps the pane map in sync with App.tsx's singleton
 * currentChat/composer state.
 */
export function applyFocusPane(
  state: MultiviewCoreState,
  index: number,
  outgoingFocusedChatId: string | null = null
): MultiviewCoreState {
  const pinnedState = outgoingFocusedChatId
    ? applySetPaneChat(state, state.focusedPaneIndex, outgoingFocusedChatId)
    : state
  return applySetFocusedPane(pinnedState, index)
}

/**
 * Close a pane: drop that cell, compact the rest in order, and downgrade the
 * layout one step. Focus follows: closing before the focused cell shifts focus
 * left by one; closing the focused cell keeps focus on the same slot index
 * (clamped). A no-op in single layout (nothing to collapse into).
 */
export function applyClosePane(state: MultiviewCoreState, index: number): MultiviewCoreState {
  if (state.layout === 'single') return state
  if (index < 0 || index >= state.paneChatIds.length) return state
  const nextLayout = DOWNGRADE_LAYOUT[state.layout]
  const remaining = state.paneChatIds.filter((_, i) => i !== index)
  const paneChatIds = clampPaneChatIds(remaining, nextLayout)
  let nextFocus = state.focusedPaneIndex
  if (index < state.focusedPaneIndex) nextFocus -= 1
  else if (index === state.focusedPaneIndex) nextFocus = index
  return {
    layout: nextLayout,
    paneChatIds,
    focusedPaneIndex: clampFocusedPaneIndex(nextFocus, nextLayout),
    trackSizes: state.trackSizes
  }
}

/**
 * Assign a chat to the most natural pane and focus it: the focused pane if it
 * is empty, else the first empty cell, else the focused pane (overwrite).
 * Returns the chosen pane index. In single layout this always overwrites pane
 * 0 — callers that want a fresh pane must widen the layout first.
 */
export function applyAssignToNextPane(
  state: MultiviewCoreState,
  chatId: string
): { state: MultiviewCoreState; index: number } {
  const count = paneCountForLayout(state.layout)
  let target: number
  if (state.paneChatIds[state.focusedPaneIndex] == null) {
    target = state.focusedPaneIndex
  } else {
    const firstEmpty = state.paneChatIds.findIndex((chatId) => chatId == null)
    target = firstEmpty >= 0 ? firstEmpty : state.focusedPaneIndex
  }
  target = Math.max(0, Math.min(target, count - 1))
  const paneChatIds = state.paneChatIds.slice()
  paneChatIds[target] = chatId
  return { state: { ...state, paneChatIds, focusedPaneIndex: target }, index: target }
}

/**
 * Open a chat in a NON-focused pane WITHOUT moving focus — the sidebar
 * "Open in Multiview pane" action. Grows the layout by one pane when there is
 * no spare non-focused cell; once at quad, overwrites a non-focused cell. The
 * focused (interactive) pane is never disturbed.
 */
export function applyOpenInNewPane(
  state: MultiviewCoreState,
  chatId: string,
  outgoingFocusedChatId: string | null = null
): MultiviewCoreState {
  let next = outgoingFocusedChatId
    ? applySetPaneChat(state, state.focusedPaneIndex, outgoingFocusedChatId)
    : state
  const hasSpare = next.paneChatIds.some((id, i) => i !== next.focusedPaneIndex && id == null)
  if (!hasSpare) {
    const grown = UPGRADE_LAYOUT[next.layout]
    if (grown !== next.layout) next = applySetLayout(next, grown)
  }
  let target = next.paneChatIds.findIndex((id, i) => i !== next.focusedPaneIndex && id == null)
  if (target < 0) target = next.paneChatIds.findIndex((_, i) => i !== next.focusedPaneIndex)
  if (target < 0) target = next.focusedPaneIndex
  const paneChatIds = next.paneChatIds.slice()
  paneChatIds[target] = chatId
  return { ...next, paneChatIds }
}

export interface ApplyResizeTrackArgs {
  orientation: MultiviewGutterOrientation
  /** Index of the track BEFORE the dragged boundary line. */
  trackIndex: number
  /** Signed pointer delta in px along the axis since drag start. */
  deltaPx: number
  /**
   * Total px available to the affected axis (the content box of the grid along
   * that axis, i.e. excluding gaps + padding). Used to convert px<->fraction.
   */
  axisTotalPx: number
  /** Per-pane minimum in px (defaults to MULTIVIEW_MIN_PANE_PX). */
  minPanePx?: number
}

/**
 * Resize the two tracks adjacent to a gutter by a pointer delta. Pure: returns
 * a new state with this layout's column/row fractions updated.
 *
 * Math: tracks are `fr` weights; px(track) = fraction/sumAdjacent * pairPx,
 * where pairPx is the combined px of the two adjacent tracks (their share of
 * axisTotalPx). We move `deltaPx` from one to the other, clamp each so neither
 * drops below `minPanePx` (the pair px is conserved, so the other side can't
 * exceed pairPx - min either), then convert back to fractions — preserving the
 * pair's combined fraction so untouched tracks are unaffected.
 */
export function applyResizeTrack(
  state: MultiviewCoreState,
  args: ApplyResizeTrackArgs
): MultiviewCoreState {
  const { orientation, trackIndex, deltaPx, axisTotalPx } = args
  const minPanePx = args.minPanePx ?? MULTIVIEW_MIN_PANE_PX
  if (!Number.isFinite(deltaPx) || deltaPx === 0) return state
  if (!Number.isFinite(axisTotalPx) || axisTotalPx <= 0) return state

  const tracks = getLayoutTracks(state.trackSizes, state.layout)
  const fractions = orientation === 'column' ? tracks.columns.slice() : tracks.rows.slice()
  if (trackIndex < 0 || trackIndex + 1 >= fractions.length) return state

  const a = fractions[trackIndex]
  const b = fractions[trackIndex + 1]
  const pairFraction = a + b
  const totalFraction = fractions.reduce((sum, f) => sum + f, 0)
  if (pairFraction <= 0 || totalFraction <= 0) return state

  // px share of the two adjacent tracks together.
  const pairPx = (pairFraction / totalFraction) * axisTotalPx
  // If the pair can't even hold two minimums, leave it fixed.
  if (pairPx < minPanePx * 2) return state

  let aPx = (a / pairFraction) * pairPx + deltaPx
  // Clamp so neither side goes below the minimum (pair px is conserved).
  aPx = Math.max(minPanePx, Math.min(aPx, pairPx - minPanePx))
  const bPx = pairPx - aPx

  // Back to fractions, conserving the pair's combined fraction.
  const nextA = (aPx / pairPx) * pairFraction
  const nextB = (bPx / pairPx) * pairFraction
  if (nextA === a && nextB === b) return state
  fractions[trackIndex] = nextA
  fractions[trackIndex + 1] = nextB

  const prior = state.trackSizes[state.layout]
  const nextTracks: MultiviewLayoutTracks =
    orientation === 'column'
      ? { columns: fractions, rows: prior?.rows ?? tracks.rows }
      : { columns: prior?.columns ?? tracks.columns, rows: fractions }
  return {
    ...state,
    trackSizes: { ...state.trackSizes, [state.layout]: nextTracks }
  }
}

/**
 * Reset a layout's track fractions to the spec defaults (equal tracks) — the
 * double-click-a-gutter affordance. Drops the stored entry so subsequent reads
 * fall back to the spec.
 */
export function applyResetTrackSizes(
  state: MultiviewCoreState,
  layout: MultiviewLayout = state.layout
): MultiviewCoreState {
  if (!state.trackSizes[layout]) return state
  const trackSizes = { ...state.trackSizes }
  delete trackSizes[layout]
  return { ...state, trackSizes }
}

export interface MultiviewPaneRefs {
  scrollRef: RefObject<HTMLDivElement | null>
  contentRef: RefObject<HTMLDivElement | null>
  endRef: RefObject<HTMLDivElement | null>
}

export interface UseMultiviewStateOptions {
  /** Seed pane 0 with this chat id (the chat that was active before split). */
  initialPaneChatId?: string | null
}

export interface UseMultiviewStateResult extends MultiviewCoreState {
  /** paneChatIds[focusedPaneIndex] (or null). The chat the sidebar/composer drive. */
  focusedChatId: string | null
  isMultiview: boolean
  /** Stable per-pane ref pool (length MAX_MULTIVIEW_PANES) for the grid panes. */
  paneRefs: MultiviewPaneRefs[]
  /** Effective column/row fractions for the CURRENT layout (dragged or spec). */
  tracks: MultiviewLayoutTracks
  setLayout: (next: MultiviewLayout, seedChatId?: string | null) => void
  setPaneChat: (index: number, chatId: string | null) => void
  setFocusedPane: (index: number) => void
  focusPane: (index: number, outgoingFocusedChatId?: string | null) => void
  closePane: (index: number) => void
  /** Place + focus a chat; returns the pane index it landed in. */
  assignToNextPane: (chatId: string) => number
  /** Open a chat in a non-focused pane (grows the layout if needed); keeps focus. */
  openInNewPane: (chatId: string, outgoingFocusedChatId?: string | null) => void
  /** Drag a gutter: move `deltaPx` between two adjacent tracks (clamped at min). */
  resizeTrack: (args: ApplyResizeTrackArgs) => void
  /** Double-click a gutter: reset a layout's fractions to the spec defaults. */
  resetTrackSizes: (layout?: MultiviewLayout) => void
  /**
   * Per-pane FX overrides keyed by pane index. A missing entry/field => follow
   * the app-global flag (App resolves `paneFx[i]?.sky ?? globalSky`). Session-
   * only (not persisted).
   */
  paneFx: Record<number, MultiviewPaneFxOverride>
  /**
   * Set a pane's sky/ghost override to an EXPLICIT boolean. Because a missing
   * entry means "follow global", callers pass the next effective value (e.g.
   * `!effectiveSky`) so the first toggle visibly flips state regardless of where
   * the global currently sits.
   */
  setPaneFxFlag: (paneIndex: number, flag: MultiviewPaneFxFlag, value: boolean) => void
}

export function useMultiviewState(
  options: UseMultiviewStateOptions = {}
): UseMultiviewStateResult {
  const [state, setState] = useState<MultiviewCoreState>(() =>
    createInitialMultiviewState(options.initialPaneChatId ?? null)
  )
  // Per-pane FX overrides (session-only; NOT part of the persisted/unit-tested
  // core state). Keyed by pane index; missing entry/field => follow the global.
  const [paneFx, setPaneFx] = useState<Record<number, MultiviewPaneFxOverride>>({})

  // Keep the latest state reachable synchronously so assignToNextPane can
  // return the chosen index without depending on a setState callback's timing.
  const stateRef = useRef(state)
  stateRef.current = state

  // One stable ref-object pool for every possible pane. Plain { current }
  // objects are valid React refs; memoized so identity never changes.
  const paneRefs = useMemo<MultiviewPaneRefs[]>(
    () =>
      Array.from({ length: MAX_MULTIVIEW_PANES }, () => ({
        scrollRef: { current: null } as RefObject<HTMLDivElement | null>,
        contentRef: { current: null } as RefObject<HTMLDivElement | null>,
        endRef: { current: null } as RefObject<HTMLDivElement | null>
      })),
    []
  )

  const setLayout = useCallback((next: MultiviewLayout, seedChatId: string | null = null) => {
    setState((s) => applySetLayout(s, next, { seedChatId }))
  }, [])
  const setPaneChat = useCallback(
    (index: number, chatId: string | null) => setState((s) => applySetPaneChat(s, index, chatId)),
    []
  )
  const setFocusedPane = useCallback(
    (index: number) => setState((s) => applySetFocusedPane(s, index)),
    []
  )
  const focusPane = useCallback((index: number, outgoingFocusedChatId: string | null = null) => {
    setState((s) => applyFocusPane(s, index, outgoingFocusedChatId))
  }, [])
  const closePane = useCallback((index: number) => setState((s) => applyClosePane(s, index)), [])
  const assignToNextPane = useCallback((chatId: string) => {
    const result = applyAssignToNextPane(stateRef.current, chatId)
    stateRef.current = result.state
    setState(result.state)
    return result.index
  }, [])
  const openInNewPane = useCallback(
    (chatId: string, outgoingFocusedChatId: string | null = null) => {
      setState((s) => applyOpenInNewPane(s, chatId, outgoingFocusedChatId))
    },
    []
  )
  const resizeTrack = useCallback((args: ApplyResizeTrackArgs) => {
    setState((s) => applyResizeTrack(s, args))
  }, [])
  const resetTrackSizes = useCallback((layout?: MultiviewLayout) => {
    setState((s) => applyResetTrackSizes(s, layout ?? s.layout))
  }, [])
  const setPaneFxFlag = useCallback(
    (paneIndex: number, flag: MultiviewPaneFxFlag, value: boolean) => {
      setPaneFx((prev) => ({
        ...prev,
        [paneIndex]: { ...prev[paneIndex], [flag]: value }
      }))
    },
    []
  )

  const focusedChatId = state.paneChatIds[state.focusedPaneIndex] ?? null
  const tracks = useMemo(
    () => getLayoutTracks(state.trackSizes, state.layout),
    [state.trackSizes, state.layout]
  )

  return {
    ...state,
    focusedChatId,
    isMultiview: state.layout !== 'single',
    paneRefs,
    tracks,
    setLayout,
    setPaneChat,
    setFocusedPane,
    focusPane,
    closePane,
    assignToNextPane,
    openInNewPane,
    resizeTrack,
    resetTrackSizes,
    paneFx,
    setPaneFxFlag
  }
}
