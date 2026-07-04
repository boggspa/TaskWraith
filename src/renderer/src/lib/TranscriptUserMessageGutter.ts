import type { ChatMessage } from '../../../main/store/types'
import { truncateUserMessagePreview } from './UserMessageCollapse'
import { sumHeights, type VirtualRow } from './TranscriptVirtualWindow'

const GUTTER_PREVIEW_THRESHOLDS = {
  maxLines: 4,
  maxChars: 320,
  previewLines: 4,
  previewChars: 320
}

export interface TranscriptUserGutterMarker {
  key: string
  messageId: string
  rowKey: string
  /**
   * POSITIONAL index of this user message's row within the projected-rows /
   * `heights[]` array — the exact index space `findScrollAnchor` returns. The
   * scroll-spy joins the current anchor row index to the nearest marker at or
   * above it via {@link findActiveGutterMarkerKey}, so this MUST stay positional
   * (not `row.index`, the source-messages position) or the join drifts.
   */
  rowIndex: number
  ordinal: number
  topPercent: number
  title: string
  preview: string
  message: ChatMessage
}

export interface TranscriptUserGutterMarkerLayout {
  key: string
  topPx: number
}

function compactInlineText(value: string): string {
  return value.replace(/\s+/g, ' ').trim()
}

function truncateInlineText(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value
  const slice = value.slice(0, maxChars)
  const lastSpace = slice.search(/\s\S*$/)
  const trimmed = lastSpace > 24 ? slice.slice(0, lastSpace) : slice
  return `${trimmed.replace(/\s+$/, '')}...`
}

export function userGutterTitle(content: string): string {
  const firstLine = content
    .split('\n')
    .map((line) => compactInlineText(line))
    .find((line) => line.length > 0)
  if (!firstLine) return 'User message'
  return truncateInlineText(firstLine, 96)
}

export function userGutterPreview(content: string): string {
  const trimmed = content.trim()
  if (!trimmed) return ''
  return truncateUserMessagePreview(trimmed, GUTTER_PREVIEW_THRESHOLDS)
}

/**
 * Build the rowKey a marker carries for a user message HIDDEN inside a
 * collapsed ensemble round. It is deliberately shaped so it can NEVER collide
 * with a real projected rowKey (`${id}#${index}` — index is numeric, so the
 * `~` segment can't be produced): the jump path's rowKey lookup must MISS and
 * fall through to the message-id lookup, which resolves once
 * `ensureRoundExpandedForMessage` has re-inserted the round body.
 */
export function hiddenRoundMarkerRowKey(headerRowKey: string, messageId: string): string {
  return `${headerRowKey}~${messageId}`
}

export function buildTranscriptUserGutterMarkers(
  messages: readonly ChatMessage[],
  rows: readonly VirtualRow[],
  rowHeights?: readonly number[],
  /**
   * Ensemble round-card support: user messages dropped from the flat display
   * list because their round is COLLAPSED, keyed by the round-header message
   * id whose row now stands in for them. Each hidden user message still gets
   * a gutter marker — anchored at the header row's position — so collapsing a
   * round never makes its prompts unreachable from the rail. Clicking such a
   * marker jumps by message id (the caller auto-expands the round first).
   */
  collapsedRowUserMessages?: ReadonlyMap<string, readonly ChatMessage[]>
): TranscriptUserGutterMarker[] {
  if (!Array.isArray(messages) || messages.length === 0 || rows.length === 0) return []

  const heights = rows.map((row, index) => {
    const measured = rowHeights?.[index]
    return typeof measured === 'number' && Number.isFinite(measured) && measured > 0
      ? measured
      : row.estimatedHeight
  })
  const totalHeight = Math.max(1, sumHeights(heights, 0, heights.length))
  const markers: TranscriptUserGutterMarker[] = []

  // Index the `heights` array and set `rowIndex` by the row's POSITION in `rows`
  // (`pos`), NOT by `row.index` (its position in the source messages list). The
  // two coincide today (projectRows emits one row per message), but `findScrollAnchor`
  // — the scroll-spy's anchor — returns a POSITIONAL index into this same heights
  // array, so keying markers positionally keeps the scroll-spy join correct even if
  // projectRows ever skips a row. `messages[row.index]` stays semantic (it indexes
  // the original messages array), which is correct.
  for (let pos = 0; pos < rows.length; pos++) {
    const row = rows[pos]
    const message = messages[row.index]
    if (!message) continue

    const rowTop = sumHeights(heights, 0, pos)
    const rowHeight = heights[pos] ?? row.estimatedHeight
    const midpoint = rowTop + Math.max(0, rowHeight) / 2
    const topPercent = Math.max(0, Math.min(100, (midpoint / totalHeight) * 100))

    if (message.role === 'user') {
      markers.push({
        key: row.rowKey,
        messageId: message.id,
        rowKey: row.rowKey,
        rowIndex: pos,
        ordinal: markers.length + 1,
        topPercent,
        title: userGutterTitle(message.content || ''),
        preview: userGutterPreview(message.content || ''),
        message
      })
      continue
    }

    // Collapsed ensemble round header standing in for hidden body messages:
    // surface each hidden user prompt as a marker anchored at the header row.
    // rowIndex is the header's POSITIONAL index (multiple markers may share
    // it; the scroll-spy join resolves the last one, which is correct — the
    // reader is "inside" the collapsed card either way).
    const hiddenUsers = collapsedRowUserMessages?.get(message.id)
    if (!hiddenUsers || hiddenUsers.length === 0) continue
    for (const hidden of hiddenUsers) {
      if (!hidden || hidden.role !== 'user') continue
      markers.push({
        key: hiddenRoundMarkerRowKey(row.rowKey, `${hidden.id}#${markers.length}`),
        messageId: hidden.id,
        rowKey: hiddenRoundMarkerRowKey(row.rowKey, hidden.id),
        rowIndex: pos,
        ordinal: markers.length + 1,
        topPercent,
        title: userGutterTitle(hidden.content || ''),
        preview: userGutterPreview(hidden.content || ''),
        message: hidden
      })
    }
  }

  return markers
}

/**
 * Scroll-spy join: given the virtual-row index the viewport reading line
 * currently sits on (from `findScrollAnchor`), return the `key` of the nearest
 * user-message marker AT OR ABOVE that row — i.e. the message whose turn the
 * reader is currently inside. Markers arrive in ascending `rowIndex` order (the
 * builder walks the rows in order), so a single forward scan finds the last
 * marker that starts at or before the anchor. Returns null when the anchor sits
 * above the first marker (or there are no markers). Pure + DOM-free so it unit-
 * tests in isolation, matching the rest of this module.
 */
export function findActiveGutterMarkerKey(
  markers: readonly TranscriptUserGutterMarker[],
  anchorRowIndex: number
): string | null {
  if (!Array.isArray(markers) || markers.length === 0) return null
  if (!Number.isFinite(anchorRowIndex)) return null
  let activeKey: string | null = null
  for (const marker of markers) {
    if (marker.rowIndex <= anchorRowIndex) activeKey = marker.key
    else break
  }
  return activeKey
}

function compactMarkerStepPx(count: number): number {
  if (count >= 36) return 5
  if (count >= 28) return 6
  if (count >= 18) return 8
  return 10
}

/**
 * Peak magnification of the dock/fisheye hover bulge (scaleX of the marker
 * line at dead-centre under the cursor). ~2.3× reads clearly at the rail's
 * 8px base line without colliding with neighbours once the cosine falloff
 * tapers them.
 */
export const GUTTER_BULGE_MAX_SCALE = 2.3

/**
 * Influence half-window (px) of the dock bulge, DENSITY-SCALED off the compact
 * marker spacing. A desktop-dock-scale radius (~110px) would bulge the whole
 * cluster as one blob once markers compress to ~5px apart on a long thread, so
 * the radius shrinks with the step: ~4 marker-steps of reach, clamped to a
 * legible 20–44px so only a handful of neighbours participate at any density.
 */
export function gutterBulgeRadiusPx(markerCount: number): number {
  const step = compactMarkerStepPx(markerCount)
  return Math.max(20, Math.min(44, Math.round(step * 4)))
}

export interface GutterLensLayout {
  topPx: number
  heightPx: number
}

/**
 * Vertical bleed (px) the reading lens extends past the first/last marker
 * CENTRES, so a tick at either extreme sits inside the lens glass instead of
 * being bisected by its border.
 */
export const GUTTER_LENS_BLEED_PX = 7

/** Minimum lens height (px) so it stays grabbable-looking on huge transcripts. */
export const GUTTER_LENS_MIN_HEIGHT_PX = 18

/**
 * Skeuomorphic "reading lens": a slide-rule-cursor / scrollbar-thumb carriage
 * that rides the marker stack. Its HEIGHT encodes what fraction of the
 * transcript is visible and its POSITION encodes where the viewport sits —
 * scroll position read from geometry, not hue (the accent fill stays as the
 * colour channel; this is the physical channel).
 *
 * Classic thumb mapping: at progress 0 the lens top kisses the stack top; at
 * progress 1 its bottom kisses the stack bottom. Returns null when the whole
 * transcript is visible (viewportFraction >= 1 → nothing to indicate), when
 * the stack is degenerate, or on non-finite input.
 */
export function layoutGutterLens(
  stackTopPx: number,
  stackBottomPx: number,
  scrollProgress: number,
  viewportFraction: number
): GutterLensLayout | null {
  if (
    !Number.isFinite(stackTopPx) ||
    !Number.isFinite(stackBottomPx) ||
    !Number.isFinite(scrollProgress) ||
    !Number.isFinite(viewportFraction)
  ) {
    return null
  }
  if (viewportFraction <= 0 || viewportFraction >= 1) return null
  const top = stackTopPx - GUTTER_LENS_BLEED_PX
  const bottom = stackBottomPx + GUTTER_LENS_BLEED_PX
  const span = bottom - top
  if (span < GUTTER_LENS_MIN_HEIGHT_PX + 4) return null
  const heightPx = Math.min(span, Math.max(GUTTER_LENS_MIN_HEIGHT_PX, span * viewportFraction))
  const progress = Math.max(0, Math.min(1, scrollProgress))
  const topPx = top + (span - heightPx) * progress
  return { topPx, heightPx }
}

export function layoutTranscriptUserGutterMarkers(
  markers: readonly TranscriptUserGutterMarker[],
  frameHeight: number
): TranscriptUserGutterMarkerLayout[] {
  if (!Array.isArray(markers) || markers.length === 0) return []
  const height = Number.isFinite(frameHeight) && frameHeight > 0 ? frameHeight : 0
  const edgePad = Math.min(8, height / 2)
  const availableHeight = Math.max(0, height - edgePad * 2)
  if (availableHeight <= 0) return markers.map((marker) => ({ key: marker.key, topPx: edgePad }))

  const compactSpan = Math.min(
    availableHeight,
    (markers.length - 1) * compactMarkerStepPx(markers.length)
  )
  const start = edgePad + availableHeight - compactSpan
  const step = markers.length > 1 ? compactSpan / (markers.length - 1) : 0

  return markers.map((marker, index) => ({ key: marker.key, topPx: start + step * index }))
}
