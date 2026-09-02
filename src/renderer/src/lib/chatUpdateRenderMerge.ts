import type {
  ActiveGoal,
  ChatMessage,
  ChatRecord,
  EnsembleParticipant
} from '../../../main/store/types'
import { CHAT_COMPOSER_SELECTION_METADATA_KEYS } from '../../../shared/chatComposerSelectionPatch'
import { PENDING_PROVIDER_CHANGE_KEY } from '../../../shared/providerChangeQueue'
import { isTranscriptPagedShell } from '../../../shared/transcriptPage'
import { anchorPendingAgentQuestionMarkers } from './agentQuestionMarkerAnchor'
import { shouldPreferLiveAssistantContent } from './chatUpdatedAssistantMerge'
import { preserveOptimisticEnsembleQueue } from './queuedMessageRows'
import { TASKWRAITH_CLOSEOUT_KIND } from '../../../shared/taskWraithCloseout'
import type { ChatUpdateRenderReceipt } from './chatUpdateRenderReceipt'

export interface PendingChatUpdateRender {
  chat: ChatRecord
  messagesChanged: boolean
  hasActiveRun: boolean
  hadRecentRun: boolean
  /** Latest transport-accepted delivery awaiting a non-gating render receipt. */
  renderReceipt?: ChatUpdateRenderReceipt
}

/**
 * Fold one accepted transport delivery into the not-yet-rendered frame.
 *
 * `messagesChanged` is measured against the transport baseline, but the
 * pending slot is scoped to the render baseline. Once any accepted delivery
 * changes the transcript, a later metadata-only delivery must not clear that
 * evidence before the frame drains. Keep the newest canonical chat and live
 * run state while treating transcript dirt as a monotone bit for the whole
 * unrendered window.
 */
export function coalescePendingChatUpdateRender(
  previous: PendingChatUpdateRender | undefined,
  next: PendingChatUpdateRender
): PendingChatUpdateRender {
  return previous?.messagesChanged === true && next.messagesChanged === false
    ? { ...next, messagesChanged: true }
    : next
}

export interface ChatUpdateRenderMergeOptions {
  liveChat?: ChatRecord | null
  messagesChanged: boolean
  hasActiveRun: boolean
  hadRecentRun: boolean
  pendingMarkerIds?: ReadonlySet<string>
}

function mergeLiveMessages(
  incomingMessages: readonly ChatMessage[],
  liveMessages: readonly ChatMessage[]
): ChatMessage[] | null {
  const liveById = new Map(liveMessages.map((message) => [message.id, message]))
  let changed = false
  const mergedMessages = incomingMessages.map((message) => {
    const live = liveById.get(message.id)
    if (live && shouldPreferLiveAssistantContent(message, live)) {
      changed = true
      return { ...message, content: live.content }
    }
    return message
  })

  const incomingIds = new Set(incomingMessages.map((message) => message.id))
  const orphanedLiveAssistants = liveMessages.filter(
    (message) => message.role === 'assistant' && !incomingIds.has(message.id)
  )
  const orphanedLiveUserMessages = liveMessages.filter(
    (message) => message.role === 'user' && !incomingIds.has(message.id)
  )
  const orphanedAgentQuestionMarkers = liveMessages.filter(
    (message) =>
      message.role === 'system' &&
      message.metadata?.kind === 'agentQuestion' &&
      !incomingIds.has(message.id)
  )
  const orphanedContextCompactionCards = liveMessages.filter(
    (message) =>
      message.role === 'system' &&
      message.metadata?.kind === 'contextCompaction' &&
      !incomingIds.has(message.id)
  )
  const orphanedTaskWraithCloseouts = liveMessages.filter(
    (message) =>
      message.role === 'system' &&
      message.metadata?.kind === TASKWRAITH_CLOSEOUT_KIND &&
      !incomingIds.has(message.id)
  )
  const orphanIds = new Set(
    [
      ...orphanedLiveAssistants,
      ...orphanedLiveUserMessages,
      ...orphanedAgentQuestionMarkers,
      ...orphanedContextCompactionCards,
      ...orphanedTaskWraithCloseouts
    ].map((message) => message.id)
  )
  const orphans = liveMessages.filter((message) => orphanIds.has(message.id))
  if (orphans.length > 0) changed = true
  if (!changed) return null
  return orphans.length > 0 ? [...mergedMessages, ...orphans] : mergedMessages
}

function preserveLiveTaskWraithCloseouts(
  chat: ChatRecord,
  liveChat: ChatRecord | null | undefined
): ChatRecord {
  if (!liveChat || liveChat.messages.length === 0) return chat
  const incomingIds = new Set(chat.messages.map((message) => message.id))
  const missingCloseouts = liveChat.messages.filter(
    (message) =>
      message.role === 'system' &&
      message.metadata?.kind === TASKWRAITH_CLOSEOUT_KIND &&
      !incomingIds.has(message.id)
  )
  return missingCloseouts.length > 0
    ? { ...chat, messages: [...chat.messages, ...missingCloseouts] }
    : chat
}

function preserveLiveUserMessages(
  chat: ChatRecord,
  liveChat: ChatRecord | null | undefined
): ChatRecord {
  if (!liveChat || liveChat.messages.length === 0) return chat
  const incomingIds = new Set(chat.messages.map((message) => message.id))
  const missingUserMessages = liveChat.messages.filter(
    (message) => message.role === 'user' && !incomingIds.has(message.id)
  )
  return missingUserMessages.length > 0
    ? { ...chat, messages: [...chat.messages, ...missingUserMessages] }
    : chat
}

/** Normalize a chat/goal/ensemble freshness stamp. `ChatRecord.updatedAt` is
 * epoch ms, while renderer-authored `ActiveGoal.updatedAt` and
 * `ensemble.updatedAt` stamps persist ISO strings — accept either shape so a
 * stale-delivery comparison never silently compares a string against a number. */
function stampToMs(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string') {
    const parsed = Date.parse(value)
    if (Number.isFinite(parsed)) return parsed
  }
  return 0
}

function resolveGoalStamp(chat: ChatRecord): number {
  return Math.max(stampToMs(chat.updatedAt), stampToMs(chat.activeGoal?.updatedAt))
}

function sameAuthoredGoal(a: ActiveGoal, b: ActiveGoal): boolean {
  return (
    a.id === b.id &&
    a.status === b.status &&
    a.objective === b.objective &&
    a.updatedAt === b.updatedAt
  )
}

/**
 * 1.0.5-UI2 — A renderer-authored goal edit (the composer Goal popover's
 * Set/Save/Resume/Clear) commits optimistically and persists asynchronously.
 * A main refresh built BEFORE that save lands — an in-flight ensemble run
 * frame, a sub-thread echo — can arrive afterwards and silently revert the
 * goal the user just set or cleared. That presented as "Set Goal sets it,
 * then unsets it" and needed a second click to stick. When the live record is
 * provably fresher than the delivery, its `activeGoal` wins wholesale,
 * including a deliberate absence after Clear. A genuinely newer main-side
 * goal change (native provider sync, remote companion) still wins because its
 * stamp postdates the local edit.
 */
function preserveNewerLocalActiveGoal(
  merged: ChatRecord,
  liveChat: ChatRecord | null | undefined
): ChatRecord {
  if (!liveChat) return merged
  const liveGoal = liveChat.activeGoal
  const deliveredGoal = merged.activeGoal
  if (liveGoal === deliveredGoal) return merged
  // Deliveries round-trip through structured clone, so an identical goal is
  // never identity-equal; compare authored content before treating the field
  // as contested.
  if (liveGoal && deliveredGoal && sameAuthoredGoal(liveGoal, deliveredGoal)) return merged
  if (resolveGoalStamp(liveChat) <= resolveGoalStamp(merged)) return merged
  const next = { ...merged }
  if (liveGoal) next.activeGoal = liveGoal
  else delete next.activeGoal
  return next
}

function resolveRosterStamp(chat: ChatRecord): number {
  return Math.max(stampToMs(chat.updatedAt), stampToMs(chat.ensemble?.updatedAt))
}

function sameRosterSequence(
  left: readonly EnsembleParticipant[],
  right: readonly EnsembleParticipant[]
): boolean {
  if (left.length !== right.length) return false
  for (let index = 0; index < left.length; index += 1) {
    if (left[index].id !== right[index].id) return false
  }
  return true
}

/**
 * The user-editable seat configuration — everything the composer pickers and
 * the roster panel write on a participant. Deliberately excludes main-authored
 * runtime bookkeeping (linkedProviderSessionId, seatGeneration, prompt
 * versions, compaction summaries, token totals, ACP posture): those fields are
 * newest in the DELIVERED record and must never be rolled back to the live
 * copy when only the configuration is being restored.
 */
const ENSEMBLE_SEAT_CONFIGURATION_KEYS = [
  'provider',
  'enabled',
  'role',
  'instructions',
  'order',
  'model',
  'runtimeProfileId',
  'geminiAuthProfileId',
  'ollamaRunProfile',
  'permissionPresetId',
  'permissionOverrides',
  'stageRole',
  'reasoningEffort',
  'fastModeEnabled',
  'thinkingEnabled',
  'serviceTier',
  'pooledAgentId',
  'pooledAgentIdentity'
] as const satisfies readonly (keyof EnsembleParticipant)[]

function seatConfigurationSignature(participant: EnsembleParticipant): string {
  return JSON.stringify(ENSEMBLE_SEAT_CONFIGURATION_KEYS.map((key) => participant[key] ?? null))
}

/** Delivered seat + the live seat's user-editable configuration. An absent
 * live field is restored as absent so a deliberate local clear sticks. */
function overlaySeatConfiguration(
  delivered: EnsembleParticipant,
  live: EnsembleParticipant
): EnsembleParticipant {
  const next = { ...delivered } as unknown as Record<string, unknown>
  for (const key of ENSEMBLE_SEAT_CONFIGURATION_KEYS) {
    const value = live[key]
    if (value === undefined) delete next[key]
    else next[key] = value
  }
  return next as unknown as EnsembleParticipant
}

/**
 * 1.0.5-UI2 — The Add Participant popover commits the new seat optimistically
 * (`buildPersistedChat` stamps `ensemble.updatedAt`) and persists
 * asynchronously. A main refresh captured before that save reaches the store
 * would remove the seat again immediately after the popover's Add click.
 * When the live roster is provably fresher than the delivery and the seat
 * sequences disagree, the live sequence wins. Main-authored roster changes
 * (remote edits, orchestrator reconciliation) carry newer stamps and still
 * apply. Only `participants` (+ its cap floor) are restored — round state and
 * authority bookkeeping in the delivered ensemble stay authoritative so this
 * cannot resurrect a stale round.
 *
 * Third report in the class: a seat FIELD edit (the Provider/Model/Reasoning
 * picker bound to a participant chip, or a seat row in the Add Participant
 * picker) keeps the id sequence identical, so the membership-only comparison
 * above let a staler delivery revert the model the user just picked. When the
 * seats match but their user-editable configuration differs and the live
 * roster is fresher, restore only that configuration per seat — delivered
 * main-authored bookkeeping (session linkage, prompt versions, compaction,
 * token totals) stays, so this cannot break a resumed provider session.
 */
function preserveNewerLocalEnsembleRoster(
  merged: ChatRecord,
  liveChat: ChatRecord | null | undefined
): ChatRecord {
  const liveEnsemble = liveChat?.ensemble
  const deliveredEnsemble = merged.ensemble
  if (!liveChat || !liveEnsemble || !deliveredEnsemble) return merged
  const liveParticipants = liveEnsemble.participants
  const deliveredParticipants = deliveredEnsemble.participants
  if (liveParticipants === deliveredParticipants) return merged
  if (!Array.isArray(liveParticipants) || !Array.isArray(deliveredParticipants)) return merged
  const sameMembership = sameRosterSequence(liveParticipants, deliveredParticipants)
  if (
    sameMembership &&
    liveParticipants.every(
      (participant, index) =>
        seatConfigurationSignature(participant) ===
        seatConfigurationSignature(deliveredParticipants[index])
    )
  ) {
    return merged
  }
  if (resolveRosterStamp(liveChat) <= resolveRosterStamp(merged)) return merged
  if (sameMembership) {
    return {
      ...merged,
      ensemble: {
        ...deliveredEnsemble,
        participants: deliveredParticipants.map((participant, index) =>
          overlaySeatConfiguration(participant, liveParticipants[index])
        )
      }
    }
  }
  return {
    ...merged,
    ensemble: {
      ...deliveredEnsemble,
      participants: liveParticipants,
      maxParticipants: Math.max(
        Number(deliveredEnsemble.maxParticipants) || 0,
        liveParticipants.length
      )
    }
  }
}

/**
 * Same 1.0.5-UI2 class as the goal and roster helpers, reported 2026-08-30 as
 * "I switched Ensemble off and the next refresh forced it back on". A mode
 * switch (the composer's Ensemble toggle, or the solo-provider modal) commits
 * optimistically and persists asynchronously; a main delivery built BEFORE
 * that save lands reverts `chatKind` wholesale. The roster helper cannot catch
 * it — a collapsed live record has no `ensemble` block, so the membership
 * comparison bails — and the selection helper only covers picker keys.
 *
 * When the live record is provably fresher, its mode state wins: `chatKind`,
 * the presence/absence of the `ensemble` block, and the stashed roster a
 * collapse rides on (`providerMetadata.stashedEnsemble`, without which a later
 * Ensemble-on toggle would lose the user's roster). A genuinely newer
 * main-side mode change — this toggle's own confirmed broadcast, a remote
 * companion's switch — still wins on its stamp.
 */
function preserveNewerLocalChatKind(
  merged: ChatRecord,
  liveChat: ChatRecord | null | undefined
): ChatRecord {
  if (!liveChat) return merged
  const liveIsEnsemble = liveChat.chatKind === 'ensemble'
  const deliveredIsEnsemble = merged.chatKind === 'ensemble'
  // A degenerate live record (kind says ensemble but no roster arrived yet)
  // has nothing to defend with; the delivered block is strictly better.
  if (liveIsEnsemble && !liveChat.ensemble) return merged
  const liveStash = liveChat.providerMetadata?.stashedEnsemble
  const deliveredStash = merged.providerMetadata?.stashedEnsemble
  const sameStash =
    JSON.stringify(liveStash ?? null) === JSON.stringify(deliveredStash ?? null)
  if (liveIsEnsemble === deliveredIsEnsemble && sameStash) return merged
  if (stampToMs(liveChat.updatedAt) <= stampToMs(merged.updatedAt)) return merged
  const next: ChatRecord = { ...merged, chatKind: liveIsEnsemble ? 'ensemble' : 'single' }
  if (liveIsEnsemble) {
    next.ensemble = liveChat.ensemble
  } else {
    delete next.ensemble
  }
  if (liveStash === undefined) {
    if (next.providerMetadata && 'stashedEnsemble' in next.providerMetadata) {
      const { stashedEnsemble: _dropped, ...restMetadata } = next.providerMetadata
      if (Object.keys(restMetadata).length > 0) next.providerMetadata = restMetadata
      else delete next.providerMetadata
    }
  } else {
    next.providerMetadata = { ...(next.providerMetadata || {}), stashedEnsemble: liveStash }
  }
  return next
}

/** Local copy by repo convention (see Sidebar.tsx, LinkedChatsStrip.tsx,
 * resolveSlashParticipant.ts) — keeps this merge module dependency-light. */
const SIDE_CHAT_SELECTED_PARTICIPANT_ID_METADATA_KEY = 'sideChatSelectedParticipantId'

/**
 * The chat-level composer-selection slice: everything the Provider/Model/
 * Reasoning picker persists through the selection-patch overlay, plus the
 * queued provider change and the selected-participant pointer, all living in
 * `providerMetadata`, and the two top-level fields the same interactions move
 * (`provider` via an idle provider switch, `workflowMode` via the patch).
 */
const COMPOSER_SELECTION_CHAT_METADATA_KEYS: readonly string[] = [
  ...CHAT_COMPOSER_SELECTION_METADATA_KEYS,
  PENDING_PROVIDER_CHANGE_KEY,
  SIDE_CHAT_SELECTED_PARTICIPANT_ID_METADATA_KEY
]

function composerSelectionSignature(chat: ChatRecord): string {
  const metadata = chat.providerMetadata || {}
  return JSON.stringify([
    chat.provider ?? null,
    chat.workflowMode ?? null,
    COMPOSER_SELECTION_CHAT_METADATA_KEYS.map((key) => metadata[key] ?? null)
  ])
}

/**
 * Same 1.0.5-UI2 class as the goal and roster helpers, reported a third time
 * as "the model picker selection bounces back". A picker commit is optimistic
 * (`applyChatComposerSelectionPatch` stamps `updatedAt`) and persists through
 * a debounced patch IPC into main's selection OVERLAY, which never broadcasts
 * — so a delivery built before the patch landed both reverts the selection
 * and is the last word until some unrelated write happens. When the live
 * record is provably fresher and the selection slices differ, the live slice
 * wins wholesale, including deliberate absences (a cleared pending provider
 * change must not resurrect). Non-selection metadata in the delivery stays
 * authoritative, and a genuinely newer main-side selection (remote companion,
 * turn-end apply persisted first) still wins on its stamp.
 */
function preserveNewerLocalComposerSelection(
  merged: ChatRecord,
  liveChat: ChatRecord | null | undefined
): ChatRecord {
  if (!liveChat) return merged
  if (composerSelectionSignature(liveChat) === composerSelectionSignature(merged)) return merged
  if (stampToMs(liveChat.updatedAt) <= stampToMs(merged.updatedAt)) return merged
  const next = { ...merged }
  if (liveChat.provider) next.provider = liveChat.provider
  else delete next.provider
  if (liveChat.workflowMode) next.workflowMode = liveChat.workflowMode
  else delete next.workflowMode
  const nextMetadata: Record<string, unknown> = { ...(merged.providerMetadata || {}) }
  const liveMetadata = liveChat.providerMetadata || {}
  for (const key of COMPOSER_SELECTION_CHAT_METADATA_KEYS) {
    const value = liveMetadata[key]
    if (value === undefined) delete nextMetadata[key]
    else nextMetadata[key] = value
  }
  next.providerMetadata = nextMetadata
  return next
}

/**
 * Merge a main-owned chat update with renderer-only live content. This is
 * deliberately a separate frame-time operation: the IPC callback can accept
 * and queue a patch without blocking prompt input on transcript reconciliation.
 */
export function mergeChatUpdatedForRender(
  chat: ChatRecord,
  options: ChatUpdateRenderMergeOptions
): ChatRecord {
  const liveChat = options.liveChat
  let merged = chat
  if ((options.hasActiveRun || options.hadRecentRun) && liveChat) {
    if (!options.messagesChanged) {
      // The main patch changed metadata only. The live ref already contains
      // the renderer's newest transcript, including synthetic local rows.
      // A paged shell's messages are a presentation page, never the live
      // transcript authority — keeping them would blank the delivery's arrays.
      if (liveChat.messages !== chat.messages && !isTranscriptPagedShell(liveChat)) {
        merged = { ...chat, messages: liveChat.messages }
      }
    } else if (liveChat.messages.length > 0) {
      const mergedMessages = mergeLiveMessages(chat.messages, liveChat.messages)
      if (mergedMessages) {
        merged = { ...chat, messages: mergedMessages }
      }
    }
  }

  // A close-out is renderer-authored before its debounced save reaches main.
  // Preserve that durable-intent row across every intervening main refresh,
  // not only during the short active/recent-run merge window. Explicit chat
  // clearing is handled before this merge is called.
  merged = preserveLiveTaskWraithCloseouts(merged, liveChat)

  // A user message is renderer-authored before the backend queues and persists
  // it. Preserve that locally-authored row across every intervening main refresh,
  // not only during the short active/recent-run merge window.
  merged = preserveLiveUserMessages(merged, liveChat)

  merged = preserveOptimisticEnsembleQueue(merged, liveChat)

  // Same preservation class as closeouts and user messages above, scoped to
  // the user-authored fields whose optimistic commit is not otherwise
  // represented in a delivery: the chat mode (Ensemble on/off), the thread
  // goal, the Ensemble seat roster and per-seat configuration, and the
  // composer's chat-level selection. Mode state goes FIRST: the roster helper
  // can only compare seats once both records agree the thread is an ensemble.
  // See 1.0.5-UI2 on each helper.
  merged = preserveNewerLocalChatKind(merged, liveChat)
  merged = preserveNewerLocalActiveGoal(merged, liveChat)
  merged = preserveNewerLocalEnsembleRoster(merged, liveChat)
  merged = preserveNewerLocalComposerSelection(merged, liveChat)
  const pendingMarkerIds = options.pendingMarkerIds
  if (pendingMarkerIds && pendingMarkerIds.size > 0) {
    const anchoredMessages = anchorPendingAgentQuestionMarkers(
      merged.messages,
      liveChat?.messages || [],
      pendingMarkerIds
    )
    if (anchoredMessages !== merged.messages) {
      merged = { ...merged, messages: anchoredMessages }
    }
  }
  return merged
}
