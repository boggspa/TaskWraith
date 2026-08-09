/**
 * Host Arc Track4 Mixed Wave A — ensemble participant shadow → Host family.
 *
 * WHAT THIS IS. Ensemble roster seats live on ChatRecord.ensemble.participants.
 * Host participant cards reuse those ids so clients can join. This adapter owns
 * the allowlisted mapping into HostParticipantProjection without importing
 * electron, AppStore, or store types.
 *
 * BOUNDARIES:
 * - zero electron / AppStore / EnsembleParticipant value imports;
 * - constructs allowlisted HostParticipantProjection fields only;
 * - never forwards instructions, permission presets, session tokens,
 *   compaction summaries, or other seat-private bodies onto the wire;
 * - never invents participant id or providerId (bad rows are skipped).
 *
 * HONESTY:
 * - a throwing listParticipants propagates (fail closed, never a false empty);
 * - every listParticipants call re-reads (no cache of a moving set).
 */

import {
  encodeHostParticipantEntityId,
  type HostParticipantProjection
} from '../../shared/hostProtocol'

/** Wire id bound — matches hostProtocol HOST_PROTOCOL_MAX_ID. */
const HOST_PARTICIPANT_ID_MAX = 512
/** Role/status bound — matches hostProtocol HOST_PROTOCOL_MAX_SHORT. */
const HOST_PARTICIPANT_SHORT_MAX = 200

const KNOWN_STAGES = new Set<NonNullable<HostParticipantProjection['stage']>>([
  'scout',
  'worker',
  'reviewer',
  'background',
  'any'
])

/**
 * Thin ensemble-seat shape the composition root adapts from AppStore.
 * Deliberately narrow — no instructions / permission / session fields.
 */
export interface HostParticipantShadowEntry {
  readonly id: string
  readonly threadId: string
  readonly providerId: string
  readonly role: string
  readonly order: number
  readonly enabled: boolean
  /** Currently dispatched / speaking when known. */
  readonly active: boolean
  readonly modelId?: string
  readonly stage?: string
  readonly status?: string
}

/**
 * Optional participants port for createHostProductionBootstrap /
 * createHostProductionSuppliers.
 */
export interface HostProductionParticipantListPort {
  listParticipants(): HostParticipantProjection[]
}

export interface HostProductionParticipantShadowDeps {
  listParticipants: () => readonly HostParticipantShadowEntry[]
}

function isUsableId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.trim().length > 0
}

function boundText(value: string, max: number): string {
  return value.length > max ? value.slice(0, max) : value
}

function mapStage(value: unknown): HostParticipantProjection['stage'] | undefined {
  if (typeof value !== 'string') return undefined
  if (KNOWN_STAGES.has(value as NonNullable<HostParticipantProjection['stage']>)) {
    return value as NonNullable<HostParticipantProjection['stage']>
  }
  return undefined
}

/**
 * Map narrow participant entries into allowlisted HostParticipantProjection rows.
 *
 * Exported for unit pins; production callers should use
 * {@link createHostProductionParticipantShadow}.
 */
export function mapParticipantShadowsToHostParticipants(
  entries: readonly HostParticipantShadowEntry[]
): HostParticipantProjection[] {
  if (!Array.isArray(entries) || entries.length === 0) return []

  const rows: HostParticipantProjection[] = []
  for (const entry of entries) {
    if (!entry || !isUsableId(entry.id) || entry.id.length > HOST_PARTICIPANT_ID_MAX) continue
    const entityId = encodeHostParticipantEntityId(entry.threadId, entry.id)
    if (!entityId.ok) continue
    if (!isUsableId(entry.providerId) || entry.providerId.length > HOST_PARTICIPANT_ID_MAX) continue
    if (typeof entry.role !== 'string' || entry.role.trim().length === 0) continue
    if (typeof entry.enabled !== 'boolean' || typeof entry.active !== 'boolean') continue
    if (typeof entry.order !== 'number' || !Number.isInteger(entry.order) || entry.order < 0) {
      continue
    }

    // ALLOWLIST REBUILD: never forward instructions / permissions / sessions.
    const row: HostParticipantProjection = {
      id: entry.id,
      threadId: entry.threadId,
      providerId: entry.providerId,
      role: boundText(entry.role.trim(), HOST_PARTICIPANT_SHORT_MAX),
      order: entry.order,
      enabled: entry.enabled,
      active: entry.active
    }

    if (isUsableId(entry.modelId) && entry.modelId.length <= HOST_PARTICIPANT_ID_MAX) {
      row.modelId = entry.modelId
    }

    const stage = mapStage(entry.stage)
    if (stage !== undefined) row.stage = stage

    if (typeof entry.status === 'string' && entry.status.trim().length > 0) {
      row.status = boundText(entry.status.trim(), HOST_PARTICIPANT_SHORT_MAX)
    }

    rows.push(row)
  }
  return rows
}

/**
 * Build the optional `participants` port for createHostProductionBootstrap /
 * createHostProductionSuppliers.
 */
export function createHostProductionParticipantShadow(
  deps: HostProductionParticipantShadowDeps
): HostProductionParticipantListPort {
  if (!deps || typeof deps.listParticipants !== 'function') {
    throw new Error('HostProductionParticipantShadow requires listParticipants to be a function')
  }
  return {
    listParticipants(): HostParticipantProjection[] {
      // Live read every call — no caching of a moving roster.
      // Throws propagate: fail closed, never paint a false empty.
      return mapParticipantShadowsToHostParticipants(deps.listParticipants())
    }
  }
}
