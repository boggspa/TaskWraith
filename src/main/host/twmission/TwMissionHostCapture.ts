/**
 * Host Arc Wave 5 — production capture seam for `.twmission` (next-slice).
 *
 * Bridges a live (or test-donor) HostSnapshot into exportTwMissionBundle by
 * deriving cursorRange from the snapshot's sole-journal position fields.
 *
 * This is NOT AC9 PASS — it is the smallest production-useful step past pure
 * scaffold: export from a real Host snapshot shape without index.ts wiring
 * and without any live-state mutation on import.
 *
 * Import remains DETACHED via importTwMissionBundleBytes.
 */

import type { HostSnapshot } from '../../../shared/hostProtocol'
import { exportTwMissionBundle, type TwMissionExportResult } from './TwMissionExport'

export type TwMissionHostCaptureResult = TwMissionExportResult

export type TwMissionHostCaptureInput = {
  readonly snapshot: HostSnapshot
  readonly hostId?: string
  /** ISO timestamp; defaults to now when omitted. */
  readonly exportedAt?: string
  readonly redactionNotes?: readonly string[]
  /** Injected clock for tests when exportedAt is omitted. */
  readonly now?: () => string
}

function isNonNegInt(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0
}

/**
 * Capture a privacy-safe `.twmission` bundle from a HostSnapshot.
 *
 * cursorRange is derived from snapshot.generation / snapshot.cursor so a live
 * authority.snapshot() result can be exported without a separate position API.
 * fromCursor is always 0 (full known range up to the snapshot cursor).
 */
export function captureTwMissionFromHostSnapshot(
  input: TwMissionHostCaptureInput
): TwMissionHostCaptureResult {
  if (!input || typeof input !== 'object') {
    return { ok: false, error: 'capture input required' }
  }
  if (!input.snapshot || typeof input.snapshot !== 'object') {
    return { ok: false, error: 'snapshot required' }
  }

  const generation = input.snapshot.generation
  const cursor = input.snapshot.cursor
  if (!isNonNegInt(generation) || !isNonNegInt(cursor)) {
    return { ok: false, error: 'snapshot position invalid' }
  }

  let exportedAt = input.exportedAt
  if (typeof exportedAt !== 'string' || exportedAt.length === 0) {
    exportedAt = typeof input.now === 'function' ? input.now() : new Date().toISOString()
  }
  if (typeof exportedAt !== 'string' || exportedAt.length === 0) {
    return { ok: false, error: 'exportedAt required' }
  }

  return exportTwMissionBundle({
    snapshot: input.snapshot,
    cursorRange: {
      generation,
      fromCursor: 0,
      toCursor: cursor
    },
    exportedAt,
    ...(typeof input.hostId === 'string' && input.hostId.length > 0
      ? { hostId: input.hostId }
      : {}),
    ...(input.redactionNotes ? { redactionNotes: input.redactionNotes } : {})
  })
}
