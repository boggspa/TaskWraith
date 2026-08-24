/**
 * Host Arc Wave 5 — shared `.twmission` flight-recorder types (scaffold).
 *
 * Export/import of bounded, privacy-safe Host projection bundles.
 * Import is replay-only and MUST NOT mutate live Host state.
 *
 * This scaffold does not claim AC9 PASS — coverage matrix comes later.
 */

import {
  HOST_PROJECTION_VERSION,
  HOST_PROTOCOL_VERSION,
  type HostProjectionVersion,
  type HostProtocolVersion,
  type HostSnapshot
} from '../../shared/hostProtocol'

/** Bundle format version for `.twmission` JSON envelopes. */
export const TW_MISSION_SCHEMA_VERSION = 1 as const

export type TwMissionSchemaVersion = typeof TW_MISSION_SCHEMA_VERSION

/** Soft size ceiling for a scaffold bundle (bytes of UTF-8 JSON). */
export const TW_MISSION_MAX_BUNDLE_BYTES = 8 * 1024 * 1024

export interface TwMissionCursorRange {
  readonly generation: number
  readonly fromCursor: number
  readonly toCursor: number
}

export interface TwMissionRedactionMetadata {
  /** Always true on this scaffold — transcript bodies are never included. */
  readonly transcriptsOmitted: true
  /** Always true — artifact body bytes are never included. */
  readonly artifactBodiesOmitted: true
  /** Human-readable notes for auditors (bounded later by encoder). */
  readonly notes?: readonly string[]
}

export interface TwMissionManifest {
  readonly schemaVersion: TwMissionSchemaVersion
  readonly protocolVersion: HostProtocolVersion
  readonly projectionVersion: HostProjectionVersion
  readonly exportedAt: string
  readonly hostId?: string
  readonly cursorRange: TwMissionCursorRange
  readonly redaction: TwMissionRedactionMetadata
  /** Lowercase hex SHA-256 over the canonical payload bytes. */
  readonly integrityDigest: string
}

/**
 * Detached replay projection — never a live HostAuthority handle.
 * Callers may inspect `snapshot` for tests/preview only.
 */
export interface TwMissionDetachedReplay {
  readonly manifest: TwMissionManifest
  readonly snapshot: HostSnapshot
}

export interface TwMissionBundle {
  readonly manifest: TwMissionManifest
  readonly snapshot: HostSnapshot
}

export type TwMissionExportInput = {
  readonly snapshot: HostSnapshot
  readonly cursorRange: TwMissionCursorRange
  readonly exportedAt: string
  readonly hostId?: string
  readonly redactionNotes?: readonly string[]
}

export { HOST_PROTOCOL_VERSION, HOST_PROJECTION_VERSION }
