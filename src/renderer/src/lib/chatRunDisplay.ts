import type { ChatRecord } from '../../../main/store/types'
import type { RunCompleteNotice } from './runCompleteNotice'

/**
 * Run-queue statuses that count a chat as actively RUNNING — drives the
 * running label, composer lock, and the transcript "Thinking…" indicator for
 * a pane. This is the NARROW set (mirrors the canonical
 * ACTIVE_RUN_QUEUE_STATUSES in src/main/RunQueue.ts and the Set in App.tsx
 * behind the side-chat `isSideChatRunning` formula).
 *
 * Do NOT merge this with `chatHasInFlightThinkingWork` in chatThinkingState.ts:
 * that helper deliberately ALSO counts `queued`/`paused` (so a chat switch can
 * restore the thinking indicator for pending work), whereas a queued/paused
 * chat is NOT "running" and must not show the Running label. Same-looking
 * formulas, intentionally different status sets.
 */
export const RUNNING_RUN_QUEUE_STATUSES = new Set<string>(['starting', 'active', 'cancelling'])

export interface DeriveChatIsRunningInput {
  chat: ChatRecord | null | undefined
  runningChatIds: ReadonlySet<string>
  runQueueJobs?: ReadonlyArray<{ chatId?: string | null; status?: string | null }>
}

/**
 * Whether a chat is actively running. Pure mirror of App.tsx's
 * `isSideChatRunning` (App.tsx:14185): true when the chat id is in
 * `runningChatIds`, OR it has an active run-queue job, OR its ensemble round
 * is currently 'running'. Pure so ANY pane — not just the focused/current
 * chat — can derive its own running state without the App.tsx singletons.
 */
export function deriveChatIsRunning(input: DeriveChatIsRunningInput): boolean {
  const chatId = input.chat?.appChatId
  if (!chatId) return false
  if (input.runningChatIds.has(chatId)) return true
  for (const job of input.runQueueJobs || []) {
    if (job.chatId === chatId && job.status && RUNNING_RUN_QUEUE_STATUSES.has(job.status)) {
      return true
    }
  }
  if (input.chat?.ensemble?.activeRound?.status === 'running') return true
  return false
}

/**
 * Per-chat "last run completed" card payload. Byte-identical mirror of
 * `deriveRunCompleteNotice` in App.tsx:1098 — kept in sync by the drift-guard
 * test. Returns null while the chat is running (the card hides for the live
 * run and reappears when the next run completes) or when there is no finished
 * run to describe. Failed / cancelled runs still surface via `exitCode`.
 */
export function deriveChatRunCompleteNotice(
  chat: ChatRecord,
  isRunning: boolean
): RunCompleteNotice | null {
  if (isRunning) return null
  const runs = chat.runs
  if (!Array.isArray(runs) || runs.length === 0) return null
  const lastRun = runs[runs.length - 1]
  // A run with no endedAt is still in flight (or never recorded an end) — no
  // completed outcome to show, even if the running set hasn't caught up yet.
  if (!lastRun || !lastRun.endedAt) return null
  return {
    timestamp: lastRun.endedAt,
    exitCode: lastRun.exitCode ?? 0,
    startedAt: lastRun.startedAt || undefined
  }
}
