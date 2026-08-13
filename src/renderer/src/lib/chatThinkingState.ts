import type { ChatRecord } from '../../../main/store/types'
import { isEnsembleActiveRoundDispatchLive } from './chatBusyState'
import { hasTerminalLastRun, isRunQueueJobVisibleForChat } from './runningChatVisibility'

const ACTIVE_RUN_QUEUE_STATUSES = new Set([
  'queued',
  'steer_promoting',
  'starting',
  'active',
  'paused',
  'cancelling'
])

interface ThinkingRunQueueJobLike {
  chatId?: string | null
  runId?: string | null
  status?: string
  startedAt?: string
  updatedAt?: string
  enqueuedAt?: string
  createdAt?: string
}

/**
 * Whether the transcript should show the in-flight "Thinking…" indicator
 * for a chat. Mirrors `isCurrentChatRunning` in App.tsx but is pure so chat
 * switches can restore thinking for ensemble rounds (which often never land
 * in `runningChatIds`).
 */
export function chatHasInFlightThinkingWork(input: {
  chat: ChatRecord | null | undefined
  runningChatIds: ReadonlySet<string>
  runQueueJobs?: ReadonlyArray<{ chatId?: string | null; status?: string | null }>
  activeRunChatIds?: ReadonlySet<string>
}): boolean {
  const chatId = input.chat?.appChatId
  if (!chatId) return false
  if (input.runningChatIds.has(chatId)) return true
  if (input.activeRunChatIds?.has(chatId)) return true
  for (const job of input.runQueueJobs || []) {
    if (job.chatId === chatId && job.status && ACTIVE_RUN_QUEUE_STATUSES.has(job.status)) {
      return true
    }
  }
  if (isEnsembleActiveRoundDispatchLive(input.chat?.ensemble?.activeRound)) return true
  return false
}

/**
 * Final display gate for the focused transcript's Working row. The renderer's
 * boolean remains the outer authority because text deltas intentionally hide
 * this row while a response streams. Persisted terminal evidence may only
 * suppress that weak hint when no newer, visible queue or round work exists.
 */
export function deriveFocusedTranscriptIsThinking(input: {
  rendererIsThinking: boolean
  chat: ChatRecord | null | undefined
  runQueueJobs?: ReadonlyArray<ThinkingRunQueueJobLike>
}): boolean {
  if (!input.rendererIsThinking) return false
  const chatId = input.chat?.appChatId
  if (!chatId || !input.chat) return false
  for (const job of input.runQueueJobs || []) {
    if (
      job.chatId === chatId &&
      job.status &&
      ACTIVE_RUN_QUEUE_STATUSES.has(job.status) &&
      isRunQueueJobVisibleForChat(job, input.chat)
    ) {
      return true
    }
  }
  if (isEnsembleActiveRoundDispatchLive(input.chat.ensemble?.activeRound)) return true
  if (input.chat.chatKind === 'ensemble') return false
  return !hasTerminalLastRun(input.chat)
}
