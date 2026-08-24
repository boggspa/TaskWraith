/**
 * Pure HostSnapshot projector (Host Arc Wave 2B Subwave 4B).
 *
 * Maps an explicit, fully populated compact input DTO into a bounded HostSnapshot.
 * Shared hostProtocol imports only — no AppStore, RemoteThreadProjection, Electron,
 * or control-protocol reads. A later adapter supplies donor-projected DTOs; this
 * module never reconstructs generation/cursor or fabricates missing families.
 */

import {
  assertHostSnapshotFamilies,
  encodeHostParticipantEntityId,
  HOST_PROTOCOL_MAX_CHANNEL_MEMBERS,
  HOST_PROTOCOL_MAX_COLLECTION,
  HOST_PROTOCOL_MAX_ID,
  HOST_PROTOCOL_MAX_SHORT,
  HOST_PROTOCOL_MAX_STRING,
  HOST_PROTOCOL_MAX_TRANSCRIPT_PREVIEW,
  HOST_PROTOCOL_MAX_WARNING,
  HOST_PROTOCOL_VERSION,
  HOST_PROJECTION_VERSION,
  type HostApprovalProjection,
  type HostArtifactProjection,
  type HostChannelMemberProjection,
  type HostChannelProjection,
  type HostDecodeResult,
  type HostHealthProjection,
  type HostMissionProjection,
  type HostMissionOutcome,
  type HostParticipantProjection,
  type HostProjectionFreshness,
  type HostProviderModelProjection,
  type HostProviderTerminalOutcome,
  type HostQuestionProjection,
  type HostRecoveryProjection,
  type HostRoundOutcome,
  type HostRoundProjection,
  type HostRoutingProjection,
  type HostRunProjection,
  type HostScheduleProjection,
  type HostSnapshot,
  type HostThreadProjection,
  type HostUsageObservation,
  type HostWarningProjection,
  type HostWaveProjection,
  type HostWorkspaceProjection
} from '../shared/hostProtocol'

/** HostDeltaStore-derived position + explicit freshness injected by the adapter. */
export interface HostSnapshotProjectorPosition {
  generation: number
  cursor: number
  freshness: HostProjectionFreshness
  generatedAt: string
}

/**
 * Compact donor input for every required snapshot family.
 * Arrays may exceed wire caps; the projector truncates deterministically and
 * emits `projection_truncated` warnings. Missing families are hard errors.
 */
export interface HostSnapshotProjectorInput {
  position: HostSnapshotProjectorPosition
  health: HostHealthProjection
  workspaces: HostWorkspaceProjection[]
  threads: HostThreadProjection[]
  runs: HostRunProjection[]
  missions: HostMissionProjection[]
  rounds: HostRoundProjection[]
  participants: HostParticipantProjection[]
  providers: HostProviderModelProjection[]
  routing?: HostRoutingProjection
  questions: HostQuestionProjection[]
  approvals: HostApprovalProjection[]
  schedules: HostScheduleProjection[]
  channels?: HostChannelProjection[]
  usage: HostUsageObservation
  artifacts: HostArtifactProjection[]
  warnings: HostWarningProjection[]
  recovery: HostRecoveryProjection
}

export type HostSnapshotProjectorResult = HostDecodeResult<HostSnapshot>

const REQUIRED_ARRAY_FAMILIES = [
  'workspaces',
  'threads',
  'runs',
  'missions',
  'rounds',
  'participants',
  'providers',
  'questions',
  'approvals',
  'schedules',
  'artifacts',
  'warnings'
] as const

type RequiredArrayFamily = (typeof REQUIRED_ARRAY_FAMILIES)[number]

/** Forbidden wire keys (case-insensitive) that must never appear on the snapshot. */
const PRIVACY_KEY_SENTINELS = [
  'password',
  'passwd',
  'secret',
  'secrets',
  'apitoken',
  'api_token',
  'apikey',
  'api_key',
  'authorization',
  'auth_token',
  'authtoken',
  'credential',
  'credentials',
  'privatekey',
  'private_key',
  'accesstoken',
  'access_token',
  'refreshtoken',
  'refresh_token',
  'sessiontoken',
  'session_token',
  'bearertoken',
  'bearer_token',
  'clientsecret',
  'client_secret',
  'hiddenreasoning',
  'hidden_reasoning',
  'rawreasoning',
  'raw_reasoning',
  'thinkingtrace',
  'thinking_trace',
  'tooloutput',
  'tool_output',
  'toolargs',
  'tool_args',
  'toolarguments',
  'tool_arguments',
  'diffbody',
  'diff_body',
  'patchbody',
  'patch_body',
  'unifieddiff',
  'unified_diff',
  'fulldiff',
  'full_diff',
  'transcriptbody',
  'transcript_body',
  'fulltranscript',
  'full_transcript',
  'messagebody',
  'message_body',
  'fullmessage',
  'full_message',
  'filecontent',
  'file_content',
  'filecontents',
  'file_contents',
  'rawbytes',
  'raw_bytes',
  'artifactbytes',
  'artifact_bytes',
  'contentbytes',
  'content_bytes'
] as const

const PRIVACY_KEY_SET = new Set<string>(PRIVACY_KEY_SENTINELS)

/** Value substrings that indicate credential-like material in presentation fields. */
const PRIVACY_VALUE_SENTINELS = [
  '-----BEGIN PRIVATE KEY-----',
  '-----BEGIN RSA PRIVATE KEY-----',
  '-----BEGIN OPENSSH PRIVATE KEY-----',
  'sk-ant-',
  'sk-proj-',
  'xoxb-',
  'ghp_',
  'gho_',
  'github_pat_'
] as const

const PROVIDER_OUTCOMES = new Set<string>([
  'running',
  'completed',
  'failed',
  'cancelled',
  'requires_action',
  'unknown'
])

const ROUND_OUTCOMES = new Set<string>(['running', 'completed', 'cancelled', 'failed', 'unknown'])

const MISSION_OUTCOMES = new Set<string>([
  'active',
  'completed',
  'blocked',
  'cancelled',
  'failed',
  'unknown'
])

const CONNECTION_PHASES = new Set<string>([
  'connecting',
  'live',
  'reconnecting',
  'offline',
  'stale-cache',
  'incompatible-protocol',
  'host-unavailable'
])

const FRESHNESS = new Set<string>(['live', 'cached', 'stale'])

const HOST_STATUSES = new Set<string>(['ok', 'degraded', 'recovering', 'offline'])

const REOPEN_STATUSES = new Set<string>(['clean', 'recovered', 'degraded', 'unknown'])

const USAGE_AVAILABILITY = new Set<string>(['available', 'unavailable', 'estimated'])

const QUESTION_STATUSES = new Set<string>(['open', 'answered', 'dismissed', 'expired'])

const APPROVAL_STATUSES = new Set<string>(['pending', 'approved', 'denied', 'expired', 'cancelled'])

const WARNING_SEVERITIES = new Set<string>(['info', 'warning', 'error'])

const DECISION_SOURCES = new Set<string>(['user', 'system'])

const CHAT_KINDS = new Set<string>(['single', 'ensemble'])

const PARTICIPANT_STAGES = new Set<string>(['scout', 'worker', 'reviewer', 'background', 'any'])

const USAGE_CONFIDENCE = new Set<string>(['exact', 'derived', 'estimated', 'unknown'])

const USAGE_BAND = new Set<string>(['low', 'medium', 'high', 'critical', 'unknown'])

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function isNonNegativeInt(value: unknown): value is number {
  return (
    typeof value === 'number' && Number.isInteger(value) && value >= 0 && Number.isFinite(value)
  )
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

function isValidId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= HOST_PROTOCOL_MAX_ID
}

function isOptionalId(value: unknown): value is string | undefined {
  return value === undefined || isValidId(value)
}

function fail(error: string): HostSnapshotProjectorResult {
  return { ok: false, error }
}

function normalizeKey(key: string): string {
  return key.replace(/[^a-zA-Z0-9_]/g, '').toLowerCase()
}

function containsPrivacyValue(value: string): boolean {
  for (const sentinel of PRIVACY_VALUE_SENTINELS) {
    if (value.includes(sentinel)) return true
  }
  return false
}

/**
 * Reject any object tree that carries privacy-sensitive keys or credential-like values.
 * Walks arrays and plain objects; does not mutate the input.
 */
function assertPrivacyClean(value: unknown, path: string): HostDecodeResult<true> {
  if (typeof value === 'string') {
    if (containsPrivacyValue(value)) {
      return { ok: false, error: `privacy value sentinel at ${path}` }
    }
    return { ok: true, value: true }
  }
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i += 1) {
      const nested = assertPrivacyClean(value[i], `${path}[${i}]`)
      if (!nested.ok) return nested
    }
    return { ok: true, value: true }
  }
  if (!isRecord(value)) {
    return { ok: true, value: true }
  }
  for (const [key, child] of Object.entries(value)) {
    const normalized = normalizeKey(key)
    if (PRIVACY_KEY_SET.has(normalized)) {
      return { ok: false, error: `privacy key sentinel "${key}" at ${path}` }
    }
    const nested = assertPrivacyClean(child, `${path}.${key}`)
    if (!nested.ok) return nested
  }
  return { ok: true, value: true }
}

function truncatePresentation(value: string, max: number): { text: string; truncated: boolean } {
  if (value.length <= max) {
    return { text: value, truncated: false }
  }
  if (max <= 1) {
    return { text: '…', truncated: true }
  }
  return { text: `${value.slice(0, max - 1)}…`, truncated: true }
}

function requireArrayFamily(
  input: HostSnapshotProjectorInput,
  family: RequiredArrayFamily
): HostDecodeResult<unknown[]> {
  const value = input[family]
  if (value === undefined || value === null) {
    return { ok: false, error: `missing projection family: ${family}` }
  }
  if (!Array.isArray(value)) {
    return { ok: false, error: `projection family ${family} must be an array` }
  }
  return { ok: true, value }
}

function stableSortById<T>(items: T[], idOf: (item: T) => string): T[] {
  return [...items].sort((a, b) => {
    const left = idOf(a)
    const right = idOf(b)
    if (left < right) return -1
    if (left > right) return 1
    return 0
  })
}

function capCollection<T>(
  family: string,
  items: T[],
  warnings: HostWarningProjection[],
  at: number
): T[] {
  if (items.length <= HOST_PROTOCOL_MAX_COLLECTION) {
    return items
  }
  const kept = items.slice(0, HOST_PROTOCOL_MAX_COLLECTION)
  const dropped = items.length - HOST_PROTOCOL_MAX_COLLECTION
  warnings.push({
    warningId: `projection_truncated:${family}`,
    severity: 'warning',
    code: 'projection_truncated',
    message: truncatePresentation(
      `family ${family} truncated from ${items.length} to ${HOST_PROTOCOL_MAX_COLLECTION} (dropped ${dropped})`,
      HOST_PROTOCOL_MAX_WARNING
    ).text,
    at
  })
  return kept
}

function projectUsage(
  usage: HostUsageObservation,
  label: string
): HostDecodeResult<HostUsageObservation> {
  if (!isRecord(usage as unknown)) {
    return { ok: false, error: `${label} must be an object` }
  }
  if (typeof usage.availability !== 'string' || !USAGE_AVAILABILITY.has(usage.availability)) {
    return { ok: false, error: `${label}.availability is invalid` }
  }
  if (usage.confidence !== undefined && !USAGE_CONFIDENCE.has(usage.confidence)) {
    return { ok: false, error: `${label}.confidence is invalid` }
  }
  if (usage.band !== undefined && !USAGE_BAND.has(usage.band)) {
    return { ok: false, error: `${label}.band is invalid` }
  }

  const out: HostUsageObservation = { availability: usage.availability }

  if (usage.availability === 'unavailable') {
    // Never publish tokens/cost as zero — omit numeric fields entirely.
    if (usage.tokens !== undefined || usage.costText !== undefined) {
      // Strip rather than reject: donor may still carry stale zeros.
      // Structural validation later rejects unavailable+tokens:0 if reintroduced.
    }
    if (usage.confidence !== undefined) out.confidence = usage.confidence
    if (usage.band !== undefined) out.band = usage.band
    return { ok: true, value: out }
  }

  if (usage.tokens !== undefined) {
    if (!isNonNegativeInt(usage.tokens)) {
      return { ok: false, error: `${label}.tokens must be a non-negative integer` }
    }
    out.tokens = usage.tokens
  }
  if (usage.costText !== undefined) {
    if (typeof usage.costText !== 'string' || usage.costText.length === 0) {
      return { ok: false, error: `${label}.costText is invalid` }
    }
    if (containsPrivacyValue(usage.costText)) {
      return { ok: false, error: `privacy value sentinel at ${label}.costText` }
    }
    out.costText = truncatePresentation(usage.costText, HOST_PROTOCOL_MAX_SHORT).text
  }
  if (usage.confidence !== undefined) out.confidence = usage.confidence
  if (usage.band !== undefined) out.band = usage.band
  return { ok: true, value: out }
}

function projectHealth(
  health: HostHealthProjection,
  freshness: HostProjectionFreshness
): HostDecodeResult<HostHealthProjection> {
  if (!isRecord(health as unknown)) {
    return { ok: false, error: 'missing projection family: health' }
  }
  if (typeof health.hostStatus !== 'string' || !HOST_STATUSES.has(health.hostStatus)) {
    return { ok: false, error: 'health.hostStatus is invalid' }
  }
  if (
    typeof health.connectionPhase !== 'string' ||
    !CONNECTION_PHASES.has(health.connectionPhase)
  ) {
    return { ok: false, error: 'health.connectionPhase is invalid' }
  }
  if (typeof health.supervised !== 'boolean') {
    return { ok: false, error: 'health.supervised must be boolean' }
  }
  // Prefer explicit snapshot freshness; health.freshness must stay coherent.
  const healthFreshness =
    typeof health.freshness === 'string' && FRESHNESS.has(health.freshness)
      ? health.freshness
      : freshness
  const out: HostHealthProjection = {
    hostStatus: health.hostStatus,
    connectionPhase: health.connectionPhase,
    supervised: health.supervised,
    freshness: healthFreshness
  }
  if (health.detail !== undefined) {
    if (typeof health.detail !== 'string' || health.detail.length === 0) {
      return { ok: false, error: 'health.detail is invalid' }
    }
    out.detail = truncatePresentation(health.detail, HOST_PROTOCOL_MAX_WARNING).text
  }
  return { ok: true, value: out }
}

function projectRecovery(
  recovery: HostRecoveryProjection
): HostDecodeResult<HostRecoveryProjection> {
  if (!isRecord(recovery as unknown)) {
    return { ok: false, error: 'missing projection family: recovery' }
  }
  if (typeof recovery.reopenStatus !== 'string' || !REOPEN_STATUSES.has(recovery.reopenStatus)) {
    return { ok: false, error: 'recovery.reopenStatus is invalid' }
  }
  const out: HostRecoveryProjection = { reopenStatus: recovery.reopenStatus }
  if (recovery.lastCheckpointAt !== undefined) {
    if (!isNonNegativeInt(recovery.lastCheckpointAt)) {
      return { ok: false, error: 'recovery.lastCheckpointAt is invalid' }
    }
    out.lastCheckpointAt = recovery.lastCheckpointAt
  }
  if (recovery.lastGeneration !== undefined) {
    if (!isNonNegativeInt(recovery.lastGeneration)) {
      return { ok: false, error: 'recovery.lastGeneration is invalid' }
    }
    out.lastGeneration = recovery.lastGeneration
  }
  if (recovery.lastCursor !== undefined) {
    if (!isNonNegativeInt(recovery.lastCursor)) {
      return { ok: false, error: 'recovery.lastCursor is invalid' }
    }
    out.lastCursor = recovery.lastCursor
  }
  if (recovery.detail !== undefined) {
    if (typeof recovery.detail !== 'string' || recovery.detail.length === 0) {
      return { ok: false, error: 'recovery.detail is invalid' }
    }
    out.detail = truncatePresentation(recovery.detail, HOST_PROTOCOL_MAX_WARNING).text
  }
  return { ok: true, value: out }
}

function projectRouting(
  routing: HostRoutingProjection | undefined,
  label: string
): HostDecodeResult<HostRoutingProjection | undefined> {
  if (routing === undefined) return { ok: true, value: undefined }
  if (!isRecord(routing as unknown)) {
    return { ok: false, error: `${label} must be an object when present` }
  }
  if (typeof routing.mode !== 'string' || routing.mode.length === 0) {
    return { ok: false, error: `${label}.mode is required` }
  }
  if (typeof routing.fanout !== 'string' || routing.fanout.length === 0) {
    return { ok: false, error: `${label}.fanout is required` }
  }
  if (!isOptionalId(routing.activeParticipantId)) {
    return { ok: false, error: `${label}.activeParticipantId is invalid` }
  }
  if (!isOptionalId(routing.bossParticipantId)) {
    return { ok: false, error: `${label}.bossParticipantId is invalid` }
  }
  if (!isOptionalId(routing.captainParticipantId)) {
    return { ok: false, error: `${label}.captainParticipantId is invalid` }
  }
  if (routing.continuationHops !== undefined && !isNonNegativeInt(routing.continuationHops)) {
    return { ok: false, error: `${label}.continuationHops is invalid` }
  }
  if (routing.maxContinuationHops !== undefined && !isNonNegativeInt(routing.maxContinuationHops)) {
    return { ok: false, error: `${label}.maxContinuationHops is invalid` }
  }
  const out: HostRoutingProjection = {
    mode: truncatePresentation(routing.mode, HOST_PROTOCOL_MAX_SHORT).text,
    fanout: truncatePresentation(routing.fanout, HOST_PROTOCOL_MAX_SHORT).text
  }
  if (routing.activeParticipantId !== undefined) {
    out.activeParticipantId = routing.activeParticipantId
  }
  if (routing.continuationHops !== undefined) out.continuationHops = routing.continuationHops
  if (routing.maxContinuationHops !== undefined) {
    out.maxContinuationHops = routing.maxContinuationHops
  }
  if (routing.bossParticipantId !== undefined) out.bossParticipantId = routing.bossParticipantId
  if (routing.captainParticipantId !== undefined) {
    out.captainParticipantId = routing.captainParticipantId
  }
  return { ok: true, value: out }
}

function projectWorkspace(
  raw: HostWorkspaceProjection,
  index: number
): HostDecodeResult<HostWorkspaceProjection> {
  const label = `workspaces[${index}]`
  if (!isValidId(raw.id)) return { ok: false, error: `${label}.id is invalid` }
  if (typeof raw.name !== 'string' || raw.name.length === 0) {
    return { ok: false, error: `${label}.name is required` }
  }
  if (typeof raw.path !== 'string' || raw.path.length === 0) {
    return { ok: false, error: `${label}.path is required` }
  }
  if (typeof raw.pinned !== 'boolean') {
    return { ok: false, error: `${label}.pinned must be boolean` }
  }
  if (!isNonNegativeInt(raw.updatedAt)) {
    return { ok: false, error: `${label}.updatedAt is invalid` }
  }
  return {
    ok: true,
    value: {
      id: raw.id,
      name: truncatePresentation(raw.name, HOST_PROTOCOL_MAX_SHORT).text,
      path: truncatePresentation(raw.path, HOST_PROTOCOL_MAX_STRING).text,
      pinned: raw.pinned,
      updatedAt: raw.updatedAt
    }
  }
}

function projectThread(
  raw: HostThreadProjection,
  index: number
): HostDecodeResult<HostThreadProjection> {
  const label = `threads[${index}]`
  if (!isValidId(raw.id)) return { ok: false, error: `${label}.id is invalid` }
  if (raw.workspaceId !== null && !isValidId(raw.workspaceId)) {
    return { ok: false, error: `${label}.workspaceId is invalid` }
  }
  if (!isOptionalId(raw.parentThreadId)) {
    return { ok: false, error: `${label}.parentThreadId is invalid` }
  }
  if (typeof raw.title !== 'string' || raw.title.length === 0) {
    return { ok: false, error: `${label}.title is required` }
  }
  if (typeof raw.chatKind !== 'string' || !CHAT_KINDS.has(raw.chatKind)) {
    return { ok: false, error: `${label}.chatKind is invalid` }
  }
  if (typeof raw.archived !== 'boolean' || typeof raw.pinned !== 'boolean') {
    return { ok: false, error: `${label}.archived/pinned must be boolean` }
  }
  if (!isNonNegativeInt(raw.updatedAt) || !isNonNegativeInt(raw.messageCount)) {
    return { ok: false, error: `${label}.updatedAt/messageCount is invalid` }
  }
  if (!isOptionalId(raw.providerId)) {
    return { ok: false, error: `${label}.providerId is invalid` }
  }
  if (
    raw.missionOutcome !== undefined &&
    (typeof raw.missionOutcome !== 'string' || !MISSION_OUTCOMES.has(raw.missionOutcome))
  ) {
    return { ok: false, error: `${label}.missionOutcome is invalid` }
  }
  if (!isOptionalId(raw.activeRoundId)) {
    return { ok: false, error: `${label}.activeRoundId is invalid` }
  }

  const out: HostThreadProjection = {
    id: raw.id,
    workspaceId: raw.workspaceId,
    title: truncatePresentation(raw.title, HOST_PROTOCOL_MAX_SHORT).text,
    chatKind: raw.chatKind,
    archived: raw.archived,
    pinned: raw.pinned,
    updatedAt: raw.updatedAt,
    messageCount: raw.messageCount
  }
  if (raw.parentThreadId !== undefined) out.parentThreadId = raw.parentThreadId
  if (raw.providerId !== undefined) out.providerId = raw.providerId
  if (raw.missionOutcome !== undefined) {
    out.missionOutcome = raw.missionOutcome as HostMissionOutcome
  }
  if (raw.activeRoundId !== undefined) out.activeRoundId = raw.activeRoundId

  if (raw.latestPreview !== undefined) {
    if (typeof raw.latestPreview !== 'string') {
      return { ok: false, error: `${label}.latestPreview must be a string` }
    }
    const preview = truncatePresentation(raw.latestPreview, HOST_PROTOCOL_MAX_TRANSCRIPT_PREVIEW)
    out.latestPreview = preview.text
    out.previewTruncated = preview.truncated || raw.previewTruncated === true
  } else if (raw.previewTruncated === true) {
    out.previewTruncated = true
  }

  if (raw.usage !== undefined) {
    const usage = projectUsage(raw.usage, `${label}.usage`)
    if (!usage.ok) return usage
    out.usage = usage.value
  }

  return { ok: true, value: out }
}

function projectRun(raw: HostRunProjection, index: number): HostDecodeResult<HostRunProjection> {
  const label = `runs[${index}]`
  if (!isValidId(raw.runId)) return { ok: false, error: `${label}.runId is invalid` }
  if (!isValidId(raw.threadId)) return { ok: false, error: `${label}.threadId is invalid` }
  if (!isValidId(raw.providerId)) return { ok: false, error: `${label}.providerId is invalid` }
  if (typeof raw.providerOutcome !== 'string' || !PROVIDER_OUTCOMES.has(raw.providerOutcome)) {
    return { ok: false, error: `${label}.providerOutcome is invalid` }
  }
  if (raw.startedAt !== undefined && !isNonNegativeInt(raw.startedAt)) {
    return { ok: false, error: `${label}.startedAt is invalid` }
  }
  if (raw.endedAt !== undefined && !isNonNegativeInt(raw.endedAt)) {
    return { ok: false, error: `${label}.endedAt is invalid` }
  }
  if (!isOptionalId(raw.modelId)) {
    return { ok: false, error: `${label}.modelId is invalid` }
  }
  const out: HostRunProjection = {
    runId: raw.runId,
    threadId: raw.threadId,
    providerId: raw.providerId,
    providerOutcome: raw.providerOutcome as HostProviderTerminalOutcome
  }
  if (raw.startedAt !== undefined) out.startedAt = raw.startedAt
  if (raw.endedAt !== undefined) out.endedAt = raw.endedAt
  if (raw.modelId !== undefined) out.modelId = raw.modelId
  if (raw.usage !== undefined) {
    const usage = projectUsage(raw.usage, `${label}.usage`)
    if (!usage.ok) return usage
    out.usage = usage.value
  }
  return { ok: true, value: out }
}

function projectMission(
  raw: HostMissionProjection,
  index: number
): HostDecodeResult<HostMissionProjection> {
  const label = `missions[${index}]`
  if (!isValidId(raw.missionId)) return { ok: false, error: `${label}.missionId is invalid` }
  if (!isOptionalId(raw.threadId)) return { ok: false, error: `${label}.threadId is invalid` }
  if (typeof raw.title !== 'string' || raw.title.length === 0) {
    return { ok: false, error: `${label}.title is required` }
  }
  if (typeof raw.status !== 'string' || !MISSION_OUTCOMES.has(raw.status)) {
    return { ok: false, error: `${label}.status is invalid` }
  }
  if (!isOptionalId(raw.goalId)) return { ok: false, error: `${label}.goalId is invalid` }
  if (!isNonNegativeInt(raw.updatedAt)) {
    return { ok: false, error: `${label}.updatedAt is invalid` }
  }
  if (!isOptionalId(raw.activeRoundId)) {
    return { ok: false, error: `${label}.activeRoundId is invalid` }
  }
  const out: HostMissionProjection = {
    missionId: raw.missionId,
    title: truncatePresentation(raw.title, HOST_PROTOCOL_MAX_SHORT).text,
    status: raw.status as HostMissionOutcome,
    updatedAt: raw.updatedAt
  }
  if (raw.threadId !== undefined) out.threadId = raw.threadId
  if (raw.goalId !== undefined) out.goalId = raw.goalId
  if (raw.activeRoundId !== undefined) out.activeRoundId = raw.activeRoundId
  return { ok: true, value: out }
}

function projectWave(
  raw: HostWaveProjection,
  index: number,
  parentLabel: string
): HostDecodeResult<HostWaveProjection> {
  const label = `${parentLabel}.waves[${index}]`
  if (!isValidId(raw.waveId)) return { ok: false, error: `${label}.waveId is invalid` }
  if (typeof raw.status !== 'string' || raw.status.length === 0) {
    return { ok: false, error: `${label}.status is required` }
  }
  if (!Array.isArray(raw.participantIds)) {
    return { ok: false, error: `${label}.participantIds must be an array` }
  }
  const participantIds: string[] = []
  for (let i = 0; i < raw.participantIds.length; i += 1) {
    const id = raw.participantIds[i]
    if (!isValidId(id)) {
      return { ok: false, error: `${label}.participantIds[${i}] is invalid` }
    }
    participantIds.push(id)
  }
  const cappedIds = participantIds.slice(0, HOST_PROTOCOL_MAX_COLLECTION)
  const out: HostWaveProjection = {
    waveId: raw.waveId,
    status: truncatePresentation(raw.status, HOST_PROTOCOL_MAX_SHORT).text,
    participantIds: cappedIds
  }
  if (raw.label !== undefined) {
    if (typeof raw.label !== 'string' || raw.label.length === 0) {
      return { ok: false, error: `${label}.label is invalid` }
    }
    out.label = truncatePresentation(raw.label, HOST_PROTOCOL_MAX_SHORT).text
  }
  return { ok: true, value: out }
}

function projectRound(
  raw: HostRoundProjection,
  index: number
): HostDecodeResult<HostRoundProjection> {
  const label = `rounds[${index}]`
  if (!isValidId(raw.roundId)) return { ok: false, error: `${label}.roundId is invalid` }
  if (!isValidId(raw.threadId)) return { ok: false, error: `${label}.threadId is invalid` }
  if (typeof raw.status !== 'string' || !ROUND_OUTCOMES.has(raw.status)) {
    return { ok: false, error: `${label}.status is invalid` }
  }
  if (raw.startedAt !== undefined && !isNonNegativeInt(raw.startedAt)) {
    return { ok: false, error: `${label}.startedAt is invalid` }
  }
  if (raw.endedAt !== undefined && !isNonNegativeInt(raw.endedAt)) {
    return { ok: false, error: `${label}.endedAt is invalid` }
  }
  if (!Array.isArray(raw.participantIds)) {
    return { ok: false, error: `${label}.participantIds must be an array` }
  }
  if (!Array.isArray(raw.providerRunIds)) {
    return { ok: false, error: `${label}.providerRunIds must be an array` }
  }
  const participantIds: string[] = []
  for (let i = 0; i < raw.participantIds.length; i += 1) {
    const id = raw.participantIds[i]
    if (!isValidId(id)) {
      return { ok: false, error: `${label}.participantIds[${i}] is invalid` }
    }
    participantIds.push(id)
  }
  const providerRunIds: string[] = []
  for (let i = 0; i < raw.providerRunIds.length; i += 1) {
    const id = raw.providerRunIds[i]
    if (!isValidId(id)) {
      return { ok: false, error: `${label}.providerRunIds[${i}] is invalid` }
    }
    providerRunIds.push(id)
  }

  const out: HostRoundProjection = {
    roundId: raw.roundId,
    threadId: raw.threadId,
    status: raw.status as HostRoundOutcome,
    participantIds: participantIds.slice(0, HOST_PROTOCOL_MAX_COLLECTION),
    providerRunIds: providerRunIds.slice(0, HOST_PROTOCOL_MAX_COLLECTION)
  }
  if (raw.startedAt !== undefined) out.startedAt = raw.startedAt
  if (raw.endedAt !== undefined) out.endedAt = raw.endedAt

  if (raw.routing !== undefined) {
    const routing = projectRouting(raw.routing, `${label}.routing`)
    if (!routing.ok) return routing
    if (routing.value) out.routing = routing.value
  }

  if (raw.waves !== undefined) {
    if (!Array.isArray(raw.waves)) {
      return { ok: false, error: `${label}.waves must be an array` }
    }
    const waves: HostWaveProjection[] = []
    const limit = Math.min(raw.waves.length, HOST_PROTOCOL_MAX_COLLECTION)
    for (let i = 0; i < limit; i += 1) {
      const wave = projectWave(raw.waves[i]!, i, label)
      if (!wave.ok) return wave
      waves.push(wave.value)
    }
    out.waves = stableSortById(waves, (w) => w.waveId)
  }

  return { ok: true, value: out }
}

function projectParticipant(
  raw: HostParticipantProjection,
  index: number
): HostDecodeResult<HostParticipantProjection> {
  const label = `participants[${index}]`
  if (!isValidId(raw.id)) return { ok: false, error: `${label}.id is invalid` }
  if (!isValidId(raw.threadId)) return { ok: false, error: `${label}.threadId is invalid` }
  const entityId = encodeHostParticipantEntityId(raw.threadId, raw.id)
  if (!entityId.ok) return { ok: false, error: `${label} identity is invalid: ${entityId.error}` }
  if (!isValidId(raw.providerId)) return { ok: false, error: `${label}.providerId is invalid` }
  if (typeof raw.role !== 'string' || raw.role.length === 0) {
    return { ok: false, error: `${label}.role is required` }
  }
  if (!isOptionalId(raw.modelId)) return { ok: false, error: `${label}.modelId is invalid` }
  if (raw.stage !== undefined && !PARTICIPANT_STAGES.has(raw.stage)) {
    return { ok: false, error: `${label}.stage is invalid` }
  }
  if (!isFiniteNumber(raw.order) || !Number.isInteger(raw.order)) {
    return { ok: false, error: `${label}.order is invalid` }
  }
  if (typeof raw.enabled !== 'boolean' || typeof raw.active !== 'boolean') {
    return { ok: false, error: `${label}.enabled/active must be boolean` }
  }
  const out: HostParticipantProjection = {
    id: raw.id,
    threadId: raw.threadId,
    providerId: raw.providerId,
    role: truncatePresentation(raw.role, HOST_PROTOCOL_MAX_SHORT).text,
    order: raw.order,
    enabled: raw.enabled,
    active: raw.active
  }
  if (raw.modelId !== undefined) out.modelId = raw.modelId
  if (raw.stage !== undefined) out.stage = raw.stage
  if (raw.status !== undefined) {
    if (typeof raw.status !== 'string' || raw.status.length === 0) {
      return { ok: false, error: `${label}.status is invalid` }
    }
    out.status = truncatePresentation(raw.status, HOST_PROTOCOL_MAX_SHORT).text
  }
  return { ok: true, value: out }
}

function projectProvider(
  raw: HostProviderModelProjection,
  index: number
): HostDecodeResult<HostProviderModelProjection> {
  const label = `providers[${index}]`
  if (!isValidId(raw.providerId)) return { ok: false, error: `${label}.providerId is invalid` }
  if (typeof raw.displayProvider !== 'string' || raw.displayProvider.length === 0) {
    return { ok: false, error: `${label}.displayProvider is required` }
  }
  if (typeof raw.shortCode !== 'string' || raw.shortCode.length === 0) {
    return { ok: false, error: `${label}.shortCode is required` }
  }
  if (typeof raw.available !== 'boolean') {
    return { ok: false, error: `${label}.available must be boolean` }
  }
  if (!isOptionalId(raw.modelId)) return { ok: false, error: `${label}.modelId is invalid` }
  if (!isOptionalId(raw.hueKey)) return { ok: false, error: `${label}.hueKey is invalid` }
  const out: HostProviderModelProjection = {
    providerId: raw.providerId,
    displayProvider: truncatePresentation(raw.displayProvider, HOST_PROTOCOL_MAX_SHORT).text,
    shortCode: truncatePresentation(raw.shortCode, HOST_PROTOCOL_MAX_SHORT).text,
    available: raw.available
  }
  if (raw.modelId !== undefined) out.modelId = raw.modelId
  if (raw.modelLabel !== undefined) {
    if (typeof raw.modelLabel !== 'string' || raw.modelLabel.length === 0) {
      return { ok: false, error: `${label}.modelLabel is invalid` }
    }
    out.modelLabel = truncatePresentation(raw.modelLabel, HOST_PROTOCOL_MAX_SHORT).text
  }
  if (raw.hueKey !== undefined) out.hueKey = raw.hueKey
  if (raw.note !== undefined) {
    if (typeof raw.note !== 'string' || raw.note.length === 0) {
      return { ok: false, error: `${label}.note is invalid` }
    }
    out.note = truncatePresentation(raw.note, HOST_PROTOCOL_MAX_WARNING).text
  }
  return { ok: true, value: out }
}

function projectQuestion(
  raw: HostQuestionProjection,
  index: number
): HostDecodeResult<HostQuestionProjection> {
  const label = `questions[${index}]`
  if (!isValidId(raw.questionId)) return { ok: false, error: `${label}.questionId is invalid` }
  if (!isValidId(raw.threadId)) return { ok: false, error: `${label}.threadId is invalid` }
  if (typeof raw.status !== 'string' || !QUESTION_STATUSES.has(raw.status)) {
    return { ok: false, error: `${label}.status is invalid` }
  }
  if (typeof raw.promptPreview !== 'string' || raw.promptPreview.length === 0) {
    return { ok: false, error: `${label}.promptPreview is required` }
  }
  if (!isNonNegativeInt(raw.askedAt)) {
    return { ok: false, error: `${label}.askedAt is invalid` }
  }
  if (raw.answeredAt !== undefined && !isNonNegativeInt(raw.answeredAt)) {
    return { ok: false, error: `${label}.answeredAt is invalid` }
  }
  if (!isOptionalId(raw.receiptId)) {
    return { ok: false, error: `${label}.receiptId is invalid` }
  }
  const out: HostQuestionProjection = {
    questionId: raw.questionId,
    threadId: raw.threadId,
    status: raw.status,
    promptPreview: truncatePresentation(raw.promptPreview, HOST_PROTOCOL_MAX_TRANSCRIPT_PREVIEW)
      .text,
    askedAt: raw.askedAt
  }
  if (raw.answeredAt !== undefined) out.answeredAt = raw.answeredAt
  if (raw.receiptId !== undefined) out.receiptId = raw.receiptId
  return { ok: true, value: out }
}

function projectApproval(
  raw: HostApprovalProjection,
  index: number
): HostDecodeResult<HostApprovalProjection> {
  const label = `approvals[${index}]`
  if (!isValidId(raw.approvalId)) return { ok: false, error: `${label}.approvalId is invalid` }
  if (!isOptionalId(raw.threadId)) return { ok: false, error: `${label}.threadId is invalid` }
  if (typeof raw.status !== 'string' || !APPROVAL_STATUSES.has(raw.status)) {
    return { ok: false, error: `${label}.status is invalid` }
  }
  if (!isValidId(raw.commandId)) return { ok: false, error: `${label}.commandId is invalid` }
  if (typeof raw.actionKind !== 'string' || raw.actionKind.length === 0) {
    return { ok: false, error: `${label}.actionKind is required` }
  }
  if (!isNonNegativeInt(raw.createdAt)) {
    return { ok: false, error: `${label}.createdAt is invalid` }
  }
  if (raw.decidedAt !== undefined && !isNonNegativeInt(raw.decidedAt)) {
    return { ok: false, error: `${label}.decidedAt is invalid` }
  }
  if (
    raw.decisionSource !== undefined &&
    (typeof raw.decisionSource !== 'string' || !DECISION_SOURCES.has(raw.decisionSource))
  ) {
    return { ok: false, error: `${label}.decisionSource is invalid` }
  }
  if (typeof raw.summary !== 'string' || raw.summary.length === 0) {
    return { ok: false, error: `${label}.summary is required` }
  }
  const out: HostApprovalProjection = {
    approvalId: raw.approvalId,
    // SECOND ALLOWLIST REBUILD (the wire decoder is the other). Both must
    // learn a new field or it dies before any client sees it.
    commandId: raw.commandId,
    status: raw.status,
    actionKind: truncatePresentation(raw.actionKind, HOST_PROTOCOL_MAX_SHORT).text,
    createdAt: raw.createdAt,
    summary: truncatePresentation(raw.summary, HOST_PROTOCOL_MAX_WARNING).text
  }
  if (raw.threadId !== undefined) out.threadId = raw.threadId
  if (raw.decidedAt !== undefined) out.decidedAt = raw.decidedAt
  if (raw.decisionSource !== undefined) out.decisionSource = raw.decisionSource
  return { ok: true, value: out }
}

function projectSchedule(
  raw: HostScheduleProjection,
  index: number
): HostDecodeResult<HostScheduleProjection> {
  const label = `schedules[${index}]`
  if (!isValidId(raw.scheduleId)) return { ok: false, error: `${label}.scheduleId is invalid` }
  if (typeof raw.title !== 'string' || raw.title.length === 0) {
    return { ok: false, error: `${label}.title is required` }
  }
  if (typeof raw.enabled !== 'boolean') {
    return { ok: false, error: `${label}.enabled must be boolean` }
  }
  if (raw.nextFireAt !== undefined && !isNonNegativeInt(raw.nextFireAt)) {
    return { ok: false, error: `${label}.nextFireAt is invalid` }
  }
  if (!isOptionalId(raw.threadId)) return { ok: false, error: `${label}.threadId is invalid` }
  const out: HostScheduleProjection = {
    scheduleId: raw.scheduleId,
    title: truncatePresentation(raw.title, HOST_PROTOCOL_MAX_SHORT).text,
    enabled: raw.enabled
  }
  if (raw.nextFireAt !== undefined) out.nextFireAt = raw.nextFireAt
  if (raw.threadId !== undefined) out.threadId = raw.threadId
  return { ok: true, value: out }
}

function projectChannelMember(
  raw: HostChannelMemberProjection,
  channelIndex: number,
  memberIndex: number
): HostDecodeResult<HostChannelMemberProjection> {
  const label = `channels[${channelIndex}].members[${memberIndex}]`
  if (!isValidId(raw.memberId)) return { ok: false, error: `${label}.memberId is invalid` }
  if (raw.kind !== 'human' && raw.kind !== 'agent') {
    return { ok: false, error: `${label}.kind is invalid` }
  }
  if (typeof raw.displayName !== 'string' || raw.displayName.length === 0) {
    return { ok: false, error: `${label}.displayName is required` }
  }
  if (raw.status !== 'pending' && raw.status !== 'active') {
    return { ok: false, error: `${label}.status is invalid` }
  }
  return {
    ok: true,
    value: {
      memberId: raw.memberId,
      kind: raw.kind,
      displayName: truncatePresentation(raw.displayName, HOST_PROTOCOL_MAX_SHORT).text,
      status: raw.status
    }
  }
}

function projectChannel(
  raw: HostChannelProjection,
  index: number
): HostDecodeResult<HostChannelProjection> {
  const label = `channels[${index}]`
  if (!isValidId(raw.channelId)) return { ok: false, error: `${label}.channelId is invalid` }
  if (!isValidId(raw.threadId)) return { ok: false, error: `${label}.threadId is invalid` }
  if (!isValidId(raw.ownerMemberId)) {
    return { ok: false, error: `${label}.ownerMemberId is invalid` }
  }
  if (typeof raw.title !== 'string' || raw.title.length === 0) {
    return { ok: false, error: `${label}.title is required` }
  }
  if (raw.status !== 'active' && raw.status !== 'closed') {
    return { ok: false, error: `${label}.status is invalid` }
  }
  if (raw.availability !== 'ready' && raw.availability !== 'recovery_blocked') {
    return { ok: false, error: `${label}.availability is invalid` }
  }
  for (const field of ['membershipRevision', 'memberCount', 'messageCount', 'updatedAt'] as const) {
    if (!isNonNegativeInt(raw[field])) {
      return { ok: false, error: `${label}.${field} is invalid` }
    }
  }
  if (raw.pendingAdmissionCount !== undefined && !isNonNegativeInt(raw.pendingAdmissionCount)) {
    return { ok: false, error: `${label}.pendingAdmissionCount is invalid` }
  }
  if (raw.pendingHumanReviewCount !== undefined && !isNonNegativeInt(raw.pendingHumanReviewCount)) {
    return { ok: false, error: `${label}.pendingHumanReviewCount is invalid` }
  }

  let members: HostChannelMemberProjection[] | undefined
  if (raw.members !== undefined) {
    if (!Array.isArray(raw.members)) {
      return { ok: false, error: `${label}.members must be an array` }
    }
    if (raw.members.length > HOST_PROTOCOL_MAX_CHANNEL_MEMBERS) {
      return { ok: false, error: `${label}.members exceeds compact bound` }
    }
    members = []
    for (let memberIndex = 0; memberIndex < raw.members.length; memberIndex += 1) {
      const member = projectChannelMember(raw.members[memberIndex]!, index, memberIndex)
      if (!member.ok) return member
      members.push(member.value)
    }
    members = stableSortById(members, (member) => member.memberId)
  }

  const out: HostChannelProjection = {
    channelId: raw.channelId,
    threadId: raw.threadId,
    ownerMemberId: raw.ownerMemberId,
    title: truncatePresentation(raw.title, HOST_PROTOCOL_MAX_SHORT).text,
    status: raw.status,
    availability: raw.availability,
    membershipRevision: raw.membershipRevision,
    memberCount: raw.memberCount,
    messageCount: raw.messageCount,
    updatedAt: raw.updatedAt
  }
  if (members !== undefined) out.members = members
  if (raw.pendingAdmissionCount !== undefined) {
    out.pendingAdmissionCount = raw.pendingAdmissionCount
  }
  if (raw.pendingHumanReviewCount !== undefined) {
    out.pendingHumanReviewCount = raw.pendingHumanReviewCount
  }
  return { ok: true, value: out }
}

function projectArtifact(
  raw: HostArtifactProjection,
  index: number
): HostDecodeResult<HostArtifactProjection> {
  const label = `artifacts[${index}]`
  if (!isValidId(raw.artifactId)) return { ok: false, error: `${label}.artifactId is invalid` }
  if (typeof raw.kind !== 'string' || raw.kind.length === 0) {
    return { ok: false, error: `${label}.kind is required` }
  }
  if (!isOptionalId(raw.threadId)) return { ok: false, error: `${label}.threadId is invalid` }
  if (typeof raw.title !== 'string' || raw.title.length === 0) {
    return { ok: false, error: `${label}.title is required` }
  }
  if (!isNonNegativeInt(raw.createdAt)) {
    return { ok: false, error: `${label}.createdAt is invalid` }
  }
  if (raw.byteLength !== undefined && !isNonNegativeInt(raw.byteLength)) {
    return { ok: false, error: `${label}.byteLength is invalid` }
  }
  if (raw.sha256 !== undefined) {
    if (typeof raw.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(raw.sha256)) {
      return { ok: false, error: `${label}.sha256 is invalid` }
    }
  }
  // Defense in depth: never project body bytes even if a donor smuggles them.
  const smuggled = raw as HostArtifactProjection & { bytes?: unknown; content?: unknown }
  if (smuggled.bytes !== undefined || smuggled.content !== undefined) {
    return { ok: false, error: `${label} must not include artifact body content` }
  }
  const out: HostArtifactProjection = {
    artifactId: raw.artifactId,
    kind: truncatePresentation(raw.kind, HOST_PROTOCOL_MAX_SHORT).text,
    title: truncatePresentation(raw.title, HOST_PROTOCOL_MAX_SHORT).text,
    createdAt: raw.createdAt
  }
  if (raw.threadId !== undefined) out.threadId = raw.threadId
  if (raw.byteLength !== undefined) out.byteLength = raw.byteLength
  if (raw.sha256 !== undefined) out.sha256 = raw.sha256
  return { ok: true, value: out }
}

function projectWarning(
  raw: HostWarningProjection,
  index: number
): HostDecodeResult<HostWarningProjection> {
  const label = `warnings[${index}]`
  if (!isValidId(raw.warningId)) return { ok: false, error: `${label}.warningId is invalid` }
  if (typeof raw.severity !== 'string' || !WARNING_SEVERITIES.has(raw.severity)) {
    return { ok: false, error: `${label}.severity is invalid` }
  }
  if (typeof raw.code !== 'string' || raw.code.length === 0) {
    return { ok: false, error: `${label}.code is required` }
  }
  if (typeof raw.message !== 'string' || raw.message.length === 0) {
    return { ok: false, error: `${label}.message is required` }
  }
  if (!isNonNegativeInt(raw.at)) {
    return { ok: false, error: `${label}.at is invalid` }
  }
  if (!isOptionalId(raw.threadId)) return { ok: false, error: `${label}.threadId is invalid` }
  const out: HostWarningProjection = {
    warningId: raw.warningId,
    severity: raw.severity,
    code: truncatePresentation(raw.code, HOST_PROTOCOL_MAX_SHORT).text,
    message: truncatePresentation(raw.message, HOST_PROTOCOL_MAX_WARNING).text,
    at: raw.at
  }
  if (raw.threadId !== undefined) out.threadId = raw.threadId
  return { ok: true, value: out }
}

function projectArrayFamily<TIn, TOut>(
  items: TIn[],
  family: string,
  projectOne: (item: TIn, index: number) => HostDecodeResult<TOut>,
  idOf: (item: TOut) => string,
  truncationWarnings: HostWarningProjection[],
  at: number
): HostDecodeResult<TOut[]> {
  const projected: TOut[] = []
  for (let i = 0; i < items.length; i += 1) {
    const one = projectOne(items[i]!, i)
    if (!one.ok) return one
    projected.push(one.value)
  }
  const sorted = stableSortById(projected, idOf)
  return { ok: true, value: capCollection(family, sorted, truncationWarnings, at) }
}

/**
 * Project a fully populated compact input DTO into a HostSnapshot.
 *
 * - Requires every snapshot family (missing ⇒ error; never fabricate empty).
 * - Preserves injected generation/cursor/freshness exactly.
 * - Caps each collection at HOST_PROTOCOL_MAX_COLLECTION with deterministic order
 *   and explicit `projection_truncated` warnings.
 * - Rejects invalid identifiers; truncates presentation text only.
 * - Strips unavailable usage tokens/cost; never publishes zero as unavailable.
 * - Privacy reject on forbidden keys/values; wire surface is typed fields only.
 */
export function projectHostSnapshot(
  input: HostSnapshotProjectorInput
): HostSnapshotProjectorResult {
  if (!isRecord(input as unknown)) {
    return fail('snapshot projector input must be an object')
  }

  const privacy = assertPrivacyClean(input, 'input')
  if (!privacy.ok) return privacy

  const position = input.position
  if (!isRecord(position as unknown)) {
    return fail('position is required')
  }
  if (!isNonNegativeInt(position.generation) || !isNonNegativeInt(position.cursor)) {
    return fail('position.generation/cursor invalid')
  }
  if (typeof position.freshness !== 'string' || !FRESHNESS.has(position.freshness)) {
    return fail('position.freshness is invalid')
  }
  if (typeof position.generatedAt !== 'string' || position.generatedAt.length === 0) {
    return fail('position.generatedAt is required')
  }
  if (position.generatedAt.length > HOST_PROTOCOL_MAX_SHORT) {
    return fail('position.generatedAt exceeds short bound')
  }

  if (input.health === undefined || input.health === null) {
    return fail('missing projection family: health')
  }
  if (input.usage === undefined || input.usage === null) {
    return fail('missing projection family: usage')
  }
  if (input.recovery === undefined || input.recovery === null) {
    return fail('missing projection family: recovery')
  }

  for (const family of REQUIRED_ARRAY_FAMILIES) {
    const arr = requireArrayFamily(input, family)
    if (!arr.ok) return arr
  }

  const truncationWarnings: HostWarningProjection[] = []
  // Stable synthetic timestamp for projector-emitted truncation warnings.
  const warningAt = Date.parse(position.generatedAt)
  const at = Number.isFinite(warningAt) ? Math.max(0, Math.floor(warningAt)) : 0

  const health = projectHealth(input.health, position.freshness)
  if (!health.ok) return health

  const usage = projectUsage(input.usage, 'usage')
  if (!usage.ok) return usage

  const recovery = projectRecovery(input.recovery)
  if (!recovery.ok) return recovery

  const workspaces = projectArrayFamily(
    input.workspaces,
    'workspaces',
    projectWorkspace,
    (w) => w.id,
    truncationWarnings,
    at
  )
  if (!workspaces.ok) return workspaces

  const threads = projectArrayFamily(
    input.threads,
    'threads',
    projectThread,
    (t) => t.id,
    truncationWarnings,
    at
  )
  if (!threads.ok) return threads

  const runs = projectArrayFamily(
    input.runs,
    'runs',
    projectRun,
    (r) => r.runId,
    truncationWarnings,
    at
  )
  if (!runs.ok) return runs

  const missions = projectArrayFamily(
    input.missions,
    'missions',
    projectMission,
    (m) => m.missionId,
    truncationWarnings,
    at
  )
  if (!missions.ok) return missions

  const rounds = projectArrayFamily(
    input.rounds,
    'rounds',
    projectRound,
    (r) => r.roundId,
    truncationWarnings,
    at
  )
  if (!rounds.ok) return rounds

  const participants = projectArrayFamily(
    input.participants,
    'participants',
    projectParticipant,
    (p) => {
      const identity = encodeHostParticipantEntityId(p.threadId, p.id)
      return identity.ok ? identity.value : p.id
    },
    truncationWarnings,
    at
  )
  if (!participants.ok) return participants

  const providers = projectArrayFamily(
    input.providers,
    'providers',
    projectProvider,
    (p) => `${p.providerId}\0${p.modelId ?? ''}`,
    truncationWarnings,
    at
  )
  if (!providers.ok) return providers

  const questions = projectArrayFamily(
    input.questions,
    'questions',
    projectQuestion,
    (q) => q.questionId,
    truncationWarnings,
    at
  )
  if (!questions.ok) return questions

  const approvals = projectArrayFamily(
    input.approvals,
    'approvals',
    projectApproval,
    (a) => a.approvalId,
    truncationWarnings,
    at
  )
  if (!approvals.ok) return approvals

  const schedules = projectArrayFamily(
    input.schedules,
    'schedules',
    projectSchedule,
    (s) => s.scheduleId,
    truncationWarnings,
    at
  )
  if (!schedules.ok) return schedules

  let channels: HostChannelProjection[] | undefined
  if (input.channels !== undefined) {
    const projectedChannels = projectArrayFamily(
      input.channels,
      'channels',
      projectChannel,
      (channel) => channel.channelId,
      truncationWarnings,
      at
    )
    if (!projectedChannels.ok) return projectedChannels
    channels = projectedChannels.value
  }

  const artifacts = projectArrayFamily(
    input.artifacts,
    'artifacts',
    projectArtifact,
    (a) => a.artifactId,
    truncationWarnings,
    at
  )
  if (!artifacts.ok) return artifacts

  const donorWarnings = projectArrayFamily(
    input.warnings,
    'warnings',
    projectWarning,
    (w) => w.warningId,
    truncationWarnings,
    at
  )
  if (!donorWarnings.ok) return donorWarnings

  // Merge donor warnings + projector truncation warnings; re-cap after merge.
  const mergedWarnings = stableSortById(
    [...donorWarnings.value, ...truncationWarnings],
    (w) => w.warningId
  )
  const finalWarnings =
    mergedWarnings.length <= HOST_PROTOCOL_MAX_COLLECTION
      ? mergedWarnings
      : mergedWarnings.slice(0, HOST_PROTOCOL_MAX_COLLECTION)

  const routing = projectRouting(input.routing, 'routing')
  if (!routing.ok) return routing

  const snapshot: HostSnapshot = {
    protocolVersion: HOST_PROTOCOL_VERSION,
    projectionVersion: HOST_PROJECTION_VERSION,
    generatedAt: position.generatedAt,
    generation: position.generation,
    cursor: position.cursor,
    freshness: position.freshness,
    health: health.value,
    workspaces: workspaces.value,
    threads: threads.value,
    runs: runs.value,
    missions: missions.value,
    rounds: rounds.value,
    participants: participants.value,
    providers: providers.value,
    questions: questions.value,
    approvals: approvals.value,
    schedules: schedules.value,
    usage: usage.value,
    artifacts: artifacts.value,
    warnings: finalWarnings,
    recovery: recovery.value
  }
  if (routing.value !== undefined) {
    snapshot.routing = routing.value
  }
  if (channels !== undefined) {
    snapshot.channels = channels
  }

  // Final structural contract + soft zero usage rule.
  const families = assertHostSnapshotFamilies(snapshot)
  if (!families.ok) return families

  // Defense in depth: ensure no privacy keys leaked onto the wire object.
  const wirePrivacy = assertPrivacyClean(snapshot, 'snapshot')
  if (!wirePrivacy.ok) return wirePrivacy

  // Typed surface only — reject unexpected own enumerable keys on the root.
  const allowedRoot = new Set([
    'protocolVersion',
    'projectionVersion',
    'generatedAt',
    'generation',
    'cursor',
    'freshness',
    'health',
    'workspaces',
    'threads',
    'runs',
    'missions',
    'rounds',
    'participants',
    'providers',
    'routing',
    'questions',
    'approvals',
    'schedules',
    'channels',
    'usage',
    'artifacts',
    'warnings',
    'recovery'
  ])
  for (const key of Object.keys(snapshot)) {
    if (!allowedRoot.has(key)) {
      return fail(`snapshot leaked unexpected field: ${key}`)
    }
  }

  return { ok: true, value: snapshot }
}

/** Bound helper exported for tests — presentation truncation only. */
export function boundHostPresentationText(
  value: string,
  max: number
): { text: string; truncated: boolean } {
  return truncatePresentation(value, max)
}

/** Exported for tests — privacy key/value scan without projecting. */
export function inspectHostSnapshotPrivacy(value: unknown): HostDecodeResult<true> {
  return assertPrivacyClean(value, 'value')
}
