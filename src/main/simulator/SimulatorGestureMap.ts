/**
 * Coordinate helpers for Simulator Canvas bezel → native window mapping.
 * Pure functions for future App Drive tap/scroll wiring.
 */

export interface SimulatorRect {
  x: number
  y: number
  width: number
  height: number
}

export interface MapBezelPointInput {
  bezelRect: SimulatorRect
  windowBounds: SimulatorRect
  clientX: number
  clientY: number
}

export interface MappedPoint {
  x: number
  y: number
}

function clamp(value: number, min: number, max: number): number {
  if (max < min) return min
  return Math.min(max, Math.max(min, value))
}

/**
 * Map a pointer position in the dock bezel into the Simulator.app window bounds.
 * Relative position inside the bezel is preserved; result is clamped to the window.
 */
export function mapBezelPointToWindow(input: MapBezelPointInput): MappedPoint {
  const { bezelRect, windowBounds, clientX, clientY } = input
  const bezelW = Math.max(0, bezelRect.width)
  const bezelH = Math.max(0, bezelRect.height)
  const winW = Math.max(0, windowBounds.width)
  const winH = Math.max(0, windowBounds.height)

  const relX = bezelW > 0 ? (clientX - bezelRect.x) / bezelW : 0
  const relY = bezelH > 0 ? (clientY - bezelRect.y) / bezelH : 0
  const clampedRelX = clamp(relX, 0, 1)
  const clampedRelY = clamp(relY, 0, 1)

  const maxX = windowBounds.x + winW
  const maxY = windowBounds.y + winH
  const x = clamp(windowBounds.x + clampedRelX * winW, windowBounds.x, maxX)
  const y = clamp(windowBounds.y + clampedRelY * winH, windowBounds.y, maxY)
  return { x, y }
}

export interface MapScrollDeltaInput {
  deltaX: number
  deltaY: number
  /** Optional scale applied to both axes (default 1). */
  scale?: number
}

export interface MappedScrollDelta {
  deltaX: number
  deltaY: number
}

/** Scale wheel/trackpad deltas for future App Drive scroll composition. */
export function mapScrollDelta(input: MapScrollDeltaInput): MappedScrollDelta {
  const scale = typeof input.scale === 'number' && Number.isFinite(input.scale) ? input.scale : 1
  const deltaX = Number.isFinite(input.deltaX) ? input.deltaX * scale : 0
  const deltaY = Number.isFinite(input.deltaY) ? input.deltaY * scale : 0
  return { deltaX, deltaY }
}
