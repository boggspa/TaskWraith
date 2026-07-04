import type {
  ChatRecord,
  EnsembleParticipant,
  EnsembleRoundParticipantState,
  ProviderId
} from '../../../main/store/types'
import { reasoningDisplayLabel, shortModelName } from './composerChipFormat'
import { humaniseModelId } from './modelDisplayName'
import { resolveOllamaDisplayBrand } from './ollamaDisplayBrand'
import { getProviderLabel } from './providerLabels'

export type WorkingIndicatorPresentation = {
  providerLabel: string
  provider: ProviderId | null
  providerClass: string | null
  roleLabel: string | null
  modelBadge: string | null
}

const LIVE_ROUND_PARTICIPANT_STATUSES = new Set(['idle', 'running', 'sleeping'])
const LIVE_LANE_STATUSES = new Set(['pending', 'running', 'blocked', 'awaiting-approval'])

function modelBadgeForParticipant(participant: EnsembleParticipant): string | null {
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
    kimiThinkingEnabled:
      participant.provider === 'kimi' ? participant.thinkingEnabled : undefined
  })
  return reasoningSuffix ? `${baseModelName} ${reasoningSuffix}` : baseModelName
}

function activeParticipantId(chat: ChatRecord): string | undefined {
  const round = chat.ensemble?.activeRound
  if (!round || round.status !== 'running') return undefined
  if (round.activeParticipantId) return round.activeParticipantId

  const activeLane = Object.values(round.lanes || {}).find((lane) =>
    LIVE_LANE_STATUSES.has(lane.status)
  )
  if (activeLane?.participantId) return activeLane.participantId

  return round.participants.find((participant) =>
    LIVE_ROUND_PARTICIPANT_STATUSES.has(participant.status)
  )?.participantId
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

function workingPresentationForParticipant(
  chat: ChatRecord,
  participantId: string
): WorkingIndicatorPresentation | null {
  const participant = chat.ensemble?.participants.find((item) => item.id === participantId)
  const roundParticipant = roundParticipantForId(chat, participantId)
  const provider = participant?.provider || roundParticipant?.provider || null
  if (!provider) return null

  const roleLabel = (participant?.role || roundParticipant?.role || '').trim() || null
  const model = participant?.model || ''
  const brand =
    provider === 'ollama' && model
      ? resolveOllamaDisplayBrand(model, humaniseModelId('ollama', model))
      : null

  return {
    providerLabel: brand?.providerLabel || getProviderLabel(provider),
    provider,
    providerClass: brand?.providerClass || provider,
    roleLabel,
    modelBadge: participant ? modelBadgeForParticipant(participant) : null
  }
}

export function deriveActiveEnsembleWorkingPresentation(
  chat: ChatRecord | null | undefined
): WorkingIndicatorPresentation | null {
  if (chat?.chatKind !== 'ensemble') return null
  const participantId = activeParticipantId(chat)
  if (!participantId) return null
  return workingPresentationForParticipant(chat, participantId)
}

export function deriveActiveEnsembleWorkingPresentations(
  chat: ChatRecord | null | undefined
): WorkingIndicatorPresentation[] {
  if (chat?.chatKind !== 'ensemble') return []
  const round = chat.ensemble?.activeRound
  const lanes = Object.values(round?.lanes || {})
  if (!round || round.status !== 'running' || round.concurrentMode !== true || lanes.length === 0) {
    return []
  }
  if (round.fanoutPolicy === 'off') return []

  const liveParticipantIds = new Set<string>()
  for (const lane of lanes) {
    if (LIVE_LANE_STATUSES.has(lane.status)) {
      liveParticipantIds.add(lane.participantId)
    }
  }

  return Array.from(liveParticipantIds)
    .sort((left, right) => {
      const orderDelta = participantOrder(chat, left) - participantOrder(chat, right)
      if (orderDelta !== 0) return orderDelta
      return left.localeCompare(right)
    })
    .map((participantId) => workingPresentationForParticipant(chat, participantId))
    .filter((presentation): presentation is WorkingIndicatorPresentation => Boolean(presentation))
}
