/**
 * Pure before/after HostSnapshot → HostDomainEffectDto diff (Wave 2E-2B3).
 *
 * An injected later orchestrator captures fully decoded, privacy-inspected
 * bounded HostSnapshot values immediately before and after H. This module
 * diffs those coherent projections into HostDomainEffectDto values without
 * executing, publishing, or importing Authority / AppStore / Bridge / E /
 * bootstrap / publisher.
 *
 * Rules (Boss Wave 2E-2B3):
 * - Strict decodeHostSnapshot + inspectHostSnapshotPrivacy on both values.
 * - Same protocol/projection version, generation, and cursor required;
 *   mismatch ⇒ incoherent with zero effects.
 * - Diff every wire collection family by stable entity id and every
 *   singleton (routing / usage / health / recovery).
 * - Exclude snapshot metadata fields (protocol/projection/generation/cursor/
 *   generatedAt/freshness) from effect emission.
 * - New/changed ⇒ upsert with a cloned bounded projection payload.
 * - Missing ⇒ tombstone (never synthesize from command intent).
 * - Deterministic family then entityId order.
 * - Reject duplicate / ambiguous / unsafe / overlong ids and provider
 *   composite collisions without truncation.
 * - Participant entity ids include their owning thread because roster ids are
 *   thread-scoped and may be copied into side chats.
 * - Provider entity ids use a reversible tagged length-prefixed encoding
 *   that always distinguishes model-absent from model-present and remains
 *   unambiguous when components contain ':' (no hash / truncation).
 * - No state mutation of caller inputs.
 */

import {
  HOST_PROTOCOL_MAX_ID,
  decodeHostSnapshot,
  encodeHostParticipantEntityId,
  type HostApprovalProjection,
  type HostArtifactProjection,
  type HostDeltaFamily,
  type HostMissionProjection,
  type HostParticipantProjection,
  type HostProviderModelProjection,
  type HostQuestionProjection,
  type HostRecoveryProjection,
  type HostRoundProjection,
  type HostRoutingProjection,
  type HostRunProjection,
  type HostScheduleProjection,
  type HostSnapshot,
  type HostThreadProjection,
  type HostUsageObservation,
  type HostWarningProjection,
  type HostWorkspaceProjection,
  type HostHealthProjection
} from '../../shared/hostProtocol'
import { isSafeHostIdentifier } from './HostCommandIdentity'
import { inspectHostSnapshotPrivacy } from './HostSnapshotProjector'
import type { HostDomainEffectDto } from './HostDomainDeltaPublisher'

/** Closed incoherence vocabulary for observation-window / index failures. */
export type HostSnapshotDomainEffectDiffIncoherenceReason =
  | 'protocol_version_mismatch'
  | 'projection_version_mismatch'
  | 'generation_mismatch'
  | 'cursor_mismatch'
  | 'duplicate_entity_id'
  | 'ambiguous_entity_id'
  | 'unsafe_entity_id'
  | 'overlong_entity_id'
  | 'provider_composite_collision'
  | 'provider_composite_overlong'

export type HostSnapshotDomainEffectDiffResult =
  | {
      kind: 'effects'
      effects: readonly HostDomainEffectDto[]
    }
  | {
      kind: 'incoherent'
      reason: HostSnapshotDomainEffectDiffIncoherenceReason
      detail: string
    }
  | {
      kind: 'invalid'
      reason: 'decode_failed' | 'privacy_failed'
      detail: string
    }

/** Stable singleton entity ids (family name). */
const SINGLETON_ENTITY_IDS = {
  routing: 'routing',
  usage: 'usage',
  health: 'health',
  recovery: 'recovery'
} as const

type CollectionFamily = Exclude<
  HostDeltaFamily,
  'routing' | 'usage' | 'recovery' | 'health' | 'snapshot-meta'
>

type SingletonFamily = 'routing' | 'usage' | 'recovery' | 'health'

type DiffFamily = CollectionFamily | SingletonFamily

/** Deterministic wire-family order. snapshot-meta is intentionally excluded. */
const FAMILY_ORDER: readonly DiffFamily[] = [
  'workspace',
  'thread',
  'run',
  'mission',
  'round',
  'participant',
  'provider',
  'routing',
  'question',
  'approval',
  'schedule',
  'usage',
  'artifact',
  'warning',
  'recovery',
  'health'
]

type IndexFailure = {
  reason: HostSnapshotDomainEffectDiffIncoherenceReason
  detail: string
}

type EntityIndex = Map<string, unknown>

/**
 * Diff two unknown snapshot values into ordered domain effects.
 * Pure: does not mutate inputs, execute commands, or publish deltas.
 */
export function diffHostSnapshotDomainEffects(
  beforeRaw: unknown,
  afterRaw: unknown
): HostSnapshotDomainEffectDiffResult {
  const beforeDecoded = decodeHostSnapshot(beforeRaw)
  if (!beforeDecoded.ok) {
    return { kind: 'invalid', reason: 'decode_failed', detail: beforeDecoded.error }
  }
  const afterDecoded = decodeHostSnapshot(afterRaw)
  if (!afterDecoded.ok) {
    return { kind: 'invalid', reason: 'decode_failed', detail: afterDecoded.error }
  }

  const beforePrivacy = inspectHostSnapshotPrivacy(beforeDecoded.value)
  if (!beforePrivacy.ok) {
    return { kind: 'invalid', reason: 'privacy_failed', detail: beforePrivacy.error }
  }
  const afterPrivacy = inspectHostSnapshotPrivacy(afterDecoded.value)
  if (!afterPrivacy.ok) {
    return { kind: 'invalid', reason: 'privacy_failed', detail: afterPrivacy.error }
  }

  const before = beforeDecoded.value
  const after = afterDecoded.value

  if (before.protocolVersion !== after.protocolVersion) {
    return incoherent(
      'protocol_version_mismatch',
      `protocolVersion ${String(before.protocolVersion)} !== ${String(after.protocolVersion)}`
    )
  }
  if (before.projectionVersion !== after.projectionVersion) {
    return incoherent(
      'projection_version_mismatch',
      `projectionVersion ${String(before.projectionVersion)} !== ${String(after.projectionVersion)}`
    )
  }
  if (before.generation !== after.generation) {
    return incoherent(
      'generation_mismatch',
      `generation ${before.generation} !== ${after.generation}`
    )
  }
  if (before.cursor !== after.cursor) {
    return incoherent('cursor_mismatch', `cursor ${before.cursor} !== ${after.cursor}`)
  }

  const effects: HostDomainEffectDto[] = []

  for (const family of FAMILY_ORDER) {
    if (family === 'routing') {
      const singleton = diffSingleton(
        family,
        SINGLETON_ENTITY_IDS.routing,
        before.routing,
        after.routing
      )
      if (singleton) effects.push(singleton)
      continue
    }
    if (family === 'usage') {
      const singleton = diffSingleton(family, SINGLETON_ENTITY_IDS.usage, before.usage, after.usage)
      if (singleton) effects.push(singleton)
      continue
    }
    if (family === 'health') {
      const singleton = diffSingleton(
        family,
        SINGLETON_ENTITY_IDS.health,
        before.health,
        after.health
      )
      if (singleton) effects.push(singleton)
      continue
    }
    if (family === 'recovery') {
      const singleton = diffSingleton(
        family,
        SINGLETON_ENTITY_IDS.recovery,
        before.recovery,
        after.recovery
      )
      if (singleton) effects.push(singleton)
      continue
    }

    const beforeIndex = indexCollection(family, before)
    if (!beforeIndex.ok) {
      return incoherent(beforeIndex.failure.reason, beforeIndex.failure.detail)
    }
    const afterIndex = indexCollection(family, after)
    if (!afterIndex.ok) {
      return incoherent(afterIndex.failure.reason, afterIndex.failure.detail)
    }

    const entityIds = uniqueSortedIds(beforeIndex.index.keys(), afterIndex.index.keys())
    for (const entityId of entityIds) {
      const left = beforeIndex.index.get(entityId)
      const right = afterIndex.index.get(entityId)
      if (left === undefined && right !== undefined) {
        effects.push({
          kind: 'upsert',
          family,
          entityId,
          payload: clonePayload(right)
        })
        continue
      }
      if (left !== undefined && right === undefined) {
        effects.push({
          kind: 'tombstone',
          family,
          entityId
        })
        continue
      }
      if (left !== undefined && right !== undefined && !deepEqualCanonical(left, right)) {
        effects.push({
          kind: 'upsert',
          family,
          entityId,
          payload: clonePayload(right)
        })
      }
    }
  }

  return { kind: 'effects', effects }
}

function incoherent(
  reason: HostSnapshotDomainEffectDiffIncoherenceReason,
  detail: string
): HostSnapshotDomainEffectDiffResult {
  return { kind: 'incoherent', reason, detail }
}

function diffSingleton(
  family: 'routing' | 'usage' | 'health' | 'recovery',
  entityId: string,
  before:
    | HostRoutingProjection
    | HostUsageObservation
    | HostHealthProjection
    | HostRecoveryProjection
    | undefined,
  after:
    | HostRoutingProjection
    | HostUsageObservation
    | HostHealthProjection
    | HostRecoveryProjection
    | undefined
): HostDomainEffectDto | null {
  if (before === undefined && after === undefined) {
    return null
  }
  if (before === undefined && after !== undefined) {
    return {
      kind: 'upsert',
      family,
      entityId,
      payload: clonePayload(after)
    }
  }
  if (before !== undefined && after === undefined) {
    return {
      kind: 'tombstone',
      family,
      entityId
    }
  }
  if (before !== undefined && after !== undefined && !deepEqualCanonical(before, after)) {
    return {
      kind: 'upsert',
      family,
      entityId,
      payload: clonePayload(after)
    }
  }
  return null
}

function indexCollection(
  family: CollectionFamily,
  snapshot: HostSnapshot
): { ok: true; index: EntityIndex } | { ok: false; failure: IndexFailure } {
  const items = collectionItems(family, snapshot)
  const index: EntityIndex = new Map()

  for (let i = 0; i < items.length; i += 1) {
    const entity = items[i]
    const idResult = entityIdOf(family, entity)
    if (!idResult.ok) {
      return { ok: false, failure: idResult.failure }
    }
    const entityId = idResult.entityId
    if (index.has(entityId)) {
      if (family === 'provider') {
        return {
          ok: false,
          failure: {
            reason: 'provider_composite_collision',
            detail: `providers duplicate composite entityId "${entityId}" at index ${i}`
          }
        }
      }
      return {
        ok: false,
        failure: {
          reason: 'duplicate_entity_id',
          detail: `${family} duplicate entityId "${entityId}" at index ${i}`
        }
      }
    }
    index.set(entityId, entity)
  }

  return { ok: true, index }
}

function collectionItems(family: CollectionFamily, snapshot: HostSnapshot): readonly unknown[] {
  switch (family) {
    case 'workspace':
      return snapshot.workspaces
    case 'thread':
      return snapshot.threads
    case 'run':
      return snapshot.runs
    case 'mission':
      return snapshot.missions
    case 'round':
      return snapshot.rounds
    case 'participant':
      return snapshot.participants
    case 'provider':
      return snapshot.providers
    case 'question':
      return snapshot.questions
    case 'approval':
      return snapshot.approvals
    case 'schedule':
      return snapshot.schedules
    case 'artifact':
      return snapshot.artifacts
    case 'warning':
      return snapshot.warnings
    default: {
      const _exhaustive: never = family
      return _exhaustive
    }
  }
}

function entityIdOf(
  family: CollectionFamily,
  entity: unknown
): { ok: true; entityId: string } | { ok: false; failure: IndexFailure } {
  if (!entity || typeof entity !== 'object' || Array.isArray(entity)) {
    return {
      ok: false,
      failure: {
        reason: 'ambiguous_entity_id',
        detail: `${family} entity is not an object`
      }
    }
  }

  if (family === 'provider') {
    return providerCompositeEntityId(entity as HostProviderModelProjection)
  }
  if (family === 'participant') {
    const participant = entity as HostParticipantProjection
    const encoded = encodeHostParticipantEntityId(participant.threadId, participant.id)
    if (encoded.ok) return { ok: true, entityId: encoded.value }
    return {
      ok: false,
      failure: {
        reason: encoded.error.includes('exceeds') ? 'overlong_entity_id' : 'unsafe_entity_id',
        detail: encoded.error
      }
    }
  }

  const record = entity as Record<string, unknown>
  let raw: unknown
  switch (family) {
    case 'workspace':
      raw = (entity as HostWorkspaceProjection).id
      break
    case 'thread':
      raw = (entity as HostThreadProjection).id
      break
    case 'run':
      raw = (entity as HostRunProjection).runId
      break
    case 'mission':
      raw = (entity as HostMissionProjection).missionId
      break
    case 'round':
      raw = (entity as HostRoundProjection).roundId
      break
    case 'question':
      raw = (entity as HostQuestionProjection).questionId
      break
    case 'approval':
      raw = (entity as HostApprovalProjection).approvalId
      break
    case 'schedule':
      raw = (entity as HostScheduleProjection).scheduleId
      break
    case 'artifact':
      raw = (entity as HostArtifactProjection).artifactId
      break
    case 'warning':
      raw = (entity as HostWarningProjection).warningId
      break
    default: {
      const _exhaustive: never = family
      return {
        ok: false,
        failure: { reason: 'ambiguous_entity_id', detail: `unknown family ${_exhaustive}` }
      }
    }
  }

  if (typeof raw !== 'string') {
    return {
      ok: false,
      failure: {
        reason: 'ambiguous_entity_id',
        detail: `${family} entity id is missing or non-string`
      }
    }
  }
  if (raw.length > HOST_PROTOCOL_MAX_ID) {
    return {
      ok: false,
      failure: {
        reason: 'overlong_entity_id',
        detail: `${family} entity id exceeds HOST_PROTOCOL_MAX_ID without truncation`
      }
    }
  }
  if (!isSafeHostIdentifier(raw, HOST_PROTOCOL_MAX_ID)) {
    return {
      ok: false,
      failure: {
        reason: 'unsafe_entity_id',
        detail: `${family} entity id is empty, whitespace-padded, or contains controls`
      }
    }
  }
  // Keep record touch so TypeScript exhaustiveness on family stays honest.
  void record
  return { ok: true, entityId: raw }
}

/**
 * Provider entity ids are a reversible tagged length-prefixed encoding:
 *   model absent  → `p0:<len>:<providerId>`
 *   model present → `p1:<len>:<providerId>:<len>:<modelId>`
 *
 * Length prefixes make embedded ':' bytes unambiguous. The tag always
 * distinguishes no-model from model-present so a providerId of `a:b` cannot
 * alias provider `a` + model `b` across before/after snapshots. Final
 * entityId must fit HOST_PROTOCOL_MAX_ID — never hash or truncate.
 */
function providerCompositeEntityId(
  provider: HostProviderModelProjection
): { ok: true; entityId: string } | { ok: false; failure: IndexFailure } {
  const providerIdResult = validateProviderComponent(provider.providerId, 'provider.providerId')
  if (!providerIdResult.ok) return providerIdResult
  const providerId = providerIdResult.value

  if (provider.modelId === undefined) {
    return finalizeProviderEntityId(`p0:${providerId.length}:${providerId}`)
  }

  const modelIdResult = validateProviderComponent(provider.modelId, 'provider.modelId')
  if (!modelIdResult.ok) return modelIdResult
  const modelId = modelIdResult.value

  return finalizeProviderEntityId(
    `p1:${providerId.length}:${providerId}:${modelId.length}:${modelId}`
  )
}

function validateProviderComponent(
  value: unknown,
  label: 'provider.providerId' | 'provider.modelId'
): { ok: true; value: string } | { ok: false; failure: IndexFailure } {
  if (typeof value !== 'string') {
    return {
      ok: false,
      failure: {
        reason: 'ambiguous_entity_id',
        detail:
          label === 'provider.providerId'
            ? 'provider.providerId is missing or non-string'
            : 'provider.modelId is present but non-string'
      }
    }
  }
  if (value.length > HOST_PROTOCOL_MAX_ID) {
    return {
      ok: false,
      failure: {
        reason: 'overlong_entity_id',
        detail: `${label} exceeds HOST_PROTOCOL_MAX_ID without truncation`
      }
    }
  }
  if (!isSafeHostIdentifier(value, HOST_PROTOCOL_MAX_ID)) {
    return {
      ok: false,
      failure: {
        reason: 'unsafe_entity_id',
        detail: `${label} is empty, whitespace-padded, or contains controls`
      }
    }
  }
  return { ok: true, value }
}

function finalizeProviderEntityId(
  entityId: string
): { ok: true; entityId: string } | { ok: false; failure: IndexFailure } {
  if (entityId.length > HOST_PROTOCOL_MAX_ID) {
    return {
      ok: false,
      failure: {
        reason: 'provider_composite_overlong',
        detail: `provider composite length ${entityId.length} exceeds HOST_PROTOCOL_MAX_ID without truncation`
      }
    }
  }
  if (!isSafeHostIdentifier(entityId, HOST_PROTOCOL_MAX_ID)) {
    return {
      ok: false,
      failure: {
        reason: 'unsafe_entity_id',
        detail: 'provider composite entity id is unsafe'
      }
    }
  }
  return { ok: true, entityId }
}

function uniqueSortedIds(
  left: IterableIterator<string>,
  right: IterableIterator<string>
): string[] {
  const set = new Set<string>()
  for (const id of left) set.add(id)
  for (const id of right) set.add(id)
  return [...set].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
}

function clonePayload(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value)) as unknown
}

/** Stable deep equality via canonicalized JSON (sorted object keys). */
function deepEqualCanonical(left: unknown, right: unknown): boolean {
  return canonicalize(left) === canonicalize(right)
}

function canonicalize(value: unknown): string {
  return JSON.stringify(canonicalizeValue(value))
}

function canonicalizeValue(value: unknown): unknown {
  if (value === null || typeof value !== 'object') {
    return value
  }
  if (Array.isArray(value)) {
    return value.map((entry) => canonicalizeValue(entry))
  }
  const record = value as Record<string, unknown>
  const keys = Object.keys(record).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
  const out: Record<string, unknown> = {}
  for (const key of keys) {
    out[key] = canonicalizeValue(record[key])
  }
  return out
}
