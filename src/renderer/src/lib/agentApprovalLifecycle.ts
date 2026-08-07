export function shouldDismissAgentApproval(
  responseAccepted: boolean | { ok?: boolean } | null | undefined
): boolean {
  if (responseAccepted === true) return true
  if (responseAccepted && typeof responseAccepted === 'object' && responseAccepted.ok === true) {
    return true
  }
  return false
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
