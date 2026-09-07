/**
 * Presentation-lane gate for the pending-approval overlay.
 *
 * Transcript streaming and measurement must yield the main thread while the
 * user is deciding Allow/Deny/Grant. `deferPresentation` already exists for
 * live runs; this helper also covers the ensemble-parent case where the chat
 * never enters `runningChatIds` but a sibling lane is still flushing.
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
