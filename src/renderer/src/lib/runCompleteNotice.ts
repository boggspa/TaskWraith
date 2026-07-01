export type RunCompleteNotice = {
  timestamp: string
  exitCode: number
  startedAt?: string
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

export interface DeriveVisibleRunCompleteNoticeInput {
  notice: RunCompleteNotice | null
  isChatRunning: boolean
  isGuestParticipantRunning?: boolean
}

/**
 * Render-time guard for the Task Complete / Final Summary card. A stale notice
 * can survive in local React state while a new run starts; live run evidence
 * must always hide it so the transcript never shows "complete" during active
 * work.
 */
export function deriveVisibleRunCompleteNotice({
  notice,
  isChatRunning,
  isGuestParticipantRunning = false
}: DeriveVisibleRunCompleteNoticeInput): RunCompleteNotice | null {
  if (isChatRunning || isGuestParticipantRunning) return null
  return notice
}
