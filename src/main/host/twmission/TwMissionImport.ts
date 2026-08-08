/**
 * Host Arc Wave 5 — import `.twmission` as a detached replay projection.
 *
 * CRITICAL: this path never mutates live Host journals, authority, or AppStore.
 * It verifies integrity + re-decodes the snapshot, then returns a detached
 * object suitable for tests / preview only.
 */

import { decodeHostSnapshot } from '../../../shared/hostProtocol'
import { digestTwMissionPayload } from './TwMissionDigest'
import { decodeTwMissionBundleBytes } from './TwMissionCodec'
import {
  HOST_PROJECTION_VERSION,
  HOST_PROTOCOL_VERSION,
  TW_MISSION_SCHEMA_VERSION,
  type TwMissionDetachedReplay,
  type TwMissionManifest
} from './TwMissionTypes'

export type TwMissionImportResult =
  | { ok: true; replay: TwMissionDetachedReplay }
  | { ok: false; error: string }

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function isNonNegInt(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0
}

function parseManifest(
  raw: unknown
): { ok: true; value: TwMissionManifest } | { ok: false; error: string } {
  if (!isRecord(raw)) return { ok: false, error: 'manifest must be an object' }
  if (raw.schemaVersion !== TW_MISSION_SCHEMA_VERSION) {
    return { ok: false, error: 'unsupported schemaVersion' }
  }
  if (raw.protocolVersion !== HOST_PROTOCOL_VERSION) {
    return { ok: false, error: 'protocolVersion mismatch' }
  }
  if (raw.projectionVersion !== HOST_PROJECTION_VERSION) {
    return { ok: false, error: 'projectionVersion mismatch' }
  }
  if (typeof raw.exportedAt !== 'string' || raw.exportedAt.length === 0) {
    return { ok: false, error: 'exportedAt invalid' }
  }
  if (typeof raw.integrityDigest !== 'string' || !/^[a-f0-9]{64}$/.test(raw.integrityDigest)) {
    return { ok: false, error: 'integrityDigest invalid' }
  }
  if (!isRecord(raw.cursorRange)) return { ok: false, error: 'cursorRange invalid' }
  const cr = raw.cursorRange
  if (!isNonNegInt(cr.generation) || !isNonNegInt(cr.fromCursor) || !isNonNegInt(cr.toCursor)) {
    return { ok: false, error: 'cursorRange invalid' }
  }
  if (cr.toCursor < cr.fromCursor) return { ok: false, error: 'cursorRange inverted' }
  if (!isRecord(raw.redaction)) return { ok: false, error: 'redaction invalid' }
  if (raw.redaction.transcriptsOmitted !== true || raw.redaction.artifactBodiesOmitted !== true) {
    return { ok: false, error: 'redaction flags must omit transcripts and artifact bodies' }
  }

  const manifest: TwMissionManifest = {
    schemaVersion: TW_MISSION_SCHEMA_VERSION,
    protocolVersion: HOST_PROTOCOL_VERSION,
    projectionVersion: HOST_PROJECTION_VERSION,
    exportedAt: raw.exportedAt,
    ...(typeof raw.hostId === 'string' && raw.hostId.length > 0 ? { hostId: raw.hostId } : {}),
    cursorRange: {
      generation: cr.generation,
      fromCursor: cr.fromCursor,
      toCursor: cr.toCursor
    },
    redaction: {
      transcriptsOmitted: true,
      artifactBodiesOmitted: true,
      ...(Array.isArray(raw.redaction.notes)
        ? {
            notes: raw.redaction.notes.filter(
              (n): n is string => typeof n === 'string' && n.length > 0
            )
          }
        : {})
    },
    integrityDigest: raw.integrityDigest
  }
  return { ok: true, value: manifest }
}

/**
 * Import bundle bytes into a detached replay. Never writes Host state.
 */
export function importTwMissionBundleBytes(bytes: Uint8Array): TwMissionImportResult {
  const decoded = decodeTwMissionBundleBytes(bytes)
  if (!decoded.ok) return decoded

  if (!isRecord(decoded.value)) {
    return { ok: false, error: 'bundle must be an object' }
  }

  const manifestParsed = parseManifest(decoded.value.manifest)
  if (!manifestParsed.ok) return manifestParsed

  const snapshotDecoded = decodeHostSnapshot(decoded.value.snapshot)
  if (!snapshotDecoded.ok) {
    return { ok: false, error: `snapshot rejected: ${snapshotDecoded.error}` }
  }

  const payloadForDigest = {
    schemaVersion: manifestParsed.value.schemaVersion,
    protocolVersion: manifestParsed.value.protocolVersion,
    projectionVersion: manifestParsed.value.projectionVersion,
    exportedAt: manifestParsed.value.exportedAt,
    ...(manifestParsed.value.hostId ? { hostId: manifestParsed.value.hostId } : {}),
    cursorRange: manifestParsed.value.cursorRange,
    redaction: manifestParsed.value.redaction,
    snapshot: snapshotDecoded.value
  }

  const expected = digestTwMissionPayload(payloadForDigest)
  if (expected !== manifestParsed.value.integrityDigest) {
    return { ok: false, error: 'integrityDigest mismatch' }
  }

  return {
    ok: true,
    replay: {
      manifest: manifestParsed.value,
      snapshot: snapshotDecoded.value
    }
  }
}
