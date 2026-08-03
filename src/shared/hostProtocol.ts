/**
 * Transport-independent Host protocol (Wave 2A).
 *
 * Desktop, TUI, and paired iOS consume the same Bootstrap / HostSnapshot /
 * Delta / Command+Receipt shapes. This module has no Node or Electron imports
 * so Swift ports and browser clients can share the contract.
 *
 * Conceptual coexistence with control protocol v1 (`taskWraithControlProtocol`):
 * Host protocol version 2 is additive. Negotiation advertises both so existing
 * TUI control v1 wire remains valid; this file does not edit or replace v1.
 *
 * Compact projections exclude credentials, secrets, raw hidden reasoning,
 * unrestricted tool output, diff bodies, and unrestricted transcript content
 * by construction (bounded summaries only).
 */

/** Host Arc wire protocol version. Distinct from TUI control protocol v1. */
export const HOST_PROTOCOL_VERSION = 2 as const

/**
 * Projection schema version carried inside snapshots/deltas.
 * Bump when HostSnapshot field semantics change incompatibly.
 */
export const HOST_PROJECTION_VERSION = 1 as const

/** Control protocol v1 retained for negotiation / compatibility advertising. */
export const HOST_CONTROL_PROTOCOL_COMPAT_VERSION = 1 as const

export const HOST_PROTOCOL_MAX_STRING = 16_000
export const HOST_PROTOCOL_MAX_ID = 512
export const HOST_PROTOCOL_MAX_SHORT = 200
export const HOST_PROTOCOL_MAX_CAPABILITIES = 64
export const HOST_PROTOCOL_MAX_COLLECTION = 2_000
export const HOST_PROTOCOL_MAX_DELTAS = 500
export const HOST_PROTOCOL_MAX_TRANSCRIPT_PREVIEW = 2_000
export const HOST_PROTOCOL_MAX_WARNING = 1_000

export type HostProtocolVersion = typeof HOST_PROTOCOL_VERSION
export type HostProjectionVersion = typeof HOST_PROJECTION_VERSION

export type HostClientClass = 'desktop' | 'tui' | 'ios' | 'test'

export type HostCapability =
  | 'bootstrap'
  | 'snapshot'
  | 'deltas'
  | 'commands'
  | 'receipts'
  | 'health'
  | 'missions'
  | 'ensemble'
  | 'approvals'
  | 'questions'
  | 'schedules'
  | 'usage'
  | 'artifacts'
  | 'recovery'
  | 'compact-export'

/**
 * Authenticated client identity presented at bootstrap.
 * Transport bindings supply the proof (local token / pairing); this is the
 * protocol-visible identity after authentication succeeds.
 */
export interface HostAuthenticatedClientIdentity {
  clientId: string
  clientClass: HostClientClass
  clientVersion: string
  /** Opaque pairing / session subject when applicable (iOS pairId, TUI session). */
  subjectId?: string
  displayName?: string
}

export interface HostActorIdentity {
  /** Stable actor key: user, paired device, or local desktop session. */
  actorId: string
  clientId: string
  clientClass: HostClientClass
}

/** Generation is bumped on discontinuity/reset; not monotonic across resets. */
export type HostGeneration = number
/** Cursor is monotonic only within a single generation. */
export type HostCursor = number

export interface HostCursorPosition {
  generation: HostGeneration
  cursor: HostCursor
}

/**
 * Distinct outcome layers — never collapse across domains.
 * Provider success must not become cancelled because a later round stopped.
 */
export type HostProviderTerminalOutcome =
  | 'running'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'requires_action'
  | 'unknown'

export type HostRoundOutcome = 'running' | 'completed' | 'cancelled' | 'failed' | 'unknown'

export type HostMissionOutcome =
  | 'active'
  | 'completed'
  | 'blocked'
  | 'cancelled'
  | 'failed'
  | 'unknown'

export type HostConnectionPhase =
  | 'connecting'
  | 'live'
  | 'reconnecting'
  | 'offline'
  | 'stale-cache'
  | 'incompatible-protocol'
  | 'host-unavailable'

/** Explicit freshness: cached projections are never implied live. */
export type HostProjectionFreshness = 'live' | 'cached' | 'stale'

/**
 * Usage observation: unavailable is not zero.
 * Callers must not coerce `unavailable` into numeric 0 for projections.
 */
export type HostUsageAvailability = 'available' | 'unavailable' | 'estimated'

export interface HostUsageObservation {
  availability: HostUsageAvailability
  /** Present only when availability is available or estimated. */
  tokens?: number
  costText?: string
  confidence?: 'exact' | 'derived' | 'estimated' | 'unknown'
  band?: 'low' | 'medium' | 'high' | 'critical' | 'unknown'
}

export interface HostHealthProjection {
  hostStatus: 'ok' | 'degraded' | 'recovering' | 'offline'
  detail?: string
  connectionPhase: HostConnectionPhase
  supervised: boolean
  /** True when this projection was served from a coherent cache, not live Host. */
  freshness: HostProjectionFreshness
}

export interface HostWorkspaceProjection {
  id: string
  name: string
  path: string
  pinned: boolean
  updatedAt: number
}

export interface HostProviderModelProjection {
  providerId: string
  displayProvider: string
  modelId?: string
  modelLabel?: string
  shortCode: string
  hueKey?: string
  available: boolean
  /** Admission/availability note only — never credentials. */
  note?: string
}

export interface HostParticipantProjection {
  id: string
  providerId: string
  role: string
  modelId?: string
  stage?: 'scout' | 'worker' | 'reviewer' | 'background' | 'any'
  order: number
  enabled: boolean
  status?: string
  active: boolean
}

export interface HostRoutingProjection {
  mode: string
  fanout: string
  activeParticipantId?: string
  continuationHops?: number
  maxContinuationHops?: number
  bossParticipantId?: string
  captainParticipantId?: string
}

export interface HostWaveProjection {
  waveId: string
  label?: string
  status: string
  participantIds: string[]
}

export interface HostRoundProjection {
  roundId: string
  threadId: string
  status: HostRoundOutcome
  startedAt?: number
  endedAt?: number
  routing?: HostRoutingProjection
  waves?: HostWaveProjection[]
  participantIds: string[]
  /** Provider run ids linked to this round — outcomes stay separate. */
  providerRunIds: string[]
}

export interface HostRunProjection {
  runId: string
  threadId: string
  providerId: string
  /** Provider-terminal outcome only — not round/mission/connection. */
  providerOutcome: HostProviderTerminalOutcome
  startedAt?: number
  endedAt?: number
  modelId?: string
  usage?: HostUsageObservation
}

export interface HostMissionProjection {
  missionId: string
  threadId?: string
  title: string
  status: HostMissionOutcome
  goalId?: string
  updatedAt: number
  activeRoundId?: string
}

export interface HostThreadProjection {
  id: string
  workspaceId: string | null
  parentThreadId?: string
  title: string
  chatKind: 'single' | 'ensemble'
  archived: boolean
  pinned: boolean
  updatedAt: number
  messageCount: number
  /** Bounded preview only; never full transcript bodies. */
  latestPreview?: string
  previewTruncated?: boolean
  providerId?: string
  missionOutcome?: HostMissionOutcome
  activeRoundId?: string
  usage?: HostUsageObservation
}

export interface HostQuestionProjection {
  questionId: string
  threadId: string
  status: 'open' | 'answered' | 'dismissed' | 'expired'
  promptPreview: string
  askedAt: number
  answeredAt?: number
  /** Receipt correlation for cross-client parity — not the free-text answer body. */
  receiptId?: string
}

export interface HostApprovalProjection {
  approvalId: string
  threadId?: string
  status: 'pending' | 'approved' | 'denied' | 'expired' | 'cancelled'
  actionKind: string
  createdAt: number
  decidedAt?: number
  decisionSource?: 'user' | 'system'
  /** Compact summary only — never raw command bodies beyond a short label. */
  summary: string
}

export interface HostScheduleProjection {
  scheduleId: string
  title: string
  enabled: boolean
  nextFireAt?: number
  threadId?: string
}

export interface HostArtifactProjection {
  artifactId: string
  kind: string
  threadId?: string
  title: string
  createdAt: number
  /** Size/digest metadata only — never artifact body bytes. */
  byteLength?: number
  sha256?: string
}

export interface HostWarningProjection {
  warningId: string
  severity: 'info' | 'warning' | 'error'
  code: string
  message: string
  at: number
  threadId?: string
}

export interface HostRecoveryProjection {
  lastCheckpointAt?: number
  lastGeneration?: HostGeneration
  lastCursor?: HostCursor
  reopenStatus: 'clean' | 'recovered' | 'degraded' | 'unknown'
  detail?: string
}

/**
 * Bounded Host authority projection shared by Desktop / TUI / iOS.
 * Families mirror the Host Arc goal list; bodies stay compact by construction.
 */
export interface HostSnapshot {
  protocolVersion: HostProtocolVersion
  projectionVersion: HostProjectionVersion
  generatedAt: string
  generation: HostGeneration
  cursor: HostCursor
  freshness: HostProjectionFreshness
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
  usage: HostUsageObservation
  artifacts: HostArtifactProjection[]
  warnings: HostWarningProjection[]
  recovery: HostRecoveryProjection
}

export interface HostBootstrapHello {
  type: 'host.hello'
  protocolVersion: HostProtocolVersion
  /** Optional: client still speaks control v1 and wants compat advertised. */
  controlProtocolCompat?: typeof HOST_CONTROL_PROTOCOL_COMPAT_VERSION
  projectionVersion: HostProjectionVersion
  client: HostAuthenticatedClientIdentity
  capabilities: HostCapability[]
}

export interface HostBootstrapWelcome {
  type: 'host.welcome'
  protocolVersion: HostProtocolVersion
  controlProtocolCompat: typeof HOST_CONTROL_PROTOCOL_COMPAT_VERSION
  projectionVersion: HostProjectionVersion
  hostId: string
  hostVersion: string
  sessionId: string
  generation: HostGeneration
  cursor: HostCursor
  authenticatedClient: HostAuthenticatedClientIdentity
  capabilities: HostCapability[]
  freshness: HostProjectionFreshness
}

export type HostDeltaKind = 'upsert' | 'remove' | 'tombstone' | 'generation-reset'

export type HostDeltaFamily =
  | 'workspace'
  | 'thread'
  | 'run'
  | 'mission'
  | 'round'
  | 'participant'
  | 'provider'
  | 'routing'
  | 'question'
  | 'approval'
  | 'schedule'
  | 'usage'
  | 'artifact'
  | 'warning'
  | 'recovery'
  | 'health'
  | 'snapshot-meta'

/**
 * Ordered delta envelope.
 * - `generation` must match the client's current generation or require resnapshot.
 * - `cursor` is strictly increasing within a generation.
 * - `previousCursor` must equal the client's last applied cursor or require resnapshot.
 */
export interface HostDeltaEnvelope {
  protocolVersion: HostProtocolVersion
  projectionVersion: HostProjectionVersion
  generation: HostGeneration
  cursor: HostCursor
  previousCursor: HostCursor
  kind: HostDeltaKind
  family: HostDeltaFamily
  /** Target entity id when applicable. */
  entityId?: string
  /** Compact patch payload — never secrets or unrestricted bodies. */
  payload?: unknown
  tombstone?: boolean
  at: string
}

export type HostDeltaApplyOutcome =
  | { outcome: 'applied'; generation: HostGeneration; cursor: HostCursor }
  | { outcome: 'duplicate'; generation: HostGeneration; cursor: HostCursor }
  | { outcome: 'late'; generation: HostGeneration; cursor: HostCursor }
  | {
      outcome: 'require_resnapshot'
      reason:
        | 'generation_mismatch'
        | 'previous_cursor_mismatch'
        | 'generation_reset'
        | 'projection_version_mismatch'
        | 'cursor_regression'
      generation: HostGeneration
      cursor: HostCursor
    }
  | { outcome: 'rejected'; reason: string }

export type HostCommandName =
  | 'snapshot.get'
  | 'deltas.since'
  | 'receipt.lookup'
  | 'composer.send'
  | 'run.cancel'
  | 'question.answer'
  | 'approval.decide'
  | 'ensemble.seat.toggle'
  | 'thread.select'
  | 'ping'

export interface HostCommand {
  type: 'host.command'
  protocolVersion: HostProtocolVersion
  /** Stable Host command id (server- or client-minted unique id). */
  commandId: string
  /** Client-minted idempotency key; same key + different body ⇒ conflict. */
  idempotencyKey: string
  actor: HostActorIdentity
  name: HostCommandName
  /** Exact target selector (threadId, approvalId, …). */
  target: Record<string, string>
  /** Exact arguments for the named command. */
  arguments: Record<string, unknown>
  issuedAt: string
}

export type HostAuthorityDecision =
  | { decision: 'allow'; reason?: string }
  | { decision: 'deny'; reason: string }
  | { decision: 'ask'; reason?: string }

export type HostReceiptStatus =
  | 'accepted'
  | 'denied'
  | 'executed'
  | 'failed'
  | 'cancelled'
  | 'conflict'
  | 'pending'

/**
 * Durable command receipt — reconnect-safe lookup by commandId or idempotencyKey.
 * Persistence is owned by Host storage (Wave 2B+); this type is the wire contract.
 */
export interface HostCommandReceipt {
  type: 'host.receipt'
  protocolVersion: HostProtocolVersion
  commandId: string
  idempotencyKey: string
  name: HostCommandName
  actor: HostActorIdentity
  authority: HostAuthorityDecision
  status: HostReceiptStatus
  /** Generation/cursor when the receipt became durable. */
  generation: HostGeneration
  cursor: HostCursor
  createdAt: string
  updatedAt: string
  /** Compact result summary — never unrestricted tool/diff bodies. */
  resultSummary?: string
  errorCode?: string
  errorMessage?: string
  /**
   * When status is `conflict`: same idempotencyKey was reused with a different
   * command fingerprint than the durable original.
   */
  conflictCommandId?: string
}

export type HostDecodeResult<T> = { ok: true; value: T } | { ok: false; error: string }

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function isNonEmptyString(value: unknown, max = HOST_PROTOCOL_MAX_STRING): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= max
}

function isOptionalString(value: unknown, max = HOST_PROTOCOL_MAX_STRING): boolean {
  return value === undefined || isNonEmptyString(value, max)
}

function isNonNegativeInt(value: unknown): value is number {
  return (
    typeof value === 'number' && Number.isInteger(value) && value >= 0 && Number.isFinite(value)
  )
}

function isClientClass(value: unknown): value is HostClientClass {
  return value === 'desktop' || value === 'tui' || value === 'ios' || value === 'test'
}

const HOST_CAPABILITIES = new Set<string>([
  'bootstrap',
  'snapshot',
  'deltas',
  'commands',
  'receipts',
  'health',
  'missions',
  'ensemble',
  'approvals',
  'questions',
  'schedules',
  'usage',
  'artifacts',
  'recovery',
  'compact-export'
])

const HOST_COMMAND_NAMES = new Set<string>([
  'snapshot.get',
  'deltas.since',
  'receipt.lookup',
  'composer.send',
  'run.cancel',
  'question.answer',
  'approval.decide',
  'ensemble.seat.toggle',
  'thread.select',
  'ping'
])

const HOST_DELTA_KINDS = new Set<string>(['upsert', 'remove', 'tombstone', 'generation-reset'])

const HOST_DELTA_FAMILIES = new Set<string>([
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
  'health',
  'snapshot-meta'
])

function decodeClientIdentity(
  value: unknown,
  label: string
): HostDecodeResult<HostAuthenticatedClientIdentity> {
  if (!isRecord(value)) return { ok: false, error: `${label} must be an object` }
  if (!isNonEmptyString(value.clientId, HOST_PROTOCOL_MAX_ID)) {
    return { ok: false, error: `${label}.clientId is required` }
  }
  if (!isClientClass(value.clientClass)) {
    return { ok: false, error: `${label}.clientClass is invalid` }
  }
  if (!isNonEmptyString(value.clientVersion, 80)) {
    return { ok: false, error: `${label}.clientVersion is required` }
  }
  if (!isOptionalString(value.subjectId, HOST_PROTOCOL_MAX_ID)) {
    return { ok: false, error: `${label}.subjectId is invalid` }
  }
  if (!isOptionalString(value.displayName, HOST_PROTOCOL_MAX_SHORT)) {
    return { ok: false, error: `${label}.displayName is invalid` }
  }
  return {
    ok: true,
    value: {
      clientId: value.clientId,
      clientClass: value.clientClass,
      clientVersion: value.clientVersion,
      ...(value.subjectId !== undefined ? { subjectId: value.subjectId } : {}),
      ...(value.displayName !== undefined ? { displayName: value.displayName } : {})
    }
  }
}

function decodeActorIdentity(value: unknown): HostDecodeResult<HostActorIdentity> {
  if (!isRecord(value)) return { ok: false, error: 'actor must be an object' }
  if (!isNonEmptyString(value.actorId, HOST_PROTOCOL_MAX_ID)) {
    return { ok: false, error: 'actor.actorId is required' }
  }
  if (!isNonEmptyString(value.clientId, HOST_PROTOCOL_MAX_ID)) {
    return { ok: false, error: 'actor.clientId is required' }
  }
  if (!isClientClass(value.clientClass)) {
    return { ok: false, error: 'actor.clientClass is invalid' }
  }
  return {
    ok: true,
    value: {
      actorId: value.actorId,
      clientId: value.clientId,
      clientClass: value.clientClass
    }
  }
}

function decodeCapabilities(value: unknown): HostDecodeResult<HostCapability[]> {
  if (!Array.isArray(value) || value.length > HOST_PROTOCOL_MAX_CAPABILITIES) {
    return { ok: false, error: 'capabilities must be a bounded array' }
  }
  const out: HostCapability[] = []
  for (const entry of value) {
    if (typeof entry !== 'string' || !HOST_CAPABILITIES.has(entry)) {
      return { ok: false, error: `unknown capability: ${String(entry)}` }
    }
    out.push(entry as HostCapability)
  }
  return { ok: true, value: out }
}

function decodeStringMap(
  value: unknown,
  label: string,
  maxEntries = 32
): HostDecodeResult<Record<string, string>> {
  if (!isRecord(value)) return { ok: false, error: `${label} must be an object` }
  const keys = Object.keys(value)
  if (keys.length > maxEntries) return { ok: false, error: `${label} has too many keys` }
  const out: Record<string, string> = {}
  for (const key of keys) {
    if (!isNonEmptyString(key, HOST_PROTOCOL_MAX_SHORT)) {
      return { ok: false, error: `${label} key is invalid` }
    }
    const entry = value[key]
    if (!isNonEmptyString(entry, HOST_PROTOCOL_MAX_STRING)) {
      return { ok: false, error: `${label}.${key} must be a bounded string` }
    }
    out[key] = entry
  }
  return { ok: true, value: out }
}

function decodeArgumentsMap(value: unknown): HostDecodeResult<Record<string, unknown>> {
  if (!isRecord(value)) return { ok: false, error: 'arguments must be an object' }
  const keys = Object.keys(value)
  if (keys.length > 32) return { ok: false, error: 'arguments has too many keys' }
  for (const key of keys) {
    if (!isNonEmptyString(key, HOST_PROTOCOL_MAX_SHORT)) {
      return { ok: false, error: 'arguments key is invalid' }
    }
  }
  return { ok: true, value: value as Record<string, unknown> }
}

export function decodeHostBootstrapHello(value: unknown): HostDecodeResult<HostBootstrapHello> {
  if (!isRecord(value)) return { ok: false, error: 'hello must be an object' }
  if (value.type !== 'host.hello') return { ok: false, error: 'type must be host.hello' }
  if (value.protocolVersion !== HOST_PROTOCOL_VERSION) {
    return { ok: false, error: 'unsupported protocol version' }
  }
  if (value.projectionVersion !== HOST_PROJECTION_VERSION) {
    return { ok: false, error: 'unsupported projection version' }
  }
  if (
    value.controlProtocolCompat !== undefined &&
    value.controlProtocolCompat !== HOST_CONTROL_PROTOCOL_COMPAT_VERSION
  ) {
    return { ok: false, error: 'unsupported control protocol compat version' }
  }
  const client = decodeClientIdentity(value.client, 'client')
  if (!client.ok) return client
  const capabilities = decodeCapabilities(value.capabilities)
  if (!capabilities.ok) return capabilities
  return {
    ok: true,
    value: {
      type: 'host.hello',
      protocolVersion: HOST_PROTOCOL_VERSION,
      projectionVersion: HOST_PROJECTION_VERSION,
      ...(value.controlProtocolCompat !== undefined
        ? { controlProtocolCompat: HOST_CONTROL_PROTOCOL_COMPAT_VERSION }
        : {}),
      client: client.value,
      capabilities: capabilities.value
    }
  }
}

export function decodeHostBootstrapWelcome(value: unknown): HostDecodeResult<HostBootstrapWelcome> {
  if (!isRecord(value)) return { ok: false, error: 'welcome must be an object' }
  if (value.type !== 'host.welcome') return { ok: false, error: 'type must be host.welcome' }
  if (value.protocolVersion !== HOST_PROTOCOL_VERSION) {
    return { ok: false, error: 'unsupported protocol version' }
  }
  if (value.controlProtocolCompat !== HOST_CONTROL_PROTOCOL_COMPAT_VERSION) {
    return { ok: false, error: 'control protocol compat required' }
  }
  if (value.projectionVersion !== HOST_PROJECTION_VERSION) {
    return { ok: false, error: 'unsupported projection version' }
  }
  if (!isNonEmptyString(value.hostId, HOST_PROTOCOL_MAX_ID)) {
    return { ok: false, error: 'hostId is required' }
  }
  if (!isNonEmptyString(value.hostVersion, 80)) {
    return { ok: false, error: 'hostVersion is required' }
  }
  if (!isNonEmptyString(value.sessionId, HOST_PROTOCOL_MAX_ID)) {
    return { ok: false, error: 'sessionId is required' }
  }
  if (!isNonNegativeInt(value.generation)) {
    return { ok: false, error: 'generation must be a non-negative integer' }
  }
  if (!isNonNegativeInt(value.cursor)) {
    return { ok: false, error: 'cursor must be a non-negative integer' }
  }
  if (value.freshness !== 'live' && value.freshness !== 'cached' && value.freshness !== 'stale') {
    return { ok: false, error: 'freshness is invalid' }
  }
  const authenticatedClient = decodeClientIdentity(value.authenticatedClient, 'authenticatedClient')
  if (!authenticatedClient.ok) return authenticatedClient
  const capabilities = decodeCapabilities(value.capabilities)
  if (!capabilities.ok) return capabilities
  return {
    ok: true,
    value: {
      type: 'host.welcome',
      protocolVersion: HOST_PROTOCOL_VERSION,
      controlProtocolCompat: HOST_CONTROL_PROTOCOL_COMPAT_VERSION,
      projectionVersion: HOST_PROJECTION_VERSION,
      hostId: value.hostId,
      hostVersion: value.hostVersion,
      sessionId: value.sessionId,
      generation: value.generation,
      cursor: value.cursor,
      authenticatedClient: authenticatedClient.value,
      capabilities: capabilities.value,
      freshness: value.freshness
    }
  }
}

export function decodeHostDeltaEnvelope(value: unknown): HostDecodeResult<HostDeltaEnvelope> {
  if (!isRecord(value)) return { ok: false, error: 'delta must be an object' }
  if (value.protocolVersion !== HOST_PROTOCOL_VERSION) {
    return { ok: false, error: 'unsupported protocol version' }
  }
  if (value.projectionVersion !== HOST_PROJECTION_VERSION) {
    return { ok: false, error: 'unsupported projection version' }
  }
  if (!isNonNegativeInt(value.generation)) {
    return { ok: false, error: 'generation must be a non-negative integer' }
  }
  if (!isNonNegativeInt(value.cursor)) {
    return { ok: false, error: 'cursor must be a non-negative integer' }
  }
  if (!isNonNegativeInt(value.previousCursor)) {
    return { ok: false, error: 'previousCursor must be a non-negative integer' }
  }
  if (typeof value.kind !== 'string' || !HOST_DELTA_KINDS.has(value.kind)) {
    return { ok: false, error: 'delta kind is invalid' }
  }
  if (typeof value.family !== 'string' || !HOST_DELTA_FAMILIES.has(value.family)) {
    return { ok: false, error: 'delta family is invalid' }
  }
  if (!isOptionalString(value.entityId, HOST_PROTOCOL_MAX_ID)) {
    return { ok: false, error: 'entityId is invalid' }
  }
  if (value.tombstone !== undefined && typeof value.tombstone !== 'boolean') {
    return { ok: false, error: 'tombstone must be a boolean' }
  }
  if (!isNonEmptyString(value.at, 80)) {
    return { ok: false, error: 'at is required' }
  }
  if (value.kind === 'tombstone' && value.tombstone !== true) {
    return { ok: false, error: 'tombstone kind requires tombstone:true' }
  }
  return {
    ok: true,
    value: {
      protocolVersion: HOST_PROTOCOL_VERSION,
      projectionVersion: HOST_PROJECTION_VERSION,
      generation: value.generation,
      cursor: value.cursor,
      previousCursor: value.previousCursor,
      kind: value.kind as HostDeltaKind,
      family: value.family as HostDeltaFamily,
      ...(value.entityId !== undefined ? { entityId: value.entityId } : {}),
      ...(value.payload !== undefined ? { payload: value.payload } : {}),
      ...(value.tombstone !== undefined ? { tombstone: value.tombstone } : {}),
      at: value.at
    }
  }
}

export function decodeHostCommand(value: unknown): HostDecodeResult<HostCommand> {
  if (!isRecord(value)) return { ok: false, error: 'command must be an object' }
  if (value.type !== 'host.command') return { ok: false, error: 'type must be host.command' }
  if (value.protocolVersion !== HOST_PROTOCOL_VERSION) {
    return { ok: false, error: 'unsupported protocol version' }
  }
  if (!isNonEmptyString(value.commandId, HOST_PROTOCOL_MAX_ID)) {
    return { ok: false, error: 'commandId is required' }
  }
  if (!isNonEmptyString(value.idempotencyKey, HOST_PROTOCOL_MAX_ID)) {
    return { ok: false, error: 'idempotencyKey is required' }
  }
  if (typeof value.name !== 'string' || !HOST_COMMAND_NAMES.has(value.name)) {
    return { ok: false, error: 'unknown command name' }
  }
  if (!isNonEmptyString(value.issuedAt, 80)) {
    return { ok: false, error: 'issuedAt is required' }
  }
  const actor = decodeActorIdentity(value.actor)
  if (!actor.ok) return actor
  const target = decodeStringMap(value.target, 'target')
  if (!target.ok) return target
  const args = decodeArgumentsMap(value.arguments)
  if (!args.ok) return args

  if (value.name === 'composer.send') {
    const text = args.value.text
    if (!isNonEmptyString(text, 12_000) || !String(text).trim()) {
      return { ok: false, error: 'composer text is required' }
    }
    if (!isNonEmptyString(target.value.threadId, HOST_PROTOCOL_MAX_ID)) {
      return { ok: false, error: 'target.threadId is required' }
    }
  }
  if (
    (value.name === 'run.cancel' ||
      value.name === 'thread.select' ||
      value.name === 'ensemble.seat.toggle') &&
    !isNonEmptyString(target.value.threadId, HOST_PROTOCOL_MAX_ID)
  ) {
    return { ok: false, error: 'target.threadId is required' }
  }
  if (
    value.name === 'question.answer' &&
    !isNonEmptyString(target.value.questionId, HOST_PROTOCOL_MAX_ID)
  ) {
    return { ok: false, error: 'target.questionId is required' }
  }
  if (
    value.name === 'approval.decide' &&
    !isNonEmptyString(target.value.approvalId, HOST_PROTOCOL_MAX_ID)
  ) {
    return { ok: false, error: 'target.approvalId is required' }
  }
  if (value.name === 'receipt.lookup') {
    const hasCommand = isNonEmptyString(target.value.commandId, HOST_PROTOCOL_MAX_ID)
    const hasKey = isNonEmptyString(target.value.idempotencyKey, HOST_PROTOCOL_MAX_ID)
    if (!hasCommand && !hasKey) {
      return { ok: false, error: 'receipt.lookup requires commandId or idempotencyKey' }
    }
  }
  if (value.name === 'deltas.since') {
    if (!isNonNegativeInt(args.value.generation) || !isNonNegativeInt(args.value.cursor)) {
      return { ok: false, error: 'deltas.since requires generation and cursor' }
    }
  }

  return {
    ok: true,
    value: {
      type: 'host.command',
      protocolVersion: HOST_PROTOCOL_VERSION,
      commandId: value.commandId,
      idempotencyKey: value.idempotencyKey,
      actor: actor.value,
      name: value.name as HostCommandName,
      target: target.value,
      arguments: args.value,
      issuedAt: value.issuedAt
    }
  }
}

export function decodeHostCommandReceipt(value: unknown): HostDecodeResult<HostCommandReceipt> {
  if (!isRecord(value)) return { ok: false, error: 'receipt must be an object' }
  if (value.type !== 'host.receipt') return { ok: false, error: 'type must be host.receipt' }
  if (value.protocolVersion !== HOST_PROTOCOL_VERSION) {
    return { ok: false, error: 'unsupported protocol version' }
  }
  if (!isNonEmptyString(value.commandId, HOST_PROTOCOL_MAX_ID)) {
    return { ok: false, error: 'commandId is required' }
  }
  if (!isNonEmptyString(value.idempotencyKey, HOST_PROTOCOL_MAX_ID)) {
    return { ok: false, error: 'idempotencyKey is required' }
  }
  if (typeof value.name !== 'string' || !HOST_COMMAND_NAMES.has(value.name)) {
    return { ok: false, error: 'unknown command name' }
  }
  const actor = decodeActorIdentity(value.actor)
  if (!actor.ok) return actor
  if (!isRecord(value.authority) || typeof value.authority.decision !== 'string') {
    return { ok: false, error: 'authority is required' }
  }
  if (
    value.authority.decision !== 'allow' &&
    value.authority.decision !== 'deny' &&
    value.authority.decision !== 'ask'
  ) {
    return { ok: false, error: 'authority.decision is invalid' }
  }
  if (value.authority.decision === 'deny' && !isNonEmptyString(value.authority.reason, 500)) {
    return { ok: false, error: 'deny authority requires reason' }
  }
  const status = value.status
  if (
    status !== 'accepted' &&
    status !== 'denied' &&
    status !== 'executed' &&
    status !== 'failed' &&
    status !== 'cancelled' &&
    status !== 'conflict' &&
    status !== 'pending'
  ) {
    return { ok: false, error: 'receipt status is invalid' }
  }
  if (!isNonNegativeInt(value.generation) || !isNonNegativeInt(value.cursor)) {
    return { ok: false, error: 'generation/cursor must be non-negative integers' }
  }
  if (!isNonEmptyString(value.createdAt, 80) || !isNonEmptyString(value.updatedAt, 80)) {
    return { ok: false, error: 'createdAt/updatedAt are required' }
  }
  if (!isOptionalString(value.resultSummary, HOST_PROTOCOL_MAX_WARNING)) {
    return { ok: false, error: 'resultSummary is invalid' }
  }
  if (!isOptionalString(value.errorCode, HOST_PROTOCOL_MAX_SHORT)) {
    return { ok: false, error: 'errorCode is invalid' }
  }
  if (!isOptionalString(value.errorMessage, HOST_PROTOCOL_MAX_WARNING)) {
    return { ok: false, error: 'errorMessage is invalid' }
  }
  if (!isOptionalString(value.conflictCommandId, HOST_PROTOCOL_MAX_ID)) {
    return { ok: false, error: 'conflictCommandId is invalid' }
  }
  const authority: HostAuthorityDecision =
    value.authority.decision === 'deny'
      ? { decision: 'deny', reason: String(value.authority.reason) }
      : value.authority.decision === 'ask'
        ? {
            decision: 'ask',
            ...(isNonEmptyString(value.authority.reason, 500)
              ? { reason: value.authority.reason }
              : {})
          }
        : {
            decision: 'allow',
            ...(isNonEmptyString(value.authority.reason, 500)
              ? { reason: value.authority.reason }
              : {})
          }
  return {
    ok: true,
    value: {
      type: 'host.receipt',
      protocolVersion: HOST_PROTOCOL_VERSION,
      commandId: value.commandId,
      idempotencyKey: value.idempotencyKey,
      name: value.name as HostCommandName,
      actor: actor.value,
      authority,
      status,
      generation: value.generation,
      cursor: value.cursor,
      createdAt: value.createdAt,
      updatedAt: value.updatedAt,
      ...(value.resultSummary !== undefined ? { resultSummary: value.resultSummary } : {}),
      ...(value.errorCode !== undefined ? { errorCode: value.errorCode } : {}),
      ...(value.errorMessage !== undefined ? { errorMessage: value.errorMessage } : {}),
      ...(value.conflictCommandId !== undefined
        ? { conflictCommandId: value.conflictCommandId }
        : {})
    }
  }
}

/**
 * Pure cursor-application rules (Boss amendment):
 * generation changes on discontinuity; cursor monotonic only within a generation;
 * previousCursor mismatch ⇒ full resnapshot.
 */
export function applyHostDeltaCursor(
  current: HostCursorPosition,
  delta: HostDeltaEnvelope
): HostDeltaApplyOutcome {
  if (delta.projectionVersion !== HOST_PROJECTION_VERSION) {
    return {
      outcome: 'require_resnapshot',
      reason: 'projection_version_mismatch',
      generation: delta.generation,
      cursor: delta.cursor
    }
  }
  if (delta.kind === 'generation-reset' || delta.generation !== current.generation) {
    return {
      outcome: 'require_resnapshot',
      reason: delta.kind === 'generation-reset' ? 'generation_reset' : 'generation_mismatch',
      generation: delta.generation,
      cursor: delta.cursor
    }
  }
  if (delta.cursor < current.cursor) {
    return {
      outcome: 'late',
      generation: current.generation,
      cursor: current.cursor
    }
  }
  if (delta.cursor === current.cursor) {
    return {
      outcome: 'duplicate',
      generation: current.generation,
      cursor: current.cursor
    }
  }
  if (delta.previousCursor !== current.cursor) {
    return {
      outcome: 'require_resnapshot',
      reason: 'previous_cursor_mismatch',
      generation: delta.generation,
      cursor: delta.cursor
    }
  }
  if (delta.cursor !== current.cursor + 1) {
    // Gap inside the same generation still requires a bounded resync rather than
    // inventing missing events.
    return {
      outcome: 'require_resnapshot',
      reason: 'previous_cursor_mismatch',
      generation: delta.generation,
      cursor: delta.cursor
    }
  }
  return {
    outcome: 'applied',
    generation: delta.generation,
    cursor: delta.cursor
  }
}

/** Stable fingerprint for idempotency conflict detection (same key, different body). */
export function hostCommandFingerprint(command: HostCommand): string {
  const targetKeys = Object.keys(command.target).sort()
  const argKeys = Object.keys(command.arguments).sort()
  const target = targetKeys.map((key) => `${key}=${command.target[key]}`).join('&')
  const args = argKeys.map((key) => `${key}=${stableJson(command.arguments[key])}`).join('&')
  return `${command.name}|${target}|${args}|actor=${command.actor.actorId}`
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map((entry) => stableJson(entry)).join(',')}]`
  const record = value as Record<string, unknown>
  const keys = Object.keys(record).sort()
  return `{${keys.map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`).join(',')}}`
}

/**
 * Compare a retry against a durable receipt. Same idempotency key with a different
 * fingerprint is a conflict; identical fingerprint is a reconnect-safe replay.
 */
export function evaluateHostIdempotencyReplay(
  command: HostCommand,
  existing: HostCommandReceipt
): 'replay' | 'conflict' {
  if (command.idempotencyKey !== existing.idempotencyKey) {
    return 'conflict'
  }
  if (command.name !== existing.name) return 'conflict'
  // Receipts do not store the full argument body; commandId match is the durable
  // equality signal for reconnect lookup. Callers comparing a new commandId with
  // a different body against the same key must supply fingerprints separately.
  if (command.commandId === existing.commandId) return 'replay'
  return 'conflict'
}

export function evaluateHostIdempotencyFingerprints(
  nextFingerprint: string,
  existingFingerprint: string
): 'replay' | 'conflict' {
  return nextFingerprint === existingFingerprint ? 'replay' : 'conflict'
}

/** Empty compact snapshot skeleton for fixtures / harnesses. */
export function createEmptyHostSnapshot(input: {
  generation: HostGeneration
  cursor: HostCursor
  freshness?: HostProjectionFreshness
  generatedAt?: string
}): HostSnapshot {
  return {
    protocolVersion: HOST_PROTOCOL_VERSION,
    projectionVersion: HOST_PROJECTION_VERSION,
    generatedAt: input.generatedAt ?? '1970-01-01T00:00:00.000Z',
    generation: input.generation,
    cursor: input.cursor,
    freshness: input.freshness ?? 'live',
    health: {
      hostStatus: 'ok',
      connectionPhase: 'live',
      supervised: true,
      freshness: input.freshness ?? 'live'
    },
    workspaces: [],
    threads: [],
    runs: [],
    missions: [],
    rounds: [],
    participants: [],
    providers: [],
    questions: [],
    approvals: [],
    schedules: [],
    usage: { availability: 'unavailable', confidence: 'unknown', band: 'unknown' },
    artifacts: [],
    warnings: [],
    recovery: { reopenStatus: 'unknown' }
  }
}

/** Structural check that a snapshot carries required projection families. */
export function assertHostSnapshotFamilies(snapshot: HostSnapshot): HostDecodeResult<true> {
  const required: Array<keyof HostSnapshot> = [
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
    'usage',
    'artifacts',
    'warnings',
    'recovery',
    'health'
  ]
  for (const key of required) {
    if (snapshot[key] === undefined) {
      return { ok: false, error: `missing projection family: ${key}` }
    }
  }
  if (snapshot.protocolVersion !== HOST_PROTOCOL_VERSION) {
    return { ok: false, error: 'unsupported protocol version' }
  }
  if (snapshot.projectionVersion !== HOST_PROJECTION_VERSION) {
    return { ok: false, error: 'unsupported projection version' }
  }
  if (!isNonNegativeInt(snapshot.generation) || !isNonNegativeInt(snapshot.cursor)) {
    return { ok: false, error: 'generation/cursor invalid' }
  }
  if (snapshot.usage.availability === 'unavailable' && snapshot.usage.tokens === 0) {
    // Soft rule: unavailable should omit tokens rather than publish fake zero.
    return { ok: false, error: 'unavailable usage must not publish tokens:0' }
  }
  if (
    snapshot.threads.some(
      (thread) =>
        typeof thread.latestPreview === 'string' &&
        thread.latestPreview.length > HOST_PROTOCOL_MAX_TRANSCRIPT_PREVIEW
    )
  ) {
    return { ok: false, error: 'thread preview exceeds compact bound' }
  }
  return { ok: true, value: true }
}
