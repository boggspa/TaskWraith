/**
 * 1.0.6-TV0 — Pure windowing model for the virtualised transcript.
 *
 * The transcript (`TranscriptPanel` in App.tsx) maps the full
 * `visibleMessages` list to `.transcript-message-block` rows today, so
 * render work + memory scale with total chat length. This module holds
 * the pure decision logic for an in-house spacer-above/spacer-below
 * virtualiser: project messages → stable virtual rows, pick the visible
 * window + overscan, size the top/bottom spacers, key a measurement
 * cache, and compute the scroll-anchor correction when rows above the
 * viewport mount or resize.
 *
 * It is deliberately renderer-free (no DOM, no React) so the window math
 * is unit-testable in isolation — the same extraction pattern as
 * `TranscriptScroll.ts`. The renderer feeds it `scrollTop` /
 * `viewportHeight` from the EXISTING scroll container + listener; this
 * module never reads or writes the DOM and never substitutes its own
 * value for the browser's real `scrollHeight` (the spacers + mounted
 * rows + sentinel still sum to the true height, so every `shouldRepin*`
 * path in `TranscriptScroll.ts` keeps working byte-for-byte).
 */

import type { ChatMessage } from '../../../main/store/types'
import { isGuestParticipantReplyMessage } from '../components/GuestParticipantReplyCardModel'
import { isEnsembleFanoutResultMessage } from '../components/EnsembleFanoutResultCardModel'
import { isSubThreadDelegationMessage } from '../components/SubThreadDelegationCardModel'
import { isSubThreadReturnMessage } from '../components/SubThreadReturnCardModel'
import {
  isDeliveredExternalContribution,
  isHumanCollaboratorComment
} from '../../../main/collaboration/HumanCollaboratorMessages'

/**
 * One virtual row per transcript-message-block (the unit keyed
 * `message-block-${id}` in the renderer). NOT one per card: a block can
 * carry a RunCard boundary above its body, captured by `hasRunBoundary`.
 */
export type VirtualRowType =
  | 'user'
  | 'assistant'
  | 'system'
  | 'error'
  | 'tool'
  | 'participantHealth'
  | 'delegation'
  | 'return'
  | 'fanoutResult'
  | 'guestReply'
  | 'collaborator'

export interface VirtualRow {
  /** Stable, persisted message id. NOT guaranteed unique — historical /
   *  imported data can carry duplicate message ids (e.g. pre-1.0.7 ensemble
   *  round-status messages all shared `ensemble-round-status-${roundId}`). Use
   *  `rowKey` for React keys / DOM-element + measurement maps; `id` is for
   *  content/measurement-cache identity only. */
  id: string
  /** Collision-proof row key: `${id}#${index}`. The index disambiguates
   *  duplicate message ids so React keys, the `blockElsRef` element map, and
   *  the `data-vrow-id` lookups can never collide — a duplicate id would
   *  otherwise make multiple rows share one DOM node + one measurement slot,
   *  scrambling render order and heights (the "System rows pinned to top" /
   *  load-unload bug). Stable for a given message list. */
  rowKey: string
  /** Position in the source `visibleMessages` list. */
  index: number
  rowType: VirtualRowType
  /** Cheap content-only change token (see `contentVersion`). Geometry
   *  inputs (width bucket, expansion) are folded in at `measurementKey`
   *  time, not here. */
  contentVersion: string
  /** Heuristic height used until the row mounts + reports a real one. */
  estimatedHeight: number
  /** A RunCard renders above this block (first message of a new run). */
  hasRunBoundary: boolean
}

export interface VirtualWindow {
  /** First mounted row index (inclusive). */
  startIndex: number
  /** One past the last mounted row index (exclusive). */
  endIndex: number
  /** Height of the collapsed run of rows before `startIndex`. */
  topSpacerPx: number
  /** Height of the collapsed run of rows at/after `endIndex`. */
  bottomSpacerPx: number
}

/**
 * Per-row-type height estimates (CSS px). Intentionally generous —
 * estimates only govern off-screen spacer sizing + the very first paint;
 * once a row mounts its measured height (keyed by `measurementKey`)
 * overrides the estimate, and the anchor-correction pass absorbs the
 * difference. Tuned to typical resting heights, not worst case.
 */
export const ESTIMATED_ROW_HEIGHT_PX: Record<VirtualRowType, number> = {
  user: 88,
  assistant: 220,
  system: 64,
  error: 80,
  tool: 180,
  participantHealth: 132,
  delegation: 104,
  return: 148,
  fanoutResult: 320,
  guestReply: 220,
  collaborator: 132
}

/** Extra height added when a RunCard boundary renders above a block. */
export const RUN_BOUNDARY_HEIGHT_PX = 44

/**
 * Master gate for the in-house transcript virtualiser. TV3 flips this
 * ON by default: the transcript now mounts only the visible window +
 * overscan. The non-virtualised full-list branch is intentionally kept
 * (NOT deleted) as the instant-revert path through the `virtualize`
 * prop and as the explicit `virtualize={false}` path the renderer tests
 * exercise — its deletion is deferred until after live soak confirms no
 * scroll regressions (the documented post-soak follow-up).
 */
export const TRANSCRIPT_VIRTUALIZATION_ENABLED = true

/**
 * Overscan, in CSS px, mounted above + below the strictly-visible
 * window. Pixel-based (not row-count) because transcript rows vary
 * wildly in height. ~1.5 viewports of headroom keeps fast scrolls from
 * flashing blank while keeping the mounted set bounded.
 */
export const DEFAULT_OVERSCAN_PX = 900

/**
 * Quantise the transcript content width so a resize that does NOT change
 * text wrapping reuses cached measurements, while a real reflow (column
 * width crosses a bucket boundary) invalidates them. One bucket value
 * for the whole single-column list.
 */
export const WIDTH_BUCKET_PX = 80

export function widthBucket(clientWidth: number, step: number = WIDTH_BUCKET_PX): number {
  if (!Number.isFinite(clientWidth) || clientWidth <= 0) return 0
  return Math.floor(clientWidth / step)
}

/**
 * Classify a message into its virtual row type, mirroring the renderer's
 * dispatch in `TranscriptPanel` (App.tsx ~6268). Order matters: the
 * sub-thread delegation/return cards are detected first (they reuse
 * `role: 'system'`/`'tool'` with a metadata `kind`), then plain tool
 * rows (ActivityStack), then the participant-health card, then the
 * role-based message bubbles. Uses the canonical `isSubThread*` model
 * helpers so this stays in lockstep with the renderer.
 */
export function classifyRowType(message: ChatMessage): VirtualRowType {
  if (isSubThreadDelegationMessage(message)) return 'delegation'
  if (isSubThreadReturnMessage(message)) return 'return'
  if (isEnsembleFanoutResultMessage(message)) return 'fanoutResult'
  if (isGuestParticipantReplyMessage(message)) return 'guestReply'
  if (isHumanCollaboratorComment(message)) return 'collaborator'
  // Same rendering as a comment now, so it must share the height bucket — as a
  // 'system' row it was estimated at half its real height.
  if (isDeliveredExternalContribution(message)) return 'collaborator'
  if (message.role === 'tool') {
    return (message.toolActivities?.length || 0) > 0 ? 'tool' : 'system'
  }
  if (message.metadata?.kind === 'ensembleParticipantHealth') return 'participantHealth'
  if (message.role === 'user') return 'user'
  if (message.role === 'error') return 'error'
  if (message.role === 'assistant') return 'assistant'
  return 'system'
}

/**
 * A cheap, content-derived token that changes exactly when a row's
 * rendered body would change height. Crucially this lets a streaming
 * token invalidate ONE row's cached measurement, never the whole list:
 *
 *   - text rows (user/assistant/system/error): role + content length + a bounded
 *     markdown-shape sample. This stays cheap for long transcripts while catching
 *     same-length edits that change wrapping/fences/media hints.
 *   - tool rows (ActivityStack): activity count + every activity's
 *     status + total output-preview length. Captures the two things
 *     that change an ActivityStack's height: a status flip
 *     (running→success collapses the row) and output being revealed.
 *
 * Width bucket + expansion state are NOT folded in here — they are
 * geometry, added at `measurementKey` time so a content-identical row
 * at a new width/expansion gets a distinct cache slot.
 */
const CONTENT_VERSION_SAMPLE_CHARS = 256

function textShapeVersion(role: ChatMessage['role'], content: string): string {
  const len = content.length
  const sample =
    len > CONTENT_VERSION_SAMPLE_CHARS * 2
      ? `${content.slice(0, CONTENT_VERSION_SAMPLE_CHARS)}\u0000${content.slice(-CONTENT_VERSION_SAMPLE_CHARS)}`
      : content
  let hash = 2166136261
  let newlines = 0
  let fenceTicks = 0
  let markdownImageHints = 0
  for (let i = 0; i < sample.length; i += 1) {
    const code = sample.charCodeAt(i)
    hash ^= code
    hash = Math.imul(hash, 16777619)
    if (code === 10) newlines += 1
    if (code === 96) fenceTicks += 1
    if (code === 33 && sample.charCodeAt(i + 1) === 91) markdownImageHints += 1
  }
  return `${role[0] || 'x'}:${len}:${newlines}:${fenceTicks}:${markdownImageHints}:${(hash >>> 0).toString(36)}`
}

export function contentVersion(message: ChatMessage): string {
  if (message.role === 'tool') {
    const activities = message.toolActivities || []
    if (activities.length === 0) {
      return textShapeVersion(message.role, message.content || '')
    }
    let outputLen = 0
    let statuses = ''
    for (const a of activities) {
      outputLen += a.outputPreview?.length || a.resultSummary?.length || 0
      statuses += `${a.status || '?'}|`
    }
    return `t:${activities.length}:${statuses}:${outputLen}`
  }
  const activities = message.toolActivities || []
  if (activities.length > 0) {
    let outputLen = 0
    let statuses = ''
    for (const a of activities) {
      outputLen += a.outputPreview?.length || a.resultSummary?.length || 0
      statuses += `${a.status || '?'}|`
    }
    return `${textShapeVersion(message.role, message.content || '')}:t:${activities.length}:${statuses}:${outputLen}`
  }
  return textShapeVersion(message.role, message.content || '')
}

/**
 * 1.0.7 — content-scaled estimate. The flat per-type estimates badly
 * under-shoot dense rows: an ensemble participant answer is commonly
 * 600–1200px but `assistant` estimates 220px (~4–5×). That gap is the fuel
 * for the windowing oscillation — the window mounts a wide span off the small
 * estimate, the rows measure huge, the window collapses to the short System
 * rows, and it limit-cycles. Scaling text-row estimates by content length
 * makes the FIRST window land close, so it converges in one settle frame
 * instead of flickering. Tool rows keep the flat estimate (their height is
 * driven by activity count, not text length).
 *
 * ~0.42px/char ≈ one ~980px-wide wrapped line (~40px) per ~95 chars. Floored
 * at the per-type estimate (short rows unchanged) and capped so a pathological
 * message can't size the spacer to absurd values.
 */
export const CONTENT_PX_PER_CHAR = 0.42
export const CONTENT_SCALE_CAP_PX = 1400
const CONTENT_SCALED_TYPES: ReadonlySet<VirtualRowType> = new Set([
  'assistant',
  'user',
  'system',
  'error',
  'tool',
  'return',
  'fanoutResult',
  'guestReply',
  'collaborator'
])
const TOOL_ACTIVITY_ESTIMATE_CHARS = 180

/**
 * Tighter scale ceiling for row types whose ENTIRE body renders inside a single
 * height-clamped `LiveActivityViewport`, so their off-screen (collapsed) height
 * is bounded no matter how much content accumulates.
 *
 * `fanoutResult`: `EnsembleFanoutResultCard` wraps the whole card body in one
 * viewport capped at 240px (`collapsedMaxHeight={240}`); with the header + chrome
 * a collapsed lane card rests at ~320px — the flat base estimate. Historical
 * READ-heavy Cursor fan-out transcripts can contain thousands of chars of tool
 * output, which the
 * generic content scale would size toward `CONTENT_SCALE_CAP_PX` (1400) — ~5× the
 * real clamped height. That phantom height inflates the virtualiser's bottom
 * spacer, so `scrollHeight` balloons on every 250ms flush while the visible card
 * stays 240px. Auto-follow's snap-to-`scrollHeight` then lurches the viewport into
 * empty overscan (the "jumps to the bottom even though the fan-out output is
 * contained in its collapsible window" report), and a scrolled-away reader's
 * `distanceFromBottom` is corrupted enough to feed the re-engage bands. Capping the
 * estimate at the real clamped height keeps `scrollHeight` honest.
 *
 * NOT applied to `tool`: a standalone `ActivityStack` renders one viewport PER
 * segment with no single outer cap, so its height genuinely scales with activity
 * count and the generic scale is appropriate.
 */
export const VIEWPORT_CLAMPED_ESTIMATE_CAP_PX = 360
const VIEWPORT_CLAMPED_TYPES: ReadonlySet<VirtualRowType> = new Set(['fanoutResult'])

/**
 * Per-activity ceiling on how many output characters feed a row's height
 * estimate. An ActivityStack's rendered height scales with activity COUNT —
 * every activity body (thinking traces especially) sits inside a bounded
 * collapsed LiveActivityViewport or a click-to-expand row, so ONE activity
 * accumulating 100KB of un-truncated thinking must not scale the estimate
 * toward CONTENT_SCALE_CAP_PX (1400) when its real clamped contribution is
 * ~200px. The uncapped sum was the long-thinking analog of the fanoutResult
 * phantom height: any content-version cache miss (the row updating while NOT
 * the active live tail — e.g. thinking still growing above a system event)
 * snapped the row from its measured ~250px to the ballooned estimate and back
 * every delta flush — the "transcript jerking". 480 chars ≈ 200px at
 * CONTENT_PX_PER_CHAR, roughly one collapsed viewport.
 */
export const ACTIVITY_OUTPUT_ESTIMATE_CHAR_CAP = 480

export function estimatedHeightFor(
  rowType: VirtualRowType,
  hasRunBoundary: boolean,
  contentLength = 0
): number {
  const base = ESTIMATED_ROW_HEIGHT_PX[rowType]
  const scaleCap = VIEWPORT_CLAMPED_TYPES.has(rowType)
    ? VIEWPORT_CLAMPED_ESTIMATE_CAP_PX
    : CONTENT_SCALE_CAP_PX
  const scaled = CONTENT_SCALED_TYPES.has(rowType)
    ? Math.min(scaleCap, Math.max(base, Math.round(contentLength * CONTENT_PX_PER_CHAR)))
    : base
  return scaled + (hasRunBoundary ? RUN_BOUNDARY_HEIGHT_PX : 0)
}

/**
 * Project the (already-filtered) `visibleMessages` list into stable
 * virtual rows. `runBoundaryIds` is the set of message ids that begin a
 * new run (the renderer's `runBoundaryByMessageId` keys) — those rows
 * carry a RunCard above them, so their estimate is taller.
 *
 * Derived, never stored: the same message set always yields the same
 * ids + order, so windowing + measurement caching are stable across
 * re-renders and reloads.
 */
export function projectRows(
  messages: ChatMessage[],
  runBoundaryIds?: ReadonlySet<string> | null,
  unboundedActivityBodies = false
): VirtualRow[] {
  if (!Array.isArray(messages)) return []
  const rows: VirtualRow[] = []
  for (let index = 0; index < messages.length; index++) {
    const message = messages[index]
    const row = projectRow(message, index, runBoundaryIds, unboundedActivityBodies)
    if (row) rows.push(row)
  }
  return rows
}

export function projectRow(
  message: ChatMessage | null | undefined,
  index: number,
  runBoundaryIds?: ReadonlySet<string> | null,
  /** True when the live-activity viewport appearance setting is OFF: activity
   * bodies (thinking traces) then render UNBOUNDED in the transcript flow, so
   * the per-activity char cap would badly undershoot — keep the raw lengths
   * (the generic CONTENT_SCALE_CAP_PX still bounds the estimate). */
  unboundedActivityBodies = false
): VirtualRow | null {
  if (!message || typeof message.id !== 'string') return null
  const rowType = classifyRowType(message)
  const hasRunBoundary = runBoundaryIds ? runBoundaryIds.has(message.id) : false
  // Tool/fan-out/sub-thread rows can hide a lot of content inside bounded
  // viewports. Feed the virtualizer a coarse size signal so it does not begin
  // from a tiny spacer and then spend extra passes correcting when the row
  // enters view. NOTE: `estimatedHeightFor` caps hard-clamped types
  // (`fanoutResult`, whose entire body sits in one 240px viewport) at
  // VIEWPORT_CLAMPED_ESTIMATE_CAP_PX so this coarse signal cannot balloon the
  // bottom spacer past the row's real clamped height (see that constant).
  const activityEstimate =
    (message.toolActivities?.length || 0) * TOOL_ACTIVITY_ESTIMATE_CHARS +
    (message.toolActivities || []).reduce(
      (total, activity) =>
        total +
        (unboundedActivityBodies
          ? activity.resultSummary?.length || activity.outputPreview?.length || 0
          : Math.min(
              ACTIVITY_OUTPUT_ESTIMATE_CHAR_CAP,
              activity.resultSummary?.length || activity.outputPreview?.length || 0
            )),
      0
    )
  const contentLength =
    rowType === 'tool'
      ? activityEstimate
      : Math.max((message.content || '').length, activityEstimate)
  return {
    id: message.id,
    rowKey: `${message.id}#${index}`,
    index,
    rowType,
    contentVersion: contentVersion(message),
    estimatedHeight: estimatedHeightFor(rowType, hasRunBoundary, contentLength),
    hasRunBoundary
  }
}

/**
 * Cache key for a row's measured height. Combines a collision-proof ROW KEY
 * (`rowKey = ${id}#${index}`, NOT the bare message id — duplicate message ids
 * would otherwise share one measurement slot), the content token, the width
 * bucket, and the expansion bit so a cached measurement is reused ONLY when the
 * geometry is comparable. A streamed token (new contentVersion), a width reflow
 * (new bucket), or an expand/collapse (new bit) each yields a fresh key → fresh
 * measurement.
 */
export function measurementKey(
  rowKey: string,
  rowContentVersion: string,
  bucket: number,
  expanded: boolean
): string {
  return `${rowKey}|${rowContentVersion}|${bucket}|${expanded ? 1 : 0}`
}

/**
 * The actively streaming reveal row keeps one measurement slot while it grows.
 * Its message content length can change every provider frame, but giving every
 * token a fresh measurement key makes the virtualizer repeatedly fall back to
 * estimates right where the user is watching. Tool/progress rows get the same
 * treatment while they are the live tail: Kimi-style `_thinking` / progress
 * events can arrive as success-status tool rows whose output keeps changing.
 * Once the row leaves live mode, normal content-version keys resume and the
 * final settled height is measured.
 */
export function measurementContentVersion(
  row: VirtualRow,
  activeLiveRowKey?: string | null
): string {
  if (
    activeLiveRowKey &&
    row.rowKey === activeLiveRowKey &&
    (row.rowType === 'assistant' ||
      row.rowType === 'guestReply' ||
      row.rowType === 'fanoutResult' ||
      row.rowType === 'tool')
  ) {
    return `${row.rowType}:live`
  }
  return row.contentVersion
}

/**
 * Geometry-only cache key: the row's identity + width bucket + expansion,
 * WITHOUT the content version. The "last height this row measured at this
 * geometry" fallback lives under it (see getRowHeight).
 */
export function geometryKey(rowKey: string, bucket: number, expanded: boolean): string {
  return `${rowKey}|${bucket}|${expanded ? 1 : 0}`
}

/**
 * Resolve a row's height, in fidelity order:
 *   1. the exact measured value for this content version (`measurementKey`);
 *   2. the row's LAST measured height at this geometry (`geometryKey`) — a
 *      content-version miss means the row's body just changed (a growing
 *      thinking trace, a status flip, streamed tool output), and its previous
 *      real height is off by at most that delta. Falling all the way back to
 *      the type estimate instead snapped mid-transcript updating rows between
 *      real (~250px) and estimated (up to 1400px) heights on every flush —
 *      the long-thinking "jerking". The stale-by-one-flush value is corrected
 *      by the next measure pass without an excursion.
 *   3. the type estimate (never measured at this geometry — first mount or a
 *      width/expansion change).
 * The caller owns both `Map`s (per-chat, in refs).
 */
export function getRowHeight(
  row: VirtualRow,
  measurements: ReadonlyMap<string, number>,
  bucket: number,
  expanded: boolean,
  rowContentVersion: string = row.contentVersion,
  geometryHeights?: ReadonlyMap<string, number>
): number {
  const measured = measurements.get(measurementKey(row.rowKey, rowContentVersion, bucket, expanded))
  if (typeof measured === 'number' && Number.isFinite(measured) && measured >= 0) return measured
  const lastAtGeometry = geometryHeights?.get(geometryKey(row.rowKey, bucket, expanded))
  if (
    typeof lastAtGeometry === 'number' &&
    Number.isFinite(lastAtGeometry) &&
    lastAtGeometry >= 0
  ) {
    return lastAtGeometry
  }
  return row.estimatedHeight
}

function normalizedHeight(value: number | undefined): number {
  return Number.isFinite(value) && (value as number) > 0 ? (value as number) : 0
}

/** Sum a slice of a heights array, defensively skipping non-finite values. */
export function sumHeights(heights: readonly number[], start: number, end: number): number {
  let total = 0
  const lo = Math.max(0, start)
  const hi = Math.min(heights.length, end)
  for (let i = lo; i < hi; i++) {
    total += normalizedHeight(heights[i])
  }
  return total
}

/**
 * Prefix offsets for variable-height rows. `offsets[i]` is the top of row `i`;
 * `offsets[offsets.length - 1]` is total content height. Keeping this in one
 * array lets scroll-window and anchor math use O(log n) binary searches and
 * O(1) spacer sums instead of repeatedly scanning height slices.
 */
export function buildHeightOffsets(heights: readonly number[]): number[] {
  const hs = Array.isArray(heights) ? heights : []
  const offsets = new Array<number>(hs.length + 1)
  offsets[0] = 0
  for (let i = 0; i < hs.length; i += 1) {
    offsets[i + 1] = offsets[i] + normalizedHeight(hs[i])
  }
  return offsets
}

function usableHeightOffsets(
  heights: readonly number[],
  heightOffsets?: readonly number[] | null
): readonly number[] {
  return Array.isArray(heightOffsets) && heightOffsets.length === heights.length + 1
    ? heightOffsets
    : buildHeightOffsets(heights)
}

export function totalHeightFromOffsets(heightOffsets: readonly number[]): number {
  return heightOffsets.length > 0 ? heightOffsets[heightOffsets.length - 1] || 0 : 0
}

export function sumHeightOffsets(
  heightOffsets: readonly number[],
  start: number,
  end: number
): number {
  const last = Math.max(0, heightOffsets.length - 1)
  const lo = Math.max(0, Math.min(last, start))
  const hi = Math.max(lo, Math.min(last, end))
  return Math.max(0, (heightOffsets[hi] || 0) - (heightOffsets[lo] || 0))
}

function upperBound(values: readonly number[], target: number): number {
  let lo = 0
  let hi = values.length
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2)
    if ((values[mid] || 0) <= target) lo = mid + 1
    else hi = mid
  }
  return lo
}

function lowerBound(values: readonly number[], target: number): number {
  let lo = 0
  let hi = values.length
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2)
    if ((values[mid] || 0) < target) lo = mid + 1
    else hi = mid
  }
  return lo
}

export interface SelectWindowInput {
  /** Current scroll offset of the scroll container (px from top). */
  scrollTop: number
  /** Visible height of the scroll container (clientHeight, px). */
  viewportHeight: number
  /** Per-row heights (measured-or-estimated), index-aligned to the rows. */
  heights: readonly number[]
  /** Optional prefix offsets from {@link buildHeightOffsets}, index-aligned to heights. */
  heightOffsets?: readonly number[]
  /** Extra px mounted above + below the visible band. */
  overscanPx?: number
  /** Force-mount one row for programmatic jump/focus requests. */
  forceIndex?: number | null
}

/**
 * Choose the rows to mount (visible band + overscan) and the spacer
 * heights that stand in for the collapsed runs above + below.
 *
 * Invariants the renderer relies on:
 *   - `topSpacerPx + Σ(mounted heights) + bottomSpacerPx === Σ(all heights)`,
 *     so the browser-computed `scrollHeight` is unchanged whether a row
 *     is mounted or collapsed into a spacer. This is why
 *     `scrollTop = scrollHeight` keeps targeting the true bottom.
 *   - When the bottom is within view+overscan, `endIndex === n` and
 *     `bottomSpacerPx === 0` — so the auto-follow/streaming-pinned path
 *     mounts the last row and behaves exactly as the non-virtualised
 *     transcript did.
 *
 * Defensive against NaN / negative / detached-layout inputs.
 */
export function selectWindow(input: SelectWindowInput): VirtualWindow {
  const heights = Array.isArray(input.heights) ? input.heights : []
  const n = heights.length
  if (n === 0) return { startIndex: 0, endIndex: 0, topSpacerPx: 0, bottomSpacerPx: 0 }
  const offsets = usableHeightOffsets(heights, input.heightOffsets)
  const totalHeight = totalHeightFromOffsets(offsets)

  const viewportHeight = Number.isFinite(input.viewportHeight)
    ? Math.max(0, input.viewportHeight)
    : 0
  const overscan =
    Number.isFinite(input.overscanPx) && (input.overscanPx as number) >= 0
      ? (input.overscanPx as number)
      : DEFAULT_OVERSCAN_PX
  const forceIndex =
    typeof input.forceIndex === 'number' &&
    Number.isInteger(input.forceIndex) &&
    input.forceIndex >= 0 &&
    input.forceIndex < n
      ? input.forceIndex
      : null

  let scrollTop = Number.isFinite(input.scrollTop) ? Math.max(0, input.scrollTop) : 0
  if (forceIndex !== null) {
    const forcedRowTop = offsets[forceIndex] || 0
    scrollTop = Math.max(0, forcedRowTop - Math.round(viewportHeight * 0.35))
  }

  const windowTop = scrollTop - overscan
  const windowBottom = scrollTop + viewportHeight + overscan

  // First row whose bottom is below the window top. `upperBound(offsets, x) - 1`
  // matches the old linear `rowBottom > x` rule, including exact row boundaries.
  let startIndex =
    windowTop >= totalHeight ? n : Math.max(0, Math.min(n, upperBound(offsets, windowTop) - 1))
  // First row whose top is at or below the window bottom. `offsets` has one
  // extra total-height entry, so cap to n for the row index space.
  let endIndex = Math.max(0, Math.min(n, lowerBound(offsets, windowBottom)))
  if (endIndex < startIndex) endIndex = startIndex
  if (forceIndex !== null && (forceIndex < startIndex || forceIndex >= endIndex)) {
    startIndex = forceIndex
    endIndex = Math.min(n, forceIndex + 1)
  }

  return {
    startIndex,
    endIndex,
    topSpacerPx: offsets[startIndex] || 0,
    bottomSpacerPx: Math.max(0, totalHeight - (offsets[endIndex] || 0))
  }
}

/**
 * The scroll-anchor correction applied when rows ABOVE the viewport
 * mount or resize (the highest virtualisation risk). When the top spacer
 * changes from `previousTopSpacerPx` to `nextTopSpacerPx`, the caller
 * applies `scroller.scrollTop += delta` in a pre-paint layout effect so
 * the visible content does not move and no scroll event is attributed to
 * the user. The caller MUST gate this on `!autoFollow` (when pinned at
 * the bottom the top anchor is irrelevant and must not be touched).
 */
export function computeAnchorDelta(input: {
  previousTopSpacerPx: number
  nextTopSpacerPx: number
}): number {
  const prev = Number.isFinite(input.previousTopSpacerPx) ? input.previousTopSpacerPx : 0
  const next = Number.isFinite(input.nextTopSpacerPx) ? input.nextTopSpacerPx : 0
  return next - prev
}

/**
 * True when the window reaches the end of the list — i.e. the last row
 * is mounted and `bottomSpacerPx` is 0. The bottom-follow / streaming
 * path depends on this so the existing `scrollTop = scrollHeight` snap
 * keeps hitting the real bottom.
 */
export function windowReachesEnd(window: VirtualWindow, rowCount: number): boolean {
  return window.endIndex >= rowCount
}

export interface ScrollAnchor {
  /** Index of the first row intersecting the viewport top. */
  index: number
  /** How far the viewport top sits below that row's top edge (px). */
  offsetWithin: number
}

/**
 * Identify the row the viewport top currently sits on, plus the
 * sub-row offset. This is the anchor the renderer pins across height
 * changes: capture `{ rowId, offsetWithin }` from the *current*
 * scrollTop + heights on user scroll, then after a re-render whose
 * heights changed (a row above the viewport mounted/measured), restore
 * `scrollTop = Σ(heights before anchor) + offsetWithin`. Because the
 * anchor row stays visually fixed, content above it can grow/shrink
 * without the viewport jumping — the gold-standard virtualisation
 * anchor, and stronger than a bare top-spacer delta (it also absorbs
 * growth of mounted overscan rows that sit above the viewport).
 *
 * Returns the first row whose cumulative bottom is strictly past
 * `scrollTop`. Defensive against empty / non-finite inputs.
 */
export function findScrollAnchor(
  scrollTop: number,
  heights: readonly number[],
  heightOffsets?: readonly number[]
): ScrollAnchor {
  const hs = Array.isArray(heights) ? heights : []
  const n = hs.length
  if (n === 0) return { index: 0, offsetWithin: 0 }
  const offsets = usableHeightOffsets(hs, heightOffsets)
  const totalHeight = totalHeightFromOffsets(offsets)
  const target = Number.isFinite(scrollTop) ? Math.max(0, scrollTop) : 0
  if (target < totalHeight) {
    const index = Math.max(0, Math.min(n - 1, upperBound(offsets, target) - 1))
    return { index, offsetWithin: target - (offsets[index] || 0) }
  }
  // Scrolled at/below the end: anchor the last row.
  const lastIndex = n - 1
  return { index: lastIndex, offsetWithin: Math.max(0, target - (offsets[lastIndex] || 0)) }
}
