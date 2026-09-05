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

  // A CSS grid pair is one measured vertical band. Cutting it in half moves
  // the surviving cell and changes its height, which invalidates that very
  // selection. Include both members even when the lead has a zero-height slot.
  const slotAt = (index: number): FanoutLaneSlot | undefined => {
    const key = input.rows?.[index]?.rowKey
    return key === undefined ? undefined : input.fanoutLaneSlots?.get(key)
  }
  if (slotAt(startIndex) === 'trail' && slotAt(startIndex - 1) === 'lead') startIndex -= 1
  if (slotAt(endIndex - 1) === 'lead' && slotAt(endIndex) === 'trail') endIndex += 1

  return {
    startIndex,
    endIndex,
    topSpacerPx: offsets[startIndex] || 0,
    bottomSpacerPx: Math.max(0, totalHeight - (offsets[endIndex] || 0))
  }
}
