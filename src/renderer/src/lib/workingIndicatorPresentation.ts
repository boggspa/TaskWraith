import type {
  ChatRecord,
  ChatRun,
  ConcurrentLane,
  EnsembleParticipant,
  EnsembleParticipantStatus,
  EnsembleRoundParticipantState,
  ProviderId
} from '../../../main/store/types'
import type { ContextCompactionProgressEvent } from '../../../shared/contextCompaction'
import { LIVE_ENSEMBLE_LANE_STATUSES } from '../../../shared/ensembleRoundLifecycle'
import { reasoningDisplayLabel, shortModelName } from './composerChipFormat'
import { humaniseModelId } from './modelDisplayName'
import { resolveOllamaDisplayBrand, resolveProviderHueClass } from './ollamaDisplayBrand'
import { getProviderLabel } from './providerLabels'

export type WorkingIndicatorActivity = 'working' | 'compacting'

export type WorkingIndicatorPresentation = {
  /** Stable seat identity; null only for a non-Ensemble fallback row. */
  participantId: string | null
  /** The specific active turn/lane, so retries reset timer + token telemetry. */
  runId: string | null
  /** Per-turn anchor. Fan-out lanes deliberately do not use round.startedAt. */
  startedAt: string | null
  /** Durable accumulator from completed participant turns. */
  tokenAccumulatorBase: number
  providerLabel: string
  provider: ProviderId | null
  providerClass: string | null
  roleLabel: string | null
  modelBadge: string | null
  activity: WorkingIndicatorActivity
}

export type WorkingIndicatorProviderPresentation = {
  providerLabel: string
  providerClass: string
  modelBadge: string | null
}

export function resolveWorkingIndicatorProviderPresentation(
  provider: ProviderId,
  model = ''
): WorkingIndicatorProviderPresentation {
  const ollamaBrand =
    provider === 'ollama' && model
      ? resolveOllamaDisplayBrand(model, humaniseModelId('ollama', model))
      : null
  return {
    providerLabel:
      ollamaBrand?.providerLabel ||
      (provider === 'ollama' && model
        ? humaniseModelId('ollama', model)
        : getProviderLabel(provider)),
    providerClass: resolveProviderHueClass(provider, model) || provider,
    modelBadge:
      ollamaBrand?.modelLabel ||
      (provider === 'pi' && model ? shortModelName(provider, '', model) : null)
  }
}

const LIVE_ROUND_PARTICIPANT_STATUSES = new Set(['idle', 'running', 'sleeping'])
// The shared predicate, not a private copy. Three surfaces must agree on which
// lane states mean "this seat has not finished" — round liveness, these
// presentations, and the remote projection that tells the phone which lane
// cards to shimmer — and a copy that drifts leaves a card marked busy after its
// seat finished.
const LIVE_LANE_STATUSES = LIVE_ENSEMBLE_LANE_STATUSES

type ParticipantModelDisplay = Pick<
  EnsembleParticipant,
  'provider' | 'model' | 'reasoningEffort' | 'thinkingEnabled'
>

function isLiveRoundParticipantStatus(status: EnsembleParticipantStatus | undefined): boolean {
  return Boolean(status && LIVE_ROUND_PARTICIPANT_STATUSES.has(status))
}

function modelBadgeForParticipant(participant: ParticipantModelDisplay): string | null {
  const model = participant.model || ''
  if (!model) return null
  const baseModelName = shortModelName(participant.provider, '', model)
  if (!baseModelName) return null

  const brand =
    participant.provider === 'ollama'
      ? resolveOllamaDisplayBrand(model, humaniseModelId('ollama', model))
      : null
  if (brand?.modelLabel) return brand.modelLabel

  const reasoningSuffix = reasoningDisplayLabel({
    provider: participant.provider,
    composerStyle: 'default',
    modelId: model,
    modelLabel: '',
    codexReasoningEffort:
      participant.provider === 'codex' ? participant.reasoningEffort : undefined,
    claudeReasoningEffort:
      participant.provider === 'claude' ? participant.reasoningEffort : undefined,
    kimiReasoningEffort:
      participant.provider === 'kimi' ? participant.reasoningEffort : undefined,
    kimiThinkingEnabled: participant.provider === 'kimi' ? participant.thinkingEnabled : undefined
  })
  return reasoningSuffix ? `${baseModelName} ${reasoningSuffix}` : baseModelName
}

function activeParticipantId(chat: ChatRecord): string | undefined {
  const round = chat.ensemble?.activeRound
  if (!round || round.status !== 'running') return undefined
  if (round.activeParticipantId) {
    const participant = roundParticipantForId(chat, round.activeParticipantId)
    if (!participant || isLiveRoundParticipantStatus(participant.status)) {
      return round.activeParticipantId
    }
  }

  const activeLane = Object.values(round.lanes || {}).find((lane) =>
    LIVE_LANE_STATUSES.has(lane.status)
  )
  if (activeLane?.participantId) return activeLane.participantId

  return round.participants.find((participant) => isLiveRoundParticipantStatus(participant.status))
    ?.participantId
}

function compactingParticipantIds(
  chat: ChatRecord,
  contextCompactionProgress: readonly ContextCompactionProgressEvent[]
): string[] {
  const ids = new Set<string>()
  for (const event of contextCompactionProgress) {
    if (
      event.status === 'started' &&
      event.chatId === chat.appChatId &&
      typeof event.participantId === 'string' &&
      event.participantId
    ) {
      ids.add(event.participantId)
    }
  }
  return Array.from(ids)
}

function participantOrder(chat: ChatRecord, participantId: string): number {
  const participant = chat.ensemble?.participants.find((item) => item.id === participantId)
  if (typeof participant?.order === 'number') return participant.order
  const roundParticipant = roundParticipantForId(chat, participantId)
  if (typeof roundParticipant?.order === 'number') return roundParticipant.order
  return Number.MAX_SAFE_INTEGER
}

function roundParticipantForId(
  chat: ChatRecord,
  participantId: string
): EnsembleRoundParticipantState | undefined {
  return chat.ensemble?.activeRound?.participants.find(
    (participant) => participant.participantId === participantId
  )
}

function latestLiveLaneForParticipant(
  chat: ChatRecord,
  participantId: string
): ConcurrentLane | undefined {
  const lanes = Object.values(chat.ensemble?.activeRound?.lanes || {}).filter(
    (lane) => lane.participantId === participantId && LIVE_LANE_STATUSES.has(lane.status)
  )
  if (lanes.length === 0) return undefined
  return lanes.reduce((latest, lane) => {
    const latestTime = Date.parse(latest.startedAt || '')
    const laneTime = Date.parse(lane.startedAt || '')
    return Number.isFinite(laneTime) && (!Number.isFinite(latestTime) || laneTime > latestTime)
      ? lane
      : latest
  })
}

function activeRunForParticipant(
  chat: ChatRecord,
  participantId: string,
  preferredRunId?: string
): ChatRun | undefined {
  if (preferredRunId) {
    const preferred = chat.runs.find((run) => run.runId === preferredRunId)
    if (preferred) return preferred
  }
  const runs = chat.runs.filter(
    (run) =>
      run.ensembleParticipantId === participantId &&
      (!run.endedAt || run.status === 'running' || run.status === 'queued')
  )
  return runs.reduce<ChatRun | undefined>((latest, run) => {
    if (!latest) return run
    const latestTime = Date.parse(latest.startedAt || '')
    const runTime = Date.parse(run.startedAt || '')
    return Number.isFinite(runTime) && (!Number.isFinite(latestTime) || runTime > latestTime)
      ? run
      : latest
  }, undefined)
}

function participantTokenAccumulatorBase(participant: EnsembleParticipant | undefined): number {
  const value = Number(participant?.tokenTotals?.total_tokens)
  return Number.isFinite(value) && value > 0 ? Math.trunc(value) : 0
}

function modelDisplayForParticipant(
  provider: ProviderId,
  roundParticipant: EnsembleRoundParticipantState | undefined,
  participant: EnsembleParticipant | undefined
): ParticipantModelDisplay | null {
  if (roundParticipant?.model) {
    return {
      provider,
      model: roundParticipant.model,
      reasoningEffort: roundParticipant.reasoningEffort,
      thinkingEnabled: roundParticipant.thinkingEnabled
    }
  }
  if (participant?.provider === provider && participant.model) {
    return {
      provider,
      model: participant.model,
      reasoningEffort: participant.reasoningEffort,
      thinkingEnabled: participant.thinkingEnabled
    }
  }
  return null
}

function activityForParticipant(
  chat: ChatRecord,
  participantId: string,
  contextCompactionProgress: readonly ContextCompactionProgressEvent[]
): WorkingIndicatorActivity {
  return contextCompactionProgress.some(
    (event) =>
      event.status === 'started' &&
      event.chatId === chat.appChatId &&
      event.participantId === participantId
  )
    ? 'compacting'
    : 'working'
}

function workingPresentationForParticipant(
  chat: ChatRecord,
  participantId: string,
  contextCompactionProgress: readonly ContextCompactionProgressEvent[]
): WorkingIndicatorPresentation | null {
  const participant = chat.ensemble?.participants.find((item) => item.id === participantId)
  const roundParticipant = roundParticipantForId(chat, participantId)
  const lane = latestLiveLaneForParticipant(chat, participantId)
  const run = activeRunForParticipant(chat, participantId, lane?.runId || roundParticipant?.runId)
  const provider = roundParticipant?.provider || participant?.provider || null
  if (!provider) return null

  const roleLabel = (roundParticipant?.role || participant?.role || '').trim() || null
  const modelDisplay = modelDisplayForParticipant(provider, roundParticipant, participant)
  const model = modelDisplay?.model || ''
  const providerPresentation = resolveWorkingIndicatorProviderPresentation(provider, model)

  return {
    participantId,
    runId: lane?.runId || roundParticipant?.runId || run?.runId || null,
    startedAt:
      lane?.startedAt ||
      roundParticipant?.startedAt ||
      run?.startedAt ||
      chat.ensemble?.activeRound?.startedAt ||
      null,
    tokenAccumulatorBase: participantTokenAccumulatorBase(participant),
    providerLabel: providerPresentation.providerLabel,
    provider,
    // Pi wire ids include the actual upstream, just as Ollama model ids can.
    // Keep the working animation on that display-brand hue rather than the
    // neutral Pi seat colour (e.g. DeepSeek blue for a DeepSeek Pi run).
    providerClass: providerPresentation.providerClass,
    roleLabel,
    modelBadge: modelDisplay ? modelBadgeForParticipant(modelDisplay) : null,
    activity: activityForParticipant(chat, participantId, contextCompactionProgress)
  }
}

export function deriveActiveEnsembleWorkingPresentation(
  chat: ChatRecord | null | undefined,
  contextCompactionProgress: readonly ContextCompactionProgressEvent[] = []
): WorkingIndicatorPresentation | null {
  if (chat?.chatKind !== 'ensemble') return null
  const participantId =
    activeParticipantId(chat) || compactingParticipantIds(chat, contextCompactionProgress)[0]
  if (!participantId) return null
  return workingPresentationForParticipant(chat, participantId, contextCompactionProgress)
}

export function deriveActiveEnsembleWorkingPresentations(
  chat: ChatRecord | null | undefined,
  contextCompactionProgress: readonly ContextCompactionProgressEvent[] = []
): WorkingIndicatorPresentation[] {
  if (chat?.chatKind !== 'ensemble') return []
  const round = chat.ensemble?.activeRound
  const lanes = Object.values(round?.lanes || {})
  const compactingIds = compactingParticipantIds(chat, contextCompactionProgress)
  const isConcurrentFanout =
    Boolean(round) &&
    round?.status === 'running' &&
    round.concurrentMode === true &&
    lanes.length > 0 &&
    round.fanoutPolicy !== 'off'
  // `concurrentMode` is stamped once at `beginRound` from the requested fan-out
  // policy and never flipped afterwards, but waves DO open mid-round: a Boss
  // review wave, a scout pass, or a user @mention's additive User Fan-Out —
  // which dispatches on `concurrentLanesEnabled()` alone and so lands even in a
  // round whose own policy is `off`. Gating on the round's DECLARED mode
  // therefore hid every seat those waves had just started, collapsing the stack
  // to the caller's single fallback row for `activeParticipantId`. A live lane
  // is the seat running right now, whatever the round once declared, and it is
  // the same signal `workingParticipantIdsForRound` already projects to iOS.
  const hasLiveFanoutLane =
    round?.status === 'running' && lanes.some((lane) => LIVE_LANE_STATUSES.has(lane.status))
  const isFanoutActive = isConcurrentFanout || hasLiveFanoutLane
  if (!isFanoutActive && compactingIds.length === 0) return []

  const liveParticipantIds = new Set<string>()
  if (compactingIds.length > 0) {
    const activeId = activeParticipantId(chat)
    if (activeId) liveParticipantIds.add(activeId)
  }
  if (isFanoutActive && round?.activeParticipantId) {
    const activeParticipant = roundParticipantForId(chat, round.activeParticipantId)
    if (!activeParticipant || isLiveRoundParticipantStatus(activeParticipant.status)) {
      liveParticipantIds.add(round.activeParticipantId)
    }
  }
  if (isFanoutActive) {
    for (const lane of lanes) {
      if (LIVE_LANE_STATUSES.has(lane.status)) {
        liveParticipantIds.add(lane.participantId)
      }
    }
  }
  for (const participantId of compactingIds) {
    liveParticipantIds.add(participantId)
  }

  return Array.from(liveParticipantIds)
    .sort((left, right) => {
      const orderDelta = participantOrder(chat, left) - participantOrder(chat, right)
      if (orderDelta !== 0) return orderDelta
      return left.localeCompare(right)
    })
    .map((participantId) =>
      workingPresentationForParticipant(chat, participantId, contextCompactionProgress)
    )
    .filter((presentation): presentation is WorkingIndicatorPresentation => Boolean(presentation))
}
