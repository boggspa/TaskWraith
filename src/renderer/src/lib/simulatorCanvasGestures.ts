/**
 * Renderer helpers for Simulator Canvas human bezel gestures.
 * Maps pointer events to normalized 0..1 coords; never invents a control grant.
 */
import {
  SIMULATOR_GESTURE_ACTUATION_DEFERRED,
  SIMULATOR_PREVIEW_ONLY_BANNER,
  type SimulatorInteractionStatus,
  type SimulatorScrollGesture,
  type SimulatorTapGesture,
  type SimulatorTypeGesture
} from '../../../shared/simulatorCanvas'

export { SIMULATOR_PREVIEW_ONLY_BANNER }

export interface BezelPointNorm {
  x: number
  y: number
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0
  if (value <= 0) return 0
  if (value >= 1) return 1
  return value
}

/**
 * Map a client pointer position into normalized coords inside a bezel content rect.
 * Points outside the rect clamp to the edges (same spirit as mapBezelPointToWindow).
 */
export function mapPointerToBezelNorm(
  clientX: number,
  clientY: number,
  bezelRect: Pick<DOMRect, 'left' | 'top' | 'width' | 'height'>
): BezelPointNorm {
  const w = Math.max(0, bezelRect.width)
  const h = Math.max(0, bezelRect.height)
  const relX = w > 0 ? (clientX - bezelRect.left) / w : 0
  const relY = h > 0 ? (clientY - bezelRect.top) / h : 0
  return { x: clamp01(relX), y: clamp01(relY) }
}

/**
 * True only when main reports a control lease AND device actuation is wired.
 * A View & Control lease alone is not enough while idb is deferred.
 */
export function canSendSimulatorGestures(
  status: SimulatorInteractionStatus | null | undefined
): boolean {
  return Boolean(status?.canControl && status.actuationReady)
}

export function previewOnlyBannerText(
  status: SimulatorInteractionStatus | null | undefined
): string {
  if (!status) return SIMULATOR_PREVIEW_ONLY_BANNER
  if (!status.canControl) {
    return status.reason || SIMULATOR_PREVIEW_ONLY_BANNER
  }
  if (!status.actuationReady) {
    return status.reason || SIMULATOR_GESTURE_ACTUATION_DEFERRED
  }
  return ''
}

/** Subtle dock chip when a controller lease is held (agent run vs human). */
export function simulatorControllerBadgeText(
  status:
    | Pick<SimulatorInteractionStatus, 'controllerKind' | 'controllerLeaseHeld'>
    | null
    | undefined
): string | null {
  if (!status) return null
  if (status.controllerKind === 'run') return 'Agent is using this device'
  if (status.controllerKind === 'human' || status.controllerLeaseHeld) {
    return 'You control this device'
  }
  return null
}

export function buildTapGesture(
  chatId: string,
  point: BezelPointNorm
): SimulatorTapGesture {
  return { chatId, x: point.x, y: point.y }
}

export function buildTypeGesture(chatId: string, text: string): SimulatorTypeGesture {
  return { chatId, text }
}

export function buildScrollGesture(
  chatId: string,
  point: BezelPointNorm,
  deltaX: number,
  deltaY: number
): SimulatorScrollGesture {
  return {
    chatId,
    x: point.x,
    y: point.y,
    deltaX: Number.isFinite(deltaX) ? deltaX : 0,
    deltaY: Number.isFinite(deltaY) ? deltaY : 0
  }
}
