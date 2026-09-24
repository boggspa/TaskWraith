import { createHash } from 'node:crypto'

import type {
  WorkspaceLockAuthorityFence,
  WorkspaceLockClaimStatus,
  WorkspaceLockLease
} from './WorkspaceLockTypes'
import { isWorkspaceLockOpaqueId, isWorkspaceLockOwnerDisplayText } from './WorkspaceLockTypes'
import { workspaceLockRuntimeMarkerFilename } from './WorkspaceLockMarkerProjection'
import { isRuntimeMarkerName } from './RuntimeMarkerPattern'

/** The schema is deliberately a literal rather than a permissive version range. */
export const WORKSPACE_LOCK_WAL_SCHEMA = 'taskwraith.workspace-lock.wal.v1'

export interface WorkspaceLockWalAuthority {
  instanceId: string
  generation: number
}

/**
 * A marker is a derived checkout artefact, never authority state. Keeping a
 * durable inventory lets startup remove a marker written before a crash even
 * when the corresponding lease was later released in the same interrupted run.
 */
export interface WorkspaceLockWalMarker {
  worktreeIdentity: string
  worktreeObjectIdentity: string
  markerName: string
}

interface WorkspaceLockWalEventBase<K extends WorkspaceLockWalEventKind, P> {
  schema: typeof WORKSPACE_LOCK_WAL_SCHEMA
  sequence: number
  previousDigest: string
  transitionId: string
  timestamp: string
  authority: WorkspaceLockWalAuthority
  kind: K
  payload: P
  digest: string
}

export interface WorkspaceLockWalBootPayload {
  fence: WorkspaceLockAuthorityFence
  markers?: WorkspaceLockWalMarker[]
}

export interface WorkspaceLockWalAcquirePayload {
  leases: WorkspaceLockLease[]
  /** Exact prior operation leases atomically superseded by this acquisition. */
  replacesLeaseIds?: string[]
  markers?: WorkspaceLockWalMarker[]
}

export interface WorkspaceLockWalPreparePayload {
  markers: WorkspaceLockWalMarker[]
}

export interface WorkspaceLockWalReleasePayload {
  leaseIds: string[]
  /** Present for operation-scoped release replay; omitted for direct token release. */
  ownerRunId?: string
  acquiredTransitionId?: string
  /** Human-approval audit receipt for exact recovery-blocked force release. */
  forceApprovalReceiptId?: string
  markers?: WorkspaceLockWalMarker[]
}

export interface WorkspaceLockWalReleaseRunPayload {
  runId: string
  leaseIds: string[]
  forceOrphaned?: boolean
  retainedLeaseIds?: string[]
  markers?: WorkspaceLockWalMarker[]
}

export interface WorkspaceLockWalRecoverPayload {
  decisions: WorkspaceLockWalRecoveryDecision[]
  markers?: WorkspaceLockWalMarker[]
}

export interface WorkspaceLockWalCleanupPayload {
  /** Inactive markers conclusively removed (or already absent). */
  markers: WorkspaceLockWalMarker[]
}

/** Startup recovery records the conservative outcome for every inspected lease. */
export interface WorkspaceLockWalRecoveryDecision {
  leaseId: string
  status: 'orphan_live' | 'recovery_blocked' | 'recovered'
  reason?: 'owner_dead' | 'pid_reused'
}

export type WorkspaceLockWalEvent =
  | WorkspaceLockWalEventBase<'boot', WorkspaceLockWalBootPayload>
  | WorkspaceLockWalEventBase<'prepare', WorkspaceLockWalPreparePayload>
  | WorkspaceLockWalEventBase<'acquire', WorkspaceLockWalAcquirePayload>
  | WorkspaceLockWalEventBase<'release', WorkspaceLockWalReleasePayload>
  | WorkspaceLockWalEventBase<'release_run', WorkspaceLockWalReleaseRunPayload>
  | WorkspaceLockWalEventBase<'recover', WorkspaceLockWalRecoverPayload>
  | WorkspaceLockWalEventBase<'cleanup', WorkspaceLockWalCleanupPayload>

export type WorkspaceLockWalEventKind = WorkspaceLockWalEvent['kind']

export type WorkspaceLockWalEventInput =
  | {
      transitionId: string
      timestamp: string
      authority: WorkspaceLockWalAuthority
      kind: 'prepare'
      payload: WorkspaceLockWalPreparePayload
    }
  | {
      transitionId: string
      timestamp: string
      authority: WorkspaceLockWalAuthority
      kind: 'boot'
      payload: WorkspaceLockWalBootPayload
    }
  | {
      transitionId: string
      timestamp: string
      authority: WorkspaceLockWalAuthority
      kind: 'acquire'
      payload: WorkspaceLockWalAcquirePayload
    }
  | {
      transitionId: string
      timestamp: string
      authority: WorkspaceLockWalAuthority
      kind: 'release'
      payload: WorkspaceLockWalReleasePayload
    }
  | {
      transitionId: string
      timestamp: string
      authority: WorkspaceLockWalAuthority
      kind: 'release_run'
      payload: WorkspaceLockWalReleaseRunPayload
    }
  | {
      transitionId: string
      timestamp: string
      authority: WorkspaceLockWalAuthority
      kind: 'recover'
      payload: WorkspaceLockWalRecoverPayload
    }
  | {
      transitionId: string
      timestamp: string
      authority: WorkspaceLockWalAuthority
      kind: 'cleanup'
      payload: WorkspaceLockWalCleanupPayload
    }

/**
 * Everything a checkpoint must carry to stand in for the events it compacted.
 * Deliberately the complete projection minus `events`/`leases`: the id sets are
 * never truncated, because refusing a reused transition or lease id is a fence,
 * not an optimisation. See docs/performance/workspace-lock-wal-checkpoint.md.
 */
export interface WorkspaceLockWalCheckpointBaseline {
  sequence: number
  lastDigest: string
  lastTransitionId: string
  transitionIds: string[]
  leaseIds: string[]
  maxGeneration: number
  activeLeases: WorkspaceLockLease[]
  recoveredLeases: WorkspaceLockLease[]
  knownMarkers: WorkspaceLockWalMarker[]
}

export interface WorkspaceLockWalState {
  sequence: number
  lastDigest: string
  lastTransitionId: string
  /** All prior transition ids; never infer uniqueness from a digest chain alone. */
  transitionIds: string[]
  /**
   * Validated history retained so request-level idempotency survives restart.
   * With a checkpoint this holds only the frames after `baseline.sequence`;
   * an older transition is refused rather than replayed.
   */
  events: WorkspaceLockWalEvent[]
  /** Lease ids are never reusable, including after a normal release. */
  leaseIds: string[]
  maxGeneration: number
  /** Leases that still block a conflicting acquire. */
  activeLeases: WorkspaceLockLease[]
  /** Leases intentionally retired by recovery, retained for audit and cleanup. */
  recoveredLeases: WorkspaceLockLease[]
  /** Active plus recovered leases; release events deliberately remove their lease. */
  leases: WorkspaceLockLease[]
  /** Active markers plus inactive markers whose durable cleanup is still pending. */
  knownMarkers: WorkspaceLockWalMarker[]
  /** The compacted prefix `events` starts after, or null when it holds everything. */
  baseline: WorkspaceLockWalCheckpointBaseline | null
}

export interface WorkspaceLockWalAppendResult {
  event: WorkspaceLockWalEvent
  line: string
  nextState: WorkspaceLockWalState
}

interface WorkspaceLockWalUnsignedRecord {
  schema: typeof WORKSPACE_LOCK_WAL_SCHEMA
  sequence: number
  previousDigest: string
  transitionId: string
  timestamp: string
  authority: WorkspaceLockWalAuthority
  kind: WorkspaceLockWalEventKind
  payload: unknown
}

const DIGEST_LENGTH = 64
const leaseStatuses: readonly WorkspaceLockClaimStatus[] = [
  'held',
  'orphan_live',
  'recovery_blocked',
  'recovered'
]
const MAX_RECOVERED_LEASES_IN_STATE = 100

export function createEmptyWorkspaceLockWalState(): WorkspaceLockWalState {
  return {
    sequence: 0,
    lastDigest: '',
    lastTransitionId: '',
    transitionIds: [],
    events: [],
    leaseIds: [],
    maxGeneration: 0,
    activeLeases: [],
    recoveredLeases: [],
    leases: [],
    knownMarkers: [],
    baseline: null
  }
}

/**
 * The state a checkpoint stands for: sequence `baseline.sequence` reached, and
 * no retained events, so replay of the following frames starts here instead of
 * from zero.
 */
export function workspaceLockWalStateFromBaseline(
  baseline: WorkspaceLockWalCheckpointBaseline
): WorkspaceLockWalState {
  const activeLeases = baseline.activeLeases.map(cloneLease).sort(compareLease)
  const recoveredLeases = baseline.recoveredLeases.map(cloneLease).sort(compareLease)
  const state: WorkspaceLockWalState = {
    sequence: baseline.sequence,
    lastDigest: baseline.lastDigest,
    lastTransitionId: baseline.lastTransitionId,
    transitionIds: [...baseline.transitionIds],
    events: [],
    leaseIds: [...baseline.leaseIds],
    maxGeneration: baseline.maxGeneration,
    activeLeases,
    recoveredLeases,
    leases: [...activeLeases, ...recoveredLeases],
    knownMarkers: baseline.knownMarkers.map((marker) => ({ ...marker })),
    baseline
  }
  assertState(state)
  return state
}

/** The compacted prefix length; 0 when `events` still holds the whole history. */
export function workspaceLockWalCheckpointSequence(state: WorkspaceLockWalState): number {
  return state.baseline ? state.baseline.sequence : 0
}

/**
 * Produces one canonical, newline-terminated JSONL record and its replayed
 * state. Callers persist `line` only after their persistence byte-fence check.
 */
export function appendWorkspaceLockWalEvent(
  state: WorkspaceLockWalState,
  input: WorkspaceLockWalEventInput
): WorkspaceLockWalAppendResult {
  assertState(state)
  const unsigned = {
    schema: WORKSPACE_LOCK_WAL_SCHEMA as typeof WORKSPACE_LOCK_WAL_SCHEMA,
    sequence: state.sequence + 1,
    previousDigest: state.lastDigest,
    transitionId: input.transitionId,
    timestamp: input.timestamp,
    authority: input.authority,
    kind: input.kind,
    payload: input.payload
  }
  const event = {
    ...unsigned,
    digest: digestWorkspaceLockWalRecord(unsigned)
  } as WorkspaceLockWalEvent
  const nextState = applyValidatedWorkspaceLockWalEvent(state, validateWorkspaceLockWalEvent(event))
  return { event, line: `${canonicalJson(event)}\n`, nextState }
}

/**
 * Reads the complete durable prefix. A final unterminated byte fragment is a
 * possible torn append and is ignored; every newline-terminated frame must be
 * fully valid or recovery stops fail-closed.
 */
export function decodeWorkspaceLockWal(
  raw: string,
  baseline?: WorkspaceLockWalCheckpointBaseline | null
): WorkspaceLockWalState {
  if (typeof raw !== 'string') throw new Error('Workspace-lock WAL must be UTF-8 text.')
  let state = baseline
    ? workspaceLockWalStateFromBaseline(baseline)
    : createEmptyWorkspaceLockWalState()
  if (!raw) return state

  const lastNewline = raw.lastIndexOf('\n')
  const completePrefix = lastNewline < 0 ? '' : raw.slice(0, lastNewline + 1)
  if (!completePrefix) return state

  const lines = completePrefix.slice(0, -1).split('\n')
  const transitionIds = new Set<string>(state.transitionIds)
  const leaseIds = new Set<string>(state.leaseIds)
  for (const [index, line] of lines.entries()) {
    if (!line || line.includes('\r')) throw corrupt(index + 1, 'empty or non-canonical frame')
    let parsed: unknown
    try {
      parsed = JSON.parse(line)
    } catch {
      throw corrupt(index + 1, 'malformed JSON')
    }
    try {
      const event = validateWorkspaceLockWalEvent(parsed)
      state = applyValidatedWorkspaceLockWalEvent(state, event, {
        transitionIds,
        leaseIds,
        reuseHistoryArrays: true
      })
    } catch (error) {
      const reason = error instanceof Error ? error.message : 'invalid event'
      throw corrupt(index + 1, reason)
    }
  }
  state.leaseIds.sort()
  assertState(state)
  return state
}

/** Linear-time historical projection used only for exact committed-operation replay. */
export function historicalWorkspaceLockWalEvent(
  state: WorkspaceLockWalState,
  transitionId: string
): { event: WorkspaceLockWalEvent; previous: WorkspaceLockWalState } | null {
  assertState(state)
  let previous = state.baseline
    ? workspaceLockWalStateFromBaseline(state.baseline)
    : createEmptyWorkspaceLockWalState()
  const transitionIds = new Set<string>(previous.transitionIds)
  const leaseIds = new Set<string>(previous.leaseIds)
  for (const event of state.events) {
    if (event.transitionId === transitionId) {
      previous.leaseIds.sort()
      assertState(previous)
      return { event, previous }
    }
    previous = applyValidatedWorkspaceLockWalEvent(previous, event, {
      transitionIds,
      leaseIds,
      reuseHistoryArrays: true
    })
  }
  return null
}

/** Validates an untrusted JSON value before it can affect replay. */
export function validateWorkspaceLockWalEvent(value: unknown): WorkspaceLockWalEvent {
  const event = object(value, 'event')
  exactKeys(event, [
    'schema',
    'sequence',
    'previousDigest',
    'transitionId',
    'timestamp',
    'authority',
    'kind',
    'payload',
    'digest'
  ])
  if (event.schema !== WORKSPACE_LOCK_WAL_SCHEMA) throw new Error('unknown WAL schema')
  if (!positiveSafeInteger(event.sequence)) throw new Error('invalid sequence')
  if (!digest(event.previousDigest) && event.previousDigest !== '')
    throw new Error('invalid previous digest')
  opaqueId(event.transitionId, 'transition id')
  isoTimestamp(event.timestamp, 'timestamp')
  const authority = validateAuthority(event.authority)
  if (typeof event.kind !== 'string' || !isKind(event.kind))
    throw new Error('unknown WAL event kind')
  if (!digest(event.digest)) throw new Error('invalid event digest')

  const payload = validatePayload(event.kind, event.payload)
  const candidate = {
    schema: WORKSPACE_LOCK_WAL_SCHEMA as typeof WORKSPACE_LOCK_WAL_SCHEMA,
    sequence: event.sequence,
    previousDigest: event.previousDigest,
    transitionId: event.transitionId,
    timestamp: event.timestamp,
    authority,
    kind: event.kind,
    payload
  }
  if (digestWorkspaceLockWalRecord(candidate) !== event.digest) throw new Error('digest mismatch')
  return { ...candidate, digest: event.digest } as WorkspaceLockWalEvent
}

/** Replays one already-validated record, preserving all fail-closed fences. */
export function applyWorkspaceLockWalEvent(
  current: WorkspaceLockWalState,
  event: WorkspaceLockWalEvent
): WorkspaceLockWalState {
  assertState(current)
  const checked = validateWorkspaceLockWalEvent(event)
  return applyValidatedWorkspaceLockWalEvent(current, checked)
}

interface WorkspaceLockWalReducerOptions {
  transitionIds: Set<string>
  leaseIds: Set<string>
  reuseHistoryArrays: true
}

function applyValidatedWorkspaceLockWalEvent(
  current: WorkspaceLockWalState,
  checked: WorkspaceLockWalEvent,
  options?: WorkspaceLockWalReducerOptions
): WorkspaceLockWalState {
  if (checked.sequence !== current.sequence + 1) throw new Error('non-contiguous WAL sequence')
  if (checked.previousDigest !== current.lastDigest) throw new Error('WAL digest chain mismatch')
  const transitionIds = options?.transitionIds || new Set(current.transitionIds)
  if (transitionIds.has(checked.transitionId)) throw new Error('duplicate transition id')

  const active = new Map(current.activeLeases.map((lease) => [lease.leaseId, cloneLease(lease)]))
  const recovered = new Map(
    current.recoveredLeases.map((lease) => [lease.leaseId, cloneLease(lease)])
  )
  const knownLeaseIds = options?.leaseIds || new Set(current.leaseIds)
  const addedLeaseIds: string[] = []

  switch (checked.kind) {
    case 'boot':
      if (
        checked.payload.fence.instanceId !== checked.authority.instanceId ||
        checked.payload.fence.generation !== checked.authority.generation
      ) {
        throw new Error('boot fence does not match event authority')
      }
      break
    case 'prepare':
      break
    case 'acquire':
      if (checked.payload.replacesLeaseIds) {
        releaseLeases(active, checked.payload.replacesLeaseIds)
      }
      for (const lease of checked.payload.leases) {
        if (knownLeaseIds.has(lease.leaseId)) throw new Error('duplicate lease id')
        if (
          lease.acquiredTransitionId !== checked.transitionId ||
          lease.authorityInstanceId !== checked.authority.instanceId ||
          lease.authorityGeneration !== checked.authority.generation ||
          lease.acquiredAt !== checked.timestamp ||
          lease.statusChangedAt !== checked.timestamp ||
          lease.status !== 'held'
        ) {
          throw new Error('acquired lease does not match its event')
        }
        active.set(lease.leaseId, cloneLease(lease))
        knownLeaseIds.add(lease.leaseId)
        addedLeaseIds.push(lease.leaseId)
      }
      break
    case 'release':
      if (checked.payload.ownerRunId && checked.payload.acquiredTransitionId) {
        const operationLeaseIds = [...active.values()]
          .filter(
            (lease) =>
              lease.owner.runId === checked.payload.ownerRunId &&
              lease.acquiredTransitionId === checked.payload.acquiredTransitionId &&
              (checked.payload.forceApprovalReceiptId !== undefined ||
                (lease.authorityInstanceId === checked.authority.instanceId &&
                  lease.authorityGeneration === checked.authority.generation))
          )
          .map((lease) => lease.leaseId)
          .sort()
        const releasedLeaseIds = [...checked.payload.leaseIds].sort()
        if (
          operationLeaseIds.length !== releasedLeaseIds.length ||
          operationLeaseIds.some((leaseId, index) => leaseId !== releasedLeaseIds[index])
        ) {
          throw new Error('operation release must settle the complete active acquisition')
        }
        for (const leaseId of checked.payload.leaseIds) {
          const lease = active.get(leaseId)
          if (
            !lease ||
            lease.owner.runId !== checked.payload.ownerRunId ||
            lease.acquiredTransitionId !== checked.payload.acquiredTransitionId ||
            (checked.payload.forceApprovalReceiptId !== undefined &&
              (lease.status !== 'recovery_blocked' ||
                (lease.owner.lifecycle !== 'launching-child' && lease.owner.lifecycle !== 'child')))
          ) {
            throw new Error('operation release identity does not match its lease')
          }
        }
      }
      releaseLeases(active, checked.payload.leaseIds)
      break
    case 'release_run':
      {
        const runLeaseIds = [...active.values()]
          .filter((lease) => lease.owner.runId === checked.payload.runId)
          .map((lease) => lease.leaseId)
          .sort()
        const settledLeaseIds = [
          ...checked.payload.leaseIds,
          ...(checked.payload.retainedLeaseIds || [])
        ].sort()
        if (
          checked.payload.forceOrphaned !== undefined &&
          (runLeaseIds.length !== settledLeaseIds.length ||
            runLeaseIds.some((leaseId, index) => leaseId !== settledLeaseIds[index]))
        ) {
          throw new Error('release_run must classify every active run lease')
        }
        if (checked.payload.forceOrphaned && checked.payload.retainedLeaseIds?.length) {
          throw new Error('forced release_run cannot retain leases')
        }
        for (const leaseId of checked.payload.leaseIds) {
          const lease = active.get(leaseId)
          if (!lease) throw new Error('release_run references a lease that is not active')
          if (lease.owner.runId !== checked.payload.runId) {
            throw new Error('release_run lease belongs to another run')
          }
        }
        for (const leaseId of checked.payload.retainedLeaseIds || []) {
          const lease = active.get(leaseId)
          if (!lease) throw new Error('release_run retained lease is not active')
          if (lease.owner.runId !== checked.payload.runId) {
            throw new Error('release_run retained lease belongs to another run')
          }
          if (checked.payload.leaseIds.includes(leaseId)) {
            throw new Error('release_run cannot release and retain the same lease')
          }
          if (lease.owner.lifecycle !== 'child' && lease.owner.lifecycle !== 'launching-child') {
            throw new Error('release_run may retain only managed child leases')
          }
        }
      }
      releaseLeases(active, checked.payload.leaseIds)
      break
    case 'recover':
      for (const decision of checked.payload.decisions) {
        const lease = active.get(decision.leaseId)
        if (!lease) throw new Error('recover references a lease that is not active')
        const recoveredLease: WorkspaceLockLease = {
          ...lease,
          status: decision.status,
          statusChangedAt: checked.timestamp,
          ...(decision.reason ? { recoveryReason: decision.reason } : {})
        }
        if (decision.status === 'recovered') {
          active.delete(decision.leaseId)
          recovered.set(decision.leaseId, recoveredLease)
        } else {
          active.set(decision.leaseId, recoveredLease)
        }
      }
      break
    case 'cleanup':
      {
        const activeMarkerKeys = new Set(
          [...active.values()].map((lease) =>
            markerKey({
              worktreeIdentity: lease.claim.worktreeCanonicalPath,
              worktreeObjectIdentity: lease.claim.worktreeObjectIdentity!,
              markerName: workspaceLockRuntimeMarkerFilename(
                lease.authorityInstanceId,
                lease.owner.lockOwnerId
              )
            })
          )
        )
        for (const marker of checked.payload.markers) {
          if (
            !current.knownMarkers.some((candidate) => markerKey(candidate) === markerKey(marker))
          ) {
            throw new Error('cleanup references a marker that is not pending')
          }
          if (activeMarkerKeys.has(markerKey(marker))) {
            throw new Error('cleanup cannot retire an active marker')
          }
        }
      }
      break
  }

  const markers =
    checked.kind === 'cleanup'
      ? current.knownMarkers.filter(
          (marker) =>
            !checked.payload.markers.some((retired) => markerKey(retired) === markerKey(marker))
        )
      : mergeMarkers(current.knownMarkers, markersFor(checked))
  const activeLeases = [...active.values()].sort(compareLease)
  const recoveredLeases = [...recovered.values()]
    .sort(
      (left, right) =>
        right.statusChangedAt.localeCompare(left.statusChangedAt) || compareLease(left, right)
    )
    .slice(0, MAX_RECOVERED_LEASES_IN_STATE)
    .sort(compareLease)
  const nextTransitionIds = options
    ? (current.transitionIds.push(checked.transitionId), current.transitionIds)
    : [...current.transitionIds, checked.transitionId]
  const nextEvents = options
    ? (current.events.push(checked), current.events)
    : [...current.events, checked]
  const nextLeaseIds = options
    ? (current.leaseIds.push(...addedLeaseIds), current.leaseIds)
    : [...knownLeaseIds].sort()
  transitionIds.add(checked.transitionId)
  return {
    sequence: checked.sequence,
    lastDigest: checked.digest,
    lastTransitionId: checked.transitionId,
    transitionIds: nextTransitionIds,
    events: nextEvents,
    leaseIds: nextLeaseIds,
    maxGeneration: Math.max(current.maxGeneration, checked.authority.generation),
    activeLeases,
    recoveredLeases,
    leases: [...activeLeases, ...recoveredLeases],
    knownMarkers: markers,
    baseline: current.baseline
  }
}

export function digestWorkspaceLockWalRecord(
  recordWithoutDigest: WorkspaceLockWalUnsignedRecord
): string {
  return createHash('sha256').update(canonicalJson(recordWithoutDigest), 'utf8').digest('hex')
}

/**
 * Exposed so the checkpoint envelope signs with the exact same construction as
 * an event. Two digest constructions would be two things to keep in step.
 */
export function canonicalWorkspaceLockWalJson(value: unknown): string {
  return canonicalJson(value)
}

export function workspaceLockWalDigest(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value), 'utf8').digest('hex')
}

/**
 * Digest of exact UTF-8 content, NOT of its canonical-JSON encoding.
 *
 * Archive segments are audit evidence a person may want to verify with
 * `shasum -a 256 events-<seq>.jsonl`. Running them through `canonicalJson`
 * first would hash the quoted, escaped string and silently make that
 * impossible.
 */
export function workspaceLockWalContentDigest(text: string): string {
  if (typeof text !== 'string') throw new Error('Workspace-lock content digest requires text.')
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

/**
 * Validates an untrusted checkpoint projection with the same fail-closed
 * validators replay uses. A checkpoint stands in for events that are no longer
 * on the boot path, so it may not be trusted any further than one of them.
 */
export function validateWorkspaceLockWalCheckpointBaseline(
  value: unknown
): WorkspaceLockWalCheckpointBaseline {
  const baseline = object(value, 'checkpoint baseline')
  exactKeys(baseline, [
    'sequence',
    'lastDigest',
    'lastTransitionId',
    'transitionIds',
    'leaseIds',
    'maxGeneration',
    'activeLeases',
    'recoveredLeases',
    'knownMarkers'
  ])
  if (!positiveSafeInteger(baseline.sequence)) throw new Error('invalid checkpoint sequence')
  if (!digest(baseline.lastDigest)) throw new Error('invalid checkpoint digest anchor')
  opaqueId(baseline.lastTransitionId, 'checkpoint transition anchor')
  if (!safeGeneration(baseline.maxGeneration)) throw new Error('invalid checkpoint generation')
  const transitionIds = idArray(baseline.transitionIds, 'checkpoint transition id')
  if (transitionIds.length !== baseline.sequence) {
    throw new Error('checkpoint transition history does not match its sequence')
  }
  if (transitionIds[transitionIds.length - 1] !== baseline.lastTransitionId) {
    throw new Error('checkpoint last transition id is not current')
  }
  const leaseIdList = idArray(baseline.leaseIds, 'checkpoint lease id')
  if (leaseIdList.some((leaseId, index) => index > 0 && leaseId < leaseIdList[index - 1])) {
    throw new Error('checkpoint lease ids are not sorted')
  }
  if (!Array.isArray(baseline.activeLeases) || !Array.isArray(baseline.recoveredLeases)) {
    throw new Error('checkpoint lease projection must be an array')
  }
  const activeLeases = baseline.activeLeases.map((lease) => validateLease(lease))
  const recoveredLeases = baseline.recoveredLeases.map((lease) => validateLease(lease))
  const knownMarkers = validateMarkers(baseline.knownMarkers)
  const projection: WorkspaceLockWalCheckpointBaseline = {
    sequence: baseline.sequence,
    lastDigest: baseline.lastDigest,
    lastTransitionId: baseline.lastTransitionId,
    transitionIds,
    leaseIds: leaseIdList,
    maxGeneration: baseline.maxGeneration,
    activeLeases,
    recoveredLeases,
    knownMarkers
  }
  // Reuse the full state invariant rather than restating a weaker subset here.
  workspaceLockWalStateFromBaseline(projection)
  return projection
}

function idArray(value: unknown, label: string): string[] {
  if (!Array.isArray(value)) throw new Error(`${label} list must be an array`)
  for (const id of value) opaqueId(id, label)
  unique(value as string[], label)
  return [...(value as string[])]
}

function validatePayload(kind: WorkspaceLockWalEventKind, value: unknown): unknown {
  const payload = object(value, `${kind} payload`)
  switch (kind) {
    case 'boot': {
      optionalMarkers(payload, ['fence'])
      exactKeys(payload, payload.markers === undefined ? ['fence'] : ['fence', 'markers'])
      return { fence: validateFence(payload.fence), ...markersProperty(payload) }
    }
    case 'prepare': {
      exactKeys(payload, ['markers'])
      const markers = validateMarkers(payload.markers)
      if (!markers.length) throw new Error('prepare must contain one or more markers')
      return { markers }
    }
    case 'acquire': {
      optionalMarkers(payload, ['leases'])
      const acquireKeys = [
        'leases',
        ...(payload.replacesLeaseIds === undefined ? [] : ['replacesLeaseIds']),
        ...(payload.markers === undefined ? [] : ['markers'])
      ]
      exactKeys(payload, acquireKeys)
      if (!Array.isArray(payload.leases) || payload.leases.length === 0) {
        throw new Error('acquire must contain one or more leases')
      }
      const leases = payload.leases.map((lease) => validateLease(lease))
      unique(
        leases.map((lease) => lease.leaseId),
        'lease id'
      )
      return {
        leases,
        ...(payload.replacesLeaseIds === undefined
          ? {}
          : { replacesLeaseIds: leaseIds(payload.replacesLeaseIds) }),
        ...markersProperty(payload)
      }
    }
    case 'release': {
      optionalMarkers(payload, ['leaseIds'])
      const hasOperationIdentity =
        payload.ownerRunId !== undefined ||
        payload.acquiredTransitionId !== undefined ||
        payload.forceApprovalReceiptId !== undefined
      if (
        hasOperationIdentity &&
        (payload.ownerRunId === undefined || payload.acquiredTransitionId === undefined)
      ) {
        throw new Error('release operation identity must be complete')
      }
      exactKeys(payload, [
        'leaseIds',
        ...(hasOperationIdentity ? ['ownerRunId', 'acquiredTransitionId'] : []),
        ...(payload.forceApprovalReceiptId === undefined ? [] : ['forceApprovalReceiptId']),
        ...(payload.markers === undefined ? [] : ['markers'])
      ])
      if (hasOperationIdentity) {
        opaqueId(payload.ownerRunId, 'release owner run id')
        opaqueId(payload.acquiredTransitionId, 'released acquisition transition id')
      }
      if (payload.forceApprovalReceiptId !== undefined) {
        opaqueId(payload.forceApprovalReceiptId, 'force approval receipt id')
      }
      return {
        leaseIds: leaseIds(payload.leaseIds),
        ...(hasOperationIdentity
          ? {
              ownerRunId: payload.ownerRunId as string,
              acquiredTransitionId: payload.acquiredTransitionId as string,
              ...(payload.forceApprovalReceiptId === undefined
                ? {}
                : { forceApprovalReceiptId: payload.forceApprovalReceiptId as string })
            }
          : {}),
        ...markersProperty(payload)
      }
    }
    case 'release_run': {
      optionalMarkers(payload, ['runId', 'leaseIds'])
      exactKeys(payload, [
        'runId',
        'leaseIds',
        ...(payload.forceOrphaned === undefined ? [] : ['forceOrphaned']),
        ...(payload.retainedLeaseIds === undefined ? [] : ['retainedLeaseIds']),
        ...(payload.markers === undefined ? [] : ['markers'])
      ])
      opaqueId(payload.runId, 'run id')
      if (payload.forceOrphaned !== undefined && typeof payload.forceOrphaned !== 'boolean') {
        throw new Error('release_run forceOrphaned must be boolean')
      }
      return {
        runId: payload.runId,
        leaseIds: leaseIds(payload.leaseIds),
        ...(payload.forceOrphaned === undefined ? {} : { forceOrphaned: payload.forceOrphaned }),
        ...(payload.retainedLeaseIds === undefined
          ? {}
          : { retainedLeaseIds: leaseIds(payload.retainedLeaseIds) }),
        ...markersProperty(payload)
      }
    }
    case 'recover': {
      optionalMarkers(payload, ['decisions'])
      exactKeys(payload, payload.markers === undefined ? ['decisions'] : ['decisions', 'markers'])
      return { decisions: recoveryDecisions(payload.decisions), ...markersProperty(payload) }
    }
    case 'cleanup': {
      exactKeys(payload, ['markers'])
      const markers = validateMarkers(payload.markers)
      if (!markers.length) throw new Error('cleanup must contain one or more markers')
      return { markers }
    }
  }
}

function validateFence(value: unknown): WorkspaceLockAuthorityFence {
  const fence = object(value, 'fence')
  exactKeys(fence, [
    'instanceId',
    'generation',
    'pid',
    'processBirthIdentity',
    'fenceId',
    'acquiredAt'
  ])
  opaqueId(fence.instanceId, 'fence instance id')
  if (!safeGeneration(fence.generation)) throw new Error('invalid fence generation')
  if (!positiveSafeInteger(fence.pid)) throw new Error('invalid fence pid')
  opaqueId(fence.processBirthIdentity, 'fence process identity')
  opaqueId(fence.fenceId, 'fence id')
  isoTimestamp(fence.acquiredAt, 'fence acquiredAt')
  return { ...fence } as unknown as WorkspaceLockAuthorityFence
}

function validateAuthority(value: unknown): WorkspaceLockWalAuthority {
  const authority = object(value, 'authority')
  exactKeys(authority, ['instanceId', 'generation'])
  opaqueId(authority.instanceId, 'authority instance id')
  if (!safeGeneration(authority.generation)) throw new Error('invalid authority generation')
  return { instanceId: authority.instanceId, generation: authority.generation }
}

function validateLease(value: unknown): WorkspaceLockLease {
  const lease = object(value, 'lease')
  exactKeys(
    lease,
    lease.recoveryReason === undefined
      ? [
          'leaseId',
          'acquiredTransitionId',
          'authorityInstanceId',
          'authorityGeneration',
          'owner',
          'claim',
          'acquiredAt',
          'status',
          'statusChangedAt'
        ]
      : [
          'leaseId',
          'acquiredTransitionId',
          'authorityInstanceId',
          'authorityGeneration',
          'owner',
          'claim',
          'acquiredAt',
          'status',
          'statusChangedAt',
          'recoveryReason'
        ]
  )
  opaqueId(lease.leaseId, 'lease id')
  opaqueId(lease.acquiredTransitionId, 'lease transition id')
  opaqueId(lease.authorityInstanceId, 'lease authority id')
  if (!safeGeneration(lease.authorityGeneration))
    throw new Error('invalid lease authority generation')
  const owner = validateOwner(lease.owner)
  const claim = validateClaim(lease.claim)
  isoTimestamp(lease.acquiredAt, 'lease acquiredAt')
  if (
    typeof lease.status !== 'string' ||
    !leaseStatuses.includes(lease.status as WorkspaceLockClaimStatus)
  ) {
    throw new Error('invalid lease status')
  }
  isoTimestamp(lease.statusChangedAt, 'lease statusChangedAt')
  if (
    lease.recoveryReason !== undefined &&
    lease.recoveryReason !== 'owner_dead' &&
    lease.recoveryReason !== 'pid_reused'
  ) {
    throw new Error('invalid lease recovery reason')
  }
  if (lease.status === 'recovered' && !lease.recoveryReason) {
    throw new Error('recovered lease is missing its recovery reason')
  }
  return { ...lease, owner, claim } as WorkspaceLockLease
}

function validateOwner(value: unknown): WorkspaceLockLease['owner'] {
  const owner = object(value, 'lease owner')
  const allowed = [
    'lockOwnerId',
    'runId',
    'lifecycle',
    'laneId',
    'chatId',
    'provider',
    'participantId',
    'displayName',
    'chatTitle',
    'pid',
    'processBirthIdentity'
  ]
  exactKeys(
    owner,
    allowed.filter((key) => owner[key] !== undefined)
  )
  opaqueId(owner.lockOwnerId, 'lease owner lock id')
  opaqueId(owner.runId, 'lease owner run id')
  if (
    owner.lifecycle !== undefined &&
    owner.lifecycle !== 'run' &&
    owner.lifecycle !== 'launching-child' &&
    owner.lifecycle !== 'child'
  ) {
    throw new Error('invalid lease owner lifecycle')
  }
  if (!positiveSafeInteger(owner.pid)) throw new Error('invalid lease owner pid')
  opaqueId(owner.processBirthIdentity, 'lease owner process identity')
  for (const key of ['laneId', 'chatId', 'provider', 'participantId']) {
    if (owner[key] !== undefined) opaqueId(owner[key], `lease owner ${key}`)
  }
  for (const key of ['displayName', 'chatTitle']) {
    if (owner[key] !== undefined) displayText(owner[key], `lease owner ${key}`)
  }
  return { ...owner } as unknown as WorkspaceLockLease['owner']
}

function validateClaim(value: unknown): WorkspaceLockLease['claim'] {
  const claim = object(value, 'lease claim')
  const allowed = [
    'workspaceIdentity',
    'worktreeCanonicalPath',
    'worktreeIdentity',
    'worktreeObjectIdentity',
    'targetCanonicalPath',
    'comparisonTargetPath',
    'objectIdentity',
    'physicalTargetIdentity',
    'displayWorkspacePath',
    'displayWorktreePath',
    'relativeTargetPath',
    'worktreeName',
    'branch',
    'kind',
    'mode',
    'hunk',
    'globalFilesystem',
    'pathEvidence'
  ]
  exactKeys(
    claim,
    allowed.filter((key) => claim[key] !== undefined)
  )
  for (const key of [
    'workspaceIdentity',
    'worktreeCanonicalPath',
    'worktreeIdentity',
    'targetCanonicalPath',
    'comparisonTargetPath',
    'physicalTargetIdentity',
    'displayWorkspacePath',
    'displayWorktreePath'
  ]) {
    pathString(claim[key], `lease claim ${key}`)
  }
  identityString(claim.worktreeObjectIdentity, 'lease claim worktreeObjectIdentity')
  if (claim.objectIdentity !== undefined) {
    identityString(claim.objectIdentity, 'lease claim objectIdentity')
  }
  if (!['workspace', 'tree', 'file', 'hunk'].includes(claim.kind as string)) {
    throw new Error('invalid lease claim kind')
  }
  if (claim.mode !== 'read' && claim.mode !== 'write') throw new Error('invalid lease claim mode')
  if (claim.relativeTargetPath !== undefined) {
    pathString(claim.relativeTargetPath, 'lease claim relativeTargetPath')
  }
  for (const key of ['worktreeName', 'branch']) {
    if (claim[key] !== undefined) opaqueId(claim[key], `lease claim ${key}`)
  }
  if (claim.globalFilesystem !== undefined) {
    if (claim.globalFilesystem !== true) throw new Error('invalid global filesystem claim')
    if (claim.kind !== 'workspace' || claim.mode !== 'write') {
      throw new Error('global filesystem authority requires a write workspace claim')
    }
  }
  if (claim.pathEvidence !== undefined) {
    validatePathEvidence(claim.pathEvidence)
    const evidence = claim.pathEvidence as Record<string, unknown>
    const containment = evidence.containment as Record<string, unknown>
    if (
      claim.worktreeCanonicalPath !== containment.canonicalRootPath ||
      claim.worktreeIdentity !== containment.comparisonRootPath ||
      claim.worktreeObjectIdentity !== (containment.rootIdentity as Record<string, unknown>).key ||
      claim.targetCanonicalPath !== evidence.canonicalPath ||
      claim.comparisonTargetPath !== evidence.comparisonPath ||
      claim.physicalTargetIdentity !== evidence.comparisonPath ||
      claim.objectIdentity !== evidence.physicalIdentity
    ) {
      throw new Error('lease claim path evidence does not match its canonical identities')
    }
    if (claim.kind !== 'workspace' && claim.relativeTargetPath !== containment.relativeTargetPath) {
      throw new Error('lease claim path evidence does not match its relative target')
    }
  } else {
    throw new Error('lease claim is missing path evidence')
  }
  if (
    claim.kind === 'workspace' &&
    (claim.relativeTargetPath !== undefined || claim.hunk !== undefined)
  ) {
    throw new Error('workspace claim has a target or hunk')
  }
  if (claim.kind !== 'workspace' && claim.relativeTargetPath === undefined) {
    throw new Error('non-workspace claim is missing its target')
  }
  if (claim.kind === 'hunk') {
    if (!claim.hunk) throw new Error('hunk claim is missing its hunk')
    validateHunk(claim.hunk)
  } else if (claim.hunk !== undefined) {
    throw new Error('non-hunk claim has a hunk')
  }
  return { ...claim } as unknown as WorkspaceLockLease['claim']
}

function validatePathEvidence(value: unknown): void {
  const evidence = object(value, 'lease claim path evidence')
  exactKeys(evidence, [
    'requestedRootPath',
    'requestedTargetPath',
    'lexicalRootPath',
    'lexicalTargetPath',
    'pathFlavor',
    'caseSensitive',
    'targetExists',
    'canonicalPath',
    'comparisonPath',
    'physicalIdentity',
    'targetIdentity',
    'containment'
  ])
  for (const key of [
    'requestedRootPath',
    'requestedTargetPath',
    'lexicalRootPath',
    'lexicalTargetPath',
    'canonicalPath',
    'comparisonPath'
  ]) {
    pathString(evidence[key], `path evidence ${key}`)
  }
  if (evidence.pathFlavor !== 'posix' && evidence.pathFlavor !== 'win32') {
    throw new Error('invalid path evidence flavor')
  }
  if (typeof evidence.caseSensitive !== 'boolean' || typeof evidence.targetExists !== 'boolean') {
    throw new Error('invalid path evidence filesystem flags')
  }
  identityString(evidence.physicalIdentity, 'path evidence physical identity')
  validateTargetIdentity(evidence.targetIdentity)

  const containment = object(evidence.containment, 'path containment evidence')
  exactKeys(containment, [
    'canonicalRootPath',
    'canonicalTargetPath',
    'comparisonRootPath',
    'comparisonTargetPath',
    'relativeTargetPath',
    'rootIdentity',
    'existingAncestorCanonicalPath',
    'existingAncestorIdentity'
  ])
  for (const key of [
    'canonicalRootPath',
    'canonicalTargetPath',
    'comparisonRootPath',
    'comparisonTargetPath',
    'relativeTargetPath',
    'existingAncestorCanonicalPath'
  ]) {
    pathString(containment[key], `path containment ${key}`)
  }
  validateFileIdentity(containment.rootIdentity, 'path containment root identity')
  validateFileIdentity(
    containment.existingAncestorIdentity,
    'path containment existing ancestor identity'
  )
}

function validateTargetIdentity(value: unknown): void {
  const identity = object(value, 'path target identity')
  if (identity.kind === 'existing') {
    exactKeys(identity, ['kind', 'file', 'key'])
    validateFileIdentity(identity.file, 'existing target identity')
  } else if (identity.kind === 'planned') {
    exactKeys(identity, ['kind', 'existingAncestor', 'normalizedSuffix', 'key'])
    validateFileIdentity(identity.existingAncestor, 'planned target ancestor identity')
    pathString(identity.normalizedSuffix, 'planned target suffix')
  } else {
    throw new Error('invalid path target identity kind')
  }
  identityString(identity.key, 'path target identity key')
}

function validateFileIdentity(value: unknown, label: string): void {
  const identity = object(value, label)
  exactKeys(identity, ['device', 'inode', 'key'])
  if (
    typeof identity.device !== 'string' ||
    !/^\d+$/.test(identity.device) ||
    typeof identity.inode !== 'string' ||
    !/^\d+$/.test(identity.inode)
  ) {
    throw new Error(`invalid ${label}`)
  }
  identityString(identity.key, `${label} key`)
}

function validateHunk(value: unknown): void {
  const hunk = object(value, 'lease hunk')
  exactKeys(hunk, ['baseline', 'startLine', 'endLine'])
  opaqueId(hunk.baseline, 'lease hunk baseline')
  if (
    !nonNegativeSafeInteger(hunk.startLine) ||
    !nonNegativeSafeInteger(hunk.endLine) ||
    hunk.endLine < hunk.startLine
  ) {
    throw new Error('invalid lease hunk range')
  }
}

function optionalMarkers(payload: Record<string, unknown>, required: string[]): void {
  for (const key of required) if (!(key in payload)) throw new Error(`missing ${key}`)
  if (payload.markers !== undefined) validateMarkers(payload.markers)
}

function markersProperty(payload: Record<string, unknown>): { markers?: WorkspaceLockWalMarker[] } {
  return payload.markers === undefined ? {} : { markers: validateMarkers(payload.markers) }
}

function validateMarkers(value: unknown): WorkspaceLockWalMarker[] {
  if (!Array.isArray(value)) throw new Error('markers must be an array')
  const result = value.map((marker) => {
    const parsed = object(marker, 'marker')
    exactKeys(parsed, ['worktreeIdentity', 'worktreeObjectIdentity', 'markerName'])
    opaqueId(parsed.worktreeIdentity, 'marker worktree identity')
    identityString(parsed.worktreeObjectIdentity, 'marker worktree object identity')
    if (typeof parsed.markerName !== 'string' || !isRuntimeMarkerName(parsed.markerName)) {
      throw new Error('invalid derived marker name')
    }
    return {
      worktreeIdentity: parsed.worktreeIdentity,
      worktreeObjectIdentity: parsed.worktreeObjectIdentity,
      markerName: parsed.markerName
    }
  })
  unique(result.map(markerKey), 'marker')
  return result
}

function markersFor(event: WorkspaceLockWalEvent): WorkspaceLockWalMarker[] {
  return event.kind === 'cleanup' ? [] : event.payload.markers || []
}

function releaseLeases(active: Map<string, WorkspaceLockLease>, ids: readonly string[]): void {
  for (const leaseId of ids) {
    if (!active.has(leaseId)) throw new Error('release references a lease that is not active')
  }
  for (const leaseId of ids) active.delete(leaseId)
}

function leaseIds(value: unknown): string[] {
  if (!Array.isArray(value) || value.length === 0)
    throw new Error('lease ids must be a non-empty array')
  const ids = value.map((id) => {
    opaqueId(id, 'lease id')
    return id
  })
  unique(ids, 'lease id')
  return ids
}

function recoveryDecisions(value: unknown): WorkspaceLockWalRecoveryDecision[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error('recovery decisions must be a non-empty array')
  }
  const decisions = value.map((candidate) => {
    const decision = object(candidate, 'recovery decision')
    exactKeys(
      decision,
      decision.reason === undefined ? ['leaseId', 'status'] : ['leaseId', 'status', 'reason']
    )
    opaqueId(decision.leaseId, 'recovery lease id')
    if (
      decision.status !== 'orphan_live' &&
      decision.status !== 'recovery_blocked' &&
      decision.status !== 'recovered'
    ) {
      throw new Error('invalid recovery status')
    }
    if (
      decision.reason !== undefined &&
      decision.reason !== 'owner_dead' &&
      decision.reason !== 'pid_reused'
    ) {
      throw new Error('invalid recovery reason')
    }
    if (decision.status === 'recovered' && decision.reason === undefined) {
      throw new Error('recovered decision is missing its recovery reason')
    }
    if (decision.status !== 'recovered' && decision.reason !== undefined) {
      throw new Error('non-recovered decision cannot include a recovery reason')
    }
    return {
      leaseId: decision.leaseId,
      status: decision.status,
      ...(decision.reason ? { reason: decision.reason } : {})
    } as WorkspaceLockWalRecoveryDecision
  })
  unique(
    decisions.map((decision) => decision.leaseId),
    'recovery lease id'
  )
  return decisions
}

function mergeMarkers(
  current: readonly WorkspaceLockWalMarker[],
  additions: readonly WorkspaceLockWalMarker[]
): WorkspaceLockWalMarker[] {
  const markers = new Map<string, WorkspaceLockWalMarker>()
  for (const marker of [...current, ...additions]) markers.set(markerKey(marker), { ...marker })
  return [...markers.values()].sort((left, right) =>
    markerKey(left).localeCompare(markerKey(right))
  )
}

function assertState(state: WorkspaceLockWalState): void {
  if (!state || (state.baseline !== null && typeof state.baseline !== 'object')) {
    throw new Error('invalid workspace-lock WAL state')
  }
  // Frames before this point live in a checkpoint (and a sealed archive
  // segment); `events` is the replayable suffix after it.
  const compacted = state.baseline ? state.baseline.sequence : 0
  if (
    !nonNegativeSafeInteger(compacted) ||
    !nonNegativeSafeInteger(state.sequence) ||
    compacted > state.sequence ||
    !Array.isArray(state.transitionIds) ||
    !Array.isArray(state.events) ||
    !Array.isArray(state.leaseIds) ||
    state.transitionIds.length !== state.sequence ||
    state.events.length !== state.sequence - compacted ||
    (state.sequence === 0
      ? state.lastDigest !== '' || state.lastTransitionId !== ''
      : !digest(state.lastDigest) || !isWorkspaceLockOpaqueId(state.lastTransitionId))
  ) {
    throw new Error('invalid workspace-lock WAL state')
  }
  if (
    !safeGeneration(state.maxGeneration) ||
    !Array.isArray(state.activeLeases) ||
    !Array.isArray(state.recoveredLeases) ||
    !Array.isArray(state.leases) ||
    !Array.isArray(state.knownMarkers)
  ) {
    throw new Error('invalid workspace-lock WAL state')
  }
  for (const transitionId of state.transitionIds) opaqueId(transitionId, 'transition id')
  unique(state.transitionIds, 'transition id')
  if (
    state.events.some(
      (event, index) =>
        event.transitionId !== state.transitionIds[compacted + index] ||
        event.sequence !== compacted + index + 1
    )
  ) {
    throw new Error('workspace-lock WAL events do not match transition history')
  }
  for (const leaseId of state.leaseIds) opaqueId(leaseId, 'lease id')
  unique(state.leaseIds, 'lease id')
  if (
    state.sequence > 0 &&
    state.lastTransitionId !== state.transitionIds[state.transitionIds.length - 1]
  ) {
    throw new Error('workspace-lock WAL last transition id is not current')
  }
  const active = state.activeLeases.map(validateLease)
  const recovered = state.recoveredLeases.map(validateLease)
  if (
    active.some((lease) => lease.status === 'recovered') ||
    recovered.some((lease) => lease.status !== 'recovered')
  ) {
    throw new Error('invalid workspace-lock WAL lease projection')
  }
  unique(
    [...active, ...recovered].map((lease) => lease.leaseId),
    'lease id'
  )
  if ([...active, ...recovered].some((lease) => !state.leaseIds.includes(lease.leaseId))) {
    throw new Error('workspace-lock WAL lease ids omit a projected lease')
  }
  const projected = [...active, ...recovered].sort(compareLease)
  if (canonicalJson(projected) !== canonicalJson(state.leases.slice().sort(compareLease))) {
    throw new Error('workspace-lock WAL leases are not a valid projection')
  }
  validateMarkers(state.knownMarkers)
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalValue(value))
}

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalValue)
  if (value && typeof value === 'object') {
    const source = value as Record<string, unknown>
    const result: Record<string, unknown> = {}
    for (const key of Object.keys(source).sort()) {
      if (source[key] !== undefined) result[key] = canonicalValue(source[key])
    }
    return result
  }
  return value
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error(`${label} must be an object`)
  return value as Record<string, unknown>
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): void {
  const actual = Object.keys(value).sort()
  const wanted = [...expected].sort()
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    throw new Error('unexpected or missing object property')
  }
}

function opaqueId(value: unknown, label: string): asserts value is string {
  if (!isWorkspaceLockOpaqueId(value)) throw new Error(`invalid ${label}`)
}

function displayText(value: unknown, label: string): asserts value is string {
  if (!isWorkspaceLockOwnerDisplayText(value)) throw new Error(`invalid ${label}`)
}

function pathString(value: unknown, label: string): asserts value is string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > 32_768 ||
    value.includes('\0')
  ) {
    throw new Error(`invalid ${label}`)
  }
}

function identityString(value: unknown, label: string): asserts value is string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > 65_536 ||
    value.includes('\0')
  ) {
    throw new Error(`invalid ${label}`)
  }
}

function isoTimestamp(value: unknown, label: string): asserts value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) {
    throw new Error(`invalid ${label}`)
  }
  const parsed = new Date(value)
  if (!Number.isFinite(parsed.valueOf()) || parsed.toISOString() !== value) {
    throw new Error(`invalid ${label}`)
  }
}

function digest(value: unknown): value is string {
  return typeof value === 'string' && new RegExp(`^[a-f0-9]{${DIGEST_LENGTH}}$`).test(value)
}

function positiveSafeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) > 0
}

function nonNegativeSafeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0
}

function safeGeneration(value: unknown): value is number {
  return nonNegativeSafeInteger(value)
}

function unique(values: readonly string[], label: string): void {
  if (new Set(values).size !== values.length) throw new Error(`duplicate ${label}`)
}

function isKind(value: string): value is WorkspaceLockWalEventKind {
  return (
    value === 'boot' ||
    value === 'prepare' ||
    value === 'acquire' ||
    value === 'release' ||
    value === 'release_run' ||
    value === 'recover' ||
    value === 'cleanup'
  )
}

function cloneLease(lease: WorkspaceLockLease): WorkspaceLockLease {
  return {
    ...lease,
    owner: { ...lease.owner },
    claim: {
      ...lease.claim,
      ...(lease.claim.hunk ? { hunk: { ...lease.claim.hunk } } : {}),
      ...(lease.claim.pathEvidence
        ? {
            pathEvidence: {
              ...lease.claim.pathEvidence,
              targetIdentity:
                lease.claim.pathEvidence.targetIdentity.kind === 'existing'
                  ? {
                      ...lease.claim.pathEvidence.targetIdentity,
                      file: { ...lease.claim.pathEvidence.targetIdentity.file }
                    }
                  : {
                      ...lease.claim.pathEvidence.targetIdentity,
                      existingAncestor: {
                        ...lease.claim.pathEvidence.targetIdentity.existingAncestor
                      }
                    },
              containment: {
                ...lease.claim.pathEvidence.containment,
                rootIdentity: { ...lease.claim.pathEvidence.containment.rootIdentity },
                existingAncestorIdentity: {
                  ...lease.claim.pathEvidence.containment.existingAncestorIdentity
                }
              }
            }
          }
        : {})
    }
  }
}

function compareLease(left: WorkspaceLockLease, right: WorkspaceLockLease): number {
  return left.leaseId.localeCompare(right.leaseId)
}

function markerKey(marker: WorkspaceLockWalMarker): string {
  return `${marker.worktreeIdentity}\u0000${marker.worktreeObjectIdentity}\u0000${marker.markerName}`
}

function corrupt(line: number, reason: string): Error {
  return new Error(`Workspace-lock WAL is corrupt at line ${line}: ${reason}`)
}
