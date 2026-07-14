export type ChatPopoutAuthorityMutation = 'trusted-session' | 'workspace-trust'

const CHAT_POPOUT_AUTHORITY_REASONS: Record<ChatPopoutAuthorityMutation, string> = {
  'trusted-session': 'Open this chat in the main window to change Trusted Session.',
  'workspace-trust': 'Open this chat in the main window to change workspace trust.'
}

/**
 * Detached chat renderers can read their exact owner-scoped projection, but
 * authority-changing controls stay with the primary renderer.
 */
export function chatPopoutAuthorityDisabledReason(
  isChatPopoutWindow: boolean,
  mutation: ChatPopoutAuthorityMutation
): string | undefined {
  return isChatPopoutWindow ? CHAT_POPOUT_AUTHORITY_REASONS[mutation] : undefined
}

/**
 * Approval elevation may still be confirmed for the owning chat, but a
 * detached renderer must not write global acknowledgement settings or forge a
 * global ledger entry. It will warn again on the next elevation.
 */
export function shouldPersistApprovalElevationAck(isChatPopoutWindow: boolean): boolean {
  return !isChatPopoutWindow
}

/** Shared selection gate for visible-but-disabled authority rows. */
export function permissionOptionCanBeSelected<T extends { disabled?: boolean }>(
  option: T | undefined
): option is T {
  return Boolean(option && option.disabled !== true)
}
