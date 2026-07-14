import type { ExternalPathGrant } from '../../../main/store/types'

export interface ExternalWorkspaceOwnerTarget {
  ownerKey: string
  chatId: string
  path: string
}

/**
 * External-workspace authority belongs to one chat, even when another visible
 * chat grants the same filesystem path. Keep renderer caches on that same
 * composite boundary instead of allowing path-only entries to bleed between
 * panes.
 */
export function externalWorkspaceOwnerKey(chatId: string, path: string): string {
  return JSON.stringify([chatId.trim(), path])
}

export function repositoryUiStateKey(path: string, chatId?: string | null): string {
  const normalizedChatId = chatId?.trim()
  return normalizedChatId
    ? `external:${externalWorkspaceOwnerKey(normalizedChatId, path)}`
    : `workspace:${JSON.stringify(path)}`
}

export function buildExternalWorkspaceOwnerTargets(
  grants: ExternalPathGrant[]
): ExternalWorkspaceOwnerTarget[] {
  const targetsByOwner = new Map<string, ExternalWorkspaceOwnerTarget>()
  for (const grant of grants) {
    const chatId = grant.chatId?.trim()
    if (!chatId) continue
    const ownerKey = externalWorkspaceOwnerKey(chatId, grant.path)
    if (!targetsByOwner.has(ownerKey)) {
      targetsByOwner.set(ownerKey, { ownerKey, chatId, path: grant.path })
    }
  }
  return Array.from(targetsByOwner.values()).sort((left, right) =>
    left.path === right.path
      ? left.chatId.localeCompare(right.chatId)
      : left.path.localeCompare(right.path)
  )
}

/** Project a shared composite cache back to the path-keyed shape one Composer expects. */
export function projectExternalWorkspaceOwnerCache<T>(
  grants: ExternalPathGrant[],
  cacheByOwner: Record<string, T>
): Record<string, T> {
  const projected: Record<string, T> = {}
  for (const grant of grants) {
    if (Object.prototype.hasOwnProperty.call(projected, grant.path)) continue
    const chatId = grant.chatId?.trim()
    if (!chatId) continue
    const ownerKey = externalWorkspaceOwnerKey(chatId, grant.path)
    if (Object.prototype.hasOwnProperty.call(cacheByOwner, ownerKey)) {
      projected[grant.path] = cacheByOwner[ownerKey]
    }
  }
  return projected
}
