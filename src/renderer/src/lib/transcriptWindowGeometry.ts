import {
  buildHeightOffsets,
  selectWindow,
  totalHeightFromOffsets,
  type SelectWindowInput,
  type VirtualRow,
  type VirtualWindow,
  type VirtualWindowBand
} from './TranscriptVirtualWindow'
import type { FanoutLaneSlot } from './fanoutLanePairing'

export interface TranscriptWindowGeometryInput extends SelectWindowInput {
  /** Retain mounted rows during measurement; omit on scroll/topology changes. */
  previous?: VirtualWindowBand | null
  rows?: readonly Pick<VirtualRow, 'rowKey'>[]
  fanoutLaneSlots?: ReadonlyMap<string, FanoutLaneSlot>
}

/**
 * Keep the mounted band stable while sizes settle, not a stale copy of the
 * sizes. Both selection and spacers use the same current geometry. Measurement
 * may extend the band to cover newly exposed content, but cannot evict a row
 * whose mount supplied that measurement. The next scroll can trim the band.
 */
export function selectTranscriptWindow(input: TranscriptWindowGeometryInput): VirtualWindow {
  const offsets = input.heightOffsets ?? buildHeightOffsets(input.heights)
  const totalHeight = totalHeightFromOffsets(offsets)
  const viewportHeight = Number.isFinite(input.viewportHeight)
    ? Math.max(0, input.viewportHeight)
    : 0
  // The DOM scroller also contains padding and the working indicator. It can
  // outrun the row model during late growth, before ResizeObserver reports it.
  // Bound row lookup to that model's scroll range so the tail stays measurable.
  const scrollTop = Math.min(
    Number.isFinite(input.scrollTop) ? Math.max(0, input.scrollTop) : 0,
    Math.max(0, totalHeight - viewportHeight)
  )
  const next = selectWindow({ ...input, scrollTop, viewportHeight, heightOffsets: offsets })
  let startIndex = next.startIndex
  let endIndex = next.endIndex
  if (input.previous) {
    startIndex = Math.max(0, Math.min(startIndex, input.previous.startIndex))
    endIndex = Math.min(input.heights.length, Math.max(endIndex, input.previous.endIndex))
  }

  // A CSS grid row of lane cells is ONE measured vertical band. Cutting it in
  // half moves the surviving cells and changes their heights, which invalidates
  // that very selection — and it is worse than a one-cell defect: both spacers
  // carry `grid-column: 1 / -1`, so the spacer that replaces the missing cells
  // forces a fresh grid row and shifts the COLUMN PHASE of every lane below it
  // until a full-span row resets it. Include the whole grid row even when the
  // leading cells have a zero-height slot.
  //
  // `lead` is exactly "a sibling follows me on this grid row", so the row
  // boundaries are where a `lead` does NOT precede: walk out to them. A single
  // step is enough at two tracks and at no other count, which is why this is a
  // loop rather than the pair of `if`s it replaced. Both are bounded by the
  // track count (a group's last cell is a `trail` or a `solo`) and by the row
  // list itself, so a stale or inconsistent slot map cannot spin either one.
  const rowCount = input.heights.length
  const slotAt = (index: number): FanoutLaneSlot | undefined => {
    const key = input.rows?.[index]?.rowKey
    return key === undefined ? undefined : input.fanoutLaneSlots?.get(key)
  }
  while (startIndex > 0 && slotAt(startIndex - 1) === 'lead') startIndex -= 1
  while (endIndex < rowCount && slotAt(endIndex - 1) === 'lead') endIndex += 1

  return {
    startIndex,
    endIndex,
    topSpacerPx: offsets[startIndex] || 0,
    bottomSpacerPx: Math.max(0, totalHeight - (offsets[endIndex] || 0))
  }
}
