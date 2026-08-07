/**
 * Renderer-safe structural checks for durable external-path grants.
 *
 * HMAC signing and main-owned grant types stay in the main process. This
 * structural check deliberately needs only the persisted binding fields, so
 * the renderer can fail closed without importing Node-backed code.
 */

export const EXTERNAL_PATH_GRANT_BINDING_VERSION = 2 as const

/** Ledger / IPC reason when Accept is cancelled because the chat primary moved. */
export const STALE_EXTERNAL_PATH_GRANT_BINDING_REASON = 'stale-grant-binding' as const

export const STALE_EXTERNAL_PATH_GRANT_BINDING_MESSAGE =
  'The chat workspace changed while this grant prompt was open. TaskWraith cancelled the grant; re-approve from the current workspace if still needed.'

type ExternalPathGrantBindingShape = {
  bindingVersion?: unknown
  issuedBy?: unknown
  signature?: unknown
  duration?: unknown
  chatId?: unknown
  workspaceId?: unknown
}

type ExternalPathGrantChatBindingShape = {
  appChatId?: unknown
  workspaceId?: unknown
}

function trimmed(value: unknown): string | null {
  const result = typeof value === 'string' ? value.trim() : ''
  return result || null
}

/**
 * A durable secondary-workspace grant is usable only when it carries the
 * current binding, a main-issued signature, and the exact chat/workspace
 * identities. Run-only grants never satisfy durable coverage.
 */
export function isChatBoundDurableExternalPathGrant(
  grant: ExternalPathGrantBindingShape | null | undefined,
  chat: ExternalPathGrantChatBindingShape | null | undefined
): boolean {
  if (!grant || !chat) return false
  if (grant.bindingVersion !== EXTERNAL_PATH_GRANT_BINDING_VERSION) return false
  if (grant.issuedBy !== 'main') return false
  if (typeof grant.signature !== 'string' || grant.signature.length === 0) return false
  if (grant.duration === 'thisRun') return false
  if (grant.duration !== 'thisThread' && grant.duration !== 'workspace') return false
  const grantChatId = trimmed(grant.chatId)
  const grantWorkspaceId = trimmed(grant.workspaceId)
  const chatId = trimmed(chat.appChatId)
  const workspaceId = trimmed(chat.workspaceId)
  if (!grantChatId || !grantWorkspaceId || !chatId || !workspaceId) return false
  return grantChatId === chatId && grantWorkspaceId === workspaceId
}

/** Snapshot of a chat's primary workspace at grant-consent time. */
export type ChatGrantWorkspaceBinding = {
  workspaceScope: 'global' | 'workspace'
  workspaceId?: string | null
  workspacePath?: string | null
}

export function chatGrantWorkspaceBindingFromChat(chat: {
  scope?: string | null
  workspaceId?: string | null
  workspacePath?: string | null
}): ChatGrantWorkspaceBinding {
  const workspaceScope = chat.scope === 'global' ? 'global' : 'workspace'
  if (workspaceScope === 'global') {
    return { workspaceScope: 'global' }
  }
  return {
    workspaceScope: 'workspace',
    workspaceId: trimmed(chat.workspaceId),
    workspacePath: trimmed(chat.workspacePath)
  }
}

/**
 * True when a pending consent still describes the chat's current primary.
 * Missing stamped binding fails closed — Accept must not remint onto a
 * rebound primary the way pick-and-persist cancels mid-dialog.
 *
 * Id/path comparison trims whitespace so detection stamps and store reads
 * align. Chat↔chat pick-and-persist keeps raw `===` in its local wrapper.
 */
export function sameChatGrantWorkspaceBinding(
  stamped:
    | {
        workspaceScope?: 'global' | 'workspace' | null
        workspaceId?: string | null
        workspacePath?: string | null
      }
    | null
    | undefined,
  chat:
    | {
        scope?: string | null
        workspaceId?: string | null
        workspacePath?: string | null
      }
    | null
    | undefined
): boolean {
  if (!stamped || !chat) return false
  if (stamped.workspaceScope !== 'global' && stamped.workspaceScope !== 'workspace') {
    return false
  }
  const current = chatGrantWorkspaceBindingFromChat(chat)
  if (stamped.workspaceScope !== current.workspaceScope) return false
  if (stamped.workspaceScope === 'global') return true
  return (
    trimmed(stamped.workspaceId) === trimmed(current.workspaceId) &&
    trimmed(stamped.workspacePath) === trimmed(current.workspacePath)
  )
}
