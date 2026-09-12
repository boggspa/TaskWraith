/** Projection of HostProfileDomainStore into HostSnapshot donor families. */

import type { HostSnapshotProjectorInput } from './HostSnapshotProjector'
import { HostProfileDomainStore } from './HostProfileDomainStore'
import { basename } from 'node:path'
import {
  createEmptyHostSnapshot,
  decodeHostSnapshot,
  HOST_PROTOCOL_MAX_COLLECTION,
  HOST_PROTOCOL_MAX_GOAL_CRITERIA,
  HOST_PROTOCOL_MAX_GOAL_OBJECTIVE,
  HOST_PROTOCOL_MAX_SHORT,
  HOST_WARNING_PROJECTION_WINDOWED,
  hostRunFailureReason,
  type HostHealthProjection,
  type HostParticipantProjection,
  type HostProviderModelProjection,
  type HostRoundOutcome,
  type HostRoundProjection,
  type HostRoutingProjection,
  type HostRunProjection,
  type HostThreadGoalProjection,
  type HostUsageObservation,
  type HostWarningProjection
} from '../shared/hostProtocol'
import {
  hostComputeGoalRuntimeTiming,
  type HostGoalRuntimeLedgerFacts
} from '../host-shared/ActiveGoalContract'
import { isEnsembleRoundPresentationLive } from '../shared/ensembleRoundLifecycle'

/**
 * Project the goal the App already wrote onto this record.
 *
 * Read-only by construction: this Host never authors a goal, so the projection
 * can only narrow what the App stored. Everything is bounded because the thread
 * list ships in every snapshot — an unbounded objective on a busy profile would
 * put kilobytes per thread on the wire for a field most threads do not have.
 * A clipped objective is flagged rather than passed off as the whole objective.
 */
function projectThreadGoal(
  value: unknown,
  lastActivityAt: number
): HostThreadGoalProjection | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const record = value as Record<string, unknown>
  const { id, objective, status, mode } = record
  if (typeof id !== 'string' || id.length === 0 || id.length > 512) return undefined
  if (typeof objective !== 'string' || objective.length === 0) return undefined
  if (typeof mode !== 'string' || mode.length === 0 || mode.length > 512) return undefined
  if (
    status !== 'active' &&
    status !== 'paused' &&
    status !== 'blocked' &&
    status !== 'completed'
  ) {
    return undefined
  }

  const goal: HostThreadGoalProjection = {
    id,
    objective: objective.slice(0, HOST_PROTOCOL_MAX_GOAL_OBJECTIVE),
    status,
    mode
  }
  if (objective.length > HOST_PROTOCOL_MAX_GOAL_OBJECTIVE) goal.objectiveTruncated = true
  if (typeof record.blockedReason === 'string' && record.blockedReason.length > 0) {
    goal.blockedReason = record.blockedReason.slice(0, HOST_PROTOCOL_MAX_SHORT)
  }

  const specification = record.specification
  if (specification && typeof specification === 'object' && !Array.isArray(specification)) {
    const criteria = (specification as Record<string, unknown>).acceptanceCriteria
    if (Array.isArray(criteria)) {
      const bounded = criteria
        .filter((entry): entry is string => typeof entry === 'string' && entry.length > 0)
        .slice(0, HOST_PROTOCOL_MAX_GOAL_CRITERIA)
        .map((entry) => entry.slice(0, HOST_PROTOCOL_MAX_SHORT))
      if (bounded.length) goal.acceptanceCriteria = bounded
    }
  }

  const ledger = record.runtimeLedger
  if (ledger && typeof ledger === 'object' && !Array.isArray(ledger)) {
    const facts = ledger as unknown as HostGoalRuntimeLedgerFacts
    if (typeof facts.startedAt === 'string' && Array.isArray(facts.intervals)) {
      // The thread's own last-activity stamp is the ceiling on an open interval:
      // a goal cannot have been working after its thread stopped changing.
      const timing = hostComputeGoalRuntimeTiming(facts, new Date(), {
        ...(Number.isFinite(lastActivityAt) ? { lastActivityAt } : {})
      })
      goal.wallMs = timing.wallMs
      goal.activeMs = timing.activeMs
    }
  }
  return goal
}

export type HostProfileDomainSnapshotFamilies = Omit<
  HostSnapshotProjectorInput,
  'position' | 'recovery'
>

/**
 * Build only donor families. Position and recovery remain Host-runtime owned;
 * this profile store never invents a second cursor/generation journal.
 */
export interface HostProfileDomainProjectionOptions {
  readonly store: HostProfileDomainStore
  /** Lifecycle/supervision truth is owned by the standalone composition. */
  readonly health: HostHealthProjection
  /** Current provider inventory/runtime availability; never infer from chats. */
  readonly providers: readonly HostProviderModelProjection[]
}

function timestamp(value: string | undefined): number | undefined {
  if (!value) return undefined
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined
}

function boundedSelectionId(value: unknown): string | undefined {
  return typeof value === 'string' &&
    value.length > 0 &&
    value.length <= 512 &&
    value.trim() === value &&
    // eslint-disable-next-line no-control-regex -- profile display facts reject C0 controls.
    !/[\u0000-\u001f\u007f]/.test(value)
    ? value
    : undefined
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function records(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value)
    ? value.flatMap((entry) => (record(entry) ? [record(entry)!] : []))
    : []
}

function nonNegativeInteger(value: unknown): number | undefined {
  return Number.isSafeInteger(value) && Number(value) >= 0 ? Number(value) : undefined
}

function stringTimestamp(value: unknown): number | undefined {
  return timestamp(typeof value === 'string' ? value : undefined)
}

function providerOutcome(
  status: string | undefined
): 'running' | 'completed' | 'failed' | 'cancelled' | 'unknown' {
  switch (typeof status === 'string' ? status.toLowerCase() : '') {
    case 'starting':
    case 'pending':
    case 'queued':
    case 'awaiting':
    case 'running':
      return 'running'
    case 'success':
    case 'succeeded':
    case 'completed':
      return 'completed'
    case 'failed':
    case 'error':
      return 'failed'
    case 'cancelled':
    case 'canceled':
      return 'cancelled'
    default:
      return 'unknown'
  }
}

type ProfileThread = ReturnType<HostProfileDomainStore['listThreadSummaries']>[number]
type ProfileRun = NonNullable<ProfileThread['runs']>[number]

function profileRunUsage(run: ProfileRun): HostUsageObservation | undefined {
  const input = run.usage?.inputTokens ?? 0
  const output = run.usage?.outputTokens ?? 0
  const tokens = input + output
  if (!Number.isSafeInteger(tokens) || tokens <= 0) return undefined
  return { availability: 'estimated', tokens, confidence: 'estimated' }
}

function latestProfileRunUsage(
  runs: readonly ProfileRun[] | undefined
): HostUsageObservation | undefined {
  let latest: { at: number; usage: HostUsageObservation } | undefined
  for (const run of runs ?? []) {
    const usage = profileRunUsage(run)
    if (!usage) continue
    const endedAt = timestamp(run.endedAt)
    const startedAt = timestamp(run.startedAt)
    const at = endedAt ?? startedAt ?? 0
    if (!latest || at >= latest.at) latest = { at, usage }
  }
  return latest?.usage
}

/**
 * Leave headroom below the public per-family cap for future live-source joins.
 * This is a working-set projection, not retention: complete run history remains
 * in the profile record and its history surfaces.
 */
export const HOST_PROFILE_RUN_PROJECTION_LIMIT = Math.min(1_800, HOST_PROTOCOL_MAX_COLLECTION - 1)
export const HOST_PROFILE_ROUND_PROJECTION_LIMIT = Math.min(1_800, HOST_PROTOCOL_MAX_COLLECTION - 1)

interface ProfileRunProjectionCandidate {
  readonly key: string
  readonly row: HostRunProjection
  readonly active: boolean
  readonly recency: number
}

function runIsActive(run: ProfileRun): boolean {
  const status = typeof run.status === 'string' ? run.status.toLowerCase() : ''
  if (
    ['completed', 'success', 'succeeded', 'failed', 'error', 'cancelled', 'canceled'].includes(
      status
    )
  ) {
    return false
  }
  // Match HostProfileDomainStore's fail-closed legacy rule: an unknown or
  // status-less row is possibly live unless a terminal timestamp proves not.
  return timestamp(run.endedAt) === undefined
}

function projectProfileRuns(
  threads: readonly Pick<ProfileThread, 'appChatId' | 'provider' | 'updatedAt' | 'runs'>[],
  totalCount?: number,
  complete = true
): {
  runs: HostRunProjection[]
  warning?: HostWarningProjection
} {
  const candidates = threads.flatMap((thread) =>
    (thread.runs ?? []).map((run, index): ProfileRunProjectionCandidate => {
      const startedAt = timestamp(run.startedAt)
      const endedAt = timestamp(run.endedAt)
      // The reason a run failed is recorded on the row but used to stop here,
      // so every client could only ever render a bare `provider:failed` — the
      // "fails with nothing evidently wrong" report. Compose it once, with the
      // shared rule that yields undefined (never '') when there is nothing to
      // say, so an empty summary list stays ABSENT rather than projecting a
      // blank reason a client would render as a dangling separator.
      const failureReason =
        providerOutcome(run.status) === 'failed'
          ? hostRunFailureReason(run.warningSummaries)
          : undefined
      return {
        key: `${thread.appChatId.length}:${thread.appChatId}:${run.runId.length}:${run.runId}:${index}`,
        row: {
          runId: run.runId,
          threadId: thread.appChatId,
          providerId: run.provider ?? thread.provider ?? 'unknown',
          providerOutcome: providerOutcome(run.status),
          ...(startedAt !== undefined ? { startedAt } : {}),
          ...(endedAt !== undefined ? { endedAt } : {}),
          ...(run.requestedModel ? { modelId: run.requestedModel } : {}),
          ...(run.errorCode ? { errorCode: run.errorCode } : {}),
          ...(failureReason ? { failureReason } : {}),
          ...(profileRunUsage(run) ? { usage: profileRunUsage(run) } : {})
        },
        active: runIsActive(run),
        recency: endedAt ?? startedAt ?? thread.updatedAt
      }
    })
  )
  if (complete && (totalCount ?? candidates.length) <= HOST_PROFILE_RUN_PROJECTION_LIMIT) {
    return { runs: candidates.map((candidate) => candidate.row) }
  }

  const ranked = [...candidates].sort((left, right) => {
    if (left.active !== right.active) return left.active ? -1 : 1
    if (left.recency !== right.recency) return right.recency - left.recency
    return left.key.localeCompare(right.key)
  })
  const selected = new Set(
    ranked.slice(0, HOST_PROFILE_RUN_PROJECTION_LIMIT).map((candidate) => candidate.key)
  )
  const runs = candidates
    .filter((candidate) => selected.has(candidate.key))
    .map((candidate) => candidate.row)
  const warningAt = candidates.reduce((latest, candidate) => Math.max(latest, candidate.recency), 0)
  return {
    runs,
    warning: {
      warningId: `${HOST_WARNING_PROJECTION_WINDOWED}:runs`,
      severity: 'warning',
      code: HOST_WARNING_PROJECTION_WINDOWED,
      message:
        `family runs ${complete ? 'intentionally windowed' : 'still loading'} from ${totalCount ?? candidates.length} to ` +
        `${HOST_PROFILE_RUN_PROJECTION_LIMIT}; possibly-live rows precede recent terminal rows`,
      at: warningAt
    }
  }
}

const PROFILE_ROW_VALIDATION_SNAPSHOT = createEmptyHostSnapshot({
  generation: 0,
  cursor: 0
})

interface ProfileRoundProjectionCandidate {
  readonly row: HostRoundProjection
  readonly participantStatusById: ReadonlyMap<string, string>
  readonly activeParticipantId?: string
  readonly recency: number
}

function profileRoundStatus(
  thread: ProfileThread,
  activeRound: Record<string, unknown>
): HostRoundOutcome {
  const raw = String(activeRound.status ?? '').toLowerCase()
  if (raw === 'completed' || raw === 'success' || raw === 'succeeded') return 'completed'
  if (raw === 'cancelled' || raw === 'canceled') return 'cancelled'
  if (raw === 'failed' || raw === 'error') return 'failed'
  if (raw !== 'running' && raw !== 'active') return 'unknown'

  // Catalogue summaries carry a presentation status computed from the FULL
  // record before chrome is bounded. That is the Host's liveness witness for
  // this donor: a persisted `status: running` row alone can be restart residue.
  const cataloguePresentation = record(thread.cataloguePresentation)
  const live =
    thread.catalogueProjection === true
      ? cataloguePresentation?.status === 'running'
      : isEnsembleRoundPresentationLive(
          activeRound as unknown as Parameters<typeof isEnsembleRoundPresentationLive>[0]
        )
  // Loss of a liveness witness is not terminal evidence. Recovery may later
  // publish a concrete interrupted/failed/cancelled outcome; until then the
  // Host must keep this explicitly unresolved instead of manufacturing a
  // successful completion from absence.
  return live ? 'running' : 'unknown'
}

function roundRouting(
  ensemble: Record<string, unknown>,
  activeRound: Record<string, unknown>,
  status: HostRoundOutcome
): HostRoutingProjection | undefined {
  const rawMode = boundedSelectionId(activeRound.orchestrationMode ?? ensemble.orchestrationMode)
  const mode = rawMode === 'turn_bound' ? 'continuous' : rawMode
  const fanout = boundedSelectionId(activeRound.fanoutPolicy ?? ensemble.fanoutPolicy)
  if (!mode || !fanout) return undefined
  const activeParticipantId =
    status === 'running' ? boundedSelectionId(activeRound.activeParticipantId) : undefined
  const continuationHops = nonNegativeInteger(activeRound.continuationHops ?? activeRound.hops)
  const maxContinuationHops = nonNegativeInteger(
    activeRound.maxContinuationHops ?? ensemble.maxContinuationHops
  )
  const bossParticipantId = boundedSelectionId(
    activeRound.bossmanParticipantId ?? ensemble.bossmanParticipantId
  )
  const activeRoundCaptainIds = Array.isArray(activeRound.captainParticipantIds)
    ? activeRound.captainParticipantIds
    : []
  const ensembleCaptainIds = Array.isArray(ensemble.captainParticipantIds)
    ? ensemble.captainParticipantIds
    : []
  const captainParticipantId = boundedSelectionId(
    activeRoundCaptainIds[0] ??
      ensembleCaptainIds[0] ??
      activeRound.secondInCommandParticipantId ??
      ensemble.secondInCommandParticipantId
  )
  return {
    mode,
    fanout,
    ...(activeParticipantId ? { activeParticipantId } : {}),
    ...(continuationHops !== undefined ? { continuationHops } : {}),
    ...(maxContinuationHops !== undefined ? { maxContinuationHops } : {}),
    ...(bossParticipantId ? { bossParticipantId } : {}),
    ...(captainParticipantId ? { captainParticipantId } : {})
  }
}

function projectThreadRound(
  thread: ProfileThread,
  runs: readonly ProfileRun[]
): ProfileRoundProjectionCandidate | null {
  if (thread.chatKind !== 'ensemble') return null
  const ensemble = record(thread.ensemble)
  const activeRound = record(ensemble?.activeRound)
  if (!ensemble || !activeRound) return null
  const roundId = boundedSelectionId(activeRound.roundId ?? activeRound.id)
  if (!roundId) return null
  const status = profileRoundStatus(thread, activeRound)
  const roundParticipants = records(activeRound.participants)
  const configuredParticipants = records(ensemble.participants)
  const participantIds: string[] = []
  const participantStatusById = new Map<string, string>()
  const providerRunIds = new Set<string>()
  const seenParticipants = new Set<string>()
  for (const participant of roundParticipants) {
    const participantId = boundedSelectionId(participant.participantId ?? participant.id)
    if (!participantId || seenParticipants.has(participantId)) continue
    seenParticipants.add(participantId)
    participantIds.push(participantId)
    const participantStatus =
      typeof participant.status === 'string'
        ? participant.status.trim().slice(0, HOST_PROTOCOL_MAX_SHORT) || undefined
        : undefined
    if (participantStatus) participantStatusById.set(participantId, participantStatus)
    const runId = boundedSelectionId(participant.runId)
    if (runId) providerRunIds.add(runId)
  }
  if (participantIds.length === 0) {
    for (const participant of configuredParticipants) {
      const participantId = boundedSelectionId(participant.id)
      if (!participantId || seenParticipants.has(participantId)) continue
      seenParticipants.add(participantId)
      participantIds.push(participantId)
    }
  }
  for (const run of runs) {
    const raw = run as unknown as Record<string, unknown>
    if (boundedSelectionId(raw.ensembleRoundId) !== roundId) continue
    const runId = boundedSelectionId(run.runId)
    if (runId) providerRunIds.add(runId)
  }
  const startedAt = stringTimestamp(activeRound.startedAt)
  const endedAt = stringTimestamp(activeRound.endedAt ?? activeRound.completedAt)
  const routing = roundRouting(ensemble, activeRound, status)
  const candidate: HostRoundProjection = {
    roundId,
    threadId: thread.appChatId,
    status,
    participantIds,
    providerRunIds: [...providerRunIds].sort(),
    ...(startedAt !== undefined ? { startedAt } : {}),
    ...(endedAt !== undefined ? { endedAt } : {}),
    ...(routing ? { routing } : {})
  }
  const decoded = decodeHostSnapshot({
    ...PROFILE_ROW_VALIDATION_SNAPSHOT,
    rounds: [candidate]
  })
  const row = decoded.ok ? decoded.value.rounds[0] : undefined
  if (!row) return null
  const activeParticipantId =
    row.status === 'running' ? boundedSelectionId(activeRound.activeParticipantId) : undefined
  return {
    row,
    participantStatusById,
    ...(activeParticipantId ? { activeParticipantId } : {}),
    recency: endedAt ?? startedAt ?? thread.updatedAt
  }
}

function projectProfileRounds(
  threads: readonly ProfileThread[],
  runsByThread: ReadonlyMap<string, readonly ProfileRun[]>
): {
  rounds: HostRoundProjection[]
  byThreadId: ReadonlyMap<string, ProfileRoundProjectionCandidate>
  includedThreadIds: ReadonlySet<string>
  warning?: HostWarningProjection
} {
  const candidates = threads.flatMap((thread) => {
    const candidate = projectThreadRound(
      thread,
      runsByThread.get(thread.appChatId) ?? thread.runs ?? []
    )
    return candidate ? [candidate] : []
  })
  const byThreadId = new Map(candidates.map((candidate) => [candidate.row.threadId, candidate]))
  if (candidates.length <= HOST_PROFILE_ROUND_PROJECTION_LIMIT) {
    return {
      rounds: candidates.map((candidate) => candidate.row),
      byThreadId,
      includedThreadIds: new Set(candidates.map((candidate) => candidate.row.threadId))
    }
  }
  const selected = [...candidates]
    .sort((left, right) => {
      const leftLive = left.row.status === 'running'
      const rightLive = right.row.status === 'running'
      if (leftLive !== rightLive) return leftLive ? -1 : 1
      if (left.recency !== right.recency) return right.recency - left.recency
      return left.row.roundId.localeCompare(right.row.roundId)
    })
    .slice(0, HOST_PROFILE_ROUND_PROJECTION_LIMIT)
  const warningAt = candidates.reduce((latest, candidate) => Math.max(latest, candidate.recency), 0)
  return {
    rounds: selected.map((candidate) => candidate.row),
    byThreadId,
    includedThreadIds: new Set(selected.map((candidate) => candidate.row.threadId)),
    warning: {
      warningId: `${HOST_WARNING_PROJECTION_WINDOWED}:rounds`,
      severity: 'warning',
      code: HOST_WARNING_PROJECTION_WINDOWED,
      message:
        `family rounds intentionally windowed from ${candidates.length} to ` +
        `${HOST_PROFILE_ROUND_PROJECTION_LIMIT}; live rows precede recent terminal rows`,
      at: warningAt
    }
  }
}

function decodeParticipantCandidate(
  thread: ProfileThread,
  value: unknown,
  activeParticipantId: unknown,
  roundStatus?: string,
  hasRound = false
): HostParticipantProjection | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const participant = value as Record<string, unknown>
  const hasModelId = Object.prototype.hasOwnProperty.call(participant, 'modelId')
  const hasModel = Object.prototype.hasOwnProperty.call(participant, 'model')
  const candidate = {
    id: participant.id,
    threadId: thread.appChatId,
    providerId: participant.provider,
    role: participant.role,
    ...(hasModelId
      ? { modelId: participant.modelId }
      : hasModel
        ? { modelId: participant.model }
        : {}),
    ...(Object.prototype.hasOwnProperty.call(participant, 'reasoningEffort')
      ? { reasoningEffort: participant.reasoningEffort }
      : {}),
    ...(Object.prototype.hasOwnProperty.call(participant, 'thinkingEnabled')
      ? { thinkingEnabled: participant.thinkingEnabled }
      : {}),
    ...(Object.prototype.hasOwnProperty.call(participant, 'permissionPresetId')
      ? { permissionPresetId: participant.permissionPresetId }
      : {}),
    ...(Object.prototype.hasOwnProperty.call(participant, 'stageRole')
      ? { stage: participant.stageRole }
      : Object.prototype.hasOwnProperty.call(participant, 'stage')
        ? { stage: participant.stage }
        : {}),
    order: participant.order,
    enabled: participant.enabled,
    ...(roundStatus
      ? { status: roundStatus }
      : Object.prototype.hasOwnProperty.call(participant, 'status')
        ? { status: participant.status }
        : {}),
    active: hasRound ? participant.id === activeParticipantId : participant.active === true
  }
  const decoded = decodeHostSnapshot({
    ...PROFILE_ROW_VALIDATION_SNAPSHOT,
    participants: [candidate]
  })
  return decoded.ok ? (decoded.value.participants[0] ?? null) : null
}

interface ProjectedThreadParticipants {
  readonly participants: HostParticipantProjection[]
  readonly omitted: number
  readonly warningAt: number
}

function projectThreadParticipants(
  thread: ProfileThread,
  round?: ProfileRoundProjectionCandidate
): ProjectedThreadParticipants {
  if (thread.chatKind !== 'ensemble') {
    return { participants: [], omitted: 0, warningAt: 0 }
  }
  const ensemble = thread.ensemble
  if (!ensemble || typeof ensemble !== 'object' || Array.isArray(ensemble)) {
    return { participants: [], omitted: 0, warningAt: 0 }
  }
  const record = ensemble as Record<string, unknown>
  if (!Array.isArray(record.participants)) {
    return { participants: [], omitted: 0, warningAt: 0 }
  }
  const activeParticipantId = round?.activeParticipantId
  const seen = new Set<string>()
  const participants: HostParticipantProjection[] = []
  let omitted = 0

  for (const value of record.participants) {
    const participantRecord = value as Record<string, unknown>
    const participantId = boundedSelectionId(participantRecord?.id)
    const participant = decodeParticipantCandidate(
      thread,
      value,
      activeParticipantId,
      participantId ? round?.participantStatusById.get(participantId) : undefined,
      round !== undefined
    )
    if (!participant || seen.has(participant.id)) {
      omitted += 1
      continue
    }
    seen.add(participant.id)
    participants.push(participant)
  }
  return {
    participants,
    omitted,
    warningAt: omitted > 0 ? thread.updatedAt : 0
  }
}

export function projectHostProfileDomainSnapshot(
  options: HostProfileDomainProjectionOptions
): HostProfileDomainSnapshotFamilies {
  const { store, health, providers } = options
  const workspaces = store.listWorkspaces().map((workspace) => ({
    id: workspace.id,
    name: (workspace.displayName ?? basename(workspace.path)) || 'Workspace',
    path: workspace.realPath,
    pinned: workspace.pinned,
    updatedAt: workspace.updatedAt
  }))
  const threads = store.listThreadSummaries()
  const runWindow = store.listRunSummaries()
  const threadById = new Map(threads.map((thread) => [thread.appChatId, thread]))
  const sourceRunEntries = runWindow
    ? runWindow.entries
    : threads.flatMap((thread) =>
        (thread.runs ?? []).map((run) => ({ chatId: thread.appChatId, run }))
      )
  const runsByThread = new Map<string, ProfileRun[]>()
  for (const { chatId, run } of sourceRunEntries) {
    const rows = runsByThread.get(chatId) ?? []
    rows.push(run)
    runsByThread.set(chatId, rows)
  }
  const roundProjection = projectProfileRounds(threads, runsByThread)
  const participantProjections = threads.map((thread) =>
    projectThreadParticipants(thread, roundProjection.byThreadId.get(thread.appChatId))
  )
  const participants = participantProjections.flatMap((projection) => projection.participants)
  const omittedParticipants = participantProjections.reduce(
    (count, projection) => count + projection.omitted,
    0
  )
  const participantWarningAt = participantProjections.reduce(
    (latest, projection) => Math.max(latest, projection.warningAt),
    0
  )
  const warnings: HostWarningProjection[] =
    omittedParticipants === 0
      ? []
      : [
          {
            warningId: 'projection_rows_omitted:participants',
            severity: 'warning',
            code: 'projection_rows_omitted',
            message: `family participants omitted ${omittedParticipants} decoder-invalid row${
              omittedParticipants === 1 ? '' : 's'
            }`,
            at: participantWarningAt
          }
        ]
  if (roundProjection.warning) warnings.push(roundProjection.warning)
  const runProjection = runWindow
    ? projectProfileRuns(
        sourceRunEntries.flatMap(({ chatId, run }) => {
          const thread = threadById.get(chatId)
          return thread
            ? [
                {
                  appChatId: chatId,
                  provider: thread.provider,
                  updatedAt: thread.updatedAt,
                  runs: [run]
                }
              ]
            : []
        }),
        runWindow.total,
        runWindow.complete
      )
    : projectProfileRuns(threads)
  if (runProjection.warning) warnings.push(runProjection.warning)
  return {
    health,
    workspaces,
    threads: threads.map((thread) => {
      const goal = projectThreadGoal(thread.activeGoal, thread.updatedAt)
      const metadata =
        thread.providerMetadata && typeof thread.providerMetadata === 'object'
          ? (thread.providerMetadata as Record<string, unknown>)
          : {}
      const modelId = boundedSelectionId(metadata.selectedModelType)
      const reasoningEffort = boundedSelectionId(metadata.reasoningEffort)
      const rawPermission = boundedSelectionId(metadata.permissionPresetId)
      const storedPermission =
        rawPermission &&
        ['read_only', 'plan', 'default', 'workspace_write', 'full_access'].includes(rawPermission)
          ? rawPermission
          : undefined
      const permissionPresetId =
        thread.workflowMode === 'plan' && storedPermission === 'read_only'
          ? 'plan'
          : storedPermission
      const usage = latestProfileRunUsage(thread.runs)
      const activeRoundId =
        roundProjection.includedThreadIds.has(thread.appChatId) &&
        roundProjection.byThreadId.get(thread.appChatId)?.row.status === 'running'
          ? roundProjection.byThreadId.get(thread.appChatId)?.row.roundId
          : undefined
      return {
        id: thread.appChatId,
        workspaceId: thread.scope === 'workspace' ? (thread.workspaceId ?? null) : null,
        title: thread.title,
        chatKind: thread.chatKind === 'ensemble' ? 'ensemble' : 'single',
        archived: thread.archived,
        pinned: thread.pinned === true,
        updatedAt: thread.updatedAt,
        messageCount: thread.messageCount,
        ...(thread.latestPreview ? { latestPreview: thread.latestPreview } : {}),
        ...(thread.provider ? { providerId: thread.provider } : {}),
        ...(modelId ? { modelId } : {}),
        ...(reasoningEffort ? { reasoningEffort } : {}),
        ...(permissionPresetId ? { permissionPresetId } : {}),
        ...(usage ? { usage } : {}),
        ...(goal ? { goal } : {}),
        ...(activeRoundId ? { activeRoundId } : {})
      }
    }),
    runs: runProjection.runs,
    missions: [],
    rounds: roundProjection.rounds,
    participants,
    providers: [...providers],
    questions: [],
    approvals: [],
    schedules: [],
    usage: { availability: 'unavailable', confidence: 'unknown', band: 'unknown' },
    artifacts: [],
    warnings
  }
}
