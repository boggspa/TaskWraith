/**
 * Pane-local approval projection for independently mounted chat surfaces.
 *
 * A Multiview pane must never inherit the focused chat's approval card: that
 * would make a valid action apply from the wrong transcript. It must also not
 * hide its own card merely because another pane owns the legacy App composer.
 * Keep both the visible head and its queue scoped to the pane's chat id.
 */
export interface ChatSurfacePendingApprovals<T> {
  pendingAgentApproval: T | null
  pendingApprovalQueueByChatId: Record<string, readonly T[]>
}

export function projectChatSurfacePendingApprovals<T>(
  chatId: string,
  approvalHeadByChatId: Readonly<Record<string, T | null | undefined>>,
  approvalQueueByChatId: Readonly<Record<string, readonly T[] | undefined>>
): ChatSurfacePendingApprovals<T> {
  const pendingAgentApproval = approvalHeadByChatId[chatId] ?? null
  const queue = approvalQueueByChatId[chatId]
  return {
    pendingAgentApproval,
    pendingApprovalQueueByChatId: queue ? { [chatId]: queue } : {}
  }
}
