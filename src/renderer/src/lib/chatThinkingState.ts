import type { ChatRecord } from '../../../main/store/types'

const ACTIVE_RUN_QUEUE_STATUSES = new Set([
  'queued',
  'steer_promoting',
  'starting',
  'active',
  'paused',
  'cancelling'
])

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
  if (input.chat?.ensemble?.activeRound?.status === 'running') return true
  return false
}
