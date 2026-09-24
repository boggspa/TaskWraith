import type { ChatMessage } from '../../../main/store/types'

export type RunCompleteNotice = {
  timestamp: string
  exitCode: number
  startedAt?: string
  /** Stable scope for matching a persisted closeout to this exact outcome. */
  runId?: string
  /** Stable scope for an Ensemble round completion. Takes precedence over runId. */
  roundId?: string
  /**
   * Set true for intentional steer handoff so the renderer can suppress
   * the Task Complete / run-summary card while preserving plain stop/cancel
   * feedback behavior.
   */
  suppressRunSummary?: boolean
}

export const shouldSuppressRunCompleteSummary = (notice: RunCompleteNotice | null): boolean => {
  return Boolean(notice?.suppressRunSummary)
}

/**
 * Whether a persisted closeout belongs to the outcome represented by a notice.
 * Scoped notices compare durable ids; legacy notices fall back to their exact
 * completion timestamp so an older closeout cannot suppress a newer footer.
 */
export function closeoutMatchesRunCompleteNotice(
  message: Pick<ChatMessage, 'runId' | 'timestamp' | 'metadata'>,
  notice: RunCompleteNotice
): boolean {
  if (notice.roundId) return message.metadata?.closeoutRoundId === notice.roundId
  if (notice.runId) {
    return message.metadata?.sourceRunId === notice.runId || message.runId === notice.runId
  }
  return message.timestamp === notice.timestamp
}

export interface DeriveVisibleRunCompleteNoticeInput {
  notice: RunCompleteNotice | null
  isChatRunning: boolean
}

/**
 * Render-time guard for the Task Complete / Final Summary card. A stale notice
 * can survive in local React state while a new run starts; live run evidence
 * must always hide it so the transcript never shows "complete" during active
 * work.
 */
export function deriveVisibleRunCompleteNotice({
  notice,
  isChatRunning
}: DeriveVisibleRunCompleteNoticeInput): RunCompleteNotice | null {
  if (isChatRunning) return null
  return notice
}
