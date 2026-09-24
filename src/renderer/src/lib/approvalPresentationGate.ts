/**
 * Presentation-lane gate for the pending-approval overlay.
 *
 * Defer transcript-derived App and pane chrome while a run or approval is
 * active. The visible virtualised TranscriptPanel subscribes independently at
 * urgent priority so background presentation cannot starve streamed text.
 * This also covers ensemble parents whose sibling lanes are still flushing.
 */

export function shouldDeferTranscriptPresentation(input: {
  running: boolean
  approvalOpen: boolean
}): boolean {
  return input.running || input.approvalOpen
}

export function chatHasPendingApproval(
  chatId: string | null | undefined,
  approvalHeadByChatId?: Readonly<Record<string, unknown>> | null,
  approvalQueueByChatId?: Readonly<Record<string, readonly unknown[] | undefined>> | null
): boolean {
  if (!chatId) return false
  if (approvalHeadByChatId?.[chatId]) return true
  const queue = approvalQueueByChatId?.[chatId]
  return Array.isArray(queue) && queue.length > 0
}
