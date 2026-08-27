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
export const HOST_PROJECTION_VERSION = 2 as const

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
/** Channels currently cap live/pending seats at eight members. */
export const HOST_PROTOCOL_MAX_CHANNEL_MEMBERS = 8
/** Lowercase SHA-256 hex digest length for command fingerprints on the wire. */
export const HOST_COMMAND_FINGERPRINT_HEX_LENGTH = 64

export type HostProtocolVersion = typeof HOST_PROTOCOL_VERSION
export type HostProjectionVersion = typeof HOST_PROJECTION_VERSION

export type HostClientClass = 'desktop' | 'tui' | 'ios' | 'test' | 'host-cli'

export type HostCapability =
  | 'bootstrap'
  | 'snapshot'
  | 'deltas'
  | 'model-offers'
  | 'provider-catalog'
  | 'provider-auth'
  | 'history'
  /** Opt-in setup mutations; never requested by legacy/default clients. */
  | 'setup'
  | 'host-lifecycle'
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
  | 'channels'
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

/**
 * Stable identity of the app's local Desktop Host transport.
 *
 * Renderer command bodies carry this value for deterministic fingerprints,
 * but the main-process broker re-stamps it before transport. The renderer is
 * therefore never trusted to select its actor; Host still derives the call
 * context from the authenticated socket binding and evaluates action
 * authority independently.
 */
export const TASKWRAITH_DESKTOP_HOST_CLIENT_ID = 'taskwraith-desktop-renderer'
export const TASKWRAITH_DESKTOP_HOST_ACTOR = {
  actorId: TASKWRAITH_DESKTOP_HOST_CLIENT_ID,
  clientId: TASKWRAITH_DESKTOP_HOST_CLIENT_ID,
  clientClass: 'desktop'
} as const satisfies HostActorIdentity

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
  /**
   * Whether this provider id is admitted in the configured snapshot.
   * Required boolean on the wire — omit/undefined fails decodeHostSnapshot.
   * Does NOT mean runtime-healthy; producers without a health signal must
   * still emit a boolean, and clients must not paint it as "available".
   */
  available: boolean
  /** Admission note only (e.g. configured / conditional-offer) — never credentials. */
  note?: string
}

export interface HostParticipantProjection {
  id: string
  /** Owning app chat id. Participant ids are only unique within this thread. */
  threadId: string
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
  /**
   * Exact command this approval governs (Wave 4.2c).
   *
   * REQUIRED, because an approval always governs some command: the durable
   * deferred record has carried `commandId` beside `challengeId` all along,
   * so this publishes an existing fact rather than inventing one.
   *
   * Without it the only available binding was `actionKind`, which is a command
   * NAME, not an identity. With two concurrent asks of the same kind — the
   * designed end state once Desktop is a second live projection — a client
   * could resolve the wrong one. This field is the join key in both
   * directions: an approval names its command, and a client holding a
   * commandId can find its approval exactly.
   */
  commandId: string
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

/** Compact Channel membership metadata. Never carries identity keys or room bindings. */
export interface HostChannelMemberProjection {
  memberId: string
  kind: 'human' | 'agent'
  displayName: string
  status: 'pending' | 'active'
}

/**
 * Compact multi-human Channel state.
 *
 * Message bodies, invite credentials, relay room ids, public keys and human
 * review bodies deliberately remain on the authenticated Channel resource
 * API. Host carries only enough state for shared lifecycle and administration.
 */
export interface HostChannelProjection {
  channelId: string
  /** ChannelStore chatId expressed in Host vocabulary. */
  threadId: string
  ownerMemberId: string
  title: string
  status: 'active' | 'closed'
  availability: 'ready' | 'recovery_blocked'
  membershipRevision: number
  memberCount: number
  messageCount: number
  updatedAt: number
  /** Omitted when membership detail is unavailable (for example recovery-blocked). */
  members?: HostChannelMemberProjection[]
  pendingAdmissionCount?: number
  pendingHumanReviewCount?: number
}

/**
 * Wave 5d — stable warning codes.
 *
 * Clients MUST match on `code`, never on `message`. Prose matching is the
 * bug class this repo already hit once, where a predicate whose whole job was
 * proving connection was satisfied by the string "Host is not connected".
 * Codes are snake_case, conforming to the existing vocabulary
 * (`projection_truncated`, `invalid_command_id`, `receipt_failed`).
 *
 * PROVIDER_SOURCE_NOT_READY carries a distinction the `providers` family
 * cannot express by itself: that array is REQUIRED, so an empty one means
 * BOTH "measured none" AND "source has not finished discovering". Without
 * this code a client renders a confident zero for an unknown — fabricated
 * telemetry, which the arc goal forbids by name ("Unavailable telemetry is
 * not zero").
 */
export const HOST_WARNING_PROVIDER_SOURCE_NOT_READY = 'provider_source_not_ready'

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
  /** Optional until the production Channels source is installed. */
  channels?: HostChannelProjection[]
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

/**
 * Authority-RPC response frames for body-bearing reads (Wave 2D-1).
 * Clients consume these instead of routing `snapshot.get` / `deltas.since`
 * through `host.command` (reserved aliases never mint durable receipts).
 * `receipt` remains on the existing `host.receipt` envelope.
 */
export interface HostSnapshotFrame {
  type: 'host.snapshot'
  protocolVersion: HostProtocolVersion
  snapshot: HostSnapshot
}

export interface HostDeltasFrame {
  type: 'host.deltas'
  protocolVersion: HostProtocolVersion
  result: HostDeltasSinceResult
}

export interface HostHealthFrame {
  type: 'host.health'
  protocolVersion: HostProtocolVersion
  health: HostHealthProjection
}

/**
 * Inputs a later session adapter uses to mint `HostBootstrapWelcome`.
 * Identity must already be transport-verified — this contract never
 * authenticates, opens listeners, or invents capabilities beyond intersection.
 */
export interface HostBootstrapWelcomeMintInput {
  hostId: string
  hostVersion: string
  sessionId: string
  generation: HostGeneration
  cursor: HostCursor
  authenticatedClient: HostAuthenticatedClientIdentity
  hostCapabilityOffer: readonly HostCapability[]
  clientCapabilityRequest: readonly HostCapability[]
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
  | 'channel'
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
      generation: HostGeneration
      cursor: HostCursor
    }
  | { outcome: 'rejected'; reason: string }

/**
 * Wire result for `deltas.since` — mirrors HostDeltaStore.since() semantics
 * without importing main/Node. Cursor regressions on the client apply path
 * remain `late` (see applyHostDeltaCursor); they are not a since-result reason.
 */
export type HostDeltasSinceResult =
  | {
      kind: 'deltas'
      generation: HostGeneration
      fromCursor: HostCursor
      toCursor: HostCursor
      deltas: HostDeltaEnvelope[]
    }
  | {
      kind: 'full_resnapshot_required'
      reason:
        | 'generation_mismatch'
        | 'previous_cursor_mismatch'
        | 'retention_gap'
        | 'generation_reset'
      generation: HostGeneration
      cursor: HostCursor
      clientGeneration: HostGeneration
      clientCursor: HostCursor
    }

export type HostDeltasSinceResnapshotReason = Extract<
  HostDeltasSinceResult,
  { kind: 'full_resnapshot_required' }
>['reason']

/**
 * Typed `question.answer` arguments — Bridge questionReply / questionReject donors.
 * `answer` carries free-text or option chip text; `dismiss` is an explicit reject.
 */
export type HostQuestionAnswerDecision = 'answer' | 'dismiss'

/**
 * Typed `approval.decide` arguments — Bridge approvalReply core approve/deny set.
 * Path-grant and provider-route Bridge decisions are intentionally excluded so
 * this command cannot widen permission ceilings from the wire alone.
 */
export type HostApprovalDecideDecision =
  | 'accept'
  | 'acceptForSession'
  | 'acceptForWorkspace'
  | 'decline'
  | 'cancel'

/** Matches Bridge questionReply answer bound (BRIDGE_QUESTION_ANSWER_MAX_CHARS). */
export const HOST_QUESTION_ANSWER_MAX_CHARS = 8_000
/** Matches Bridge questionReject message bound. */
export const HOST_QUESTION_DISMISS_MESSAGE_MAX_CHARS = 1_000
/** Optional note on approval.decide — keep compact. */
export const HOST_APPROVAL_DECIDE_MESSAGE_MAX_CHARS = 1_000

export const HOST_QUESTION_ANSWER_DECISIONS: readonly HostQuestionAnswerDecision[] = [
  'answer',
  'dismiss'
] as const

export const HOST_APPROVAL_DECIDE_DECISIONS: readonly HostApprovalDecideDecision[] = [
  'accept',
  'acceptForSession',
  'acceptForWorkspace',
  'decline',
  'cancel'
] as const

/** Maximum durable thread-record artifact size; matches HostProfileDomainStore. */
export const HOST_THREAD_RECORD_TRANSFER_MAX_BYTES = 64 * 1024 * 1024

export interface HostThreadRecordPersistArguments {
  transferId: string
  sha256: string
  byteLength: number
  expectedRevision: number
}

export type HostCommandName =
  | 'snapshot.get'
  | 'deltas.since'
  | 'receipt.lookup'
  | 'composer.send'
  | 'run.cancel'
  | 'question.answer'
  | 'approval.decide'
  | 'ensemble.seat.toggle'
  | 'channel.member.revoke'
  | 'channel.close'
  | 'thread.select'
  | 'workspace.register'
  | 'thread.create'
  | 'thread.configure'
  | 'thread.record.persist'
  | 'thread.record.delete'
  | 'thread.archive'
  | 'provider.auth.begin'
  | 'provider.auth.cancel'
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

/**
 * Canonical receipt statuses — aligned with HostCommandReceiptStore semantics.
 * No accepted/executed synonym fork: use pending → succeeded (or failed/denied/…).
 */
export type HostReceiptStatus =
  | 'pending'
  | 'succeeded'
  | 'failed'
  | 'denied'
  | 'cancelled'
  | 'indeterminate'
  | 'conflict'

export const HOST_RECEIPT_STATUSES: readonly HostReceiptStatus[] = [
  'pending',
  'succeeded',
  'failed',
  'denied',
  'cancelled',
  'indeterminate',
  'conflict'
] as const

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
  /**
   * Lowercase SHA-256 hex digest of the canonical command body.
   * Required for idempotency replay/conflict; never raw args on the wire.
   */
  commandFingerprint: string
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
  resultRef?: HostResultRef
}

/** Opaque durable result locator; never a path, URL, credential, or body. */
export type HostResultRef =
  | { kind: 'workspace'; workspaceId: string }
  | { kind: 'thread'; threadId: string }
  | { kind: 'provider-auth'; providerId: string; operationId: string }

export type HostDecodeResult<T> = { ok: true; value: T } | { ok: false; error: string }

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function isNonEmptyString(value: unknown, max = HOST_PROTOCOL_MAX_STRING): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= max
}

function isOptionalString(
  value: unknown,
  max = HOST_PROTOCOL_MAX_STRING
): value is string | undefined {
  return value === undefined || isNonEmptyString(value, max)
}

export function decodeHostResultRef(value: unknown): HostDecodeResult<HostResultRef | undefined> {
  if (value === undefined) return { ok: true, value: undefined }
  if (!isRecord(value) || typeof value.kind !== 'string') {
    return { ok: false, error: 'resultRef is invalid' }
  }
  if (value.kind === 'workspace') {
    if (Object.keys(value).length !== 2 || !isSafeHostEntityIdComponent(value.workspaceId)) {
      return { ok: false, error: 'resultRef is invalid' }
    }
    return {
      ok: true,
      value: { kind: 'workspace', workspaceId: value.workspaceId }
    }
  }
  if (value.kind === 'thread') {
    if (Object.keys(value).length !== 2 || !isSafeHostEntityIdComponent(value.threadId)) {
      return { ok: false, error: 'resultRef is invalid' }
    }
    return {
      ok: true,
      value: { kind: 'thread', threadId: value.threadId }
    }
  }
  if (value.kind !== 'provider-auth') return { ok: false, error: 'resultRef is invalid' }
  if (
    Object.keys(value).length !== 3 ||
    !isSafeHostEntityIdComponent(value.providerId) ||
    !isSafeHostEntityIdComponent(value.operationId)
  ) {
    return { ok: false, error: 'resultRef is invalid' }
  }
  return {
    ok: true,
    value: {
      kind: 'provider-auth',
      providerId: value.providerId,
      operationId: value.operationId
    }
  }
}

function hasUnsafeHostIdentifierControlCharacter(value: string): boolean {
  return Array.from(value).some((character) => {
    const code = character.charCodeAt(0)
    return code <= 0x1f || code === 0x7f
  })
}

function isSafeHostEntityIdComponent(value: unknown): value is string {
  return (
    isNonEmptyString(value, HOST_PROTOCOL_MAX_ID) &&
    value.trim() === value &&
    !hasUnsafeHostIdentifierControlCharacter(value)
  )
}

/**
 * Stable participant delta identity.
 *
 * Ensemble roster ids can be copied between chats, so `participant.id` alone
 * is not globally unique. This tagged length-prefixed encoding is reversible,
 * unambiguous when either component contains `:`, and bounded to the normal
 * Host entity-id limit without hashing or truncation.
 */
export function encodeHostParticipantEntityId(
  threadId: unknown,
  participantId: unknown
): HostDecodeResult<string> {
  if (!isSafeHostEntityIdComponent(threadId)) {
    return { ok: false, error: 'participant threadId is empty, oversized, or unsafe' }
  }
  if (!isSafeHostEntityIdComponent(participantId)) {
    return { ok: false, error: 'participant id is empty, oversized, or unsafe' }
  }
  const entityId = `pt1:${threadId.length}:${threadId}:${participantId.length}:${participantId}`
  if (entityId.length > HOST_PROTOCOL_MAX_ID) {
    return { ok: false, error: 'participant composite entity id exceeds Host id bound' }
  }
  return { ok: true, value: entityId }
}

/**
 * Stable provider/model delta identity.
 *
 * A provider can advertise a provider-wide row and any number of model rows.
 * `providerId` alone therefore cannot key the collection. The tagged,
 * length-prefixed encoding keeps the model-absent row distinct from every
 * model-present row and remains reversible when either component contains
 * `:`. It intentionally matches the entity id carried by Host deltas.
 */
export function encodeHostProviderEntityId(
  providerId: unknown,
  modelId: unknown
): HostDecodeResult<string> {
  if (!isSafeHostEntityIdComponent(providerId)) {
    return { ok: false, error: 'provider id is empty, oversized, or unsafe' }
  }
  if (modelId === undefined) {
    const entityId = `p0:${providerId.length}:${providerId}`
    if (entityId.length > HOST_PROTOCOL_MAX_ID) {
      return { ok: false, error: 'provider composite entity id exceeds Host id bound' }
    }
    return { ok: true, value: entityId }
  }
  if (!isSafeHostEntityIdComponent(modelId)) {
    return { ok: false, error: 'provider model id is empty, oversized, or unsafe' }
  }
  const entityId = `p1:${providerId.length}:${providerId}:${modelId.length}:${modelId}`
  if (entityId.length > HOST_PROTOCOL_MAX_ID) {
    return { ok: false, error: 'provider composite entity id exceeds Host id bound' }
  }
  return { ok: true, value: entityId }
}

function isNonNegativeInt(value: unknown): value is number {
  return (
    typeof value === 'number' && Number.isInteger(value) && value >= 0 && Number.isFinite(value)
  )
}

function isClientClass(value: unknown): value is HostClientClass {
  return (
    value === 'desktop' ||
    value === 'tui' ||
    value === 'ios' ||
    value === 'test' ||
    value === 'host-cli'
  )
}

/** Canonical host capability offer order (stable intersect ordering). */
export const HOST_CAPABILITY_ORDER: readonly HostCapability[] = [
  'bootstrap',
  'snapshot',
  'deltas',
  'model-offers',
  'provider-catalog',
  'provider-auth',
  'history',
  'setup',
  'host-lifecycle',
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
  'channels',
  'recovery',
  'compact-export'
] as const

const HOST_CAPABILITIES = new Set<string>(HOST_CAPABILITY_ORDER)

const HOST_QUESTION_ANSWER_DECISION_SET = new Set<string>(HOST_QUESTION_ANSWER_DECISIONS)
const HOST_APPROVAL_DECIDE_DECISION_SET = new Set<string>(HOST_APPROVAL_DECIDE_DECISIONS)

const HOST_COMMAND_NAMES = new Set<string>([
  'snapshot.get',
  'deltas.since',
  'receipt.lookup',
  'composer.send',
  'run.cancel',
  'question.answer',
  'approval.decide',
  'ensemble.seat.toggle',
  'channel.member.revoke',
  'channel.close',
  'thread.select',
  'workspace.register',
  'thread.create',
  'thread.configure',
  'thread.record.persist',
  'thread.record.delete',
  'thread.archive',
  'provider.auth.begin',
  'provider.auth.cancel',
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
  'channel',
  'warning',
  'recovery',
  'health',
  'snapshot-meta'
])

const HOST_FRESHNESS = new Set<string>(['live', 'cached', 'stale'])
const HOST_STATUSES = new Set<string>(['ok', 'degraded', 'recovering', 'offline'])
const HOST_CONNECTION_PHASES = new Set<string>([
  'connecting',
  'live',
  'reconnecting',
  'offline',
  'stale-cache',
  'incompatible-protocol',
  'host-unavailable'
])
const HOST_REOPEN_STATUSES = new Set<string>(['clean', 'recovered', 'degraded', 'unknown'])
const HOST_USAGE_AVAILABILITY = new Set<string>(['available', 'unavailable', 'estimated'])
const HOST_USAGE_CONFIDENCE = new Set<string>(['exact', 'derived', 'estimated', 'unknown'])
const HOST_USAGE_BAND = new Set<string>(['low', 'medium', 'high', 'critical', 'unknown'])
const HOST_PROVIDER_OUTCOMES = new Set<string>([
  'running',
  'completed',
  'failed',
  'cancelled',
  'requires_action',
  'unknown'
])
const HOST_ROUND_OUTCOMES = new Set<string>([
  'running',
  'completed',
  'cancelled',
  'failed',
  'unknown'
])
const HOST_MISSION_OUTCOMES = new Set<string>([
  'active',
  'completed',
  'blocked',
  'cancelled',
  'failed',
  'unknown'
])
const HOST_QUESTION_STATUSES = new Set<string>(['open', 'answered', 'dismissed', 'expired'])
const HOST_APPROVAL_STATUSES = new Set<string>([
  'pending',
  'approved',
  'denied',
  'expired',
  'cancelled'
])
const HOST_WARNING_SEVERITIES = new Set<string>(['info', 'warning', 'error'])
const HOST_DECISION_SOURCES = new Set<string>(['user', 'system'])
const HOST_CHAT_KINDS = new Set<string>(['single', 'ensemble'])
const HOST_PARTICIPANT_STAGES = new Set<string>([
  'scout',
  'worker',
  'reviewer',
  'background',
  'any'
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
  const identity: HostAuthenticatedClientIdentity = {
    clientId: value.clientId,
    clientClass: value.clientClass,
    clientVersion: value.clientVersion
  }
  if (value.subjectId !== undefined) {
    identity.subjectId = value.subjectId
  }
  if (value.displayName !== undefined) {
    identity.displayName = value.displayName
  }
  return { ok: true, value: identity }
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

function decodeQuestionAnswerArguments(
  value: Record<string, unknown>
): HostDecodeResult<Record<string, unknown>> {
  const decision = value.decision
  if (typeof decision !== 'string' || !HOST_QUESTION_ANSWER_DECISION_SET.has(decision)) {
    return { ok: false, error: 'question.answer decision must be answer or dismiss' }
  }
  for (const key of Object.keys(value)) {
    if (key !== 'decision' && key !== 'answer' && key !== 'isCustom' && key !== 'message') {
      return { ok: false, error: 'question.answer has unknown argument keys' }
    }
  }
  if (decision === 'answer') {
    if (value.message !== undefined) {
      return { ok: false, error: 'question.answer answer must not include dismiss message' }
    }
    const answer = value.answer
    if (
      typeof answer !== 'string' ||
      answer.length === 0 ||
      answer.length > HOST_QUESTION_ANSWER_MAX_CHARS
    ) {
      return { ok: false, error: 'question.answer answer text is required and bounded' }
    }
    if (!answer.trim()) {
      return { ok: false, error: 'question.answer answer text is required and bounded' }
    }
    if (value.isCustom !== undefined && typeof value.isCustom !== 'boolean') {
      return { ok: false, error: 'question.answer isCustom must be boolean' }
    }
    const out: Record<string, unknown> = { decision: 'answer', answer }
    if (value.isCustom !== undefined) out.isCustom = value.isCustom
    return { ok: true, value: out }
  }
  // dismiss
  if (value.answer !== undefined || value.isCustom !== undefined) {
    return { ok: false, error: 'question.answer dismiss must not include answer fields' }
  }
  if (
    value.message !== undefined &&
    (typeof value.message !== 'string' ||
      value.message.length === 0 ||
      value.message.length > HOST_QUESTION_DISMISS_MESSAGE_MAX_CHARS)
  ) {
    return { ok: false, error: 'question.answer dismiss message is invalid' }
  }
  const out: Record<string, unknown> = { decision: 'dismiss' }
  if (value.message !== undefined) out.message = value.message
  return { ok: true, value: out }
}

function decodeApprovalDecideArguments(
  value: Record<string, unknown>
): HostDecodeResult<Record<string, unknown>> {
  const decision = value.decision
  if (typeof decision !== 'string' || !HOST_APPROVAL_DECIDE_DECISION_SET.has(decision)) {
    return { ok: false, error: 'approval.decide decision is invalid' }
  }
  if (
    value.message !== undefined &&
    (typeof value.message !== 'string' ||
      value.message.length === 0 ||
      value.message.length > HOST_APPROVAL_DECIDE_MESSAGE_MAX_CHARS)
  ) {
    return { ok: false, error: 'approval.decide message is invalid' }
  }
  // Reject unknown keys so clients cannot smuggle path grants or wideners.
  for (const key of Object.keys(value)) {
    if (key !== 'decision' && key !== 'message') {
      return { ok: false, error: 'approval.decide has unknown argument keys' }
    }
  }
  const out: Record<string, unknown> = { decision }
  if (value.message !== undefined) out.message = value.message
  return { ok: true, value: out }
}

const HOST_THREAD_RECORD_TRANSFER_ID_MAX_CHARS = 128
const HOST_THREAD_RECORD_TRANSFER_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]*$/
const HOST_SHA256_HEX_RE = /^[a-f0-9]{64}$/

function decodeThreadRecordPersistArguments(
  value: Record<string, unknown>
): HostDecodeResult<HostThreadRecordPersistArguments> {
  const allowed = ['transferId', 'sha256', 'byteLength', 'expectedRevision'] as const
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key as (typeof allowed)[number])) {
      return { ok: false, error: 'thread.record.persist has unknown argument keys' }
    }
  }
  if (Object.keys(value).length !== allowed.length) {
    return {
      ok: false,
      error:
        'thread.record.persist arguments must be exactly { transferId, sha256, byteLength, expectedRevision }'
    }
  }
  if (
    !isNonEmptyString(value.transferId, HOST_THREAD_RECORD_TRANSFER_ID_MAX_CHARS) ||
    !HOST_THREAD_RECORD_TRANSFER_ID_RE.test(value.transferId)
  ) {
    return { ok: false, error: 'thread.record.persist transferId is invalid' }
  }
  if (typeof value.sha256 !== 'string' || !HOST_SHA256_HEX_RE.test(value.sha256)) {
    return { ok: false, error: 'thread.record.persist sha256 must be lowercase SHA-256 hex' }
  }
  if (
    !Number.isSafeInteger(value.byteLength) ||
    (value.byteLength as number) <= 0 ||
    (value.byteLength as number) > HOST_THREAD_RECORD_TRANSFER_MAX_BYTES
  ) {
    return { ok: false, error: 'thread.record.persist byteLength is invalid' }
  }
  if (!Number.isSafeInteger(value.expectedRevision) || (value.expectedRevision as number) < 0) {
    return { ok: false, error: 'thread.record.persist expectedRevision is invalid' }
  }
  return {
    ok: true,
    value: {
      transferId: value.transferId,
      sha256: value.sha256,
      byteLength: value.byteLength as number,
      expectedRevision: value.expectedRevision as number
    }
  }
}

function decodeThreadRecordDeleteArguments(
  value: Record<string, unknown>
): HostDecodeResult<Record<string, unknown>> {
  const keys = Object.keys(value)
  if (keys.some((key) => key !== 'expectedRevision')) {
    return { ok: false, error: 'thread.record.delete has unknown argument keys' }
  }
  if (keys.length !== 1) {
    return {
      ok: false,
      error: 'thread.record.delete arguments must be exactly { expectedRevision }'
    }
  }
  if (!Number.isSafeInteger(value.expectedRevision) || (value.expectedRevision as number) < 0) {
    return { ok: false, error: 'thread.record.delete expectedRevision is invalid' }
  }
  return { ok: true, value: { expectedRevision: value.expectedRevision } }
}

/**
 * Deterministic capability intersection: host offer ∩ client request.
 * Preserves host offer order, dedupes, and never invents capabilities.
 * Prefer `buildHostBootstrapWelcome` when minting a Welcome frame — it applies
 * this intersection and returns a decode-valid envelope.
 */
export function intersectHostCapabilities(
  hostOffer: readonly HostCapability[],
  clientRequest: readonly HostCapability[]
): HostCapability[] {
  const requested = new Set<HostCapability>()
  for (const entry of clientRequest) {
    if (HOST_CAPABILITIES.has(entry)) requested.add(entry)
  }
  const out: HostCapability[] = []
  const seen = new Set<HostCapability>()
  for (const entry of hostOffer) {
    if (!HOST_CAPABILITIES.has(entry) || !requested.has(entry) || seen.has(entry)) continue
    seen.add(entry)
    out.push(entry)
  }
  return out
}

const HOST_DELTAS_SINCE_RESNAPSHOT_REASONS = new Set<string>([
  'generation_mismatch',
  'previous_cursor_mismatch',
  'retention_gap',
  'generation_reset'
])

export function decodeHostDeltasSinceResult(
  value: unknown
): HostDecodeResult<HostDeltasSinceResult> {
  if (!isRecord(value)) return { ok: false, error: 'deltas-since result must be an object' }
  if (value.kind === 'deltas') {
    if (!isNonNegativeInt(value.generation) || !isNonNegativeInt(value.fromCursor)) {
      return { ok: false, error: 'deltas-since deltas requires generation and fromCursor' }
    }
    if (!isNonNegativeInt(value.toCursor)) {
      return { ok: false, error: 'deltas-since deltas requires toCursor' }
    }
    if (value.toCursor < value.fromCursor) {
      return { ok: false, error: 'deltas-since toCursor must be >= fromCursor' }
    }
    if (!Array.isArray(value.deltas) || value.deltas.length > HOST_PROTOCOL_MAX_DELTAS) {
      return { ok: false, error: 'deltas-since deltas must be a bounded array' }
    }
    const deltas: HostDeltaEnvelope[] = []
    for (const entry of value.deltas) {
      const decoded = decodeHostDeltaEnvelope(entry)
      if (!decoded.ok) return decoded
      if (decoded.value.generation !== value.generation) {
        return { ok: false, error: 'deltas-since delta generation mismatch' }
      }
      deltas.push(decoded.value)
    }
    return {
      ok: true,
      value: {
        kind: 'deltas',
        generation: value.generation,
        fromCursor: value.fromCursor,
        toCursor: value.toCursor,
        deltas
      }
    }
  }
  if (value.kind === 'full_resnapshot_required') {
    if (
      typeof value.reason !== 'string' ||
      !HOST_DELTAS_SINCE_RESNAPSHOT_REASONS.has(value.reason)
    ) {
      return { ok: false, error: 'deltas-since resnapshot reason is invalid' }
    }
    if (
      !isNonNegativeInt(value.generation) ||
      !isNonNegativeInt(value.cursor) ||
      !isNonNegativeInt(value.clientGeneration) ||
      !isNonNegativeInt(value.clientCursor)
    ) {
      return { ok: false, error: 'deltas-since resnapshot position fields are required' }
    }
    return {
      ok: true,
      value: {
        kind: 'full_resnapshot_required',
        reason: value.reason as HostDeltasSinceResnapshotReason,
        generation: value.generation,
        cursor: value.cursor,
        clientGeneration: value.clientGeneration,
        clientCursor: value.clientCursor
      }
    }
  }
  return { ok: false, error: 'deltas-since kind is invalid' }
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
  const envelope: HostDeltaEnvelope = {
    protocolVersion: HOST_PROTOCOL_VERSION,
    projectionVersion: HOST_PROJECTION_VERSION,
    generation: value.generation,
    cursor: value.cursor,
    previousCursor: value.previousCursor,
    kind: value.kind as HostDeltaKind,
    family: value.family as HostDeltaFamily,
    at: value.at
  }
  if (value.entityId !== undefined) {
    envelope.entityId = value.entityId
  }
  if (value.payload !== undefined) {
    envelope.payload = value.payload
  }
  if (typeof value.tombstone === 'boolean') {
    envelope.tombstone = value.tombstone
  }
  return { ok: true, value: envelope }
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
  let args = decodeArgumentsMap(value.arguments)
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
      value.name === 'ensemble.seat.toggle' ||
      value.name === 'thread.record.persist' ||
      value.name === 'thread.record.delete') &&
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
  if (value.name === 'question.answer') {
    const questionArgs = decodeQuestionAnswerArguments(args.value)
    if (!questionArgs.ok) return questionArgs
    args = { ok: true, value: questionArgs.value }
  }
  if (
    value.name === 'approval.decide' &&
    !isNonEmptyString(target.value.approvalId, HOST_PROTOCOL_MAX_ID)
  ) {
    return { ok: false, error: 'target.approvalId is required' }
  }
  if (value.name === 'approval.decide') {
    const approvalArgs = decodeApprovalDecideArguments(args.value)
    if (!approvalArgs.ok) return approvalArgs
    args = { ok: true, value: approvalArgs.value }
  }
  if (value.name === 'thread.record.persist') {
    const persistArgs = decodeThreadRecordPersistArguments(args.value)
    if (!persistArgs.ok) return persistArgs
    args = { ok: true, value: { ...persistArgs.value } }
  }
  if (value.name === 'thread.record.delete') {
    const deleteArgs = decodeThreadRecordDeleteArguments(args.value)
    if (!deleteArgs.ok) return deleteArgs
    args = { ok: true, value: deleteArgs.value }
  }
  if (
    (value.name === 'channel.member.revoke' || value.name === 'channel.close') &&
    !isNonEmptyString(target.value.channelId, HOST_PROTOCOL_MAX_ID)
  ) {
    return { ok: false, error: 'target.channelId is required' }
  }
  if (
    value.name === 'channel.member.revoke' &&
    !isNonEmptyString(args.value.memberId, HOST_PROTOCOL_MAX_ID)
  ) {
    return { ok: false, error: 'channel.member.revoke memberId is required' }
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
    status !== 'pending' &&
    status !== 'succeeded' &&
    status !== 'failed' &&
    status !== 'denied' &&
    status !== 'cancelled' &&
    status !== 'indeterminate' &&
    status !== 'conflict'
  ) {
    return { ok: false, error: 'receipt status is invalid' }
  }
  const commandFingerprint = normalizeHostCommandFingerprint(value.commandFingerprint)
  if (!commandFingerprint) {
    return { ok: false, error: 'commandFingerprint must be lowercase SHA-256 hex' }
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
  const resultRef = decodeHostResultRef(value.resultRef)
  if (!resultRef.ok) return resultRef
  if (resultRef.value !== undefined && status !== 'succeeded') {
    return { ok: false, error: 'resultRef requires a succeeded receipt' }
  }
  let authority: HostAuthorityDecision
  if (value.authority.decision === 'deny') {
    authority = { decision: 'deny', reason: String(value.authority.reason) }
  } else if (value.authority.decision === 'ask') {
    authority = { decision: 'ask' }
    if (isNonEmptyString(value.authority.reason, 500)) {
      authority.reason = value.authority.reason
    }
  } else {
    authority = { decision: 'allow' }
    if (isNonEmptyString(value.authority.reason, 500)) {
      authority.reason = value.authority.reason
    }
  }
  const receipt: HostCommandReceipt = {
    type: 'host.receipt',
    protocolVersion: HOST_PROTOCOL_VERSION,
    commandId: value.commandId,
    idempotencyKey: value.idempotencyKey,
    name: value.name as HostCommandName,
    actor: actor.value,
    authority,
    status,
    commandFingerprint,
    generation: value.generation,
    cursor: value.cursor,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt
  }
  if (value.resultSummary !== undefined) {
    receipt.resultSummary = value.resultSummary
  }
  if (value.errorCode !== undefined) {
    receipt.errorCode = value.errorCode
  }
  if (value.errorMessage !== undefined) {
    receipt.errorMessage = value.errorMessage
  }
  if (value.conflictCommandId !== undefined) {
    receipt.conflictCommandId = value.conflictCommandId
  }
  if (resultRef.value) receipt.resultRef = resultRef.value
  return { ok: true, value: receipt }
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

/**
 * Normalize a wire command fingerprint to lowercase SHA-256 hex.
 * Returns null when the value is not a bounded SHA-256 hex digest.
 * Callers that need to *compute* digests must do so in a Node-capable Host
 * module (e.g. HostCommandReceiptStore.hostCommandFingerprint) — this shared
 * contract never treats a raw canonical string as a fingerprint.
 */
export function normalizeHostCommandFingerprint(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const normalized = value.trim().toLowerCase()
  if (normalized.length !== HOST_COMMAND_FINGERPRINT_HEX_LENGTH) return null
  if (!/^[a-f0-9]+$/.test(normalized)) return null
  return normalized
}

export function isHostCommandFingerprint(value: unknown): value is string {
  return normalizeHostCommandFingerprint(value) !== null
}

/**
 * Compare a retry against a durable receipt using the supplied SHA-256 hex
 * fingerprint. Same idempotency key + identical fingerprint ⇒ reconnect-safe
 * replay; same key + different fingerprint ⇒ conflict. commandId is never the
 * equality signal (that footgun allowed same-key / different-body collisions).
 */
export function evaluateHostIdempotencyReplay(
  next: { idempotencyKey: string; commandFingerprint: string },
  existing: HostCommandReceipt
): 'replay' | 'conflict' {
  if (next.idempotencyKey !== existing.idempotencyKey) {
    return 'conflict'
  }
  return evaluateHostIdempotencyFingerprints(next.commandFingerprint, existing.commandFingerprint)
}

export function evaluateHostIdempotencyFingerprints(
  nextFingerprint: string,
  existingFingerprint: string
): 'replay' | 'conflict' {
  const next = normalizeHostCommandFingerprint(nextFingerprint)
  const existing = normalizeHostCommandFingerprint(existingFingerprint)
  if (!next || !existing) return 'conflict'
  return next === existing ? 'replay' : 'conflict'
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

function decodeBoundedArray<T>(
  value: unknown,
  label: string,
  decodeItem: (entry: unknown, index: number) => HostDecodeResult<T>
): HostDecodeResult<T[]> {
  if (!Array.isArray(value)) return { ok: false, error: `${label} must be an array` }
  if (value.length > HOST_PROTOCOL_MAX_COLLECTION) {
    return { ok: false, error: `${label} exceeds collection bound` }
  }
  const out: T[] = []
  for (let i = 0; i < value.length; i += 1) {
    const decoded = decodeItem(value[i], i)
    if (!decoded.ok) return decoded
    out.push(decoded.value)
  }
  return { ok: true, value: out }
}

function decodeOptionalNonNegativeInt(
  value: unknown,
  label: string
): HostDecodeResult<number | undefined> {
  if (value === undefined) return { ok: true, value: undefined }
  if (!isNonNegativeInt(value)) return { ok: false, error: `${label} is invalid` }
  return { ok: true, value }
}

/** Strict wire decoder for `HostHealthProjection`. */
export function decodeHostHealthProjection(value: unknown): HostDecodeResult<HostHealthProjection> {
  if (!isRecord(value)) return { ok: false, error: 'health must be an object' }
  if (typeof value.hostStatus !== 'string' || !HOST_STATUSES.has(value.hostStatus)) {
    return { ok: false, error: 'health.hostStatus is invalid' }
  }
  if (
    typeof value.connectionPhase !== 'string' ||
    !HOST_CONNECTION_PHASES.has(value.connectionPhase)
  ) {
    return { ok: false, error: 'health.connectionPhase is invalid' }
  }
  if (typeof value.supervised !== 'boolean') {
    return { ok: false, error: 'health.supervised must be boolean' }
  }
  if (typeof value.freshness !== 'string' || !HOST_FRESHNESS.has(value.freshness)) {
    return { ok: false, error: 'health.freshness is invalid' }
  }
  if (!isOptionalString(value.detail, HOST_PROTOCOL_MAX_WARNING)) {
    return { ok: false, error: 'health.detail is invalid' }
  }
  const health: HostHealthProjection = {
    hostStatus: value.hostStatus as HostHealthProjection['hostStatus'],
    connectionPhase: value.connectionPhase as HostConnectionPhase,
    supervised: value.supervised,
    freshness: value.freshness as HostProjectionFreshness
  }
  if (value.detail !== undefined) {
    health.detail = value.detail
  }
  return { ok: true, value: health }
}

function decodeHostUsageObservation(value: unknown): HostDecodeResult<HostUsageObservation> {
  if (!isRecord(value)) return { ok: false, error: 'usage must be an object' }
  if (typeof value.availability !== 'string' || !HOST_USAGE_AVAILABILITY.has(value.availability)) {
    return { ok: false, error: 'usage.availability is invalid' }
  }
  if (value.tokens !== undefined) {
    if (typeof value.tokens !== 'number' || !Number.isFinite(value.tokens) || value.tokens < 0) {
      return { ok: false, error: 'usage.tokens is invalid' }
    }
  }
  if (!isOptionalString(value.costText, HOST_PROTOCOL_MAX_SHORT)) {
    return { ok: false, error: 'usage.costText is invalid' }
  }
  if (
    value.confidence !== undefined &&
    (typeof value.confidence !== 'string' || !HOST_USAGE_CONFIDENCE.has(value.confidence))
  ) {
    return { ok: false, error: 'usage.confidence is invalid' }
  }
  if (
    value.band !== undefined &&
    (typeof value.band !== 'string' || !HOST_USAGE_BAND.has(value.band))
  ) {
    return { ok: false, error: 'usage.band is invalid' }
  }
  if (value.availability === 'unavailable' && value.tokens !== undefined) {
    return { ok: false, error: 'unavailable usage must not publish tokens' }
  }
  const usage: HostUsageObservation = {
    availability: value.availability as HostUsageAvailability
  }
  if (value.tokens !== undefined) usage.tokens = value.tokens
  if (value.costText !== undefined) usage.costText = value.costText
  if (value.confidence !== undefined) {
    usage.confidence = value.confidence as NonNullable<HostUsageObservation['confidence']>
  }
  if (value.band !== undefined) {
    usage.band = value.band as NonNullable<HostUsageObservation['band']>
  }
  return { ok: true, value: usage }
}

function decodeHostRecoveryProjection(value: unknown): HostDecodeResult<HostRecoveryProjection> {
  if (!isRecord(value)) return { ok: false, error: 'recovery must be an object' }
  if (typeof value.reopenStatus !== 'string' || !HOST_REOPEN_STATUSES.has(value.reopenStatus)) {
    return { ok: false, error: 'recovery.reopenStatus is invalid' }
  }
  const lastCheckpointAt = decodeOptionalNonNegativeInt(
    value.lastCheckpointAt,
    'recovery.lastCheckpointAt'
  )
  if (!lastCheckpointAt.ok) return lastCheckpointAt
  const lastGeneration = decodeOptionalNonNegativeInt(
    value.lastGeneration,
    'recovery.lastGeneration'
  )
  if (!lastGeneration.ok) return lastGeneration
  const lastCursor = decodeOptionalNonNegativeInt(value.lastCursor, 'recovery.lastCursor')
  if (!lastCursor.ok) return lastCursor
  if (!isOptionalString(value.detail, HOST_PROTOCOL_MAX_WARNING)) {
    return { ok: false, error: 'recovery.detail is invalid' }
  }
  const recovery: HostRecoveryProjection = {
    reopenStatus: value.reopenStatus as HostRecoveryProjection['reopenStatus']
  }
  if (lastCheckpointAt.value !== undefined) recovery.lastCheckpointAt = lastCheckpointAt.value
  if (lastGeneration.value !== undefined) recovery.lastGeneration = lastGeneration.value
  if (lastCursor.value !== undefined) recovery.lastCursor = lastCursor.value
  if (value.detail !== undefined) recovery.detail = value.detail
  return { ok: true, value: recovery }
}

function decodeHostRoutingProjection(value: unknown): HostDecodeResult<HostRoutingProjection> {
  if (!isRecord(value)) return { ok: false, error: 'routing must be an object' }
  if (!isNonEmptyString(value.mode, HOST_PROTOCOL_MAX_SHORT)) {
    return { ok: false, error: 'routing.mode is required' }
  }
  if (!isNonEmptyString(value.fanout, HOST_PROTOCOL_MAX_SHORT)) {
    return { ok: false, error: 'routing.fanout is required' }
  }
  if (!isOptionalString(value.activeParticipantId, HOST_PROTOCOL_MAX_ID)) {
    return { ok: false, error: 'routing.activeParticipantId is invalid' }
  }
  if (!isOptionalString(value.bossParticipantId, HOST_PROTOCOL_MAX_ID)) {
    return { ok: false, error: 'routing.bossParticipantId is invalid' }
  }
  if (!isOptionalString(value.captainParticipantId, HOST_PROTOCOL_MAX_ID)) {
    return { ok: false, error: 'routing.captainParticipantId is invalid' }
  }
  const continuationHops = decodeOptionalNonNegativeInt(
    value.continuationHops,
    'routing.continuationHops'
  )
  if (!continuationHops.ok) return continuationHops
  const maxContinuationHops = decodeOptionalNonNegativeInt(
    value.maxContinuationHops,
    'routing.maxContinuationHops'
  )
  if (!maxContinuationHops.ok) return maxContinuationHops
  const routing: HostRoutingProjection = {
    mode: value.mode,
    fanout: value.fanout
  }
  if (value.activeParticipantId !== undefined) {
    routing.activeParticipantId = value.activeParticipantId
  }
  if (continuationHops.value !== undefined) routing.continuationHops = continuationHops.value
  if (maxContinuationHops.value !== undefined) {
    routing.maxContinuationHops = maxContinuationHops.value
  }
  if (value.bossParticipantId !== undefined) routing.bossParticipantId = value.bossParticipantId
  if (value.captainParticipantId !== undefined) {
    routing.captainParticipantId = value.captainParticipantId
  }
  return { ok: true, value: routing }
}

function decodeHostWorkspaceProjection(
  value: unknown,
  index: number
): HostDecodeResult<HostWorkspaceProjection> {
  const label = `workspaces[${index}]`
  if (!isRecord(value)) return { ok: false, error: `${label} must be an object` }
  if (!isNonEmptyString(value.id, HOST_PROTOCOL_MAX_ID)) {
    return { ok: false, error: `${label}.id is required` }
  }
  if (!isNonEmptyString(value.name, HOST_PROTOCOL_MAX_SHORT)) {
    return { ok: false, error: `${label}.name is required` }
  }
  if (!isNonEmptyString(value.path, HOST_PROTOCOL_MAX_STRING)) {
    return { ok: false, error: `${label}.path is required` }
  }
  if (typeof value.pinned !== 'boolean') {
    return { ok: false, error: `${label}.pinned must be boolean` }
  }
  if (!isNonNegativeInt(value.updatedAt)) {
    return { ok: false, error: `${label}.updatedAt is invalid` }
  }
  return {
    ok: true,
    value: {
      id: value.id,
      name: value.name,
      path: value.path,
      pinned: value.pinned,
      updatedAt: value.updatedAt
    }
  }
}

function decodeHostThreadProjection(
  value: unknown,
  index: number
): HostDecodeResult<HostThreadProjection> {
  const label = `threads[${index}]`
  if (!isRecord(value)) return { ok: false, error: `${label} must be an object` }
  if (!isNonEmptyString(value.id, HOST_PROTOCOL_MAX_ID)) {
    return { ok: false, error: `${label}.id is required` }
  }
  if (!(value.workspaceId === null || isNonEmptyString(value.workspaceId, HOST_PROTOCOL_MAX_ID))) {
    return { ok: false, error: `${label}.workspaceId is invalid` }
  }
  if (!isNonEmptyString(value.title, HOST_PROTOCOL_MAX_SHORT)) {
    return { ok: false, error: `${label}.title is required` }
  }
  if (typeof value.chatKind !== 'string' || !HOST_CHAT_KINDS.has(value.chatKind)) {
    return { ok: false, error: `${label}.chatKind is invalid` }
  }
  if (typeof value.archived !== 'boolean' || typeof value.pinned !== 'boolean') {
    return { ok: false, error: `${label}.archived/pinned must be boolean` }
  }
  if (!isNonNegativeInt(value.updatedAt) || !isNonNegativeInt(value.messageCount)) {
    return { ok: false, error: `${label}.updatedAt/messageCount are invalid` }
  }
  if (
    value.latestPreview !== undefined &&
    (typeof value.latestPreview !== 'string' ||
      value.latestPreview.length === 0 ||
      value.latestPreview.length > HOST_PROTOCOL_MAX_TRANSCRIPT_PREVIEW)
  ) {
    return { ok: false, error: `${label}.latestPreview is invalid` }
  }
  if (value.previewTruncated !== undefined && typeof value.previewTruncated !== 'boolean') {
    return { ok: false, error: `${label}.previewTruncated must be boolean` }
  }
  if (!isOptionalString(value.parentThreadId, HOST_PROTOCOL_MAX_ID)) {
    return { ok: false, error: `${label}.parentThreadId is invalid` }
  }
  if (!isOptionalString(value.providerId, HOST_PROTOCOL_MAX_ID)) {
    return { ok: false, error: `${label}.providerId is invalid` }
  }
  if (!isOptionalString(value.activeRoundId, HOST_PROTOCOL_MAX_ID)) {
    return { ok: false, error: `${label}.activeRoundId is invalid` }
  }
  if (
    value.missionOutcome !== undefined &&
    (typeof value.missionOutcome !== 'string' || !HOST_MISSION_OUTCOMES.has(value.missionOutcome))
  ) {
    return { ok: false, error: `${label}.missionOutcome is invalid` }
  }
  let usage: HostUsageObservation | undefined
  if (value.usage !== undefined) {
    const decodedUsage = decodeHostUsageObservation(value.usage)
    if (!decodedUsage.ok) return decodedUsage
    usage = decodedUsage.value
  }
  const thread: HostThreadProjection = {
    id: value.id,
    workspaceId: value.workspaceId as string | null,
    title: value.title,
    chatKind: value.chatKind as HostThreadProjection['chatKind'],
    archived: value.archived,
    pinned: value.pinned,
    updatedAt: value.updatedAt,
    messageCount: value.messageCount
  }
  if (value.parentThreadId !== undefined) thread.parentThreadId = value.parentThreadId
  if (value.latestPreview !== undefined) thread.latestPreview = value.latestPreview
  if (value.previewTruncated !== undefined) thread.previewTruncated = value.previewTruncated
  if (value.providerId !== undefined) thread.providerId = value.providerId
  if (value.missionOutcome !== undefined) {
    thread.missionOutcome = value.missionOutcome as HostMissionOutcome
  }
  if (value.activeRoundId !== undefined) thread.activeRoundId = value.activeRoundId
  if (usage !== undefined) thread.usage = usage
  return { ok: true, value: thread }
}

function decodeHostRunProjection(
  value: unknown,
  index: number
): HostDecodeResult<HostRunProjection> {
  const label = `runs[${index}]`
  if (!isRecord(value)) return { ok: false, error: `${label} must be an object` }
  if (!isNonEmptyString(value.runId, HOST_PROTOCOL_MAX_ID)) {
    return { ok: false, error: `${label}.runId is required` }
  }
  if (!isNonEmptyString(value.threadId, HOST_PROTOCOL_MAX_ID)) {
    return { ok: false, error: `${label}.threadId is required` }
  }
  if (!isNonEmptyString(value.providerId, HOST_PROTOCOL_MAX_ID)) {
    return { ok: false, error: `${label}.providerId is required` }
  }
  if (
    typeof value.providerOutcome !== 'string' ||
    !HOST_PROVIDER_OUTCOMES.has(value.providerOutcome)
  ) {
    return { ok: false, error: `${label}.providerOutcome is invalid` }
  }
  const startedAt = decodeOptionalNonNegativeInt(value.startedAt, `${label}.startedAt`)
  if (!startedAt.ok) return startedAt
  const endedAt = decodeOptionalNonNegativeInt(value.endedAt, `${label}.endedAt`)
  if (!endedAt.ok) return endedAt
  if (!isOptionalString(value.modelId, HOST_PROTOCOL_MAX_ID)) {
    return { ok: false, error: `${label}.modelId is invalid` }
  }
  let usage: HostUsageObservation | undefined
  if (value.usage !== undefined) {
    const decodedUsage = decodeHostUsageObservation(value.usage)
    if (!decodedUsage.ok) return decodedUsage
    usage = decodedUsage.value
  }
  const run: HostRunProjection = {
    runId: value.runId,
    threadId: value.threadId,
    providerId: value.providerId,
    providerOutcome: value.providerOutcome as HostProviderTerminalOutcome
  }
  if (startedAt.value !== undefined) run.startedAt = startedAt.value
  if (endedAt.value !== undefined) run.endedAt = endedAt.value
  if (value.modelId !== undefined) run.modelId = value.modelId
  if (usage !== undefined) run.usage = usage
  return { ok: true, value: run }
}

function decodeHostMissionProjection(
  value: unknown,
  index: number
): HostDecodeResult<HostMissionProjection> {
  const label = `missions[${index}]`
  if (!isRecord(value)) return { ok: false, error: `${label} must be an object` }
  if (!isNonEmptyString(value.missionId, HOST_PROTOCOL_MAX_ID)) {
    return { ok: false, error: `${label}.missionId is required` }
  }
  if (!isNonEmptyString(value.title, HOST_PROTOCOL_MAX_SHORT)) {
    return { ok: false, error: `${label}.title is required` }
  }
  if (typeof value.status !== 'string' || !HOST_MISSION_OUTCOMES.has(value.status)) {
    return { ok: false, error: `${label}.status is invalid` }
  }
  if (!isNonNegativeInt(value.updatedAt)) {
    return { ok: false, error: `${label}.updatedAt is invalid` }
  }
  if (!isOptionalString(value.threadId, HOST_PROTOCOL_MAX_ID)) {
    return { ok: false, error: `${label}.threadId is invalid` }
  }
  if (!isOptionalString(value.goalId, HOST_PROTOCOL_MAX_ID)) {
    return { ok: false, error: `${label}.goalId is invalid` }
  }
  if (!isOptionalString(value.activeRoundId, HOST_PROTOCOL_MAX_ID)) {
    return { ok: false, error: `${label}.activeRoundId is invalid` }
  }
  const mission: HostMissionProjection = {
    missionId: value.missionId,
    title: value.title,
    status: value.status as HostMissionOutcome,
    updatedAt: value.updatedAt
  }
  if (value.threadId !== undefined) mission.threadId = value.threadId
  if (value.goalId !== undefined) mission.goalId = value.goalId
  if (value.activeRoundId !== undefined) mission.activeRoundId = value.activeRoundId
  return { ok: true, value: mission }
}

function decodeHostWaveProjection(
  value: unknown,
  label: string
): HostDecodeResult<HostWaveProjection> {
  if (!isRecord(value)) return { ok: false, error: `${label} must be an object` }
  if (!isNonEmptyString(value.waveId, HOST_PROTOCOL_MAX_ID)) {
    return { ok: false, error: `${label}.waveId is required` }
  }
  if (!isNonEmptyString(value.status, HOST_PROTOCOL_MAX_SHORT)) {
    return { ok: false, error: `${label}.status is required` }
  }
  if (!isOptionalString(value.label, HOST_PROTOCOL_MAX_SHORT)) {
    return { ok: false, error: `${label}.label is invalid` }
  }
  const participantIds = decodeBoundedArray(
    value.participantIds,
    `${label}.participantIds`,
    (entry, i) => {
      if (!isNonEmptyString(entry, HOST_PROTOCOL_MAX_ID)) {
        return { ok: false, error: `${label}.participantIds[${i}] is invalid` }
      }
      return { ok: true, value: entry }
    }
  )
  if (!participantIds.ok) return participantIds
  const wave: HostWaveProjection = {
    waveId: value.waveId,
    status: value.status,
    participantIds: participantIds.value
  }
  if (value.label !== undefined) wave.label = value.label
  return { ok: true, value: wave }
}

function decodeHostRoundProjection(
  value: unknown,
  index: number
): HostDecodeResult<HostRoundProjection> {
  const label = `rounds[${index}]`
  if (!isRecord(value)) return { ok: false, error: `${label} must be an object` }
  if (!isNonEmptyString(value.roundId, HOST_PROTOCOL_MAX_ID)) {
    return { ok: false, error: `${label}.roundId is required` }
  }
  if (!isNonEmptyString(value.threadId, HOST_PROTOCOL_MAX_ID)) {
    return { ok: false, error: `${label}.threadId is required` }
  }
  if (typeof value.status !== 'string' || !HOST_ROUND_OUTCOMES.has(value.status)) {
    return { ok: false, error: `${label}.status is invalid` }
  }
  const startedAt = decodeOptionalNonNegativeInt(value.startedAt, `${label}.startedAt`)
  if (!startedAt.ok) return startedAt
  const endedAt = decodeOptionalNonNegativeInt(value.endedAt, `${label}.endedAt`)
  if (!endedAt.ok) return endedAt
  let routing: HostRoutingProjection | undefined
  if (value.routing !== undefined) {
    const decodedRouting = decodeHostRoutingProjection(value.routing)
    if (!decodedRouting.ok) return decodedRouting
    routing = decodedRouting.value
  }
  let waves: HostWaveProjection[] | undefined
  if (value.waves !== undefined) {
    const decodedWaves = decodeBoundedArray(value.waves, `${label}.waves`, (entry, i) =>
      decodeHostWaveProjection(entry, `${label}.waves[${i}]`)
    )
    if (!decodedWaves.ok) return decodedWaves
    waves = decodedWaves.value
  }
  const participantIds = decodeBoundedArray(
    value.participantIds,
    `${label}.participantIds`,
    (entry, i) => {
      if (!isNonEmptyString(entry, HOST_PROTOCOL_MAX_ID)) {
        return { ok: false, error: `${label}.participantIds[${i}] is invalid` }
      }
      return { ok: true, value: entry }
    }
  )
  if (!participantIds.ok) return participantIds
  const providerRunIds = decodeBoundedArray(
    value.providerRunIds,
    `${label}.providerRunIds`,
    (entry, i) => {
      if (!isNonEmptyString(entry, HOST_PROTOCOL_MAX_ID)) {
        return { ok: false, error: `${label}.providerRunIds[${i}] is invalid` }
      }
      return { ok: true, value: entry }
    }
  )
  if (!providerRunIds.ok) return providerRunIds
  const round: HostRoundProjection = {
    roundId: value.roundId,
    threadId: value.threadId,
    status: value.status as HostRoundOutcome,
    participantIds: participantIds.value,
    providerRunIds: providerRunIds.value
  }
  if (startedAt.value !== undefined) round.startedAt = startedAt.value
  if (endedAt.value !== undefined) round.endedAt = endedAt.value
  if (routing !== undefined) round.routing = routing
  if (waves !== undefined) round.waves = waves
  return { ok: true, value: round }
}

function decodeHostParticipantProjection(
  value: unknown,
  index: number
): HostDecodeResult<HostParticipantProjection> {
  const label = `participants[${index}]`
  if (!isRecord(value)) return { ok: false, error: `${label} must be an object` }
  if (!isNonEmptyString(value.id, HOST_PROTOCOL_MAX_ID)) {
    return { ok: false, error: `${label}.id is required` }
  }
  if (!isNonEmptyString(value.threadId, HOST_PROTOCOL_MAX_ID)) {
    return { ok: false, error: `${label}.threadId is required` }
  }
  const entityId = encodeHostParticipantEntityId(value.threadId, value.id)
  if (!entityId.ok) {
    return { ok: false, error: `${label} has invalid identity: ${entityId.error}` }
  }
  if (!isNonEmptyString(value.providerId, HOST_PROTOCOL_MAX_ID)) {
    return { ok: false, error: `${label}.providerId is required` }
  }
  if (!isNonEmptyString(value.role, HOST_PROTOCOL_MAX_SHORT)) {
    return { ok: false, error: `${label}.role is required` }
  }
  if (!isNonNegativeInt(value.order)) {
    return { ok: false, error: `${label}.order is invalid` }
  }
  if (typeof value.enabled !== 'boolean' || typeof value.active !== 'boolean') {
    return { ok: false, error: `${label}.enabled/active must be boolean` }
  }
  if (!isOptionalString(value.modelId, HOST_PROTOCOL_MAX_ID)) {
    return { ok: false, error: `${label}.modelId is invalid` }
  }
  if (!isOptionalString(value.status, HOST_PROTOCOL_MAX_SHORT)) {
    return { ok: false, error: `${label}.status is invalid` }
  }
  if (
    value.stage !== undefined &&
    (typeof value.stage !== 'string' || !HOST_PARTICIPANT_STAGES.has(value.stage))
  ) {
    return { ok: false, error: `${label}.stage is invalid` }
  }
  const participant: HostParticipantProjection = {
    id: value.id,
    threadId: value.threadId,
    providerId: value.providerId,
    role: value.role,
    order: value.order,
    enabled: value.enabled,
    active: value.active
  }
  if (value.modelId !== undefined) participant.modelId = value.modelId
  if (value.stage !== undefined) {
    participant.stage = value.stage as NonNullable<HostParticipantProjection['stage']>
  }
  if (value.status !== undefined) participant.status = value.status
  return { ok: true, value: participant }
}

function decodeHostProviderModelProjection(
  value: unknown,
  index: number
): HostDecodeResult<HostProviderModelProjection> {
  const label = `providers[${index}]`
  if (!isRecord(value)) return { ok: false, error: `${label} must be an object` }
  if (!isNonEmptyString(value.providerId, HOST_PROTOCOL_MAX_ID)) {
    return { ok: false, error: `${label}.providerId is required` }
  }
  if (!isNonEmptyString(value.displayProvider, HOST_PROTOCOL_MAX_SHORT)) {
    return { ok: false, error: `${label}.displayProvider is required` }
  }
  if (!isNonEmptyString(value.shortCode, HOST_PROTOCOL_MAX_SHORT)) {
    return { ok: false, error: `${label}.shortCode is required` }
  }
  if (typeof value.available !== 'boolean') {
    return { ok: false, error: `${label}.available must be boolean` }
  }
  if (!isOptionalString(value.modelId, HOST_PROTOCOL_MAX_ID)) {
    return { ok: false, error: `${label}.modelId is invalid` }
  }
  if (!isOptionalString(value.modelLabel, HOST_PROTOCOL_MAX_SHORT)) {
    return { ok: false, error: `${label}.modelLabel is invalid` }
  }
  if (!isOptionalString(value.hueKey, HOST_PROTOCOL_MAX_SHORT)) {
    return { ok: false, error: `${label}.hueKey is invalid` }
  }
  if (!isOptionalString(value.note, HOST_PROTOCOL_MAX_WARNING)) {
    return { ok: false, error: `${label}.note is invalid` }
  }
  const provider: HostProviderModelProjection = {
    providerId: value.providerId,
    displayProvider: value.displayProvider,
    shortCode: value.shortCode,
    available: value.available
  }
  if (value.modelId !== undefined) provider.modelId = value.modelId
  if (value.modelLabel !== undefined) provider.modelLabel = value.modelLabel
  if (value.hueKey !== undefined) provider.hueKey = value.hueKey
  if (value.note !== undefined) provider.note = value.note
  return { ok: true, value: provider }
}

function decodeHostQuestionProjection(
  value: unknown,
  index: number
): HostDecodeResult<HostQuestionProjection> {
  const label = `questions[${index}]`
  if (!isRecord(value)) return { ok: false, error: `${label} must be an object` }
  if (!isNonEmptyString(value.questionId, HOST_PROTOCOL_MAX_ID)) {
    return { ok: false, error: `${label}.questionId is required` }
  }
  if (!isNonEmptyString(value.threadId, HOST_PROTOCOL_MAX_ID)) {
    return { ok: false, error: `${label}.threadId is required` }
  }
  if (typeof value.status !== 'string' || !HOST_QUESTION_STATUSES.has(value.status)) {
    return { ok: false, error: `${label}.status is invalid` }
  }
  if (!isNonEmptyString(value.promptPreview, HOST_PROTOCOL_MAX_WARNING)) {
    return { ok: false, error: `${label}.promptPreview is required` }
  }
  if (!isNonNegativeInt(value.askedAt)) {
    return { ok: false, error: `${label}.askedAt is invalid` }
  }
  const answeredAt = decodeOptionalNonNegativeInt(value.answeredAt, `${label}.answeredAt`)
  if (!answeredAt.ok) return answeredAt
  if (!isOptionalString(value.receiptId, HOST_PROTOCOL_MAX_ID)) {
    return { ok: false, error: `${label}.receiptId is invalid` }
  }
  const question: HostQuestionProjection = {
    questionId: value.questionId,
    threadId: value.threadId,
    status: value.status as HostQuestionProjection['status'],
    promptPreview: value.promptPreview,
    askedAt: value.askedAt
  }
  if (answeredAt.value !== undefined) question.answeredAt = answeredAt.value
  if (value.receiptId !== undefined) question.receiptId = value.receiptId
  return { ok: true, value: question }
}

function decodeHostApprovalProjection(
  value: unknown,
  index: number
): HostDecodeResult<HostApprovalProjection> {
  const label = `approvals[${index}]`
  if (!isRecord(value)) return { ok: false, error: `${label} must be an object` }
  if (!isNonEmptyString(value.approvalId, HOST_PROTOCOL_MAX_ID)) {
    return { ok: false, error: `${label}.approvalId is required` }
  }
  if (typeof value.status !== 'string' || !HOST_APPROVAL_STATUSES.has(value.status)) {
    return { ok: false, error: `${label}.status is invalid` }
  }
  if (!isNonEmptyString(value.commandId, HOST_PROTOCOL_MAX_ID)) {
    return { ok: false, error: `${label}.commandId is required` }
  }
  if (!isNonEmptyString(value.actionKind, HOST_PROTOCOL_MAX_SHORT)) {
    return { ok: false, error: `${label}.actionKind is required` }
  }
  if (!isNonNegativeInt(value.createdAt)) {
    return { ok: false, error: `${label}.createdAt is invalid` }
  }
  if (!isNonEmptyString(value.summary, HOST_PROTOCOL_MAX_WARNING)) {
    return { ok: false, error: `${label}.summary is required` }
  }
  if (!isOptionalString(value.threadId, HOST_PROTOCOL_MAX_ID)) {
    return { ok: false, error: `${label}.threadId is invalid` }
  }
  const decidedAt = decodeOptionalNonNegativeInt(value.decidedAt, `${label}.decidedAt`)
  if (!decidedAt.ok) return decidedAt
  if (
    value.decisionSource !== undefined &&
    (typeof value.decisionSource !== 'string' || !HOST_DECISION_SOURCES.has(value.decisionSource))
  ) {
    return { ok: false, error: `${label}.decisionSource is invalid` }
  }
  const approval: HostApprovalProjection = {
    approvalId: value.approvalId,
    // ALLOWLIST REBUILD: this literal is the wire boundary. A field absent
    // here is silently dropped even though it typechecks upstream.
    commandId: value.commandId,
    status: value.status as HostApprovalProjection['status'],
    actionKind: value.actionKind,
    createdAt: value.createdAt,
    summary: value.summary
  }
  if (value.threadId !== undefined) approval.threadId = value.threadId
  if (decidedAt.value !== undefined) approval.decidedAt = decidedAt.value
  if (value.decisionSource !== undefined) {
    approval.decisionSource = value.decisionSource as NonNullable<
      HostApprovalProjection['decisionSource']
    >
  }
  return { ok: true, value: approval }
}

function decodeHostScheduleProjection(
  value: unknown,
  index: number
): HostDecodeResult<HostScheduleProjection> {
  const label = `schedules[${index}]`
  if (!isRecord(value)) return { ok: false, error: `${label} must be an object` }
  if (!isNonEmptyString(value.scheduleId, HOST_PROTOCOL_MAX_ID)) {
    return { ok: false, error: `${label}.scheduleId is required` }
  }
  if (!isNonEmptyString(value.title, HOST_PROTOCOL_MAX_SHORT)) {
    return { ok: false, error: `${label}.title is required` }
  }
  if (typeof value.enabled !== 'boolean') {
    return { ok: false, error: `${label}.enabled must be boolean` }
  }
  const nextFireAt = decodeOptionalNonNegativeInt(value.nextFireAt, `${label}.nextFireAt`)
  if (!nextFireAt.ok) return nextFireAt
  if (!isOptionalString(value.threadId, HOST_PROTOCOL_MAX_ID)) {
    return { ok: false, error: `${label}.threadId is invalid` }
  }
  const schedule: HostScheduleProjection = {
    scheduleId: value.scheduleId,
    title: value.title,
    enabled: value.enabled
  }
  if (nextFireAt.value !== undefined) schedule.nextFireAt = nextFireAt.value
  if (value.threadId !== undefined) schedule.threadId = value.threadId
  return { ok: true, value: schedule }
}

function decodeHostChannelMemberProjection(
  value: unknown,
  index: number
): HostDecodeResult<HostChannelMemberProjection> {
  const label = `channel member[${index}]`
  if (!isRecord(value)) return { ok: false, error: `${label} must be an object` }
  if (!isNonEmptyString(value.memberId, HOST_PROTOCOL_MAX_ID)) {
    return { ok: false, error: `${label}.memberId is required` }
  }
  if (value.kind !== 'human' && value.kind !== 'agent') {
    return { ok: false, error: `${label}.kind is invalid` }
  }
  if (!isNonEmptyString(value.displayName, HOST_PROTOCOL_MAX_SHORT)) {
    return { ok: false, error: `${label}.displayName is required` }
  }
  if (value.status !== 'pending' && value.status !== 'active') {
    return { ok: false, error: `${label}.status is invalid` }
  }
  return {
    ok: true,
    value: {
      memberId: value.memberId,
      kind: value.kind,
      displayName: value.displayName,
      status: value.status
    }
  }
}

function decodeHostChannelProjection(
  value: unknown,
  index: number
): HostDecodeResult<HostChannelProjection> {
  const label = `channels[${index}]`
  if (!isRecord(value)) return { ok: false, error: `${label} must be an object` }
  if (!isNonEmptyString(value.channelId, HOST_PROTOCOL_MAX_ID)) {
    return { ok: false, error: `${label}.channelId is required` }
  }
  if (!isNonEmptyString(value.threadId, HOST_PROTOCOL_MAX_ID)) {
    return { ok: false, error: `${label}.threadId is required` }
  }
  if (!isNonEmptyString(value.ownerMemberId, HOST_PROTOCOL_MAX_ID)) {
    return { ok: false, error: `${label}.ownerMemberId is required` }
  }
  if (!isNonEmptyString(value.title, HOST_PROTOCOL_MAX_SHORT)) {
    return { ok: false, error: `${label}.title is required` }
  }
  if (value.status !== 'active' && value.status !== 'closed') {
    return { ok: false, error: `${label}.status is invalid` }
  }
  if (value.availability !== 'ready' && value.availability !== 'recovery_blocked') {
    return { ok: false, error: `${label}.availability is invalid` }
  }
  for (const field of ['membershipRevision', 'memberCount', 'messageCount', 'updatedAt'] as const) {
    if (!isNonNegativeInt(value[field])) {
      return { ok: false, error: `${label}.${field} is invalid` }
    }
  }
  const pendingAdmissionCount = decodeOptionalNonNegativeInt(
    value.pendingAdmissionCount,
    `${label}.pendingAdmissionCount`
  )
  if (!pendingAdmissionCount.ok) return pendingAdmissionCount
  const pendingHumanReviewCount = decodeOptionalNonNegativeInt(
    value.pendingHumanReviewCount,
    `${label}.pendingHumanReviewCount`
  )
  if (!pendingHumanReviewCount.ok) return pendingHumanReviewCount

  let members: HostChannelMemberProjection[] | undefined
  if (value.members !== undefined) {
    if (!Array.isArray(value.members)) {
      return { ok: false, error: `${label}.members must be an array` }
    }
    if (value.members.length > HOST_PROTOCOL_MAX_CHANNEL_MEMBERS) {
      return { ok: false, error: `${label}.members exceeds compact bound` }
    }
    members = []
    for (let memberIndex = 0; memberIndex < value.members.length; memberIndex += 1) {
      const member = decodeHostChannelMemberProjection(value.members[memberIndex], memberIndex)
      if (!member.ok) return member
      members.push(member.value)
    }
  }

  const channel: HostChannelProjection = {
    channelId: value.channelId,
    threadId: value.threadId,
    ownerMemberId: value.ownerMemberId,
    title: value.title,
    status: value.status,
    availability: value.availability,
    membershipRevision: value.membershipRevision as number,
    memberCount: value.memberCount as number,
    messageCount: value.messageCount as number,
    updatedAt: value.updatedAt as number
  }
  if (members !== undefined) channel.members = members
  if (pendingAdmissionCount.value !== undefined) {
    channel.pendingAdmissionCount = pendingAdmissionCount.value
  }
  if (pendingHumanReviewCount.value !== undefined) {
    channel.pendingHumanReviewCount = pendingHumanReviewCount.value
  }
  return { ok: true, value: channel }
}

function decodeHostArtifactProjection(
  value: unknown,
  index: number
): HostDecodeResult<HostArtifactProjection> {
  const label = `artifacts[${index}]`
  if (!isRecord(value)) return { ok: false, error: `${label} must be an object` }
  if (!isNonEmptyString(value.artifactId, HOST_PROTOCOL_MAX_ID)) {
    return { ok: false, error: `${label}.artifactId is required` }
  }
  if (!isNonEmptyString(value.kind, HOST_PROTOCOL_MAX_SHORT)) {
    return { ok: false, error: `${label}.kind is required` }
  }
  if (!isNonEmptyString(value.title, HOST_PROTOCOL_MAX_SHORT)) {
    return { ok: false, error: `${label}.title is required` }
  }
  if (!isNonNegativeInt(value.createdAt)) {
    return { ok: false, error: `${label}.createdAt is invalid` }
  }
  if (!isOptionalString(value.threadId, HOST_PROTOCOL_MAX_ID)) {
    return { ok: false, error: `${label}.threadId is invalid` }
  }
  const byteLength = decodeOptionalNonNegativeInt(value.byteLength, `${label}.byteLength`)
  if (!byteLength.ok) return byteLength
  if (
    value.sha256 !== undefined &&
    (typeof value.sha256 !== 'string' ||
      value.sha256.length !== HOST_COMMAND_FINGERPRINT_HEX_LENGTH ||
      !/^[a-f0-9]+$/.test(value.sha256))
  ) {
    return { ok: false, error: `${label}.sha256 is invalid` }
  }
  const artifact: HostArtifactProjection = {
    artifactId: value.artifactId,
    kind: value.kind,
    title: value.title,
    createdAt: value.createdAt
  }
  if (value.threadId !== undefined) artifact.threadId = value.threadId
  if (byteLength.value !== undefined) artifact.byteLength = byteLength.value
  if (value.sha256 !== undefined) artifact.sha256 = value.sha256
  return { ok: true, value: artifact }
}

function decodeHostWarningProjection(
  value: unknown,
  index: number
): HostDecodeResult<HostWarningProjection> {
  const label = `warnings[${index}]`
  if (!isRecord(value)) return { ok: false, error: `${label} must be an object` }
  if (!isNonEmptyString(value.warningId, HOST_PROTOCOL_MAX_ID)) {
    return { ok: false, error: `${label}.warningId is required` }
  }
  if (typeof value.severity !== 'string' || !HOST_WARNING_SEVERITIES.has(value.severity)) {
    return { ok: false, error: `${label}.severity is invalid` }
  }
  if (!isNonEmptyString(value.code, HOST_PROTOCOL_MAX_SHORT)) {
    return { ok: false, error: `${label}.code is required` }
  }
  if (!isNonEmptyString(value.message, HOST_PROTOCOL_MAX_WARNING)) {
    return { ok: false, error: `${label}.message is required` }
  }
  if (!isNonNegativeInt(value.at)) {
    return { ok: false, error: `${label}.at is invalid` }
  }
  if (!isOptionalString(value.threadId, HOST_PROTOCOL_MAX_ID)) {
    return { ok: false, error: `${label}.threadId is invalid` }
  }
  const warning: HostWarningProjection = {
    warningId: value.warningId,
    severity: value.severity as HostWarningProjection['severity'],
    code: value.code,
    message: value.message,
    at: value.at
  }
  if (value.threadId !== undefined) warning.threadId = value.threadId
  return { ok: true, value: warning }
}

/**
 * Strict wire decoder for `HostSnapshot`.
 * Fail-closed on missing families, invalid enums, oversized collections/previews,
 * and unavailable-usage fake zeros. Does not invent projection data.
 */
export function decodeHostSnapshot(value: unknown): HostDecodeResult<HostSnapshot> {
  if (!isRecord(value)) return { ok: false, error: 'snapshot must be an object' }
  if (value.protocolVersion !== HOST_PROTOCOL_VERSION) {
    return { ok: false, error: 'unsupported protocol version' }
  }
  if (value.projectionVersion !== HOST_PROJECTION_VERSION) {
    return { ok: false, error: 'unsupported projection version' }
  }
  if (!isNonEmptyString(value.generatedAt, 80)) {
    return { ok: false, error: 'generatedAt is required' }
  }
  if (!isNonNegativeInt(value.generation) || !isNonNegativeInt(value.cursor)) {
    return { ok: false, error: 'generation/cursor must be non-negative integers' }
  }
  if (typeof value.freshness !== 'string' || !HOST_FRESHNESS.has(value.freshness)) {
    return { ok: false, error: 'freshness is invalid' }
  }

  const health = decodeHostHealthProjection(value.health)
  if (!health.ok) return health
  const workspaces = decodeBoundedArray(
    value.workspaces,
    'workspaces',
    decodeHostWorkspaceProjection
  )
  if (!workspaces.ok) return workspaces
  const threads = decodeBoundedArray(value.threads, 'threads', decodeHostThreadProjection)
  if (!threads.ok) return threads
  const runs = decodeBoundedArray(value.runs, 'runs', decodeHostRunProjection)
  if (!runs.ok) return runs
  const missions = decodeBoundedArray(value.missions, 'missions', decodeHostMissionProjection)
  if (!missions.ok) return missions
  const rounds = decodeBoundedArray(value.rounds, 'rounds', decodeHostRoundProjection)
  if (!rounds.ok) return rounds
  const participants = decodeBoundedArray(
    value.participants,
    'participants',
    decodeHostParticipantProjection
  )
  if (!participants.ok) return participants
  const providers = decodeBoundedArray(
    value.providers,
    'providers',
    decodeHostProviderModelProjection
  )
  if (!providers.ok) return providers
  let routing: HostRoutingProjection | undefined
  if (value.routing !== undefined) {
    const decodedRouting = decodeHostRoutingProjection(value.routing)
    if (!decodedRouting.ok) return decodedRouting
    routing = decodedRouting.value
  }
  const questions = decodeBoundedArray(value.questions, 'questions', decodeHostQuestionProjection)
  if (!questions.ok) return questions
  const approvals = decodeBoundedArray(value.approvals, 'approvals', decodeHostApprovalProjection)
  if (!approvals.ok) return approvals
  const schedules = decodeBoundedArray(value.schedules, 'schedules', decodeHostScheduleProjection)
  if (!schedules.ok) return schedules
  let channels: HostChannelProjection[] | undefined
  if (value.channels !== undefined) {
    const decodedChannels = decodeBoundedArray(
      value.channels,
      'channels',
      decodeHostChannelProjection
    )
    if (!decodedChannels.ok) return decodedChannels
    channels = decodedChannels.value
  }
  const usage = decodeHostUsageObservation(value.usage)
  if (!usage.ok) return usage
  const artifacts = decodeBoundedArray(value.artifacts, 'artifacts', decodeHostArtifactProjection)
  if (!artifacts.ok) return artifacts
  const warnings = decodeBoundedArray(value.warnings, 'warnings', decodeHostWarningProjection)
  if (!warnings.ok) return warnings
  const recovery = decodeHostRecoveryProjection(value.recovery)
  if (!recovery.ok) return recovery

  const snapshot: HostSnapshot = {
    protocolVersion: HOST_PROTOCOL_VERSION,
    projectionVersion: HOST_PROJECTION_VERSION,
    generatedAt: value.generatedAt,
    generation: value.generation,
    cursor: value.cursor,
    freshness: value.freshness as HostProjectionFreshness,
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
    warnings: warnings.value,
    recovery: recovery.value
  }
  if (routing !== undefined) snapshot.routing = routing
  if (channels !== undefined) snapshot.channels = channels

  const families = assertHostSnapshotFamilies(snapshot)
  if (!families.ok) return families
  return { ok: true, value: snapshot }
}

export function decodeHostSnapshotFrame(value: unknown): HostDecodeResult<HostSnapshotFrame> {
  if (!isRecord(value)) return { ok: false, error: 'snapshot frame must be an object' }
  if (value.type !== 'host.snapshot') return { ok: false, error: 'type must be host.snapshot' }
  if (value.protocolVersion !== HOST_PROTOCOL_VERSION) {
    return { ok: false, error: 'unsupported protocol version' }
  }
  const snapshot = decodeHostSnapshot(value.snapshot)
  if (!snapshot.ok) return snapshot
  return {
    ok: true,
    value: {
      type: 'host.snapshot',
      protocolVersion: HOST_PROTOCOL_VERSION,
      snapshot: snapshot.value
    }
  }
}

export function decodeHostDeltasFrame(value: unknown): HostDecodeResult<HostDeltasFrame> {
  if (!isRecord(value)) return { ok: false, error: 'deltas frame must be an object' }
  if (value.type !== 'host.deltas') return { ok: false, error: 'type must be host.deltas' }
  if (value.protocolVersion !== HOST_PROTOCOL_VERSION) {
    return { ok: false, error: 'unsupported protocol version' }
  }
  const result = decodeHostDeltasSinceResult(value.result)
  if (!result.ok) return result
  return {
    ok: true,
    value: {
      type: 'host.deltas',
      protocolVersion: HOST_PROTOCOL_VERSION,
      result: result.value
    }
  }
}

export function decodeHostHealthFrame(value: unknown): HostDecodeResult<HostHealthFrame> {
  if (!isRecord(value)) return { ok: false, error: 'health frame must be an object' }
  if (value.type !== 'host.health') return { ok: false, error: 'type must be host.health' }
  if (value.protocolVersion !== HOST_PROTOCOL_VERSION) {
    return { ok: false, error: 'unsupported protocol version' }
  }
  const health = decodeHostHealthProjection(value.health)
  if (!health.ok) return health
  return {
    ok: true,
    value: {
      type: 'host.health',
      protocolVersion: HOST_PROTOCOL_VERSION,
      health: health.value
    }
  }
}

/**
 * Pure Welcome mint helper for a later authenticated session adapter.
 * Intersects capabilities, validates bounds, and returns a decode-valid frame.
 * Does not authenticate, allocate session ids, open listeners, or persist state.
 */
export function buildHostBootstrapWelcome(
  input: HostBootstrapWelcomeMintInput
): HostDecodeResult<HostBootstrapWelcome> {
  if (!isNonEmptyString(input.hostId, HOST_PROTOCOL_MAX_ID)) {
    return { ok: false, error: 'hostId is required' }
  }
  if (!isNonEmptyString(input.hostVersion, 80)) {
    return { ok: false, error: 'hostVersion is required' }
  }
  if (!isNonEmptyString(input.sessionId, HOST_PROTOCOL_MAX_ID)) {
    return { ok: false, error: 'sessionId is required' }
  }
  if (!isNonNegativeInt(input.generation) || !isNonNegativeInt(input.cursor)) {
    return { ok: false, error: 'generation/cursor must be non-negative integers' }
  }
  if (!HOST_FRESHNESS.has(input.freshness)) {
    return { ok: false, error: 'freshness is invalid' }
  }
  const authenticatedClient = decodeClientIdentity(input.authenticatedClient, 'authenticatedClient')
  if (!authenticatedClient.ok) return authenticatedClient
  if (
    !Array.isArray(input.hostCapabilityOffer) ||
    input.hostCapabilityOffer.length > HOST_PROTOCOL_MAX_CAPABILITIES
  ) {
    return { ok: false, error: 'hostCapabilityOffer must be a bounded array' }
  }
  if (
    !Array.isArray(input.clientCapabilityRequest) ||
    input.clientCapabilityRequest.length > HOST_PROTOCOL_MAX_CAPABILITIES
  ) {
    return { ok: false, error: 'clientCapabilityRequest must be a bounded array' }
  }
  for (const entry of input.hostCapabilityOffer) {
    if (typeof entry !== 'string' || !HOST_CAPABILITIES.has(entry)) {
      return { ok: false, error: `unknown host capability: ${String(entry)}` }
    }
  }
  for (const entry of input.clientCapabilityRequest) {
    if (typeof entry !== 'string' || !HOST_CAPABILITIES.has(entry)) {
      return { ok: false, error: `unknown client capability: ${String(entry)}` }
    }
  }
  const capabilities = intersectHostCapabilities(
    input.hostCapabilityOffer,
    input.clientCapabilityRequest
  )
  const welcome: HostBootstrapWelcome = {
    type: 'host.welcome',
    protocolVersion: HOST_PROTOCOL_VERSION,
    controlProtocolCompat: HOST_CONTROL_PROTOCOL_COMPAT_VERSION,
    projectionVersion: HOST_PROJECTION_VERSION,
    hostId: input.hostId,
    hostVersion: input.hostVersion,
    sessionId: input.sessionId,
    generation: input.generation,
    cursor: input.cursor,
    authenticatedClient: authenticatedClient.value,
    capabilities,
    freshness: input.freshness
  }
  return decodeHostBootstrapWelcome(welcome)
}
