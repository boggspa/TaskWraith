import type {
  ActiveGoalStatus,
  ChatRecord,
  EnsembleFanoutPolicy,
  EnsembleOrchestrationMode,
  EnsembleParticipant,
  EnsembleRoundState
} from '../../../main/store/types'
import { isOllamaModelInstalled } from '../../../shared/ollamaModelAvailability'
import {
  estimateWorstOllamaEnsembleUiPressure,
  ollamaContextPressureMessage,
  type OllamaContextPressureSeverity
} from '../../../main/ollama/OllamaEnsembleContext'
import { activeEnsembleRoundForComposer } from './chatBusyState'
import {
  ensembleFanoutPolicyEnabled,
  normalizeEnsembleFanoutPolicy
} from './ensembleFanoutPolicy'
import { resolveSlashParticipantForChat } from './resolveSlashParticipant'

export interface MultiviewEnsembleComposerProjection {
  participants: EnsembleParticipant[]
  enabledParticipants: EnsembleParticipant[]
  selectedParticipant: EnsembleParticipant | null
  liveRound: EnsembleRoundState | undefined
  currentOrchestrationMode: EnsembleOrchestrationMode
  activeOrchestrationMode: EnsembleOrchestrationMode
  currentFanoutPolicy: EnsembleFanoutPolicy
  activeFanoutPolicy: EnsembleFanoutPolicy
  currentConcurrentMode: boolean
  activeConcurrentMode: boolean
  continuationHops: number
  maxContinuationHops: number
  isRoundRunning: boolean
  roundStatus: EnsembleRoundState['status'] | undefined
  activeGoalStatus: ActiveGoalStatus | null
  providerBlendStyle: Record<string, string>
  ollamaContextWarning: {
    severity: OllamaContextPressureSeverity
    message: string
    suggestedChars: number
    clampContextChars: boolean
  } | null
}

export interface MultiviewEnsembleSelectionOwnership {
  selectedParticipantIdByChatId: Record<string, string>
  userOverrodeSelectionRoundKeys: Set<string>
}

/**
 * Applies a main-owned queued-prompt removal to the newest renderer snapshot.
 * Queue additions are append-only, so a still-present captured prefix can be
 * replaced while preserving anything appended during the IPC round trip. If
 * the latest queue has already advanced or diverged, it remains authoritative.
 */
export function mergeEnsembleQueuedPromptMutationResult(
  capturedQueue: string[],
  remainingQueue: string[],
  latestQueue: string[]
): string[] {
  const capturedStillPrefixesLatest = capturedQueue.every(
    (prompt, index) => latestQueue[index] === prompt
  )
  return capturedStillPrefixesLatest
    ? [...remainingQueue, ...latestQueue.slice(capturedQueue.length)]
    : latestQueue
}

/**
 * Drops renderer-local selection ownership once its chat, participant, or live
 * round no longer exists. This keeps resting panes from accumulating stale
 * round override keys without sacrificing selection retention for open chats.
 */
export function pruneMultiviewEnsembleSelectionOwnership(
  chats: ChatRecord[],
  selectedParticipantIdByChatId: Record<string, string>,
  userOverrodeSelectionRoundKeys: Set<string>
): MultiviewEnsembleSelectionOwnership {
  const validParticipantIdsByChat = new Map<string, Set<string>>()
  const liveRoundKeys = new Set<string>()

  for (const chat of chats) {
    if (chat.chatKind !== 'ensemble' || !chat.ensemble) continue
    validParticipantIdsByChat.set(
      chat.appChatId,
      new Set(chat.ensemble.participants.map((participant) => participant.id))
    )
    const liveRound = activeEnsembleRoundForComposer(chat.ensemble.activeRound)
    if (liveRound?.roundId) {
      liveRoundKeys.add(`${chat.appChatId}:${liveRound.roundId}`)
    }
  }

  let nextSelectedParticipantIds = selectedParticipantIdByChatId
  for (const [chatId, participantId] of Object.entries(selectedParticipantIdByChatId)) {
    if (validParticipantIdsByChat.get(chatId)?.has(participantId)) continue
    if (nextSelectedParticipantIds === selectedParticipantIdByChatId) {
      nextSelectedParticipantIds = { ...selectedParticipantIdByChatId }
    }
    delete nextSelectedParticipantIds[chatId]
  }

  let nextOverrideKeys = userOverrodeSelectionRoundKeys
  for (const key of userOverrodeSelectionRoundKeys) {
    if (liveRoundKeys.has(key)) continue
    if (nextOverrideKeys === userOverrodeSelectionRoundKeys) {
      nextOverrideKeys = new Set(userOverrodeSelectionRoundKeys)
    }
    nextOverrideKeys.delete(key)
  }

  return {
    selectedParticipantIdByChatId: nextSelectedParticipantIds,
    userOverrodeSelectionRoundKeys: nextOverrideKeys
  }
}

/**
 * Builds the Ensemble composer state for one chat without consulting renderer-
 * global selection or round state. Multiview callers can derive one projection
 * per pane and safely reuse participant ids that also exist in another chat.
 */
export function buildMultiviewEnsembleComposerProjection(
  chat: ChatRecord,
  installedOllamaModels: Array<{ id?: string; contextLength?: number }> = [],
  selectedParticipantId?: string | null
): MultiviewEnsembleComposerProjection {
  const participants = [...(chat.ensemble?.participants || [])].sort(
    (left, right) => left.order - right.order
  )
  const enabledParticipants = participants.filter((participant) => participant.enabled)
  const liveRound = activeEnsembleRoundForComposer(chat.ensemble?.activeRound)
  const selectedParticipant =
    (selectedParticipantId
      ? participants.find((participant) => participant.id === selectedParticipantId)
      : null) || resolveSlashParticipantForChat(chat)
  const currentOrchestrationMode: EnsembleOrchestrationMode =
    chat.ensemble?.orchestrationMode === 'continuous' ? 'continuous' : 'turn_bound'
  const activeOrchestrationMode = liveRound?.orchestrationMode ?? currentOrchestrationMode
  const currentFanoutPolicy = normalizeEnsembleFanoutPolicy(
    chat.ensemble?.fanoutPolicy,
    chat.ensemble?.concurrentModeEnabled
  )
  const activeFanoutPolicy =
    liveRound?.fanoutPolicy !== undefined || liveRound?.concurrentMode !== undefined
      ? normalizeEnsembleFanoutPolicy(liveRound.fanoutPolicy, liveRound.concurrentMode)
      : currentFanoutPolicy
  const ollamaParticipants = participants.filter(
    (participant) => participant.enabled && participant.provider === 'ollama'
  )
  const explicitOllamaContextLengths = ollamaParticipants
    .map(
      (participant) =>
        installedOllamaModels.find(
          (model) => model.id && isOllamaModelInstalled(participant.model || '', [model.id])
        )?.contextLength
    )
    .filter(
      (contextLength): contextLength is number =>
        typeof contextLength === 'number' &&
        Number.isFinite(contextLength) &&
        contextLength >= 2048
    )
  const ollamaPressure =
    ollamaParticipants.length > 0
      ? estimateWorstOllamaEnsembleUiPressure({
          configuredContextChars: chat.ensemble?.ensembleContextChars,
          participantCount: enabledParticipants.length,
          ollamaParticipants: ollamaParticipants.map((participant) => ({
            modelId: participant.model,
            ollamaContextLength: installedOllamaModels.find(
              (model) =>
                model.id && isOllamaModelInstalled(participant.model || '', [model.id])
            )?.contextLength
          })),
          toolsEnabled: chat.scope !== 'global'
        })
      : null

  return {
    participants,
    enabledParticipants,
    selectedParticipant,
    liveRound,
    currentOrchestrationMode,
    activeOrchestrationMode,
    currentFanoutPolicy,
    activeFanoutPolicy,
    currentConcurrentMode: ensembleFanoutPolicyEnabled(currentFanoutPolicy),
    activeConcurrentMode: ensembleFanoutPolicyEnabled(activeFanoutPolicy),
    continuationHops: liveRound?.continuationHops ?? 0,
    maxContinuationHops:
      chat.ensemble?.maxContinuationHops ?? liveRound?.maxContinuationHops ?? 6,
    isRoundRunning: Boolean(liveRound),
    roundStatus: liveRound?.status,
    activeGoalStatus: chat.activeGoal?.status ?? null,
    providerBlendStyle: enabledParticipants.slice(0, 4).reduce<Record<string, string>>(
      (style, participant, index) => {
        style[`--ensemble-provider-${index + 1}`] =
          `var(--provider-${participant.provider}-color)`
        return style
      },
      {}
    ),
    ollamaContextWarning: ollamaPressure
      ? {
          severity: ollamaPressure.severity,
          message: ollamaContextPressureMessage(ollamaPressure),
          suggestedChars: ollamaPressure.effectiveTranscriptChars,
          clampContextChars: explicitOllamaContextLengths.some(
            (contextLength) => contextLength < 128 * 1024
          )
        }
      : null
  }
}
