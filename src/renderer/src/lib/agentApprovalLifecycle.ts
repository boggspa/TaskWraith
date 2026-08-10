export function shouldDismissAgentApproval(
  responseAccepted: boolean | { ok?: boolean } | null | undefined
): boolean {
  if (responseAccepted === true) return true
  if (responseAccepted && typeof responseAccepted === 'object' && responseAccepted.ok === true) {
    return true
  }
  return false
}

/**
 * Locate a pending approval by id against live head/queue maps.
 * Prefer this over a route captured before an await — sequential Allow-all
 * must not trust a stale head-vs-queue location.
 */
export function locatePendingApproval(
  requestId: string,
  byChatId: Record<string, { id?: string } | null | undefined>,
  queueByChatId: Record<string, readonly { id?: string }[] | undefined> = {}
): { chatId: string; inHead: boolean; inQueue: boolean } | null {
  let headChatId: string | null = null
  for (const [chatId, approval] of Object.entries(byChatId)) {
    if (approval?.id === requestId) {
      headChatId = chatId
      break
    }
  }
  let queueChatId: string | null = null
  for (const [chatId, queue] of Object.entries(queueByChatId)) {
    if ((queue || []).some((approval) => approval?.id === requestId)) {
      queueChatId = chatId
      break
    }
  }
  if (!headChatId && !queueChatId) return null
  const chatId = headChatId || queueChatId!
  return {
    chatId,
    inHead: headChatId === chatId,
    inQueue: queueChatId === chatId
  }
}

export function agentApprovalCancelPresentation(
  approval:
    | {
        provider?: string
        method?: string
      }
    | null
    | undefined
): { label: 'Cancel run' | 'Cancel request'; title: string } {
  if (approval?.provider === 'kimi' && approval.method === 'request/ApprovalRequest') {
    return {
      label: 'Cancel run',
      title: 'Cancel the Kimi run that is waiting on this approval.'
    }
  }
  return {
    label: 'Cancel request',
    title: 'Cancel only this pending approval request.'
  }
}
