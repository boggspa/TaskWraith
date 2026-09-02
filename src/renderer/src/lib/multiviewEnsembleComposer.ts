import type {
  ActiveGoalStatus,
  ChatRecord,
  EnsembleFanoutPolicy,
  EnsembleParticipant,
  EnsembleRoundState
} from '../../../main/store/types'
import { activeEnsembleRoundForComposer } from './chatBusyState'
import { normalizeEnsembleFanoutPolicy } from './ensembleFanoutPolicy'
import { resolveProviderHueClass } from './ollamaDisplayBrand'
import { overlayPendingEnsembleSeatSelections } from './pendingEnsembleSeatSelection'
import { resolveSlashParticipantForChat } from './resolveSlashParticipant'

export interface MultiviewEnsembleComposerProjection {
  participants: EnsembleParticipant[]
  enabledParticipants: EnsembleParticipant[]
  selectedParticipant: EnsembleParticipant | null
  liveRound: EnsembleRoundState | undefined
  currentFanoutPolicy: EnsembleFanoutPolicy
  activeFanoutPolicy: EnsembleFanoutPolicy
  continuationHops: number
  maxContinuationHops: number
  isRoundRunning: boolean
  roundStatus: EnsembleRoundState['status'] | undefined
  activeGoalStatus: ActiveGoalStatus | null
  providerBlendStyle: Record<string, string>
}

export interface MultiviewEnsembleSelectionOwnership {
  selectedParticipantIdByChatId: Record<string, string>
  userOverrodeSelectionRoundKeys: Set<string>
}

export interface MultiviewEnsembleSelectionPruneSnapshot {
  chats: ChatRecord[]
  ownershipKey: string
}

export function buildEnsembleProviderBlendStyle(
  participants: readonly Pick<EnsembleParticipant, 'provider' | 'model'>[]
): Record<string, string> {
  return participants.slice(0, 4).reduce<Record<string, string>>((style, participant, index) => {
    const providerClass = resolveProviderHueClass(participant.provider, participant.model)
    style[`--ensemble-provider-${index + 1}`] = `var(--provider-${providerClass}-color)`
    return style
  }, {})
}

export function isMultiviewEnsembleParticipantSelectionValid(
  chat: ChatRecord | null | undefined,
  participantId: string
): boolean {
  return Boolean(
    chat?.chatKind === 'ensemble' &&
    chat.ensemble?.participants.some((participant) => participant.id === participantId)
  )
}

/**
 * Projects the live speaker without mutating the renderer's user-owned
 * participant selection. A per-round manual override wins while that round is
 * live; once it becomes terminal, the caller's resting selection is restored.
 */
export function resolveMultiviewEnsembleParticipantSelection(
  chat: ChatRecord | null | undefined,
  userSelectedParticipantId: string | null | undefined,
  userOverrodeSelectionRoundKeys: ReadonlySet<string>
): string | null {
  const liveRound = activeEnsembleRoundForComposer(chat?.ensemble?.activeRound)
  const roundKey =
    chat?.appChatId && liveRound?.roundId ? `${chat.appChatId}:${liveRound.roundId}` : null
  const activeParticipantId = liveRound?.activeParticipantId
  const validUserSelection =
    userSelectedParticipantId &&
    isMultiviewEnsembleParticipantSelectionValid(chat, userSelectedParticipantId)
      ? userSelectedParticipantId
      : null
  const hasValidManualOverride = Boolean(
    validUserSelection && roundKey && userOverrodeSelectionRoundKeys.has(roundKey)
  )
  if (
    activeParticipantId &&
    isMultiviewEnsembleParticipantSelectionValid(chat, activeParticipantId) &&
    !hasValidManualOverride
  ) {
    return activeParticipantId
  }
  return validUserSelection
}

/**
 * Builds a stable key from only the fields that renderer-local selection
 * cleanup owns. The caller supplies the reconciled, hydrated chat-map values;
 * unlike the referentially unstable list/stream snapshots, that map preserves
 * live pane records and has already discarded genuinely deleted chats.
 */
export function buildMultiviewEnsembleSelectionPruneSnapshot(
  authoritativeChats: Iterable<ChatRecord>
): MultiviewEnsembleSelectionPruneSnapshot {
  const chats = Array.from(authoritativeChats)
  const ownershipKey = JSON.stringify(
    chats
      .map((chat) => {
        const liveRound = activeEnsembleRoundForComposer(chat.ensemble?.activeRound)
        return [
          chat.appChatId,
          chat.chatKind === 'ensemble' && chat.ensemble ? 'ensemble' : 'other',
          chat.chatKind === 'ensemble' && chat.ensemble
            ? chat.ensemble.participants.map((participant) => participant.id).sort()
            : [],
          liveRound?.roundId || null
        ]
      })
      .sort(([leftId], [rightId]) => String(leftId).localeCompare(String(rightId)))
  )

  return { chats, ownershipKey }
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
  selectedParticipantId?: string | null,
  pendingParticipantSelections?: Record<string, EnsembleParticipant>
): MultiviewEnsembleComposerProjection {
  const participants = overlayPendingEnsembleSeatSelections(
    [...(chat.ensemble?.participants || [])].sort((left, right) => left.order - right.order),
    pendingParticipantSelections
  )
  const enabledParticipants = participants.filter((participant) => participant.enabled)
  const liveRound = activeEnsembleRoundForComposer(chat.ensemble?.activeRound)
  const fallbackParticipantId = resolveSlashParticipantForChat(chat)?.id
  const selectedParticipant =
    participants.find(
      (participant) => participant.id === (selectedParticipantId || fallbackParticipantId)
    ) || null
  const currentFanoutPolicy = normalizeEnsembleFanoutPolicy(
    chat.ensemble?.fanoutPolicy,
    chat.ensemble?.concurrentModeEnabled
  )
  const activeFanoutPolicy =
    liveRound?.fanoutPolicy !== undefined || liveRound?.concurrentMode !== undefined
      ? normalizeEnsembleFanoutPolicy(liveRound.fanoutPolicy, liveRound.concurrentMode)
      : currentFanoutPolicy
  return {
    participants,
    enabledParticipants,
    selectedParticipant,
    liveRound,
    currentFanoutPolicy,
    activeFanoutPolicy,
    continuationHops: liveRound?.continuationHops ?? 0,
    maxContinuationHops: chat.ensemble?.maxContinuationHops ?? liveRound?.maxContinuationHops ?? 6,
    isRoundRunning: Boolean(liveRound),
    roundStatus: liveRound?.status,
    activeGoalStatus: chat.activeGoal?.status ?? null,
    providerBlendStyle: buildEnsembleProviderBlendStyle(enabledParticipants)
  }
}
