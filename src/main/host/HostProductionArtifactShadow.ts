/**
 * Host Arc Track4 Mixed Wave A — canvas/session artifact shadow → Host family.
 *
 * WHAT THIS IS. Canvas sessions (and similar Host-adjacent indexes) are keyed
 * by a store-minted id. Host artifact cards reuse that id so clients can join.
 * This adapter owns the allowlisted mapping into HostArtifactProjection without
 * importing electron, CanvasStore, or AppStore.
 *
 * BOUNDARIES:
 * - zero electron / CanvasStore / AppStore value imports;
 * - constructs allowlisted HostArtifactProjection fields only;
 * - never forwards body bytes, content, URLs, screenshots, or eval scripts;
 * - title is a bounded presentation label only (never a prompt/body launder).
 *
 * HONESTY:
 * - a throwing listArtifacts propagates (fail closed, never a false empty);
 * - every listArtifacts call re-reads (no cache of a moving set).
 */

import type { HostArtifactProjection } from '../../shared/hostProtocol'

/** Wire id bound — matches hostProtocol HOST_PROTOCOL_MAX_ID. */
const HOST_ARTIFACT_ID_MAX = 512
/** Kind/title bound — matches hostProtocol HOST_PROTOCOL_MAX_SHORT. */
const HOST_ARTIFACT_SHORT_MAX = 200

/**
 * Thin artifact-index row the composition root adapts (e.g. Canvas sessions).
 * Deliberately narrow — no body / url / content fields admitted.
 */
export interface HostArtifactShadowEntry {
  readonly artifactId: string
  readonly kind: string
  readonly title: string
  /** Epoch ms. */
  readonly createdAt: number
  readonly threadId?: string
  readonly byteLength?: number
  /** Lowercase hex sha-256 when known; omitted otherwise. */
  readonly sha256?: string
}

/**
 * Optional artifacts port for createHostProductionBootstrap /
 * createHostProductionSuppliers.
 */
export interface HostProductionArtifactListPort {
  listArtifacts(): HostArtifactProjection[]
}

export interface HostProductionArtifactShadowDeps {
  listArtifacts: () => readonly HostArtifactShadowEntry[]
}

function isUsableId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.trim().length > 0
}

function boundText(value: string, max: number): string {
  return value.length > max ? value.slice(0, max) : value
}

function parseCreatedAtMs(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined
  if (!Number.isInteger(value) || value < 0) return undefined
  return value
}

function parseByteLength(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined
  if (!Number.isInteger(value) || value < 0) return undefined
  return value
}

function parseSha256(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  if (!/^[a-f0-9]{64}$/.test(value)) return undefined
  return value
}

/**
 * Map narrow artifact entries into allowlisted HostArtifactProjection rows.
 *
 * Exported for unit pins; production callers should use
 * {@link createHostProductionArtifactShadow}.
 */
export function mapArtifactShadowsToHostArtifacts(
  entries: readonly HostArtifactShadowEntry[]
): HostArtifactProjection[] {
  if (!Array.isArray(entries) || entries.length === 0) return []

  const rows: HostArtifactProjection[] = []
  for (const entry of entries) {
    if (!entry || !isUsableId(entry.artifactId) || entry.artifactId.length > HOST_ARTIFACT_ID_MAX) {
      continue
    }
    if (typeof entry.kind !== 'string' || entry.kind.trim().length === 0) continue
    if (typeof entry.title !== 'string' || entry.title.trim().length === 0) continue

    const createdAt = parseCreatedAtMs(entry.createdAt)
    if (createdAt === undefined) continue

    // Defense in depth: refuse if a donor smuggled body fields onto the entry.
    const smuggled = entry as HostArtifactShadowEntry & {
      bytes?: unknown
      content?: unknown
      url?: unknown
      body?: unknown
    }
    if (
      smuggled.bytes !== undefined ||
      smuggled.content !== undefined ||
      smuggled.url !== undefined ||
      smuggled.body !== undefined
    ) {
      continue
    }

    // ALLOWLIST REBUILD: metadata only — never artifact body bytes.
    const row: HostArtifactProjection = {
      artifactId: entry.artifactId,
      kind: boundText(entry.kind.trim(), HOST_ARTIFACT_SHORT_MAX),
      title: boundText(entry.title.trim(), HOST_ARTIFACT_SHORT_MAX),
      createdAt
    }

    if (isUsableId(entry.threadId) && entry.threadId.length <= HOST_ARTIFACT_ID_MAX) {
      row.threadId = entry.threadId
    }

    const byteLength = parseByteLength(entry.byteLength)
    if (byteLength !== undefined) row.byteLength = byteLength

    const sha256 = parseSha256(entry.sha256)
    if (sha256 !== undefined) row.sha256 = sha256

    rows.push(row)
  }
  return rows
}

/**
 * Build the optional `artifacts` port for createHostProductionBootstrap /
 * createHostProductionSuppliers.
 */
export function createHostProductionArtifactShadow(
  deps: HostProductionArtifactShadowDeps
): HostProductionArtifactListPort {
  if (!deps || typeof deps.listArtifacts !== 'function') {
    throw new Error('HostProductionArtifactShadow requires listArtifacts to be a function')
  }
  return {
    listArtifacts(): HostArtifactProjection[] {
      // Live read every call — no caching of a moving set.
      // Throws propagate: fail closed, never paint a false empty.
      return mapArtifactShadowsToHostArtifacts(deps.listArtifacts())
    }
  }
}
