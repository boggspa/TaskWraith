/**
 * Host Arc Wave 5 — export a privacy-safe `.twmission` bundle from a snapshot.
 *
 * Does not touch live Host journals. Caller supplies an already-projected
 * HostSnapshot (typically from a test donor or a read-only capture).
 */

import { decodeHostSnapshot } from '../../../shared/hostProtocol'
import { digestTwMissionPayload } from './TwMissionDigest'
import {
  HOST_PROJECTION_VERSION,
  HOST_PROTOCOL_VERSION,
  TW_MISSION_MAX_BUNDLE_BYTES,
  TW_MISSION_SCHEMA_VERSION,
  type TwMissionBundle,
  type TwMissionExportInput,
  type TwMissionManifest
} from './TwMissionTypes'
import { encodeTwMissionBundle } from './TwMissionCodec'

export type TwMissionExportResult =
  | { ok: true; bundle: TwMissionBundle; bytes: Uint8Array }
  | { ok: false; error: string }

function isNonNegInt(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0
}

/**
 * Build a signed `.twmission` bundle. Snapshot is re-decoded so foreign keys
 * and transcript-shaped smuggling cannot ride through export.
 */
export function exportTwMissionBundle(input: TwMissionExportInput): TwMissionExportResult {
  if (!input || typeof input !== 'object') {
    return { ok: false, error: 'export input required' }
  }
  if (typeof input.exportedAt !== 'string' || input.exportedAt.length === 0) {
    return { ok: false, error: 'exportedAt required' }
  }
  const range = input.cursorRange
  if (
    !range ||
    !isNonNegInt(range.generation) ||
    !isNonNegInt(range.fromCursor) ||
    !isNonNegInt(range.toCursor)
  ) {
    return { ok: false, error: 'cursorRange invalid' }
  }
  if (range.toCursor < range.fromCursor) {
    return { ok: false, error: 'cursorRange inverted' }
  }

  const decoded = decodeHostSnapshot(input.snapshot)
  if (!decoded.ok) {
    return { ok: false, error: `snapshot rejected: ${decoded.error}` }
  }

  const payloadForDigest = {
    schemaVersion: TW_MISSION_SCHEMA_VERSION,
    protocolVersion: HOST_PROTOCOL_VERSION,
    projectionVersion: HOST_PROJECTION_VERSION,
    exportedAt: input.exportedAt,
    ...(typeof input.hostId === 'string' && input.hostId.length > 0
      ? { hostId: input.hostId }
      : {}),
    cursorRange: {
      generation: range.generation,
      fromCursor: range.fromCursor,
      toCursor: range.toCursor
    },
    redaction: {
      transcriptsOmitted: true as const,
      artifactBodiesOmitted: true as const,
      ...(input.redactionNotes && input.redactionNotes.length > 0
        ? { notes: [...input.redactionNotes] }
        : {})
    },
    snapshot: decoded.value
  }

  const integrityDigest = digestTwMissionPayload(payloadForDigest)
  const manifest: TwMissionManifest = {
    schemaVersion: TW_MISSION_SCHEMA_VERSION,
    protocolVersion: HOST_PROTOCOL_VERSION,
    projectionVersion: HOST_PROJECTION_VERSION,
    exportedAt: input.exportedAt,
    ...(typeof input.hostId === 'string' && input.hostId.length > 0
      ? { hostId: input.hostId }
      : {}),
    cursorRange: payloadForDigest.cursorRange,
    redaction: payloadForDigest.redaction,
    integrityDigest
  }

  const bundle: TwMissionBundle = {
    manifest,
    snapshot: decoded.value
  }

  const encoded = encodeTwMissionBundle(bundle)
  if (!encoded.ok) return encoded
  if (encoded.bytes.byteLength > TW_MISSION_MAX_BUNDLE_BYTES) {
    return { ok: false, error: 'bundle exceeds size ceiling' }
  }

  return { ok: true, bundle, bytes: encoded.bytes }
}
