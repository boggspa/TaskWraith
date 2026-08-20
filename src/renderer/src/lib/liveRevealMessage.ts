import type { ChatMessage, EnsembleRoundState } from '../../../main/store/types'
import { isEnsembleRoundPresentationLive } from '../../../shared/ensembleRoundLifecycle'
import {
  ensembleFanoutParticipantId,
  isEnsembleFanoutResultMessage
} from '../components/EnsembleFanoutResultCardModel'
import { isGuestParticipantReplyMessage } from '../components/GuestParticipantReplyCardModel'

export interface LiveRevealMessageOptions {
  revealEnabled: boolean
  revealChatIsRunning: boolean
  revealRunId?: string | null
}

export interface LiveToolMessageOptions {
  revealChatIsRunning: boolean
  revealRunId?: string | null
}

export interface LiveMeasurementMessageOptions extends LiveRevealMessageOptions {
  /** Seats whose fan-out lane cards are currently working (shimmer / busy). */
  workingFanoutParticipantIds?: ReadonlySet<string> | null
}

export function isLiveRevealMessageCandidate(
  message: ChatMessage | null | undefined,
  revealRunId?: string | null
): boolean {
  if (!message) return false
  const assistantLike = message.role === 'assistant' || isGuestParticipantReplyMessage(message)
  if (!assistantLike) return false
  if (revealRunId && message.runId && message.runId !== revealRunId) return false
  return true
}

/**
 * Typewriter / reveal UI: only the final assistant-like message in a running
 * chat. Measurement freeze uses {@link resolveLiveMeasurementMessageIds}.
 */
export function resolveLiveRevealMessageId(
  messages: readonly ChatMessage[],
  options: LiveRevealMessageOptions
): string | null {
  if (!options.revealEnabled || !options.revealChatIsRunning) return null
  const lastMessage = messages[messages.length - 1]
  if (!isLiveRevealMessageCandidate(lastMessage, options.revealRunId)) return null
  return lastMessage.id
}

export function isLiveToolMessageCandidate(
  message: ChatMessage | null | undefined,
  revealRunId?: string | null
): boolean {
  if (!message || message.role !== 'tool') return false
  if (!Array.isArray(message.toolActivities) || message.toolActivities.length === 0) return false
  if (revealRunId && message.runId && message.runId !== revealRunId) return false
  return true
}

export function toolMessageHasActiveActivity(message: ChatMessage | null | undefined): boolean {
  const activities = message?.toolActivities
  if (!activities || activities.length === 0) return false
  for (const activity of activities) {
    if (activity.status === 'running' || activity.status === 'pending') return true
  }
  return false
}

/**
 * Legacy singular helper: the list-tail tool activity row, when it is the live
 * measurement target. Prefer {@link resolveLiveToolMessageIds} / measurement
 * ids for multi-row freeze.
 */
export function resolveLiveToolMessageId(
  messages: readonly ChatMessage[],
  options: LiveToolMessageOptions
): string | null {
  if (!options.revealChatIsRunning) return null
  const lastMessage = messages[messages.length - 1]
  if (!isLiveToolMessageCandidate(lastMessage, options.revealRunId)) return null
  return lastMessage.id
}

/**
 * Tool stacks that should keep a stable `:live` measurement slot while the
 * chat runs: every stack with a running/pending activity, plus the NEWEST tool
 * candidate of the in-flight turn (Kimi success-status thinking that still
 * grows — and, more importantly, the stack the next tool call will land in).
 *
 * That last one deliberately does NOT depend on list-tail position, for the
 * same reason `resolveLiveFanoutMessageIds` doesn't: a working seat's stack
 * settles between two tool calls, so a tail-anchored rule stopped calling it
 * live the moment anything landed below it — a steer row, an orchestrator
 * notice, another seat's turn. The settled-stack fold reads this set as
 * `isLiveRow`, so the row folded into its one-liner and re-expanded on the
 * next call, once per tool call, for the rest of the turn (reported
 * 2026-08-19 as the transcript "flashing" right after a steer).
 */
export function resolveLiveToolMessageIds(
  messages: readonly ChatMessage[],
  options: LiveToolMessageOptions
): string[] {
  if (!options.revealChatIsRunning) return []
  const ids: string[] = []
  const seen = new Set<string>()
  const push = (id: string): void => {
    if (seen.has(id)) return
    seen.add(id)
    ids.push(id)
  }
  for (const message of messages) {
    if (!isLiveToolMessageCandidate(message, options.revealRunId)) continue
    if (toolMessageHasActiveActivity(message)) push(message.id)
  }
  // Only the NEWEST candidate — every older stack of the same turn still folds
  // as the conversation moves past it, which is the whole point of the fold.
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (!isLiveToolMessageCandidate(messages[index], options.revealRunId)) continue
    push(messages[index].id)
    break
  }
  return ids
}

export function isLiveFanoutMessageCandidate(
  message: ChatMessage | null | undefined,
  revealRunId?: string | null
): boolean {
  if (!message || !isEnsembleFanoutResultMessage(message)) return false
  if (revealRunId && message.runId && message.runId !== revealRunId) return false
  return true
}

/**
 * Fan-out lane cards whose seat is currently working — may sit above a later
 * Boss/system/serial message, so they must not depend on list-tail position.
 */
export function resolveLiveFanoutMessageIds(
  messages: readonly ChatMessage[],
  options: {
    revealChatIsRunning: boolean
    revealRunId?: string | null
    workingFanoutParticipantIds?: ReadonlySet<string> | null
  }
): string[] {
  if (!options.revealChatIsRunning) return []
  const working = options.workingFanoutParticipantIds
  if (!working || working.size === 0) return []
  const ids: string[] = []
  for (const message of messages) {
    if (!isLiveFanoutMessageCandidate(message, options.revealRunId)) continue
    const participantId = ensembleFanoutParticipantId(message)
    if (participantId && working.has(participantId)) ids.push(message.id)
  }
  return ids
}

/**
 * Whether the transcript should treat its chat as having a turn in flight.
 *
 * `runningChatIds` is renderer-owned and does NOT reliably contain Ensemble
 * chats: rounds are orchestrated in main, so a round can run start to finish
 * without the chat ever entering that set. `deriveChatIsRunning` carries its
 * own round clause for exactly this reason; without the same clause here every
 * live-row signal below (`resolveLiveMeasurementMessageIds` and therefore the
 * panel's `activeLiveRowKeys`) is empty for the whole round, which leaves the
 * settled-stack fold with list-tail position as its only guard.
 */
export function resolveTranscriptChatIsRunning(input: {
  chatId: string | null | undefined
  runningChatIds: readonly string[] | null | undefined
  activeRound?: EnsembleRoundState | null
}): boolean {
  if (!input.chatId) return false
  if (Array.isArray(input.runningChatIds) && input.runningChatIds.includes(input.chatId)) {
    return true
  }
  return isEnsembleRoundPresentationLive(input.activeRound)
}

/**
 * Message ids that should freeze virtualizer measurement keys (`*:live`) for
 * the current run: the reveal-tail assistant (when enabled), every live tool
 * stack, and every working fan-out lane — not only `messages[length - 1]`.
 */
export function resolveLiveMeasurementMessageIds(
  messages: readonly ChatMessage[],
  options: LiveMeasurementMessageOptions
): string[] {
  if (!options.revealChatIsRunning) return []
  const ids: string[] = []
  const seen = new Set<string>()
  const push = (id: string | null | undefined): void => {
    if (!id || seen.has(id)) return
    seen.add(id)
    ids.push(id)
  }

  push(resolveLiveRevealMessageId(messages, options))
  for (const id of resolveLiveToolMessageIds(messages, options)) push(id)
  for (const id of resolveLiveFanoutMessageIds(messages, options)) push(id)
  return ids
}
