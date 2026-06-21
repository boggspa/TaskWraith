import { useCallback, useMemo, useRef, useState } from 'react'
import type { RefObject } from 'react'
import {
  DEFAULT_MULTIVIEW_LAYOUT,
  MAX_MULTIVIEW_PANES,
  clampFocusedPaneIndex,
  defaultColumnFractions,
  defaultRowFractions,
  normalizeMultiviewLayout,
  paneCountForLayout,
  type MultiviewGutterOrientation,
  type MultiviewLayout,
  type MultiviewPaneRecord
} from '../../../shared/multiviewLayouts'

/**
 * useMultiviewState — owns the renderer-only Multiview state (which layout,
 * which chat is in each pane, which pane is focused, and per-pane settings). The
 * focused pane is wired to the existing currentChat machinery in App.tsx; this
 * hook writes no App singleton. All real logic lives in the pure `apply*`
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
  // Assigning a chat clears any canvas (the two are mutually exclusive). No-op for
  // an ordinary canvas-less pane already on this chatId. Canvas-less panes keep the
  // exact old shape (no canvasId key) so existing records are byte-identical.
  if (pane.chatId === chatId && !pane.canvasId) return panes
  const next = panes.slice()
  next[index] = pane.canvasId ? { ...pane, chatId, canvasId: null } : { ...pane, chatId }
  return next
}

/** Put a live-embedded canvas in a pane (clears its chat). `null` clears the canvas. */
export function applySetPaneCanvas(
  state: MultiviewCoreState,
  index: number,
  canvasId: string | null
): MultiviewCoreState {
  if (index < 0 || index >= state.panes.length) return state
  const pane = state.panes[index]
  if ((pane.canvasId ?? null) === canvasId && (canvasId === null || pane.chatId === null)) {
    return state
  }
  const next = state.panes.slice()
  next[index] = { ...pane, canvasId, chatId: canvasId ? null : pane.chatId }
  return { ...state, panes: next }
}

export function createInitialMultiviewState(
  initialPaneChatId: string | null = null
): MultiviewCoreState {
  return {
    layout: DEFAULT_MULTIVIEW_LAYOUT,
    panes: [{ id: mintPaneId(1), chatId: initialPaneChatId }],
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

/** Switch layout, re-clamping pane records and the focused index to fit. */
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
  // Seed the focused pane's chat first (id preserved) before clamping.
  const seededPanes = seedChatId
    ? withChatAt(state.panes, state.focusedPaneIndex, seedChatId)
    : state.panes
  const clamped = clampPanes(seededPanes, next, state.nextPaneSeq)
  let panes = clamped.panes
  if (seedChatId && nextPaneCount > previousPaneCount) {
    panes = panes.map((pane) => (pane.chatId == null ? { ...pane, chatId: seedChatId } : pane))
  }
  return {
    layout: next,
    panes,
    focusedPaneIndex: clampFocusedPaneIndex(state.focusedPaneIndex, next),
    // Track fractions are keyed by layout id, so they survive switching layouts
    // within a session (and a return to a previously-dragged layout restores it).
    trackSizes: state.trackSizes,
    // Shrinking drops tail panes; prune their now-orphaned settings.
    paneSettings: pruneSettings(state.paneSettings, panes),
    nextPaneSeq: clamped.nextPaneSeq
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
 * Close a pane: drop that cell, compact the rest in order (SURVIVING panes keep
 * their ids and settings), and downgrade the layout one step. Focus follows:
 * closing before the focused cell shifts focus left by one; closing the focused
 * cell keeps focus on the same slot index (clamped). A no-op in single layout.
 */
export function applyClosePane(state: MultiviewCoreState, index: number): MultiviewCoreState {
  if (state.layout === 'single') return state
  if (index < 0 || index >= state.panes.length) return state
  const nextLayout = DOWNGRADE_LAYOUT[state.layout]
  const remaining = state.panes.filter((_, i) => i !== index)
  // Downgrade always reduces paneCount by exactly one, so `remaining` already
  // matches nextLayout's count — clampPanes is a no-op pass-through here.
  const clamped = clampPanes(remaining, nextLayout, state.nextPaneSeq)
  let nextFocus = state.focusedPaneIndex
  if (index < state.focusedPaneIndex) nextFocus -= 1
  else if (index === state.focusedPaneIndex) nextFocus = index
  return {
    layout: nextLayout,
    panes: clamped.panes,
    focusedPaneIndex: clampFocusedPaneIndex(nextFocus, nextLayout),
    trackSizes: state.trackSizes,
    paneSettings: pruneSettings(state.paneSettings, clamped.panes),
    nextPaneSeq: clamped.nextPaneSeq
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
  if (state.panes[state.focusedPaneIndex]?.chatId == null) {
    target = state.focusedPaneIndex
  } else {
    const firstEmpty = state.panes.findIndex((pane) => pane.chatId == null)
    target = firstEmpty >= 0 ? firstEmpty : state.focusedPaneIndex
  }
  target = Math.max(0, Math.min(target, count - 1))
  const panes = withChatAt(state.panes, target, chatId)
  return { state: { ...state, panes, focusedPaneIndex: target }, index: target }
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
  const hasSpare = next.panes.some((pane, i) => i !== next.focusedPaneIndex && pane.chatId == null)
  if (!hasSpare) {
    const grown = UPGRADE_LAYOUT[next.layout]
    if (grown !== next.layout) next = applySetLayout(next, grown)
  }
  let target = next.panes.findIndex((pane, i) => i !== next.focusedPaneIndex && pane.chatId == null)
  if (target < 0) target = next.panes.findIndex((_, i) => i !== next.focusedPaneIndex)
  if (target < 0) target = next.focusedPaneIndex
  const panes = withChatAt(next.panes, target, chatId)
  return { ...next, panes }
}

/**
 * Open a live-embedded CANVAS in a NON-focused pane WITHOUT moving focus — the
 * composer "Open web canvas" button. Grows the layout by one pane when there is no
 * spare (chat-less AND canvas-less) non-focused cell; once at quad, overwrites a
 * non-focused cell. The focused chat pane is never disturbed. Returns the target
 * pane index so the caller can wire the embed there.
 */
export function applyOpenCanvasInNewPane(
  state: MultiviewCoreState,
  canvasId: string
): { state: MultiviewCoreState; index: number } {
  let next = state
  const hasSpare = next.panes.some(
    (pane, i) => i !== next.focusedPaneIndex && pane.chatId == null && pane.canvasId == null
  )
  if (!hasSpare) {
    const grown = UPGRADE_LAYOUT[next.layout]
    if (grown !== next.layout) next = applySetLayout(next, grown)
  }
  let target = next.panes.findIndex(
    (pane, i) => i !== next.focusedPaneIndex && pane.chatId == null && pane.canvasId == null
  )
  if (target < 0) target = next.panes.findIndex((_, i) => i !== next.focusedPaneIndex)
  if (target < 0) target = next.focusedPaneIndex
  next = applySetPaneCanvas(next, target, canvasId)
  return { state: next, index: target }
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
      if (typeof pane.id === 'string' && pane.id) return { id: pane.id, chatId }
      const minted = mintPaneId(seq)
      seq += 1
      return { id: minted, chatId }
    })
  } else if (Array.isArray(record.paneChatIds)) {
    sourcePanes = record.paneChatIds.map((entry) => {
      const minted = mintPaneId(seq)
      seq += 1
      return { id: minted, chatId: typeof entry === 'string' ? entry : null }
    })
  }

  const clamped = clampPanes(sourcePanes, layout, seq)
  // Never let the sequence trail behind an existing id, so future mints can't collide.
  const nextPaneSeq = Math.max(clamped.nextPaneSeq, highestPaneSeq(clamped.panes) + 1)

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
    focusedPaneIndex: clampFocusedPaneIndex(Number(record.focusedPaneIndex) || 0, layout),
    trackSizes,
    // Drop settings for any pane id not present after clamping.
    paneSettings: pruneSettings(rawSettings, clamped.panes),
    nextPaneSeq
  }
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
  /** The stable id of the focused pane (or null) — key future per-pane settings off this. */
  focusedPaneId: string | null
  /** The chats in cell order — the backward-compatible index-based view of `panes`. */
  paneChatIds: (string | null)[]
  isMultiview: boolean
  /** Stable per-pane ref pool (length MAX_MULTIVIEW_PANES) for the grid panes. */
  paneRefs: MultiviewPaneRefs[]
  /** Effective column/row fractions for the CURRENT layout (dragged or spec). */
  tracks: MultiviewLayoutTracks
  setLayout: (next: MultiviewLayout, seedChatId?: string | null) => void
  setPaneChat: (index: number, chatId: string | null) => void
  setPaneCanvas: (index: number, canvasId: string | null) => void
  setFocusedPane: (index: number) => void
  focusPane: (index: number, outgoingFocusedChatId?: string | null) => void
  closePane: (index: number) => void
  /** Place + focus a chat; returns the pane index it landed in. */
  assignToNextPane: (chatId: string) => number
  /** Open a chat in a non-focused pane (grows the layout if needed); keeps focus. */
  openInNewPane: (chatId: string, outgoingFocusedChatId?: string | null) => void
  /** Open a live-embedded canvas in a new/spare non-focused pane; returns its index. */
  openCanvasInNewPane: (canvasId: string) => number
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

  // Keep the latest state reachable synchronously so assignToNextPane can
  // return the chosen index without depending on a setState callback's timing.
  const stateRef = useRef(state)
  stateRef.current = state

  // One stable ref-object pool for every possible pane. Plain { current }
  // objects are valid React refs; memoized so identity never changes. Kept
  // index-keyed (transient DOM anchors, re-attached per render) — pane identity
  // for SETTINGS lives in `paneSettings`, not here.
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
  const setPaneCanvas = useCallback(
    (index: number, canvasId: string | null) =>
      setState((s) => applySetPaneCanvas(s, index, canvasId)),
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
  const openCanvasInNewPane = useCallback((canvasId: string) => {
    const result = applyOpenCanvasInNewPane(stateRef.current, canvasId)
    stateRef.current = result.state
    setState(result.state)
    return result.index
  }, [])
  const resizeTrack = useCallback((args: ApplyResizeTrackArgs) => {
    setState((s) => applyResizeTrack(s, args))
  }, [])
  const resetTrackSizes = useCallback((layout?: MultiviewLayout) => {
    setState((s) => applyResetTrackSizes(s, layout ?? s.layout))
  }, [])
  const setPaneFxFlag = useCallback(
    (paneIndex: number, flag: MultiviewPaneFxFlag, value: boolean) => {
      setState((s) => {
        const paneId = s.panes[paneIndex]?.id
        if (!paneId) return s
        return applySetPaneFxFlag(s, paneId, flag, value)
      })
    },
    []
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

  const focusedPane = state.panes[state.focusedPaneIndex]
  const focusedChatId = focusedPane?.chatId ?? null
  const focusedPaneId = focusedPane?.id ?? null
  const tracks = useMemo(
    () => getLayoutTracks(state.trackSizes, state.layout),
    [state.trackSizes, state.layout]
  )

  return {
    ...state,
    focusedChatId,
    focusedPaneId,
    paneChatIds,
    isMultiview: state.layout !== 'single',
    paneRefs,
    tracks,
    setLayout,
    setPaneChat,
    setPaneCanvas,
    setFocusedPane,
    focusPane,
    closePane,
    assignToNextPane,
    openInNewPane,
    openCanvasInNewPane,
    resizeTrack,
    resetTrackSizes,
    paneFx,
    setPaneFxFlag
  }
}
