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

/** `metadata.kind` App.tsx stamps on the ProviderRunFailureCard's row. Main
 * reuses the same kind for its own failure notices (`RunFailureNotice.ts`). */
const PROVIDER_RUN_FAILURE_KIND = 'providerRunFailure'

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

/**
 * A goal edit the renderer committed optimistically and has not yet had
 * confirmed by main. `goalId` is the objective it intends to be active;
 * `null` records a Clear, and `clearedGoalId` names what that Clear removed
 * so a stale echo of it can still be rejected.
 */
export interface LocalGoalIntent {
  goalId: string | null
  clearedGoalId?: string
}

export interface ChatUpdateRenderMergeOptions {
  liveChat?: ChatRecord | null
  messagesChanged: boolean
  hasActiveRun: boolean
  hadRecentRun: boolean
  pendingMarkerIds?: ReadonlySet<string>
  /** Un-persisted renderer goal edit for this chat, when one is in flight. */
  localGoalIntent?: LocalGoalIntent | null
}

/**
 * Put preserved live rows back where they sat, instead of at the tail.
 *
 * A preserved row is one the delivery does not carry yet: a prompt the renderer
 * authored before main persisted it, a close-out, a synthetic card. Re-appending
 * it at the end inverts the transcript whenever the delivery already carries
 * rows main appended AFTER that row's position — reported 2026-09-10 as "tools
 * keep appearing ABOVE the user prompt". Muse makes it near-certain: its first
 * delegate-wave rows land within milliseconds, so they beat the `saveChat`
 * round-trip carrying the prompt, and the renderer's next whole-record save
 * persists the inverted order. The transcript render pipeline is pure array
 * order (no timestamp sort), so the array IS the reading order.
 *
 * Each preserved row is re-anchored to its nearest preceding live neighbour that
 * the delivery still carries, keeping live order among rows sharing an anchor.
 * Between that anchor and the next row live already orders after it, the row
 * settles by timestamp: a delivered row provably OLDER than it genuinely
 * preceded it and stays above, and everything else — newer, or carrying no
 * readable stamp — goes below, so an unstamped row can only ever fall on the
 * forward-only side. A row with no anchor at all is read two
 * ways, because "no anchor" conflates two opposite situations. When its live
 * prefix is INTACT — every row before it is itself preserved, or there are none
 * — the row genuinely belongs at the transcript's head and settles against the
 * delivery by the same timestamp rule as an anchored row. That is the first turn
 * of a new chat: the prompt sits at live index 0 while the run's first tool row
 * is already delivered, so a tail fallback there inverts the very turn this
 * function exists to fix. When instead some live row before it is neither
 * delivered nor preserved, the prefix was genuinely dropped (paged out, or a
 * stale base), position proves nothing, and the row keeps the historical tail
 * placement.
 */
function restorePreservedLiveRows(
  deliveredMessages: readonly ChatMessage[],
  liveMessages: readonly ChatMessage[],
  preservedIds: ReadonlySet<string>
): ChatMessage[] {
  const deliveredIds = new Set(deliveredMessages.map((message) => message.id))
  const liveIds = new Set(liveMessages.map((message) => message.id))
  const afterAnchor = new Map<string, ChatMessage[]>()
  const head: ChatMessage[] = []
  const unanchored: ChatMessage[] = []
  let anchorId: string | null = null
  let prefixIntact = true
  for (const message of liveMessages) {
    if (deliveredIds.has(message.id)) {
      anchorId = message.id
      continue
    }
    if (!preservedIds.has(message.id)) {
      prefixIntact = false
      continue
    }
    if (anchorId === null) {
      if (prefixIntact) head.push(message)
      else unanchored.push(message)
      continue
    }
    const bucket = afterAnchor.get(anchorId)
    if (bucket) bucket.push(message)
    else afterAnchor.set(anchorId, [message])
  }
  const restored: ChatMessage[] = []
  // The head bucket seeds `pending`, so a row with no live predecessor settles
  // against the delivery through the same timestamp rule as an anchored row.
  let pending: ChatMessage[] = head
  for (const message of deliveredMessages) {
    if (pending.length > 0) {
      const pendingMs = timestampMs(pending[0].timestamp)
      const deliveredMs = timestampMs(message.timestamp)
      // A row live already knows about is ordered by live, not by its stamp:
      // the anchor was the LAST live predecessor, so this one comes after.
      const precedesPending =
        !liveIds.has(message.id) &&
        pendingMs !== null &&
        deliveredMs !== null &&
        deliveredMs < pendingMs
      if (!precedesPending) {
        restored.push(...pending)
        pending = []
      }
    }
    restored.push(message)
    // Consume the bucket so a duplicated id in the delivery cannot re-emit it.
    const bucket = afterAnchor.get(message.id)
    if (bucket) {
      pending.push(...bucket)
      afterAnchor.delete(message.id)
    }
  }
  restored.push(...pending, ...unanchored)
  return restored
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
  if (orphanIds.size > 0) changed = true
  if (!changed) return null
  return orphanIds.size > 0
    ? restorePreservedLiveRows(mergedMessages, liveMessages, orphanIds)
    : mergedMessages
}

function timestampMs(value: unknown): number | null {
  if (typeof value !== 'string' || value.length === 0) return null
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? parsed : null
}

/**
 * A paged shell's messages are one tail window, so "missing from the shell"
 * is true of every historical row outside that window. Only a row that is
 * provably NEWER than the window may be preserved onto it: a row at or past
 * the shell's known canonical total (a full live transcript running ahead of
 * the snapshot), or — for a stale base where position proves nothing — a row
 * strictly newer than the window's newest message. Everything else is history
 * that must stay paged out: appending it reorders the transcript and splits
 * each resurrected prompt off from its round as a lone "0 messages" card.
 */
function filterPagedShellPreservations(
  chat: ChatRecord,
  liveChat: ChatRecord,
  missing: ChatMessage[]
): ChatMessage[] {
  if (missing.length === 0) return missing
  const total = (chat as { messageCount?: unknown }).messageCount
  const knownTotal =
    typeof total === 'number' && Number.isFinite(total) ? total : Number.POSITIVE_INFINITY
  const liveIndexById = new Map<string, number>()
  for (let index = 0; index < liveChat.messages.length; index += 1) {
    const id = liveChat.messages[index]?.id
    if (id && !liveIndexById.has(id)) liveIndexById.set(id, index)
  }
  const newestMs = timestampMs(chat.messages[chat.messages.length - 1]?.timestamp)
  return missing.filter((message) => {
    const liveIndex = liveIndexById.get(message.id)
    if (liveIndex !== undefined && liveIndex >= knownTotal) return true
    if (newestMs !== null) {
      const candidateMs = timestampMs(message.timestamp)
      if (candidateMs !== null && candidateMs > newestMs) return true
    }
    return false
  })
}

/**
 * Carry the live rows `match` selects, which this delivery does not carry, back
 * onto it at their live positions.
 *
 * The always-on preservation class: rows the renderer authors before its
 * debounced `saveChat` reaches main, which must therefore survive every
 * intervening refresh rather than only the short active/recent-run merge
 * window. A paged shell is narrowed first, because "missing from the shell" is
 * true of all paged-out history.
 */
function preserveLiveRowsMatching(
  chat: ChatRecord,
  liveChat: ChatRecord | null | undefined,
  match: (message: ChatMessage) => boolean
): ChatRecord {
  if (!liveChat || liveChat.messages.length === 0) return chat
  const incomingIds = new Set(chat.messages.map((message) => message.id))
  const missing = liveChat.messages.filter(
    (message) => match(message) && !incomingIds.has(message.id)
  )
  const preservable = isTranscriptPagedShell(chat)
    ? filterPagedShellPreservations(chat, liveChat, missing)
    : missing
  if (preservable.length === 0) return chat
  return {
    ...chat,
    messages: restorePreservedLiveRows(
      chat.messages,
      liveChat.messages,
      new Set(preservable.map((message) => message.id))
    )
  }
}

function preserveLiveTaskWraithCloseouts(
  chat: ChatRecord,
  liveChat: ChatRecord | null | undefined
): ChatRecord {
  return preserveLiveRowsMatching(
    chat,
    liveChat,
    (message) => message.role === 'system' && message.metadata?.kind === TASKWRAITH_CLOSEOUT_KIND
  )
}

function preserveLiveUserMessages(
  chat: ChatRecord,
  liveChat: ChatRecord | null | undefined
): ChatRecord {
  return preserveLiveRowsMatching(chat, liveChat, (message) => message.role === 'user')
}

/**
 * Same always-on class as the close-out above, and for the same reason: App.tsx
 * appends the provider-failure card at the exit boundary and it only reaches
 * main through the 200ms debounced whole-record save. Without this the card
 * blinked in and out for as long as deliveries kept arriving — measured
 * 2026-09-11 on nine Muse runs that failed inside one second, where the
 * close-out stamped in the SAME millisecond never flickered because it was
 * already preserved here and the nine failure rows were not.
 */
function preserveLiveProviderRunFailures(
  chat: ChatRecord,
  liveChat: ChatRecord | null | undefined
): ChatRecord {
  return preserveLiveRowsMatching(
    chat,
    liveChat,
    (message) => message.metadata?.kind === PROVIDER_RUN_FAILURE_KIND
  )
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
 * then unsets it" and needed a second click to stick.
 *
 * That first fix compared `max(chat.updatedAt, activeGoal.updatedAt)` on each
 * side, which reads the wrong clock and lost MAIN-authored goals instead. Main
 * mutation paths broadcast the very object they handed to `saveChat`, whose
 * `updatedAt` predates the later stamp the store assigns (store/index.ts), and
 * `chat.updatedAt` is bumped by every unrelated save during a run. So an agent
 * `update_goal` arrived stamped OLDER than a renderer copy that had never held
 * a goal, the guard deleted it here, and the renderer's next whole-record save
 * persisted the absence over the stored goal — the goal "unset itself".
 *
 * The renderer only has a goal opinion worth defending while it holds an edit
 * of its own that main has not confirmed yet, so that intent is now stated
 * explicitly rather than inferred from ambient timestamps. With no pending
 * intent the delivery is authoritative.
 */
function preserveNewerLocalActiveGoal(
  merged: ChatRecord,
  liveChat: ChatRecord | null | undefined,
  intent: LocalGoalIntent | null | undefined
): ChatRecord {
  if (!liveChat) return merged
  const liveGoal = liveChat.activeGoal
  const deliveredGoal = merged.activeGoal
  if (liveGoal === deliveredGoal) return merged
  // Deliveries round-trip through structured clone, so an identical goal is
  // never identity-equal; compare authored content before treating the field
  // as contested.
  if (liveGoal && deliveredGoal && sameAuthoredGoal(liveGoal, deliveredGoal)) return merged
  if (!intent) return merged
  if (deliveredGoal) {
    // A local Clear defends only against an echo of the goal it cleared. A
    // different id is a newer main-authored objective, not a stale frame.
    if (intent.goalId === null) {
      if (deliveredGoal.id !== intent.clearedGoalId) return merged
    } else if (deliveredGoal.id === intent.goalId) {
      // Same goal on both sides: the goal's own stamp is an unbiased clock, so
      // a main-side status advance on it still wins.
      if (stampToMs(deliveredGoal.updatedAt) >= stampToMs(liveGoal?.updatedAt)) return merged
    }
  } else if (intent.goalId === null) {
    return merged
  }
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
        // Adopting the live transcript onto a paged shell has to carry the
        // live runs with it. The shell's runs were bounded to the same tail
        // page its messages were, so keeping them beside a full transcript
        // leaves the two arrays describing different windows — which empties
        // every older round's fan-out run index and splits its rows off from
        // their prompt.
        merged = isTranscriptPagedShell(chat)
          ? { ...chat, messages: liveChat.messages, runs: liveChat.runs }
          : { ...chat, messages: liveChat.messages }
      }
    } else if (liveChat.messages.length > 0 && !isTranscriptPagedShell(chat)) {
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

  // The provider-failure card shares the close-out's authoring lane and its
  // exposure to a stale delivery, so it shares the preservation.
  merged = preserveLiveProviderRunFailures(merged, liveChat)

  merged = preserveOptimisticEnsembleQueue(merged, liveChat)

  // Same preservation class as closeouts and user messages above, scoped to
  // the user-authored fields whose optimistic commit is not otherwise
  // represented in a delivery: the chat mode (Ensemble on/off), the thread
  // goal, the Ensemble seat roster and per-seat configuration, and the
  // composer's chat-level selection. Mode state goes FIRST: the roster helper
  // can only compare seats once both records agree the thread is an ensemble.
  // See 1.0.5-UI2 on each helper.
  merged = preserveNewerLocalChatKind(merged, liveChat)
  merged = preserveNewerLocalActiveGoal(merged, liveChat, options.localGoalIntent)
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
