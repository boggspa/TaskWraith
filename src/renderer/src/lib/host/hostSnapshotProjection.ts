/**
 * Host Arc Wave 4.3a — Desktop read-only Host projection mapper.
 *
 * WHAT THIS IS. A pure translation from `HostSnapshot` (the authoritative
 * wire projection) into a bounded view model the Desktop renderer can paint.
 * It is the Desktop counterpart of the TUI's `hostProjectionMap.ts`, and it
 * deliberately reuses that module's honesty rules rather than re-deriving them.
 *
 * WHY IT IS PURE. The renderer runs with `sandbox: true` and
 * `contextIsolation: true`, so it has no Node access and can never open the
 * Host socket itself. Everything here is therefore a total function over a
 * snapshot the transport already fetched — no I/O, no clock, no globals. That
 * also makes it fully testable without a DOM, which matters because this repo
 * has no jsdom environment for renderer tests; the established pattern is a
 * pure-logic / thin-view split.
 *
 * THE THREE HONESTY RULES (from the arc goal, and none of them is stylistic):
 *
 *  1. CACHED IS NOT LIVE. A snapshot served from cache is labelled `cached`
 *     and never silently painted as current state.
 *  2. UNAVAILABLE IS NOT ZERO. When Host reports usage `unavailable`, this
 *     returns `undefined` — never `0`. A zero would be fabricated telemetry,
 *     and it reads to a user as "nothing was spent", which is a different and
 *     false claim from "we do not know".
 *  3. CONNECTION STATE IS NOT RUN STATE. Client connectivity, Host health,
 *     run outcome and mission outcome are four distinct facts. A dropped
 *     socket must never be rendered as a failed run.
 *
 * BOUNDARY: read-only. This module never builds, submits or describes a Host
 * command — Desktop command cutover is Wave 4.3b and is hard-gated on exact
 * commandId correlation (Wave 4.2c, landed at b74b33e33: `commandId` is the
 * required join key on HostApprovalProjection).
 */

import type {
  HostHealthProjection,
  HostSnapshot,
  HostApprovalProjection,
  HostMissionProjection,
  HostParticipantProjection,
  HostProviderModelProjection,
  HostQuestionProjection,
  HostRoundProjection,
  HostRoutingProjection,
  HostRunProjection,
  HostThreadProjection,
  HostUsageObservation,
  HostWaveProjection,
  HostWorkspaceProjection
} from '../../../../shared/hostProtocol'

/* ------------------------------------------------------------------ */
/*  View model                                                        */
/* ------------------------------------------------------------------ */

/**
 * How current the projected data is.
 *
 * `live` means it came from a Host that answered just now. `cached` means it
 * is a coherent past snapshot shown while Host is unreachable — legal for
 * presentation, never legal to treat as authority.
 */
export type HostProjectionFreshnessLabel = 'live' | 'cached'

/** Bounded per-thread row. No transcript bodies cross this boundary. */
export interface HostProjectedThread {
  readonly id: string
  readonly workspaceId: string | null
  readonly title: string
  readonly chatKind: 'single' | 'ensemble'
  readonly archived: boolean
  readonly pinned: boolean
  readonly updatedAt: number
  readonly messageCount: number
  /** Bounded preview only — never the full latest message. */
  readonly preview?: string
  /** True when Host itself truncated the preview. */
  readonly previewTruncated: boolean
  readonly providerId?: string
}

/**
 * A provider/model row exactly as Host reports it.
 *
 * Wave 5a. This family ALREADY arrives decoded on the wire — Desktop was
 * simply discarding it. `note` is admission/availability text only; the wire
 * type says "never credentials", and `projectProvider` keeps that promise
 * enforceable here with an explicit allowlist rather than trusting upstream.
 */
export interface HostProjectedProvider {
  readonly providerId: string
  readonly displayProvider: string
  readonly shortCode: string
  readonly available: boolean
  readonly modelId?: string
  readonly modelLabel?: string
  readonly hueKey?: string
  /** Admission/availability note only — never credentials. */
  readonly note?: string
}

/**
 * A pending-approval row exactly as Host reports it.
 *
 * Wave 5f. SUBSET, NOT LEDGER. `HostProductionSuppliers` supplies base
 * `approvals: []`; the only rows on the wire are AWAITING approval-kind cards
 * merged by `HostMainComposition` (PIN S4-Q keeps question-kind out). Decided,
 * rejected and ledger approvals NEVER reach a client. Any view over this must
 * say "awaiting" and never "approvals", or it overstates what Host knows.
 *
 * Allowlisted on purpose — identity, kind, status and time only. `summary` is
 * human prose the leaf never renders, so it does not cross; `decidedAt` and
 * `decisionSource` describe a lifecycle stage the wire cannot carry today, so
 * projecting them would imply a capability Host does not have.
 */
export interface HostProjectedApproval {
  readonly approvalId: string
  /** Exact command this approval governs — the Wave 4.2c join key. */
  readonly commandId: string
  readonly status: HostApprovalProjection['status']
  readonly actionKind: string
  readonly createdAt: number
  readonly threadId?: string
}

/**
 * A pending/open question row exactly as Host reports it.
 *
 * Allowlisted on purpose — identity, status, preview and time only.
 * `receiptId` is correlation metadata, never the free-text answer body.
 */
export interface HostProjectedQuestion {
  readonly questionId: string
  readonly threadId: string
  readonly status: HostQuestionProjection['status']
  readonly promptPreview: string
  readonly askedAt: number
  readonly answeredAt?: number
  /** Receipt correlation for cross-client parity — not the answer body. */
  readonly receiptId?: string
}

export interface HostProjectedWorkspace {
  readonly id: string
  readonly name: string
  readonly path: string
  readonly pinned: boolean
  readonly updatedAt: number
}

/** Provider execution outcome, kept distinct from round and mission outcome. */
export interface HostProjectedRun {
  readonly runId: string
  readonly threadId: string
  readonly providerId: string
  readonly providerOutcome: HostRunProjection['providerOutcome']
  readonly startedAt?: number
  readonly endedAt?: number
  readonly modelId?: string
}

/** Authoritative mission timeline row. */
export interface HostProjectedMission {
  readonly missionId: string
  readonly threadId?: string
  readonly title: string
  readonly status: HostMissionProjection['status']
  readonly updatedAt: number
  readonly activeRoundId?: string
}

/** Compact routing facts shared by a round or the current Host projection. */
export interface HostProjectedRouting {
  readonly mode: string
  readonly fanout: string
  readonly activeParticipantId?: string
  readonly continuationHops?: number
  readonly maxContinuationHops?: number
  readonly bossParticipantId?: string
  readonly captainParticipantId?: string
}

export interface HostProjectedWave {
  readonly waveId: string
  readonly label?: string
  readonly status: string
  readonly participantIds: readonly string[]
}

/** Round timeline row; provider outcomes remain joined through providerRunIds. */
export interface HostProjectedRound {
  readonly roundId: string
  readonly threadId: string
  readonly status: HostRoundProjection['status']
  readonly startedAt?: number
  readonly endedAt?: number
  readonly routing?: HostProjectedRouting
  readonly waves: readonly HostProjectedWave[]
  readonly participantIds: readonly string[]
  readonly providerRunIds: readonly string[]
}

/** Every ensemble seat remains visible, including disabled and inactive seats. */
export interface HostProjectedParticipant {
  readonly id: string
  readonly threadId: string
  readonly providerId: string
  readonly role: string
  readonly modelId?: string
  readonly stage?: HostParticipantProjection['stage']
  readonly order: number
  readonly enabled: boolean
  readonly status?: string
  readonly active: boolean
}

/**
 * Host health as Desktop should render it.
 *
 * These fields come straight from Host and are NOT merged with client
 * connectivity: a client that cannot reach a healthy Host is a client problem,
 * and conflating the two misreports Host state (Rule 3).
 */
export interface HostProjectedHealth {
  readonly hostStatus: HostHealthProjection['hostStatus']
  readonly supervised: boolean
  readonly detail?: string
}

/**
 * Usage, or an honest absence.
 *
 * Both numbers are `undefined` when Host reports `unavailable`; they are never
 * coerced to zero. `availability` is carried through verbatim so a view can
 * say "unknown" rather than implying a measured nil.
 */
export interface HostProjectedUsage {
  readonly availability: HostUsageObservation['availability']
  readonly costUsd?: number
  readonly tokens?: number
}

export interface HostProjectedSnapshot {
  readonly generation: number
  readonly cursor: number
  readonly generatedAt: string
  readonly freshness: HostProjectionFreshnessLabel
  readonly health: HostProjectedHealth
  readonly workspaces: readonly HostProjectedWorkspace[]
  readonly threads: readonly HostProjectedThread[]
  readonly runs: readonly HostProjectedRun[]
  readonly missions: readonly HostProjectedMission[]
  readonly rounds: readonly HostProjectedRound[]
  readonly participants: readonly HostProjectedParticipant[]
  readonly providers: readonly HostProjectedProvider[]
  readonly routing?: HostProjectedRouting
  /** Question rows Host already sends — allowlisted; never answer bodies. */
  readonly questions: readonly HostProjectedQuestion[]
  /** AWAITING approval cards only — never the decided/ledger history. */
  readonly approvals: readonly HostProjectedApproval[]
  readonly usage: HostProjectedUsage
  /**
   * Wave 5d — the typed `code` of every Host warning, in wire order.
   *
   * Views match on CODE, never on `message`. Prose matching is the bug class
   * this repo already hit, where a predicate whose entire job was proving
   * connection was satisfied by the string "Host is not connected". Messages
   * are for humans; codes are for logic.
   */
  readonly warningCodes: readonly string[]
  /** Counts only — never the underlying rows. */
  readonly counts: {
    readonly runs: number
    readonly missions: number
    readonly rounds: number
    readonly questions: number
    readonly approvals: number
    readonly warnings: number
  }
}

/* ------------------------------------------------------------------ */
/*  Honest field mappers                                              */
/* ------------------------------------------------------------------ */

/**
 * Usage → view, preserving "we do not know".
 *
 * Rule 2 lives here. `unavailable` yields `undefined` for both numbers, and a
 * numeric field is emitted only when Host actually supplied a finite number.
 */
export function projectUsage(usage: HostUsageObservation | undefined): HostProjectedUsage {
  if (!usage || usage.availability === 'unavailable') {
    return { availability: usage?.availability ?? 'unavailable' }
  }
  const record = usage as HostUsageObservation & {
    costUsd?: unknown
    tokens?: unknown
  }
  const costUsd =
    typeof record.costUsd === 'number' && Number.isFinite(record.costUsd)
      ? record.costUsd
      : undefined
  const tokens =
    typeof record.tokens === 'number' && Number.isFinite(record.tokens) ? record.tokens : undefined
  return {
    availability: usage.availability,
    ...(costUsd !== undefined ? { costUsd } : {}),
    ...(tokens !== undefined ? { tokens } : {})
  }
}

/**
 * Health → view. Rule 3 lives here: this reads ONLY Host-reported health and
 * accepts no client connection flag, so a transport failure cannot be
 * laundered into a Host status.
 */
export function projectHealth(health: HostHealthProjection): HostProjectedHealth {
  return {
    hostStatus: health.hostStatus,
    supervised: health.supervised,
    ...(health.detail ? { detail: health.detail } : {})
  }
}

function projectThread(thread: HostThreadProjection): HostProjectedThread {
  return {
    id: thread.id,
    workspaceId: thread.workspaceId ?? null,
    title: thread.title,
    chatKind: thread.chatKind === 'ensemble' ? 'ensemble' : 'single',
    archived: thread.archived,
    pinned: thread.pinned,
    updatedAt: thread.updatedAt,
    messageCount: thread.messageCount,
    ...(thread.latestPreview ? { preview: thread.latestPreview } : {}),
    previewTruncated: thread.previewTruncated === true,
    ...(thread.providerId ? { providerId: thread.providerId } : {})
  }
}

function projectApproval(approval: HostApprovalProjection): HostProjectedApproval {
  // Field-by-field, same reason as projectProvider: a spread would forward
  // whatever Host adds to this record later, including `summary`, which is
  // prose. An allowlist keeps the boundary something this layer ENFORCES.
  return {
    approvalId: approval.approvalId,
    commandId: approval.commandId,
    status: approval.status,
    actionKind: approval.actionKind,
    createdAt: approval.createdAt,
    ...(approval.threadId ? { threadId: approval.threadId } : {})
  }
}

function projectQuestion(question: HostQuestionProjection): HostProjectedQuestion {
  // Field-by-field, same reason as projectApproval: a spread would forward
  // whatever Host adds later. The leaf needs identity + status + preview; the
  // free-text answer body must never cross this boundary.
  return {
    questionId: question.questionId,
    threadId: question.threadId,
    status: question.status,
    promptPreview: question.promptPreview,
    askedAt: question.askedAt,
    ...(question.answeredAt !== undefined ? { answeredAt: question.answeredAt } : {}),
    ...(question.receiptId ? { receiptId: question.receiptId } : {})
  }
}

function projectProvider(provider: HostProviderModelProjection): HostProjectedProvider {
  // Field-by-field on purpose. A spread would forward whatever Host adds to
  // this record later, and the wire type explicitly promises it never carries
  // credentials. An allowlist makes that promise something this layer ENFORCES
  // rather than something it assumes.
  return {
    providerId: provider.providerId,
    displayProvider: provider.displayProvider,
    shortCode: provider.shortCode,
    available: provider.available === true,
    ...(provider.modelId ? { modelId: provider.modelId } : {}),
    ...(provider.modelLabel ? { modelLabel: provider.modelLabel } : {}),
    ...(provider.hueKey ? { hueKey: provider.hueKey } : {}),
    ...(provider.note ? { note: provider.note } : {})
  }
}

function projectWorkspace(workspace: HostWorkspaceProjection): HostProjectedWorkspace {
  return {
    id: workspace.id,
    name: workspace.name,
    path: workspace.path,
    pinned: workspace.pinned,
    updatedAt: workspace.updatedAt
  }
}

function projectRun(run: HostRunProjection): HostProjectedRun {
  return {
    runId: run.runId,
    threadId: run.threadId,
    providerId: run.providerId,
    providerOutcome: run.providerOutcome,
    ...(run.startedAt !== undefined ? { startedAt: run.startedAt } : {}),
    ...(run.endedAt !== undefined ? { endedAt: run.endedAt } : {}),
    ...(run.modelId ? { modelId: run.modelId } : {})
  }
}

function projectMission(mission: HostMissionProjection): HostProjectedMission {
  return {
    missionId: mission.missionId,
    ...(mission.threadId ? { threadId: mission.threadId } : {}),
    title: mission.title,
    status: mission.status,
    updatedAt: mission.updatedAt,
    ...(mission.activeRoundId ? { activeRoundId: mission.activeRoundId } : {})
  }
}

function projectRouting(routing: HostRoutingProjection): HostProjectedRouting {
  return {
    mode: routing.mode,
    fanout: routing.fanout,
    ...(routing.activeParticipantId ? { activeParticipantId: routing.activeParticipantId } : {}),
    ...(routing.continuationHops !== undefined
      ? { continuationHops: routing.continuationHops }
      : {}),
    ...(routing.maxContinuationHops !== undefined
      ? { maxContinuationHops: routing.maxContinuationHops }
      : {}),
    ...(routing.bossParticipantId ? { bossParticipantId: routing.bossParticipantId } : {}),
    ...(routing.captainParticipantId ? { captainParticipantId: routing.captainParticipantId } : {})
  }
}

function projectWave(wave: HostWaveProjection): HostProjectedWave {
  return {
    waveId: wave.waveId,
    ...(wave.label ? { label: wave.label } : {}),
    status: wave.status,
    participantIds: [...wave.participantIds]
  }
}

function projectRound(round: HostRoundProjection): HostProjectedRound {
  return {
    roundId: round.roundId,
    threadId: round.threadId,
    status: round.status,
    ...(round.startedAt !== undefined ? { startedAt: round.startedAt } : {}),
    ...(round.endedAt !== undefined ? { endedAt: round.endedAt } : {}),
    ...(round.routing ? { routing: projectRouting(round.routing) } : {}),
    waves: (round.waves ?? []).map(projectWave),
    participantIds: [...round.participantIds],
    providerRunIds: [...round.providerRunIds]
  }
}

function projectParticipant(participant: HostParticipantProjection): HostProjectedParticipant {
  return {
    id: participant.id,
    threadId: participant.threadId,
    providerId: participant.providerId,
    role: participant.role,
    ...(participant.modelId ? { modelId: participant.modelId } : {}),
    ...(participant.stage ? { stage: participant.stage } : {}),
    order: participant.order,
    enabled: participant.enabled,
    ...(participant.status ? { status: participant.status } : {}),
    active: participant.active
  }
}

/* ------------------------------------------------------------------ */
/*  Snapshot mapper                                                   */
/* ------------------------------------------------------------------ */

/**
 * Project a HostSnapshot for Desktop rendering.
 *
 * `freshness` is supplied by the CALLER (the store), because the store is the
 * only component that knows whether this snapshot just arrived or is being
 * replayed from cache while Host is unreachable.
 *
 * Host's own freshness is still respected: if Host says the projection it
 * served was itself cached, the result can never be upgraded to `live`. That
 * makes Rule 1 an enforced invariant rather than a convention the caller is
 * trusted to honour.
 */
export function projectHostSnapshot(
  snapshot: HostSnapshot,
  freshness: HostProjectionFreshnessLabel
): HostProjectedSnapshot {
  const hostSaidCached = snapshot.freshness === 'cached' || snapshot.health.freshness === 'cached'
  const effectiveFreshness: HostProjectionFreshnessLabel = hostSaidCached ? 'cached' : freshness

  return {
    generation: snapshot.generation,
    cursor: snapshot.cursor,
    generatedAt: snapshot.generatedAt,
    freshness: effectiveFreshness,
    health: projectHealth(snapshot.health),
    workspaces: snapshot.workspaces.map(projectWorkspace),
    threads: snapshot.threads.map(projectThread),
    runs: snapshot.runs.map(projectRun),
    missions: snapshot.missions.map(projectMission),
    rounds: snapshot.rounds.map(projectRound),
    participants: snapshot.participants.map(projectParticipant),
    providers: snapshot.providers.map(projectProvider),
    ...(snapshot.routing ? { routing: projectRouting(snapshot.routing) } : {}),
    questions: snapshot.questions.map(projectQuestion),
    approvals: snapshot.approvals.map(projectApproval),
    usage: projectUsage(snapshot.usage),
    warningCodes: snapshot.warnings.map((warning) => warning.code),
    counts: {
      runs: snapshot.runs.length,
      missions: snapshot.missions.length,
      rounds: snapshot.rounds.length,
      questions: snapshot.questions.length,
      approvals: snapshot.approvals.length,
      warnings: snapshot.warnings.length
    }
  }
}
