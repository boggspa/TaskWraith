import type { ChatRecord } from './store/types'

export const PENDING_WORKSPACE_REBIND_KEY = 'pendingWorkspaceRebind'

export type PendingWorkspaceRebind =
  | {
      schemaVersion: 1
      scope: 'global'
      queuedAt: string
    }
  | {
      schemaVersion: 1
      scope: 'workspace'
      workspaceId: string
      workspacePath: string
      queuedAt: string
    }

function nonEmptyString(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed ? trimmed : null
}

export function readPendingWorkspaceRebind(chat: ChatRecord): PendingWorkspaceRebind | null {
  const raw = (chat.providerMetadata ?? {})[PENDING_WORKSPACE_REBIND_KEY]
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const candidate = raw as Record<string, unknown>
  const queuedAt = nonEmptyString(candidate.queuedAt)
  if (candidate.schemaVersion !== 1 || !queuedAt) return null
  if (candidate.scope === 'global') {
    return { schemaVersion: 1, scope: 'global', queuedAt }
  }
  if (candidate.scope !== 'workspace') return null
  const workspaceId = nonEmptyString(candidate.workspaceId)
  const workspacePath = nonEmptyString(candidate.workspacePath)
  if (!workspaceId || !workspacePath) return null
  return {
    schemaVersion: 1,
    scope: 'workspace',
    workspaceId,
    workspacePath,
    queuedAt
  }
}

export function queuePendingWorkspaceRebind(
  chat: ChatRecord,
  pending: PendingWorkspaceRebind
): ChatRecord {
  return {
    ...chat,
    providerMetadata: {
      ...(chat.providerMetadata ?? {}),
      [PENDING_WORKSPACE_REBIND_KEY]: { ...pending }
    }
  }
}

export function clearPendingWorkspaceRebind(chat: ChatRecord): ChatRecord {
  if (!(PENDING_WORKSPACE_REBIND_KEY in (chat.providerMetadata ?? {}))) return chat
  const { [PENDING_WORKSPACE_REBIND_KEY]: _pending, ...providerMetadata } =
    chat.providerMetadata ?? {}
  return {
    ...chat,
    providerMetadata
  }
}
