import type { ChatRecord } from '../../../main/store/types'
import type { RunCompleteNotice } from './runCompleteNotice'
import { isEnsembleActiveRoundDispatchLive } from './chatBusyState'
import { hasTerminalLastRun } from './runningChatVisibility'

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
export const RUNNING_RUN_QUEUE_STATUSES = new Set<string>([
  'steer_promoting',
  'starting',
  'active',
  'cancelling'
])

export interface DeriveChatIsRunningInput {
  chat: ChatRecord | null | undefined
  runningChatIds: ReadonlySet<string>
  runQueueJobs?: ReadonlyArray<{ chatId?: string | null; status?: string | null }>
}

/**
 * Whether a chat is actively running. Pure mirror of App.tsx's
 * `isSideChatRunning` (App.tsx:14185): true when the chat id is in
 * `runningChatIds`, OR it has an active run-queue job, OR its ensemble round
 * still has live dispatch evidence. Pure so ANY pane — not just the
 * focused/current chat — can derive its own running state without the App.tsx
 * singletons.
 */
export function deriveChatIsRunning(input: DeriveChatIsRunningInput): boolean {
  const chatId = input.chat?.appChatId
  if (!chatId) return false
  for (const job of input.runQueueJobs || []) {
    if (job.chatId === chatId && job.status && RUNNING_RUN_QUEUE_STATUSES.has(job.status)) {
      return true
    }
  }
  if (isEnsembleActiveRoundDispatchLive(input.chat?.ensemble?.activeRound)) return true
  if (input.runningChatIds.has(chatId)) {
    // `runningChatIds` is additive when a provider exit is missed. Treat a
    // terminal last run as the persisted source of truth for solo chats too,
    // matching `visibleRunningChatIds`; otherwise a recovered run can vanish
    // from Active Runs while its transcript still paints a live Working row.
    const staleTerminalRun = input.chat && hasTerminalLastRun(input.chat)
    return !staleTerminalRun
  }
  return false
}

/**
 * Per-chat "last run completed" card payload. Returns null while the chat is
 * running (the card hides for the live run and reappears when the next run
 * completes) or when there is no finished run to describe. Failed / cancelled
 * runs still surface via `exitCode`.
 */
export function deriveChatRunCompleteNotice(
  chat: ChatRecord,
  isRunning: boolean
): RunCompleteNotice | null {
  const round = chat.ensemble?.activeRound
  const runs = chat.runs
  const lastRun = Array.isArray(runs) && runs.length > 0 ? runs[runs.length - 1] : null

  // If there's an active (unfinished) regular run, hide the notice
  if (lastRun && !lastRun.endedAt) return null
  // If there's an active (unfinished) ensemble round, hide the notice
  if (round && !round.endedAt) return null

  const roundCompleted =
    round?.endedAt &&
    (round.status === 'completed' || round.status === 'cancelled' || round.status === 'failed')

  const runCompleted = lastRun?.endedAt

  if (roundCompleted && runCompleted) {
    if (round.endedAt >= lastRun.endedAt) {
      return {
        timestamp: round.endedAt,
        exitCode: round.status === 'cancelled' ? 130 : round.status === 'failed' ? 1 : 0,
        startedAt: round.startedAt || undefined,
        roundId: round.roundId,
        suppressRunSummary: false
      }
    } else {
      if (isRunning) return null
      return {
        timestamp: lastRun.endedAt,
        exitCode: lastRun.exitCode ?? 0,
        startedAt: lastRun.startedAt || undefined,
        ...(lastRun.runId ? { runId: lastRun.runId } : {}),
        suppressRunSummary: Boolean(lastRun.suppressRunSummary)
      }
    }
  }

  if (roundCompleted) {
    return {
      timestamp: round.endedAt,
      exitCode: round.status === 'cancelled' ? 130 : round.status === 'failed' ? 1 : 0,
      startedAt: round.startedAt || undefined,
      roundId: round.roundId,
      suppressRunSummary: false
    }
  }

  if (isRunning) return null

  if (runCompleted) {
    return {
      timestamp: lastRun.endedAt,
      exitCode: lastRun.exitCode ?? 0,
      startedAt: lastRun.startedAt || undefined,
      ...(lastRun.runId ? { runId: lastRun.runId } : {}),
      suppressRunSummary: Boolean(lastRun.suppressRunSummary)
    }
  }

  return null
}
