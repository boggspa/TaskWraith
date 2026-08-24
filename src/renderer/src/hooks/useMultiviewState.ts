import { useCallback, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { MutableRefObject, RefObject } from 'react'
import type { CachedChatScrollState } from '../lib/TranscriptScroll'
import {
  DEFAULT_MULTIVIEW_LAYOUT,
  clampFocusedPaneIndex,
  defaultColumnFractions,
  defaultRowFractions,
  normalizeMultiviewLayout,
  paneCountForLayout,
  type MultiviewGutterOrientation,
  type MultiviewLayout,
  type MultiviewPaneMediaRef,
  type MultiviewPaneRecord
} from '../../../shared/multiviewLayouts'

/**
 * useMultiviewState — owns the renderer-only Multiview state (which layout,
 * which chat is in each pane, which pane is focused, and per-pane settings).
 * Focus has its own tiny external store: selecting a pane updates only the grid
 * and never asks the 30k-line App composition root to reconcile. The selected
 * pane can still be explicitly projected into legacy currentChat machinery by
 * the few host-only actions that need it. All real logic lives in the pure `apply*`
 * transitions below so they can be unit-tested without a DOM (the repo avoids
 * jsdom).
 *
 * STABLE PANE IDENTITIES: panes are stored as records (`{ id, chatId }`), not as
 * a bare `(string | null)[]`. Each pane's `id` survives layout changes, focus
 * moves, and the compaction that follows closing another pane, so per-pane
 * settings (`paneSettings`, keyed by id) are never misattributed when indices
 * shift — the foundation for persisting per-pane settings safely. For backward
 * compatibility the hook still exposes a derived `paneChatIds` view, so existing
 * index-based consumers (the grid, App) are unaffected.
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
 * Per-pane FX overrides. A missing entry (or a missing `sky`/`ghost` field)
 * means "follow the app-global FX flag" — App resolves the effective value as
 * `paneFx[i]?.sky ?? globalSky`.
 */
export type MultiviewPaneFxOverride = { sky?: boolean; ghost?: boolean }
export type MultiviewPaneFxFlag = keyof MultiviewPaneFxOverride

/**
 * Settings attached to a single pane, keyed by the pane's STABLE id (see
 * `MultiviewCoreState.paneSettings`). Extensible: `fx` is the only field today,
 * but preview target / device / platform belong here too. Because the key is a
 * stable id, an entry follows its pane across close/compaction and is pruned
 * only when that pane is actually removed.
 */
export interface MultiviewPaneSettings {
  fx?: MultiviewPaneFxOverride
}

export interface MultiviewCoreState {
  layout: MultiviewLayout
  /** One record per grid cell, in cell order. Length always === paneCount. */
  panes: MultiviewPaneRecord[]
  /**
   * Pane records hidden by a smaller layout. Layout changes are presentation,
   * not destruction: switching to Single must not erase the other threads and
   * switching back must not clone the focused thread into every cell.
   */
  parkedPanes: MultiviewPaneRecord[]
  focusedPaneIndex: number
  /** Per-layout dragged track fractions; missing => use the spec defaults. */
  trackSizes: MultiviewTrackSizes
  /** Per-pane settings keyed by STABLE pane id; pruned when a pane is removed. */
  paneSettings: Record<string, MultiviewPaneSettings>
  /**
   * Monotonic source for fresh pane ids. Kept in state (not a module global) so
   * id minting stays PURE and DETERMINISTIC — transitions depend only on their
   * input, which keeps them unit-testable and reproducible across sessions and
   * lets a future persisted state resume minting without id collisions.
   */
  nextPaneSeq: number
}

/**
 * Narrow focus subscription consumed by MultiviewPaneGrid. Keeping this store
 * outside App's React state makes ordinary pane activation O(subscribers)
 * instead of a full application render while retaining a synchronous getter
 * for sidebar assignment and host-only commands.
 */
export interface MultiviewFocusStore {
  getSnapshot: () => number
  subscribe: (listener: () => void) => () => void
  set: (index: number) => void
}

export function createMultiviewFocusStore(initialIndex = 0): MultiviewFocusStore {
  let focusedPaneIndex = initialIndex
  const listeners = new Set<() => void>()
  return {
    getSnapshot: () => focusedPaneIndex,
    subscribe: (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    set: (index) => {
      if (index === focusedPaneIndex) return
      focusedPaneIndex = index
      for (const listener of listeners) listener()
    }
  }
}

/** True when two snapshots differ only by focus ownership. */
export function isMultiviewFocusOnlyChange(
  previous: MultiviewCoreState,
  next: MultiviewCoreState
): boolean {
  return (
    previous.focusedPaneIndex !== next.focusedPaneIndex &&
    previous.layout === next.layout &&
    previous.panes === next.panes &&
    previous.parkedPanes === next.parkedPanes &&
    previous.trackSizes === next.trackSizes &&
    previous.paneSettings === next.paneSettings &&
    previous.nextPaneSeq === next.nextPaneSeq
  )
}

/** Minimum size (px) any pane may be shrunk to while dragging a gutter. */
export const MULTIVIEW_MIN_PANE_PX = 240

/**
 * Closing a pane selects the next smaller catalogue shape. The six-way layout
 * collapses to quad because there is no five-pane variant; applyClosePane parks
 * the fifth survivor so closing one pane never discards another pane's state.
 */
const DOWNGRADE_LAYOUT: Record<MultiviewLayout, MultiviewLayout> = {
  single: 'single',
  'vertical-2': 'single',
  'vertical-3': 'vertical-2',
  'horizontal-2': 'single',
  'two-top-one-bottom': 'vertical-2',
  'one-top-two-bottom': 'vertical-2',
  'one-left-two-right': 'vertical-2',
  'two-left-one-right': 'vertical-2',
  quad: 'two-top-one-bottom',
  'six-way': 'quad'
}

/**
 * Grow to the next available larger catalogue shape when opening a chat in a
 * new pane and no spare cell is free. Quad jumps to six-way because there is no
 * five-pane variant, leaving one additional empty cell.
 */
const UPGRADE_LAYOUT: Record<MultiviewLayout, MultiviewLayout> = {
  single: 'vertical-2',
  'vertical-2': 'two-top-one-bottom',
  'vertical-3': 'quad',
  'horizontal-2': 'two-top-one-bottom',
  'two-top-one-bottom': 'quad',
  'one-top-two-bottom': 'quad',
  'one-left-two-right': 'quad',
  'two-left-one-right': 'quad',
  quad: 'six-way',
  'six-way': 'six-way'
}

const PANE_ID_PREFIX = 'pane-'

/** Mint a pane id from a monotonic sequence number (pure/deterministic). */
function mintPaneId(seq: number): string {
  return `${PANE_ID_PREFIX}${seq}`
}

/** Highest `pane-<n>` sequence among the given records (0 if none match). */
function highestPaneSeq(panes: ReadonlyArray<MultiviewPaneRecord>): number {
  let max = 0
  for (const pane of panes) {
    const match = /^pane-(\d+)$/.exec(pane.id)
    if (match) max = Math.max(max, Number(match[1]))
  }
  return max
}

/**
 * Pad with fresh records / truncate so the pane array length matches the
 * layout's pane count. EXISTING records (the first N) keep their ids; newly
 * created cells get freshly-minted ids. Truncation drops the tail records (their
 * ids — and, via pruneSettings, their settings — disappear). Returns the new
 * panes plus the advanced sequence number.
 */
function clampPanes(
  panes: ReadonlyArray<MultiviewPaneRecord>,
  layout: MultiviewLayout,
  startSeq: number
): { panes: MultiviewPaneRecord[]; nextPaneSeq: number } {
  const count = paneCountForLayout(layout)
  const next: MultiviewPaneRecord[] = []
  let seq = startSeq
  for (let i = 0; i < count; i += 1) {
    if (i < panes.length) {
      next.push(panes[i])
    } else {
      next.push({ id: mintPaneId(seq), chatId: null })
      seq += 1
    }
  }
  return { panes: next, nextPaneSeq: seq }
}

/**
 * Drop settings entries whose pane id is no longer present. Returns the SAME
 * reference when nothing is pruned, so identity-stable consumers don't churn.
 */
function pruneSettings(
  paneSettings: Record<string, MultiviewPaneSettings>,
  panes: ReadonlyArray<MultiviewPaneRecord>
): Record<string, MultiviewPaneSettings> {
  const live = new Set(panes.map((pane) => pane.id))
  let changed = false
  const next: Record<string, MultiviewPaneSettings> = {}
  for (const [id, settings] of Object.entries(paneSettings)) {
    if (live.has(id)) next[id] = settings
    else changed = true
  }
  return changed ? next : paneSettings
}

/**
 * Return a new panes array with the record at `index` showing `chatId` (id
 * preserved). Returns the SAME reference for an out-of-range index or a no-op
 * write, so callers can detect "nothing changed".
 */
function withChatAt(
  panes: MultiviewPaneRecord[],
  index: number,
  chatId: string | null
): MultiviewPaneRecord[] {
  if (index < 0 || index >= panes.length) return panes
  const pane = panes[index]
  // Assigning a chat clears any canvas OR detached media (all three are mutually
  // exclusive). No-op for an ordinary canvas-less / media-less pane already on this
  // chatId. Each cleared field is stamped ONLY when it was present, so a plain chat
  // pane (and a canvas-only pane) keep their exact old shape — existing records stay
  // byte-identical and only the relevant exclusion key is nulled.
  if (pane.chatId === chatId && !pane.canvasId && !pane.mediaRef) return panes
  const next = panes.slice()
  next[index] = {
    ...pane,
    chatId,
    ...(pane.canvasId ? { canvasId: null } : {}),
    ...(pane.mediaRef ? { mediaRef: null } : {})
  }
  return next
}

function isPaneEmpty(pane: MultiviewPaneRecord | undefined): boolean {
  return Boolean(pane && pane.chatId == null && !pane.canvasId && !pane.mediaRef)
}

/** Put a live-embedded canvas in a pane (clears its chat + any detached media).
 * `null` clears the canvas. */
export function applySetPaneCanvas(
  state: MultiviewCoreState,
  index: number,
  canvasId: string | null
): MultiviewCoreState {
  if (index < 0 || index >= state.panes.length) return state
  const pane = state.panes[index]
  if (
    (pane.canvasId ?? null) === canvasId &&
    (canvasId === null || (pane.chatId === null && !pane.mediaRef))
  ) {
    return state
  }
  const next = state.panes.slice()
  // When setting a canvas, clear chat + any detached media. `mediaRef: null` is
  // stamped ONLY when one was present, so a canvas-only pane keeps its exact old
  // shape (no `mediaRef` key) and existing records stay byte-identical.
  next[index] = canvasId
    ? { ...pane, canvasId, chatId: null, ...(pane.mediaRef ? { mediaRef: null } : {}) }
    : { ...pane, canvasId }
  return { ...state, panes: next }
}

/** Put a detached audio/video player in a pane (clears its chat + any canvas).
 * `null` clears the media. Mirrors applySetPaneCanvas exactly so the mutual
 * exclusion (chat / canvas / media) is symmetric. */
export function applySetPaneMedia(
  state: MultiviewCoreState,
  index: number,
  mediaRef: MultiviewPaneMediaRef | null
): MultiviewCoreState {
  if (index < 0 || index >= state.panes.length) return state
  const pane = state.panes[index]
  // No-op when clearing an already-media-less pane, or setting the very same ref
  // onto an already-cleaned (chat-null + canvas-absent) media pane.
  if (mediaRef === null && !pane.mediaRef) return state
  if (
    mediaRef !== null &&
    pane.mediaRef === mediaRef &&
    pane.chatId === null &&
    !pane.canvasId
  ) {
    return state
  }
  const next = state.panes.slice()
  next[index] = mediaRef
    ? { ...pane, mediaRef, chatId: null, canvasId: null }
    : { ...pane, mediaRef: null }
  return { ...state, panes: next }
}

export function createInitialMultiviewState(
  initialPaneChatId: string | null = null
): MultiviewCoreState {
  return {
    layout: DEFAULT_MULTIVIEW_LAYOUT,
    panes: [{ id: mintPaneId(1), chatId: initialPaneChatId }],
    parkedPanes: [],
    focusedPaneIndex: 0,
    trackSizes: {},
    paneSettings: {},
    nextPaneSeq: 2
  }
}

/** The chat ids in cell order — the backward-compatible index-based view. */
export function paneChatIdsOf(state: MultiviewCoreState): (string | null)[] {
  return state.panes.map((pane) => pane.chatId)
}

/** Every pane the session still owns, including panes hidden by the layout. */
export function paneRecordsIncludingParked(
  state: Pick<MultiviewCoreState, 'panes' | 'parkedPanes'>
): MultiviewPaneRecord[] {
  return [...state.panes, ...state.parkedPanes]
}

export function removedCanvasIds(
  previous: ReadonlyArray<MultiviewPaneRecord>,
  next: ReadonlyArray<MultiviewPaneRecord>
): string[] {
  const nextIds = new Set(
    next.map((pane) => pane.canvasId).filter((canvasId): canvasId is string => Boolean(canvasId))
  )
  const removed: string[] = []
  const seen = new Set<string>()
  for (const pane of previous) {
    const canvasId = pane.canvasId
    if (!canvasId || nextIds.has(canvasId) || seen.has(canvasId)) continue
    seen.add(canvasId)
    removed.push(canvasId)
  }
  return removed
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
   * Compatibility seed for the focused pane only. New or restored panes never
   * inherit it; their thread ownership is independent.
   */
  seedChatId?: string | null
}

/**
 * Switch layout without treating presentation as ownership. Shrinking parks
 * hidden panes; growing restores them before minting empty panes. The focused
 * pane survives a shrink even when it lived outside the new cell range.
 */
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
  // Seed only the focused pane. A layout picker is not a duplicate-thread
  // command; newly-visible panes keep their own record or remain empty.
  let seededPanes = seedChatId
    ? withChatAt(state.panes, state.focusedPaneIndex, seedChatId)
    : state.panes
  let parkedPanes = state.parkedPanes
  let focusedPaneIndex = state.focusedPaneIndex
  let nextPaneSeq = state.nextPaneSeq

  if (nextPaneCount < previousPaneCount) {
    // If focus would be truncated, keep that pane and park the displaced cells.
    if (focusedPaneIndex >= nextPaneCount) {
      const focusedPane = seededPanes[focusedPaneIndex]
      const kept = seededPanes.slice(0, Math.max(0, nextPaneCount - 1))
      seededPanes = focusedPane ? [...kept, focusedPane] : kept
      const keptIds = new Set(seededPanes.map((pane) => pane.id))
      parkedPanes = [
        ...state.panes.filter((pane) => !keptIds.has(pane.id)),
        ...state.parkedPanes
      ]
      focusedPaneIndex = Math.max(0, seededPanes.length - 1)
    } else {
      parkedPanes = [...seededPanes.slice(nextPaneCount), ...state.parkedPanes]
      seededPanes = seededPanes.slice(0, nextPaneCount)
    }
  } else if (nextPaneCount > previousPaneCount) {
    const restoreCount = Math.min(nextPaneCount - seededPanes.length, parkedPanes.length)
    seededPanes = [...seededPanes, ...parkedPanes.slice(0, restoreCount)]
    parkedPanes = parkedPanes.slice(restoreCount)
    const clamped = clampPanes(seededPanes, next, nextPaneSeq)
    seededPanes = clamped.panes
    nextPaneSeq = clamped.nextPaneSeq
  }

  const livePanes = [...seededPanes, ...parkedPanes]
  return {
    layout: next,
    panes: seededPanes,
    parkedPanes,
    focusedPaneIndex: clampFocusedPaneIndex(focusedPaneIndex, next),
    // Track fractions are keyed by layout id, so they survive switching layouts
    // within a session (and a return to a previously-dragged layout restores it).
    trackSizes: state.trackSizes,
    // Parked panes still own their settings; only explicit close removes them.
    paneSettings: pruneSettings(state.paneSettings, livePanes),
    nextPaneSeq
  }
}

/** Put a chat (or null) into a specific pane cell (the pane's id is preserved). */
export function applySetPaneChat(
  state: MultiviewCoreState,
  index: number,
  chatId: string | null
): MultiviewCoreState {
  const panes = withChatAt(state.panes, index, chatId)
  if (panes === state.panes) return state
  return { ...state, panes }
}

/** Move focus to a pane (clamped into the current layout's range). */
export function applySetFocusedPane(state: MultiviewCoreState, index: number): MultiviewCoreState {
  const focusedPaneIndex = clampFocusedPaneIndex(index, state.layout)
  if (focusedPaneIndex === state.focusedPaneIndex) return state
  return { ...state, focusedPaneIndex }
}

/**
 * Focus an explicitly selected EMPTY pane. The legacy host chat is adopted by
 * its outgoing pane only when that pane has no owner yet (the initial split
 * case); an already-owned pane is authoritative and is never overwritten by
 * singleton projection state.
 */
export function applyFocusEmptyPane(
  state: MultiviewCoreState,
  index: number,
  outgoingVisibleChatId: string | null = null
): MultiviewCoreState {
  const target = clampFocusedPaneIndex(index, state.layout)
  if (target === state.focusedPaneIndex || !isPaneEmpty(state.panes[target])) return state
  const outgoingPane = state.panes[state.focusedPaneIndex]
  const outgoingChatAlreadyOwned = Boolean(
    outgoingVisibleChatId &&
      (state.panes.some((pane) => pane.chatId === outgoingVisibleChatId) ||
        state.parkedPanes.some((pane) => pane.chatId === outgoingVisibleChatId))
  )
  const seededState =
    outgoingVisibleChatId && !outgoingChatAlreadyOwned && isPaneEmpty(outgoingPane)
      ? applySetPaneChat(state, state.focusedPaneIndex, outgoingVisibleChatId)
      : state
  return applySetFocusedPane(seededState, target)
}

/**
 * Close a pane: drop that cell, compact the rest in order (SURVIVING panes keep
 * their ids and settings), and select the next smaller layout. Focus follows:
 * closing before the focused cell shifts focus left by one; closing the focused
 * cell keeps focus on the same slot index (clamped). When six-way collapses to
 * quad, applySetLayout parks the fifth survivor. A no-op in single layout.
 */
export function applyClosePane(state: MultiviewCoreState, index: number): MultiviewCoreState {
  if (state.layout === 'single') return state
  if (index < 0 || index >= state.panes.length) return state
  const nextLayout = DOWNGRADE_LAYOUT[state.layout]
  const remaining = state.panes.filter((_, i) => i !== index)
  let nextFocus = state.focusedPaneIndex
  if (index < state.focusedPaneIndex) nextFocus -= 1
  else if (index === state.focusedPaneIndex) nextFocus = Math.min(index, remaining.length - 1)
  const withoutClosed: MultiviewCoreState = {
    ...state,
    panes: remaining,
    focusedPaneIndex: Math.max(0, nextFocus),
    paneSettings: pruneSettings(state.paneSettings, [...remaining, ...state.parkedPanes])
  }
  return applySetLayout(withoutClosed, nextLayout)
}

/**
 * Assign a chat to the explicitly focused pane. If the chat is already visible,
 * focus its existing pane instead of duplicating it. Returns the chosen pane
 * index. In single layout this always targets pane 0.
 */
export function applyAssignToFocusedPane(
  state: MultiviewCoreState,
  chatId: string
): { state: MultiviewCoreState; index: number } {
  const count = paneCountForLayout(state.layout)
  const existing = state.panes.findIndex((pane) => pane.chatId === chatId)
  if (existing >= 0) {
    return {
      state: applySetFocusedPane(state, existing),
      index: existing
    }
  }
  const target = Math.max(0, Math.min(state.focusedPaneIndex, count - 1))
  const panes = withChatAt(state.panes, target, chatId)
  return { state: { ...state, panes, focusedPaneIndex: target }, index: target }
}

/**
 * Open a chat in a NON-focused pane WITHOUT moving focus — the sidebar
 * "Open in Multiview pane" action. Grows to the next larger layout when there is
 * no spare non-focused cell; once at six-way, overwrites a non-focused cell. The
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
  let hasSpare = next.panes.some(
    (pane, i) => i !== next.focusedPaneIndex && pane.chatId == null
  )
  while (!hasSpare) {
    const grown = UPGRADE_LAYOUT[next.layout]
    if (grown === next.layout) break
    next = applySetLayout(next, grown)
    hasSpare = next.panes.some(
      (pane, i) => i !== next.focusedPaneIndex && pane.chatId == null
    )
  }
  let target = next.panes.findIndex((pane, i) => i !== next.focusedPaneIndex && pane.chatId == null)
  if (target < 0) target = next.panes.findIndex((_, i) => i !== next.focusedPaneIndex)
  if (target < 0) target = next.focusedPaneIndex
  const panes = withChatAt(next.panes, target, chatId)
  return { ...next, panes }
}

/**
 * Detach an audio/video player into a NON-focused pane WITHOUT moving focus — the
 * transcript "pop out to pane" action. The user pops the player out of the message
 * flow but KEEPS TYPING in the current (transcript) pane, so focus is preserved.
 * Clones applyOpenInNewPane: grows via UPGRADE_LAYOUT when no
 * spare non-focused EMPTY cell exists; once at six-way, overwrites a non-focused cell.
 * "Empty" here means truly empty — no chat, no canvas, no existing media — so an
 * already-detached player or a canvas is never clobbered while a spare exists.
 */
export function applyOpenMediaInNewPane(
  state: MultiviewCoreState,
  mediaRef: MultiviewPaneMediaRef
): MultiviewCoreState {
  const isEmpty = (pane: MultiviewPaneRecord): boolean =>
    pane.chatId == null && !pane.canvasId && !pane.mediaRef
  let next = state
  let hasSpare = next.panes.some(
    (pane, i) => i !== next.focusedPaneIndex && isEmpty(pane)
  )
  while (!hasSpare) {
    const grown = UPGRADE_LAYOUT[next.layout]
    if (grown === next.layout) break
    next = applySetLayout(next, grown)
    hasSpare = next.panes.some(
      (pane, i) => i !== next.focusedPaneIndex && isEmpty(pane)
    )
  }
  let target = next.panes.findIndex((pane, i) => i !== next.focusedPaneIndex && isEmpty(pane))
  if (target < 0) target = next.panes.findIndex((_, i) => i !== next.focusedPaneIndex)
  if (target < 0) target = next.focusedPaneIndex
  // Focus is deliberately NOT moved (unlike assignToFocusedPane) — keep typing in place.
  return applySetPaneMedia(next, target, mediaRef)
}

/**
 * Set a pane's FX override flag, keyed by STABLE pane id. A missing entry/field
 * means "follow the app-global flag", so callers pass the next EFFECTIVE value
 * (e.g. `!effectiveSky`) so the first toggle visibly flips regardless of where
 * the global currently sits. No-op (same reference) when the value is unchanged.
 */
export function applySetPaneFxFlag(
  state: MultiviewCoreState,
  paneId: string,
  flag: MultiviewPaneFxFlag,
  value: boolean
): MultiviewCoreState {
  const prev = state.paneSettings[paneId]
  if (prev?.fx?.[flag] === value) return state
  const nextFx: MultiviewPaneFxOverride = { ...prev?.fx, [flag]: value }
  return {
    ...state,
    paneSettings: { ...state.paneSettings, [paneId]: { ...prev, fx: nextFx } }
  }
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

/**
 * Coerce an unknown value (e.g. a future persisted setting, or a legacy
 * index-keyed `{ paneChatIds }` blob) into a valid MultiviewCoreState. This is
 * the backward-compatibility bridge for the deferred cross-session persistence
 * slice: an old serialized layout that predates stable pane records is upgraded
 * by minting fresh ids for its chat ids; an unrecognised blob falls back to the
 * default single-pane state. Pure + deterministic so it is unit-testable.
 */
export function normalizeMultiviewCoreState(raw: unknown): MultiviewCoreState {
  if (!raw || typeof raw !== 'object') return createInitialMultiviewState()
  const record = raw as Record<string, unknown>
  const layout = normalizeMultiviewLayout(record.layout)

  let seq =
    typeof record.nextPaneSeq === 'number' && record.nextPaneSeq > 0
      ? Math.floor(record.nextPaneSeq)
      : 1

  // Build source records: prefer the new `panes` shape; else upgrade a legacy
  // `paneChatIds` array; else start empty (clampPanes will seed a single cell).
  let sourcePanes: MultiviewPaneRecord[] = []
  if (Array.isArray(record.panes)) {
    sourcePanes = record.panes.map((entry) => {
      const pane = (entry ?? {}) as Record<string, unknown>
      const chatId = typeof pane.chatId === 'string' ? pane.chatId : null
      // Carry a detached media descriptor through normalization (so a future
      // persisted layout restores its media pane). A live canvasId is a transient
      // WebContentsView handle that can't survive a reload, so it is intentionally
      // dropped; mediaRef is pure data and is preserved when present.
      const media = (pane.mediaRef ?? null) as MultiviewPaneMediaRef | null
      const mediaPart = media ? { mediaRef: media } : {}
      if (typeof pane.id === 'string' && pane.id) return { id: pane.id, chatId, ...mediaPart }
      const minted = mintPaneId(seq)
      seq += 1
      return { id: minted, chatId, ...mediaPart }
    })
  } else if (Array.isArray(record.paneChatIds)) {
    sourcePanes = record.paneChatIds.map((entry) => {
      const minted = mintPaneId(seq)
      seq += 1
      return { id: minted, chatId: typeof entry === 'string' ? entry : null }
    })
  }

  const clamped = clampPanes(sourcePanes, layout, seq)
  const rawParkedPanes = Array.isArray(record.parkedPanes)
    ? record.parkedPanes
        .map((entry) => {
          const pane = (entry ?? {}) as Record<string, unknown>
          const chatId = typeof pane.chatId === 'string' ? pane.chatId : null
          const media = (pane.mediaRef ?? null) as MultiviewPaneMediaRef | null
          const id = typeof pane.id === 'string' && pane.id ? pane.id : mintPaneId(seq++)
          return { id, chatId, ...(media ? { mediaRef: media } : {}) }
        })
        .filter((pane) => !clamped.panes.some((visible) => visible.id === pane.id))
    : []
  // Never let the sequence trail behind an existing id, so future mints can't collide.
  const nextPaneSeq = Math.max(
    clamped.nextPaneSeq,
    seq,
    highestPaneSeq([...clamped.panes, ...rawParkedPanes]) + 1
  )

  const trackSizes =
    record.trackSizes && typeof record.trackSizes === 'object'
      ? (record.trackSizes as MultiviewTrackSizes)
      : {}
  const rawSettings =
    record.paneSettings && typeof record.paneSettings === 'object'
      ? (record.paneSettings as Record<string, MultiviewPaneSettings>)
      : {}

  return {
    layout,
    panes: clamped.panes,
    parkedPanes: rawParkedPanes,
    focusedPaneIndex: clampFocusedPaneIndex(Number(record.focusedPaneIndex) || 0, layout),
    trackSizes,
    // Drop settings for any pane id not present after clamping.
    paneSettings: pruneSettings(rawSettings, [...clamped.panes, ...rawParkedPanes]),
    nextPaneSeq
  }
}

export interface MultiviewPaneRefs {
  scrollRef: RefObject<HTMLDivElement | null>
  contentRef: RefObject<HTMLDivElement | null>
  endRef: RefObject<HTMLDivElement | null>
  /** Reader ownership is pane-local and chat-keyed: two panes may show the same
   * chat at different positions without influencing each other. */
  autoFollowRef: MutableRefObject<boolean>
  setAutoFollow: (next: boolean) => void
  chatScrollStateByIdRef: MutableRefObject<Map<string, CachedChatScrollState>>
  /** Bound by ChatViewPane while mounted so sending from a resting pane matches
   * the focused composer's relock-to-latest behavior. */
  bindRelockToLatest: (handler: () => void) => () => void
  relockToLatest: () => void
}

export function createMultiviewPaneRefs(): MultiviewPaneRefs {
  const autoFollowRef: MutableRefObject<boolean> = { current: true }
  let relockToLatestHandler: (() => void) | null = null
  return {
    scrollRef: { current: null },
    contentRef: { current: null },
    endRef: { current: null },
    autoFollowRef,
    setAutoFollow: (next) => {
      autoFollowRef.current = next
    },
    chatScrollStateByIdRef: { current: new Map() },
    bindRelockToLatest: (handler) => {
      relockToLatestHandler = handler
      return () => {
        if (relockToLatestHandler === handler) relockToLatestHandler = null
      }
    },
    relockToLatest: () => relockToLatestHandler?.()
  }
}

/** Resolve refs by stable pane id, not cell index. Surviving panes therefore
 * retain reader state when another cell closes and the grid compacts. */
export function resolveMultiviewPaneRefs(
  panes: ReadonlyArray<MultiviewPaneRecord>,
  refsByPaneId: Map<string, MultiviewPaneRefs>
): MultiviewPaneRefs[] {
  return panes.map((pane) => {
    const existing = refsByPaneId.get(pane.id)
    if (existing) return existing
    const created = createMultiviewPaneRefs()
    refsByPaneId.set(pane.id, created)
    return created
  })
}

export interface UseMultiviewStateOptions {
  /** Seed pane 0 with this chat id (the chat that was active before split). */
  initialPaneChatId?: string | null
}

export interface UseMultiviewStateResult extends MultiviewCoreState {
  /** Local focus authority. MultiviewPaneGrid subscribes without re-rendering App. */
  focusStore: MultiviewFocusStore
  /** paneChatIds[focusedPaneIndex] (or null). The chat the sidebar/composer drive. */
  focusedChatId: string | null
  /** The stable id of the focused pane (or null) — key future per-pane settings off this. */
  focusedPaneId: string | null
  /** The chats in cell order — the backward-compatible index-based view of `panes`. */
  paneChatIds: (string | null)[]
  isMultiview: boolean
  /** Stable, pane-id-keyed refs in current cell order. */
  paneRefs: MultiviewPaneRefs[]
  /** Effective column/row fractions for the CURRENT layout (dragged or spec). */
  tracks: MultiviewLayoutTracks
  setLayout: (next: MultiviewLayout, seedChatId?: string | null) => void
  setPaneChat: (index: number, chatId: string | null) => void
  setPaneCanvas: (index: number, canvasId: string | null) => void
  /** Put a detached audio/video player in a pane; `null` clears it. */
  setPaneMedia: (index: number, mediaRef: MultiviewPaneMediaRef | null) => void
  setFocusedPane: (index: number) => void
  /** Select an empty pane without allowing singleton state to overwrite pane ownership. */
  focusEmptyPane: (index: number, outgoingVisibleChatId?: string | null) => void
  closePane: (index: number) => void
  /** Place a chat in the focused pane, or focus its existing pane. */
  assignToFocusedPane: (chatId: string) => void
  /** Open a chat in a non-focused pane (grows the layout if needed); keeps focus. */
  openInNewPane: (chatId: string, outgoingFocusedChatId?: string | null) => void
  /** Detach an A/V player into a non-focused pane (grows if needed); keeps focus. */
  openMediaInNewPane: (mediaRef: MultiviewPaneMediaRef) => void
  /** Drag a gutter: move `deltaPx` between two adjacent tracks (clamped at min). */
  resizeTrack: (args: ApplyResizeTrackArgs) => void
  /** Double-click a gutter: reset a layout's fractions to the spec defaults. */
  resetTrackSizes: (layout?: MultiviewLayout) => void
  /**
   * Per-pane FX overrides keyed by pane INDEX — a derived, backward-compatible
   * view of the id-keyed `paneSettings`. A missing entry/field => follow the
   * app-global flag (App resolves `paneFx[i]?.sky ?? globalSky`).
   */
  paneFx: Record<number, MultiviewPaneFxOverride>
  /**
   * Set a pane's sky/ghost override to an EXPLICIT boolean. Index-based for
   * call-site compatibility; resolved to the pane's stable id internally so the
   * override follows the pane across close/compaction. Because a missing entry
   * means "follow global", callers pass the next effective value (e.g.
   * `!effectiveSky`) so the first toggle visibly flips state.
   */
  setPaneFxFlag: (paneIndex: number, flag: MultiviewPaneFxFlag, value: boolean) => void
}

export function useMultiviewState(options: UseMultiviewStateOptions = {}): UseMultiviewStateResult {
  const [state, setState] = useState<MultiviewCoreState>(() =>
    createInitialMultiviewState(options.initialPaneChatId ?? null)
  )
  // `stateRef` is authoritative for focus-only transitions that deliberately
  // skip setState. Structural transitions mirror it back into React state.
  const stateRef = useRef(state)
  const focusStoreRef = useRef(createMultiviewFocusStore(state.focusedPaneIndex))
  const commitState = useCallback((transition: (current: MultiviewCoreState) => MultiviewCoreState) => {
    const previous = stateRef.current
    const next = transition(previous)
    if (next === previous) return
    stateRef.current = next
    focusStoreRef.current.set(next.focusedPaneIndex)
    if (!isMultiviewFocusOnlyChange(previous, next)) setState(next)
  }, [])

  const paneRefsByIdRef = useRef(new Map<string, MultiviewPaneRefs>())
  const paneRefs = useMemo(
    () => resolveMultiviewPaneRefs(state.panes, paneRefsByIdRef.current),
    [state.panes]
  )
  useLayoutEffect(() => {
    const livePaneIds = new Set(
      [...state.panes, ...state.parkedPanes].map((pane) => pane.id)
    )
    for (const paneId of paneRefsByIdRef.current.keys()) {
      if (!livePaneIds.has(paneId)) paneRefsByIdRef.current.delete(paneId)
    }
  }, [state.panes, state.parkedPanes])

  const setLayout = useCallback((next: MultiviewLayout, seedChatId: string | null = null) => {
    commitState((s) => applySetLayout(s, next, { seedChatId }))
  }, [commitState])
  const setPaneChat = useCallback(
    (index: number, chatId: string | null) => commitState((s) => applySetPaneChat(s, index, chatId)),
    [commitState]
  )
  const setPaneCanvas = useCallback(
    (index: number, canvasId: string | null) =>
      commitState((s) => applySetPaneCanvas(s, index, canvasId)),
    [commitState]
  )
  const setPaneMedia = useCallback(
    (index: number, mediaRef: MultiviewPaneMediaRef | null) =>
      commitState((s) => applySetPaneMedia(s, index, mediaRef)),
    [commitState]
  )
  const setFocusedPane = useCallback(
    (index: number) => commitState((s) => applySetFocusedPane(s, index)),
    [commitState]
  )
  const focusEmptyPane = useCallback(
    (index: number, outgoingVisibleChatId: string | null = null) => {
      commitState((s) => applyFocusEmptyPane(s, index, outgoingVisibleChatId))
    },
    [commitState]
  )
  const closePane = useCallback(
    (index: number) => commitState((s) => applyClosePane(s, index)),
    [commitState]
  )
  const assignToFocusedPane = useCallback((chatId: string) => {
    commitState((s) => applyAssignToFocusedPane(s, chatId).state)
  }, [commitState])
  const openInNewPane = useCallback(
    (chatId: string, outgoingFocusedChatId: string | null = null) => {
      commitState((s) => applyOpenInNewPane(s, chatId, outgoingFocusedChatId))
    },
    [commitState]
  )
  const openMediaInNewPane = useCallback((mediaRef: MultiviewPaneMediaRef) => {
    commitState((s) => applyOpenMediaInNewPane(s, mediaRef))
  }, [commitState])
  const resizeTrack = useCallback((args: ApplyResizeTrackArgs) => {
    commitState((s) => applyResizeTrack(s, args))
  }, [commitState])
  const resetTrackSizes = useCallback((layout?: MultiviewLayout) => {
    commitState((s) => applyResetTrackSizes(s, layout ?? s.layout))
  }, [commitState])
  const setPaneFxFlag = useCallback(
    (paneIndex: number, flag: MultiviewPaneFxFlag, value: boolean) => {
      commitState((s) => {
        const paneId = s.panes[paneIndex]?.id
        if (!paneId) return s
        return applySetPaneFxFlag(s, paneId, flag, value)
      })
    },
    [commitState]
  )

  // Backward-compatible index-based views, memoized so their identity is stable
  // across renders where the underlying records/settings are unchanged (the
  // effects/memos in App that depend on `paneChatIds`/`paneFx` must not churn).
  const paneChatIds = useMemo(() => state.panes.map((pane) => pane.chatId), [state.panes])
  const paneFx = useMemo<Record<number, MultiviewPaneFxOverride>>(() => {
    const map: Record<number, MultiviewPaneFxOverride> = {}
    state.panes.forEach((pane, i) => {
      const fx = state.paneSettings[pane.id]?.fx
      if (fx) map[i] = fx
    })
    return map
  }, [state.panes, state.paneSettings])

  const tracks = useMemo(
    () => getLayoutTracks(state.trackSizes, state.layout),
    [state.trackSizes, state.layout]
  )

  return {
    ...state,
    // Accessors stay live even when App itself has not rendered since the last
    // focus click. Event handlers may safely read these through an old closure.
    get focusedPaneIndex() {
      return focusStoreRef.current.getSnapshot()
    },
    get focusedChatId() {
      const focusedPane = stateRef.current.panes[focusStoreRef.current.getSnapshot()]
      return focusedPane?.chatId ?? null
    },
    get focusedPaneId() {
      const focusedPane = stateRef.current.panes[focusStoreRef.current.getSnapshot()]
      return focusedPane?.id ?? null
    },
    focusStore: focusStoreRef.current,
    paneChatIds,
    isMultiview: state.layout !== 'single',
    paneRefs,
    tracks,
    setLayout,
    setPaneChat,
    setPaneCanvas,
    setPaneMedia,
    setFocusedPane,
    focusEmptyPane,
    closePane,
    assignToFocusedPane,
    openInNewPane,
    openMediaInNewPane,
    resizeTrack,
    resetTrackSizes,
    paneFx,
    setPaneFxFlag
  }
}
