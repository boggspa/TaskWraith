/**
 * Renderer-safe structural checks for durable external-path grants.
 *
 * HMAC signing and main-owned grant types stay in the main process. This
 * structural check deliberately needs only the persisted binding fields, so
 * the renderer can fail closed without importing Node-backed code.
 */

export const EXTERNAL_PATH_GRANT_BINDING_VERSION = 2 as const

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
