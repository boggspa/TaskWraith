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

function roundParticipantForId(
  chat: ChatRecord,
  participantId: string
): EnsembleRoundParticipantState | undefined {
  return chat.ensemble?.activeRound?.participants.find(
    (participant) => participant.participantId === participantId
  )
}

export function deriveActiveEnsembleWorkingPresentation(
  chat: ChatRecord | null | undefined
): WorkingIndicatorPresentation | null {
  if (chat?.chatKind !== 'ensemble') return null
  const participantId = activeParticipantId(chat)
  if (!participantId) return null

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
