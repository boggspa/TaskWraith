/**
 * Immutable HostSnapshot cache applicator (Wave 2D-2 Lane G).
 *
 * Desktop / TUI / iOS may keep a coherent projection cache between
 * Authority-RPC snapshots. This module applies ordered HostDeltaEnvelope
 * values onto a validated HostSnapshot without Node or Electron imports,
 * without inventing authority, and without mutating the caller's cache.
 *
 * Rules (Boss Wave 2D-2):
 * - Validate the base snapshot first.
 * - Apply on a working copy; publish a new snapshot only when the full
 *   applicable batch succeeds.
 * - duplicate / late cursors are idempotent skips.
 * - generation mismatch/reset, cursor gaps, and projection-version mismatch
 *   require a full resnapshot with the original cache unchanged.
 * - Collection families upsert/remove/tombstone by stable entity ids.
 * - Singleton families replace only with a fully valid bounded payload;
 *   singleton remove/tombstone forces resnapshot.
 * - Invalid / unknown payloads reject atomically (no cursor advance).
 * - Applied caches are marked freshness:'cached' (cached ≠ live).
 */

import {
  applyHostDeltaCursor,
  decodeHostDeltaEnvelope,
  decodeHostHealthProjection,
  decodeHostSnapshot,
  encodeHostParticipantEntityId,
  encodeHostProviderEntityId,
  type HostApprovalProjection,
  type HostArtifactProjection,
  type HostCursor,
  type HostDeltaApplyOutcome,
  type HostDeltaEnvelope,
  type HostDeltaFamily,
  type HostGeneration,
  type HostMissionProjection,
  type HostParticipantProjection,
  type HostProviderModelProjection,
  type HostQuestionProjection,
  type HostRecoveryProjection,
  type HostRoundProjection,
  type HostRunProjection,
  type HostScheduleProjection,
  type HostSnapshot,
  type HostThreadProjection,
  type HostUsageObservation,
  type HostWarningProjection,
  type HostWorkspaceProjection,
  type HostRoutingProjection
} from './hostProtocol'

/** Collection families keyed by a stable entity id on the projection. */
const COLLECTION_FAMILIES = new Set<HostDeltaFamily>([
  'workspace',
  'thread',
  'run',
  'mission',
  'round',
  'participant',
  'provider',
  'question',
  'approval',
  'schedule',
  'artifact',
  'warning'
])

/** Singleton projection families — replace whole value; remove ⇒ resnapshot. */
const SINGLETON_FAMILIES = new Set<HostDeltaFamily>(['routing', 'usage', 'recovery', 'health'])

export type HostSnapshotApplyResnapshotReason =
  | Extract<HostDeltaApplyOutcome, { outcome: 'require_resnapshot' }>['reason']
  | 'unsupported_singleton_removal'

export type HostSnapshotApplyResult =
  | {
      outcome: 'applied'
      snapshot: HostSnapshot
      generation: HostGeneration
      cursor: HostCursor
      appliedCount: number
      skippedDuplicates: number
      skippedLate: number
    }
  | {
      outcome: 'unchanged'
      snapshot: HostSnapshot
      generation: HostGeneration
      cursor: HostCursor
      skippedDuplicates: number
      skippedLate: number
    }
  | {
      outcome: 'require_resnapshot'
      reason: HostSnapshotApplyResnapshotReason
      generation: HostGeneration
      cursor: HostCursor
    }
  | {
      outcome: 'rejected'
      reason: string
    }

function cloneSnapshot(snapshot: HostSnapshot): HostSnapshot {
  return JSON.parse(JSON.stringify(snapshot)) as HostSnapshot
}

function entityIdOf(family: HostDeltaFamily, entity: unknown): string | null {
  if (!entity || typeof entity !== 'object') return null
  const record = entity as Record<string, unknown>
  switch (family) {
    case 'workspace':
    case 'thread':
      return typeof record.id === 'string' ? record.id : null
    case 'participant': {
      const encoded = encodeHostParticipantEntityId(record.threadId, record.id)
      return encoded.ok ? encoded.value : null
    }
    case 'run':
      return typeof record.runId === 'string' ? record.runId : null
    case 'mission':
      return typeof record.missionId === 'string' ? record.missionId : null
    case 'round':
      return typeof record.roundId === 'string' ? record.roundId : null
    case 'provider': {
      const encoded = encodeHostProviderEntityId(record.providerId, record.modelId)
      return encoded.ok ? encoded.value : null
    }
    case 'question':
      return typeof record.questionId === 'string' ? record.questionId : null
    case 'approval':
      return typeof record.approvalId === 'string' ? record.approvalId : null
    case 'schedule':
      return typeof record.scheduleId === 'string' ? record.scheduleId : null
    case 'artifact':
      return typeof record.artifactId === 'string' ? record.artifactId : null
    case 'warning':
      return typeof record.warningId === 'string' ? record.warningId : null
    default:
      return null
  }
}

function collectionKey(family: HostDeltaFamily): keyof HostSnapshot | null {
  switch (family) {
    case 'workspace':
      return 'workspaces'
    case 'thread':
      return 'threads'
    case 'run':
      return 'runs'
    case 'mission':
      return 'missions'
    case 'round':
      return 'rounds'
    case 'participant':
      return 'participants'
    case 'provider':
      return 'providers'
    case 'question':
      return 'questions'
    case 'approval':
      return 'approvals'
    case 'schedule':
      return 'schedules'
    case 'artifact':
      return 'artifacts'
    case 'warning':
      return 'warnings'
    default:
      return null
  }
}

function markCached(snapshot: HostSnapshot): void {
  // Applied caches must never remain advertised as live Host authority.
  if (snapshot.freshness === 'live') {
    snapshot.freshness = 'cached'
  }
  if (snapshot.health.freshness === 'live') {
    snapshot.health = {
      ...snapshot.health,
      freshness: 'cached'
    }
  }
}

function applySnapshotMeta(
  working: HostSnapshot,
  delta: HostDeltaEnvelope
): { ok: true } | { ok: false; reason: string } {
  if (delta.kind !== 'upsert') {
    return { ok: false, reason: `snapshot-meta does not support kind ${delta.kind}` }
  }
  if (delta.payload === undefined || delta.payload === null) {
    return { ok: false, reason: 'snapshot-meta upsert requires a payload' }
  }
  if (typeof delta.payload !== 'object' || Array.isArray(delta.payload)) {
    return { ok: false, reason: 'snapshot-meta payload must be an object' }
  }
  const payload = delta.payload as Record<string, unknown>
  const allowed = new Set(['generatedAt', 'freshness'])
  for (const key of Object.keys(payload)) {
    if (!allowed.has(key)) {
      return { ok: false, reason: `snapshot-meta payload has unknown key: ${key}` }
    }
  }
  if (payload.generatedAt !== undefined) {
    if (typeof payload.generatedAt !== 'string' || payload.generatedAt.trim().length === 0) {
      return { ok: false, reason: 'snapshot-meta generatedAt is invalid' }
    }
    working.generatedAt = payload.generatedAt
  }
  if (payload.freshness !== undefined) {
    if (
      payload.freshness !== 'live' &&
      payload.freshness !== 'cached' &&
      payload.freshness !== 'stale'
    ) {
      return { ok: false, reason: 'snapshot-meta freshness is invalid' }
    }
    // Client-applied caches must not claim live Host authority from a delta.
    if (payload.freshness === 'live') {
      return { ok: false, reason: 'snapshot-meta cannot promote cache to live' }
    }
    working.freshness = payload.freshness
  }
  return { ok: true }
}

function applySingleton(
  working: HostSnapshot,
  delta: HostDeltaEnvelope
):
  | { ok: true }
  | { ok: false; reason: string }
  | {
      ok: false
      resnapshot: HostSnapshotApplyResnapshotReason
      generation: HostGeneration
      cursor: HostCursor
    } {
  if (delta.kind === 'remove' || delta.kind === 'tombstone') {
    return {
      ok: false,
      resnapshot: 'unsupported_singleton_removal',
      generation: delta.generation,
      cursor: delta.cursor
    }
  }
  if (delta.kind !== 'upsert') {
    return { ok: false, reason: `${delta.family} does not support kind ${delta.kind}` }
  }
  if (delta.payload === undefined) {
    return { ok: false, reason: `${delta.family} upsert requires a fully valid payload` }
  }

  switch (delta.family) {
    case 'health': {
      const decoded = decodeHostHealthProjection(delta.payload)
      if (!decoded.ok) return { ok: false, reason: decoded.error }
      working.health = decoded.value
      return { ok: true }
    }
    case 'usage': {
      // Validate by temporary placement + full snapshot decode.
      const previous = working.usage
      working.usage = delta.payload as HostUsageObservation
      const checked = decodeHostSnapshot(working)
      if (!checked.ok) {
        working.usage = previous
        return { ok: false, reason: checked.error }
      }
      working.usage = checked.value.usage
      return { ok: true }
    }
    case 'recovery': {
      const previous = working.recovery
      working.recovery = delta.payload as HostRecoveryProjection
      const checked = decodeHostSnapshot(working)
      if (!checked.ok) {
        working.recovery = previous
        return { ok: false, reason: checked.error }
      }
      working.recovery = checked.value.recovery
      return { ok: true }
    }
    case 'routing': {
      const previous = working.routing
      working.routing = delta.payload as HostRoutingProjection
      const checked = decodeHostSnapshot(working)
      if (!checked.ok) {
        if (previous === undefined) {
          delete working.routing
        } else {
          working.routing = previous
        }
        return { ok: false, reason: checked.error }
      }
      if (checked.value.routing !== undefined) {
        working.routing = checked.value.routing
      } else {
        delete working.routing
      }
      return { ok: true }
    }
    default:
      return { ok: false, reason: `unsupported singleton family: ${delta.family}` }
  }
}

function applyCollection(
  working: HostSnapshot,
  delta: HostDeltaEnvelope
): { ok: true } | { ok: false; reason: string } {
  const key = collectionKey(delta.family)
  if (!key) return { ok: false, reason: `unknown collection family: ${delta.family}` }

  const list = working[key]
  if (!Array.isArray(list)) {
    return { ok: false, reason: `snapshot family ${key} is not an array` }
  }

  if (delta.kind === 'remove' || delta.kind === 'tombstone') {
    if (typeof delta.entityId !== 'string' || delta.entityId.length === 0) {
      return { ok: false, reason: `${delta.family} ${delta.kind} requires entityId` }
    }
    if (delta.payload !== undefined) {
      return { ok: false, reason: `${delta.family} ${delta.kind} forbids payload` }
    }
    const next = list.filter((entry) => entityIdOf(delta.family, entry) !== delta.entityId)
    ;(working as unknown as Record<string, unknown>)[key] = next
    return { ok: true }
  }

  if (delta.kind !== 'upsert') {
    return { ok: false, reason: `${delta.family} does not support kind ${delta.kind}` }
  }
  if (delta.payload === undefined) {
    return { ok: false, reason: `${delta.family} upsert requires a fully valid payload` }
  }
  if (typeof delta.entityId !== 'string' || delta.entityId.length === 0) {
    return { ok: false, reason: `${delta.family} upsert requires entityId` }
  }
  const payloadId = entityIdOf(delta.family, delta.payload)
  if (payloadId === null) {
    return { ok: false, reason: `${delta.family} upsert payload is missing its stable id` }
  }
  if (payloadId !== delta.entityId) {
    return { ok: false, reason: `${delta.family} entityId does not match payload id` }
  }

  const previous = list.slice()
  const without = previous.filter((entry) => entityIdOf(delta.family, entry) !== delta.entityId)
  without.push(delta.payload as never)
  ;(working as unknown as Record<string, unknown>)[key] = without

  const checked = decodeHostSnapshot(working)
  if (!checked.ok) {
    ;(working as unknown as Record<string, unknown>)[key] = previous
    return { ok: false, reason: checked.error }
  }

  // Re-assign the decoded (bounded/rebuild) collection so privacy extras never stick.
  ;(working as unknown as Record<string, unknown>)[key] = checked.value[key]
  return { ok: true }
}

function applyFamilyMutation(
  working: HostSnapshot,
  delta: HostDeltaEnvelope
):
  | { ok: true }
  | { ok: false; reason: string }
  | {
      ok: false
      resnapshot: HostSnapshotApplyResnapshotReason
      generation: HostGeneration
      cursor: HostCursor
    } {
  if (delta.family === 'snapshot-meta') {
    if (delta.kind === 'remove' || delta.kind === 'tombstone') {
      return {
        ok: false,
        resnapshot: 'unsupported_singleton_removal',
        generation: delta.generation,
        cursor: delta.cursor
      }
    }
    const meta = applySnapshotMeta(working, delta)
    if (!meta.ok) return meta
    return { ok: true }
  }
  if (SINGLETON_FAMILIES.has(delta.family)) {
    return applySingleton(working, delta)
  }
  if (COLLECTION_FAMILIES.has(delta.family)) {
    return applyCollection(working, delta)
  }
  return { ok: false, reason: `unknown delta family: ${delta.family}` }
}

/**
 * Apply an ordered delta batch onto a coherent HostSnapshot cache.
 *
 * The input `cache` is never mutated. On `applied`, the returned snapshot is a
 * new object. On `unchanged` / `require_resnapshot` / `rejected`, callers must
 * keep using their original cache reference.
 */
export function applyHostSnapshotDeltas(
  cache: HostSnapshot,
  deltas: readonly HostDeltaEnvelope[]
): HostSnapshotApplyResult {
  const base = decodeHostSnapshot(cache)
  if (!base.ok) {
    return { outcome: 'rejected', reason: `invalid base snapshot: ${base.error}` }
  }

  if (!Array.isArray(deltas)) {
    return { outcome: 'rejected', reason: 'deltas must be an array' }
  }

  const original = base.value
  if (deltas.length === 0) {
    return {
      outcome: 'unchanged',
      snapshot: cache,
      generation: original.generation,
      cursor: original.cursor,
      skippedDuplicates: 0,
      skippedLate: 0
    }
  }

  const working = cloneSnapshot(original)
  let appliedCount = 0
  let skippedDuplicates = 0
  let skippedLate = 0
  let mutated = false

  for (let index = 0; index < deltas.length; index += 1) {
    const raw = deltas[index]
    const decoded = decodeHostDeltaEnvelope(raw)
    if (!decoded.ok) {
      return { outcome: 'rejected', reason: `delta[${index}]: ${decoded.error}` }
    }
    const delta = decoded.value

    const cursorOutcome = applyHostDeltaCursor(
      { generation: working.generation, cursor: working.cursor },
      delta
    )

    if (cursorOutcome.outcome === 'duplicate') {
      skippedDuplicates += 1
      continue
    }
    if (cursorOutcome.outcome === 'late') {
      skippedLate += 1
      continue
    }
    if (cursorOutcome.outcome === 'require_resnapshot') {
      return {
        outcome: 'require_resnapshot',
        reason: cursorOutcome.reason,
        generation: cursorOutcome.generation,
        cursor: cursorOutcome.cursor
      }
    }
    if (cursorOutcome.outcome === 'rejected') {
      return { outcome: 'rejected', reason: cursorOutcome.reason }
    }

    const mutation = applyFamilyMutation(working, delta)
    if ('resnapshot' in mutation && mutation.ok === false) {
      return {
        outcome: 'require_resnapshot',
        reason: mutation.resnapshot,
        generation: mutation.generation,
        cursor: mutation.cursor
      }
    }
    if (!mutation.ok) {
      return { outcome: 'rejected', reason: mutation.reason }
    }

    working.generation = cursorOutcome.generation
    working.cursor = cursorOutcome.cursor
    appliedCount += 1
    mutated = true
  }

  if (!mutated) {
    return {
      outcome: 'unchanged',
      snapshot: cache,
      generation: original.generation,
      cursor: original.cursor,
      skippedDuplicates,
      skippedLate
    }
  }

  markCached(working)
  const finalized = decodeHostSnapshot(working)
  if (!finalized.ok) {
    return { outcome: 'rejected', reason: `post-apply snapshot invalid: ${finalized.error}` }
  }

  return {
    outcome: 'applied',
    snapshot: finalized.value,
    generation: finalized.value.generation,
    cursor: finalized.value.cursor,
    appliedCount,
    skippedDuplicates,
    skippedLate
  }
}

/** Type-only helpers retained so tests can name projection shapes without drift. */
export type HostSnapshotApplyCollectionEntity =
  | HostWorkspaceProjection
  | HostThreadProjection
  | HostRunProjection
  | HostMissionProjection
  | HostRoundProjection
  | HostParticipantProjection
  | HostProviderModelProjection
  | HostQuestionProjection
  | HostApprovalProjection
  | HostScheduleProjection
  | HostArtifactProjection
  | HostWarningProjection
