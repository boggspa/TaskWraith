/**
 * Shared normalized-bezel → idb device-point mapping for Simulator Canvas.
 * Used by the human InteractionBridge and agent MCP HID tools.
 */
import { mapScrollDelta } from './SimulatorGestureMap'

export type SimulatorGesturePointExtents = {
  /** Authoritative idb coordinate space. */
  pointWidth: number
  pointHeight: number
  /**
   * Optional screenshot pixel extents. When present, human bezel scroll deltas
   * (CSS/pixel space) are scaled into point space. Agent MCP passes point-space
   * deltas and omits these so no rescale applies.
   */
  pixelWidth?: number
  pixelHeight?: number
}

export function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0
  if (value <= 0) return 0
  if (value >= 1) return 1
  return value
}

export function clamp(value: number, min: number, max: number): number {
  if (max < min) return min
  return Math.min(max, Math.max(min, value))
}

export function toDevicePoint(norm: number, extent: number): number {
  return Math.round(clamp01(norm) * Math.max(0, extent))
}

export function mapNormalizedTap(
  xNorm: number,
  yNorm: number,
  extents: Pick<SimulatorGesturePointExtents, 'pointWidth' | 'pointHeight'>
): { x: number; y: number } {
  return {
    x: toDevicePoint(xNorm, extents.pointWidth),
    y: toDevicePoint(yNorm, extents.pointHeight)
  }
}

/**
 * Map a normalized scroll origin + deltas to an idb swipe.
 * Human path: supply pixelWidth/pixelHeight so wheel deltas rescale into points.
 * Agent path: omit pixel dims; deltas are already point-space.
 */
export function mapNormalizedScroll(
  xNorm: number,
  yNorm: number,
  deltaX: number,
  deltaY: number,
  extents: SimulatorGesturePointExtents
): { startX: number; startY: number; endX: number; endY: number } {
  const startX = toDevicePoint(xNorm, extents.pointWidth)
  const startY = toDevicePoint(yNorm, extents.pointHeight)
  const scaleX =
    typeof extents.pixelWidth === 'number' &&
    Number.isFinite(extents.pixelWidth) &&
    extents.pixelWidth > 0
      ? extents.pointWidth / extents.pixelWidth
      : 1
  const scaleY =
    typeof extents.pixelHeight === 'number' &&
    Number.isFinite(extents.pixelHeight) &&
    extents.pixelHeight > 0
      ? extents.pointHeight / extents.pixelHeight
      : 1
  // Scale each axis through mapScrollDelta (point-space rescale when pixels known).
  const scaledX = mapScrollDelta({ deltaX, deltaY: 0, scale: scaleX }).deltaX
  const scaledY = mapScrollDelta({ deltaX: 0, deltaY, scale: scaleY }).deltaY
  const endX = Math.round(clamp(startX - scaledX, 0, extents.pointWidth))
  const endY = Math.round(clamp(startY - scaledY, 0, extents.pointHeight))
  return { startX, startY, endX, endY }
}
