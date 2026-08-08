/**
 * Pure helpers for SimulatorCanvasPanel — frame freshness, screenshot race
 * filtering, and claim-control result surfacing.
 */
import {
  isSimulatorRotateDirection,
  type SimulatorRotateDirection,
  type SimulatorScreenshotFrame
} from '../../../shared/simulatorCanvas'

/** Live preview is marked stale when the last accepted frame is older than this. */
export const SIMULATOR_FRAME_STALE_MS = 4000

export function isSimulatorFrameStale(
  frame: Pick<SimulatorScreenshotFrame, 'capturedAt'> | null | undefined,
  nowMs: number,
  staleAfterMs: number = SIMULATOR_FRAME_STALE_MS
): boolean {
  if (!frame?.capturedAt) return false
  const captured = Date.parse(frame.capturedAt)
  if (!Number.isFinite(captured)) return false
  return nowMs - captured > staleAfterMs
}

/** Drop late screenshot responses that belong to a previously selected device. */
export function shouldAcceptSimulatorScreenshotFrame(
  frame: Pick<SimulatorScreenshotFrame, 'udid'> | null | undefined,
  selectedUdid: string
): boolean {
  if (!frame || !selectedUdid) return false
  return frame.udid === selectedUdid
}

export function claimControlFailureMessage(result: unknown): string | null {
  if (!result || typeof result !== 'object') return null
  const record = result as { ok?: unknown; error?: unknown }
  if (record.ok !== false) return null
  return typeof record.error === 'string' && record.error.trim()
    ? record.error
    : 'Could not claim Simulator control.'
}

/**
 * Soft-claim gate for bezel gestures: when ensureHumanLease fails, do not
 * call tap/type/scroll (or any other actuation).
 */
export async function actuateAfterSoftClaim<T>(
  ensureHumanLease: () => Promise<boolean>,
  actuate: () => Promise<T>
): Promise<{ ok: true; value: T } | { ok: false; aborted: true }> {
  if (!(await ensureHumanLease())) {
    return { ok: false, aborted: true }
  }
  return { ok: true, value: await actuate() }
}

/** Adopt server/session absolute orientation when present and allowlisted. */
export function orientationFromSessionPayload(
  value: unknown
): SimulatorRotateDirection | null {
  if (!value || typeof value !== 'object') return null
  const record = value as { orientation?: unknown; session?: { orientation?: unknown } }
  if (isSimulatorRotateDirection(record.orientation)) return record.orientation
  if (isSimulatorRotateDirection(record.session?.orientation)) {
    return record.session.orientation
  }
  return null
}

/**
 * Mesh listForChat rehydrate must not clobber an active or pending Simulator
 * Canvas open for the same chat.
 */
export function shouldOpenMeshFromChatRehydrate(input: {
  showSimulator: boolean
  chatId: string
  pendingSimulatorChatId: string | null | undefined
}): boolean {
  if (input.showSimulator) return false
  if (input.pendingSimulatorChatId && input.pendingSimulatorChatId === input.chatId) {
    return false
  }
  return true
}
