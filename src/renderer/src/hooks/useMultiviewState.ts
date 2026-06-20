import { useCallback, useMemo, useRef, useState } from 'react'
import type { RefObject } from 'react'
import {
  DEFAULT_MULTIVIEW_LAYOUT,
  MAX_MULTIVIEW_PANES,
  clampFocusedPaneIndex,
  clampPaneChatIds,
  paneCountForLayout,
  type MultiviewLayout
} from '../../../shared/multiviewLayouts'

/**
 * useMultiviewState — owns the renderer-only Multiview state (which layout,
 * which chat is in each pane, and which pane is focused). It writes NO App.tsx
 * singleton; the focused pane is wired to the existing currentChat machinery in
 * a later slice. All the real logic lives in the pure `apply*` transitions
 * below so they can be unit-tested without a DOM (the repo avoids jsdom).
 */

export interface MultiviewCoreState {
  layout: MultiviewLayout
  /** index = grid cell; null = an empty cell. Length always === paneCount. */
  paneChatIds: (string | null)[]
  focusedPaneIndex: number
}

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
    focusedPaneIndex: 0
  }
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
    focusedPaneIndex: clampFocusedPaneIndex(state.focusedPaneIndex, next)
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
    focusedPaneIndex: clampFocusedPaneIndex(nextFocus, nextLayout)
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
  setLayout: (next: MultiviewLayout, seedChatId?: string | null) => void
  setPaneChat: (index: number, chatId: string | null) => void
  setFocusedPane: (index: number) => void
  focusPane: (index: number, outgoingFocusedChatId?: string | null) => void
  closePane: (index: number) => void
  /** Place + focus a chat; returns the pane index it landed in. */
  assignToNextPane: (chatId: string) => number
  /** Open a chat in a non-focused pane (grows the layout if needed); keeps focus. */
  openInNewPane: (chatId: string, outgoingFocusedChatId?: string | null) => void
}

export function useMultiviewState(
  options: UseMultiviewStateOptions = {}
): UseMultiviewStateResult {
  const [state, setState] = useState<MultiviewCoreState>(() =>
    createInitialMultiviewState(options.initialPaneChatId ?? null)
  )

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

  const focusedChatId = state.paneChatIds[state.focusedPaneIndex] ?? null

  return {
    ...state,
    focusedChatId,
    isMultiview: state.layout !== 'single',
    paneRefs,
    setLayout,
    setPaneChat,
    setFocusedPane,
    focusPane,
    closePane,
    assignToNextPane,
    openInNewPane
  }
}
