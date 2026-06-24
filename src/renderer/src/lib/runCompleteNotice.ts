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
