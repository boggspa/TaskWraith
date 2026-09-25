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
  encodeHostProviderEntityId,
  type HostApprovalProjection,
  type HostArtifactProjection,
  type HostChannelProjection,
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
} from '../shared/hostProtocol'
import { isSafeHostIdentifier } from '../host-shared/HostCommandIdentity'
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

/** The delta families whose entities the diff indexes by id. */
export type HostSnapshotCollectionFamily = CollectionFamily

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
  'channel',
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

    effects.push(...diffHostEntityFamily(family, beforeIndex.index, afterIndex.index))
  }

  return { kind: 'effects', effects }
}

/**
 * The effects that turn one family's entities, keyed by entity id, into
 * another's: upserts for new and changed entities, tombstones for missing
 * ones, in entity id order.
 */
export function diffHostEntityFamily(
  family: HostSnapshotCollectionFamily,
  before: ReadonlyMap<string, unknown>,
  after: ReadonlyMap<string, unknown>
): HostDomainEffectDto[] {
  const effects: HostDomainEffectDto[] = []
  const entityIds = uniqueSortedIds(before.keys(), after.keys())
  for (const entityId of entityIds) {
    const left = before.get(entityId)
    const right = after.get(entityId)
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
    if (
      left !== undefined &&
      right !== undefined &&
      !equalProjection(comparableProjection(family, left), comparableProjection(family, right))
    ) {
      effects.push({
        kind: 'upsert',
        family,
        entityId,
        payload: clonePayload(right)
      })
    }
  }
  return effects
}

/** Whether an entity is unchanged for the diff: equal once live clock fields are set aside. */
export function hostProjectionUnchanged(
  family: HostDeltaFamily,
  before: unknown,
  after: unknown
): boolean {
  return equalProjection(comparableProjection(family, before), comparableProjection(family, after))
}

/** A wire entity's id in its delta family, or why the diff cannot index it. */
export function hostSnapshotEntityId(
  family: HostSnapshotCollectionFamily,
  entity: unknown
):
  | { ok: true; entityId: string }
  | { ok: false; reason: HostSnapshotDomainEffectDiffIncoherenceReason; detail: string } {
  const result = entityIdOf(family, entity)
  return result.ok ? result : { ok: false, ...result.failure }
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
  if (before !== undefined && after !== undefined && !equalProjection(before, after)) {
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
    case 'channel':
      return snapshot.channels ?? []
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
    const provider = entity as HostProviderModelProjection
    const encoded = encodeHostProviderEntityId(provider.providerId, provider.modelId)
    if (encoded.ok) return { ok: true, entityId: encoded.value }
    return {
      ok: false,
      failure: {
        reason: encoded.error.includes('exceeds')
          ? 'provider_composite_overlong'
          : 'unsafe_entity_id',
        detail: encoded.error
      }
    }
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
    case 'channel':
      raw = (entity as HostChannelProjection).channelId
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

function uniqueSortedIds(left: Iterable<string>, right: Iterable<string>): string[] {
  const set = new Set<string>()
  for (const id of left) set.add(id)
  for (const id of right) set.add(id)
  return [...set].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
}

function clonePayload(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value)) as unknown
}

/**
 * Elide LIVE CLOCK fields from the change comparison only — never from the
 * emitted payload.
 *
 * `goal.wallMs` / `goal.activeMs` are recomputed against the wall clock every
 * time the projection is built, so comparing them makes every re-projection a
 * "change" and the diff publishes an upsert that carries no news. Measured on a
 * live profile: four threads with an unfinished goal each republished every
 * ~1.4s, forever, with nothing else different — the Host held 82% CPU and the
 * delta cursor climbed without bound.
 *
 * The payload is untouched, so a delta emitted for any real change still
 * carries the current numbers, as does every snapshot.
 */
function comparableProjection(family: HostDeltaFamily, value: unknown): unknown {
  if (family !== 'thread' || !value || typeof value !== 'object' || Array.isArray(value)) {
    return value
  }
  const record = value as Record<string, unknown>
  const goal = record.goal
  if (!goal || typeof goal !== 'object' || Array.isArray(goal)) return value
  const goalRecord = goal as Record<string, unknown>
  if (goalRecord.wallMs === undefined && goalRecord.activeMs === undefined) return value
  const comparableGoal: Record<string, unknown> = {}
  for (const [key, entry] of Object.entries(goalRecord)) {
    if (key === 'wallMs' || key === 'activeMs') continue
    comparableGoal[key] = entry
  }
  return { ...record, goal: comparableGoal }
}

/**
 * Compare decoded projection values without sorting, cloning and serializing
 * every unchanged row. The decoder bounds these to finite JSON data; object
 * order is immaterial, array order is not. Undefined optional fields compare
 * like absent JSON properties. Changed payloads still get an isolated clone.
 */
function equalProjection(left: unknown, right: unknown): boolean {
  if (left === right) return true
  if (left === null || right === null || typeof left !== 'object' || typeof right !== 'object') {
    return false
  }
  if (Array.isArray(left)) {
    if (!Array.isArray(right) || left.length !== right.length) return false
    for (let index = 0; index < left.length; index += 1) {
      if (!equalProjection(left[index], right[index])) return false
    }
    return true
  }
  if (Array.isArray(right)) return false
  const leftRecord = left as Record<string, unknown>
  const rightRecord = right as Record<string, unknown>
  const leftKeys = Object.keys(leftRecord).filter((key) => leftRecord[key] !== undefined)
  const rightKeys = Object.keys(rightRecord).filter((key) => rightRecord[key] !== undefined)
  if (leftKeys.length !== rightKeys.length) return false
  for (const key of leftKeys) {
    if (
      !Object.prototype.hasOwnProperty.call(rightRecord, key) ||
      !equalProjection(leftRecord[key], rightRecord[key])
    ) {
      return false
    }
  }
  return true
}
