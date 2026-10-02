import type { HistoryClearDispatchAuthority } from './HistoryClearAdmissionGate'

/** Supplied synchronously by the current Store/Host owner, never by a provider. */
export interface ProviderRunAuthorityMetadataPort {
  readCurrent(chatId: string): {
    appChatId: string
    workspaceId?: string | null
    persistenceRevision: number
  } | null
  deletionBlocks(chatId: string, workspaceId: string | null): boolean
  workspaceForPath(workspacePath?: string): string | null
}

/** No retained cache or full-record fallback: unresolved ownership refuses. */
export function readProviderRunAuthorityMetadata(
  port: ProviderRunAuthorityMetadataPort,
  appChatId: string,
  workspacePath?: string
): HistoryClearDispatchAuthority | null {
  const chatId = appChatId.trim()
  if (!chatId) return null
  const current = port.readCurrent(chatId)
  if (!current || current.appChatId !== chatId) return null
  if (
    !Number.isSafeInteger(current.persistenceRevision) ||
    current.persistenceRevision < 0 ||
    (current.workspaceId != null && typeof current.workspaceId !== 'string')
  )
    return null
  const workspaceId =
    current.workspaceId?.trim() || port.workspaceForPath(workspacePath)?.trim() || null
  if (port.deletionBlocks(chatId, workspaceId)) return null
  return {
    appChatId: chatId,
    workspaceId,
    persistenceRevision: current.persistenceRevision
  }
}
