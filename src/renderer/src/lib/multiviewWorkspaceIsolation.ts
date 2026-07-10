import type { GitPrSummary, GitRepositorySnapshot } from '../../../main/services/GitService'
import {
  canonicalizeExternalPathGrantMetadata,
  collectExternalPathGrantsFromMetadata
} from '../../../main/store/ExternalPathGrants'
import type { ChatRecord, ExternalPathGrant } from '../../../main/store/types'
import type { ExternalPathGitMetadata } from './ExternalPathRepoDetect'
import { isGlobalChat } from './chatScope'
import { normalizeExternalPathGrants } from './normalizeExternalPathGrants'

export interface ExternalWorkspaceGroup {
  path: string
  representative: ExternalPathGrant
  providers: ExternalPathGrant['provider'][]
}

export interface ChatExternalWorkspaceState {
  externalPathGrants: ExternalPathGrant[]
  externalWorkspaceGroups: ExternalWorkspaceGroup[]
  externalPathRepoMetadata: Record<string, ExternalPathGitMetadata | null>
  externalGitSnapshots: Record<string, GitRepositorySnapshot | null>
  externalPrByPath: Record<string, GitPrSummary | null>
}

export function externalPathGrantsForChat(
  chat: ChatRecord | null | undefined
): ExternalPathGrant[] {
  if (!chat || isGlobalChat(chat)) return []
  return normalizeExternalPathGrants(collectExternalPathGrantsFromMetadata(chat.providerMetadata))
}

export function groupExternalPathGrants(grants: ExternalPathGrant[]): ExternalWorkspaceGroup[] {
  const byPath = new Map<string, ExternalWorkspaceGroup>()
  for (const grant of grants) {
    const existing = byPath.get(grant.path)
    if (existing) {
      if (!existing.providers.includes(grant.provider)) existing.providers.push(grant.provider)
      continue
    }
    byPath.set(grant.path, {
      path: grant.path,
      representative: grant,
      providers: [grant.provider]
    })
  }
  return Array.from(byPath.values())
}

/**
 * Select every secondary-workspace field for one chat. Callers may pass caches
 * containing many visible panes; only paths granted by `chat` are projected.
 */
export function deriveChatExternalWorkspaceState(
  chat: ChatRecord | null | undefined,
  caches: {
    repoMetadataByPath?: Record<string, ExternalPathGitMetadata | null>
    gitSnapshotsByPath?: Record<string, GitRepositorySnapshot | null>
    prByPath?: Record<string, GitPrSummary | null>
  } = {}
): ChatExternalWorkspaceState {
  return deriveExternalWorkspaceStateFromGrants(externalPathGrantsForChat(chat), caches)
}

export function deriveExternalWorkspaceStateFromGrants(
  externalPathGrants: ExternalPathGrant[],
  caches: {
    repoMetadataByPath?: Record<string, ExternalPathGitMetadata | null>
    gitSnapshotsByPath?: Record<string, GitRepositorySnapshot | null>
    prByPath?: Record<string, GitPrSummary | null>
  } = {}
): ChatExternalWorkspaceState {
  const externalWorkspaceGroups = groupExternalPathGrants(externalPathGrants)
  const externalPathRepoMetadata: Record<string, ExternalPathGitMetadata | null> = {}
  const externalGitSnapshots: Record<string, GitRepositorySnapshot | null> = {}
  const externalPrByPath: Record<string, GitPrSummary | null> = {}

  for (const grant of externalPathGrants) {
    externalPathRepoMetadata[grant.id] = caches.repoMetadataByPath?.[grant.path] ?? null
  }
  for (const group of externalWorkspaceGroups) {
    externalGitSnapshots[group.path] = caches.gitSnapshotsByPath?.[group.path] ?? null
    externalPrByPath[group.path] = caches.prByPath?.[group.path] ?? null
  }

  return {
    externalPathGrants,
    externalWorkspaceGroups,
    externalPathRepoMetadata,
    externalGitSnapshots,
    externalPrByPath
  }
}

/**
 * Persist a secondary-workspace list against the chat being edited. In
 * Multiview this must use the pane chat's identifiers, never the focused
 * workspace globals.
 */
export function applyExternalPathGrantsToChat(
  chat: ChatRecord,
  nextGrants: ExternalPathGrant[],
  updatedAt = Date.now()
): ChatRecord {
  const normalized = normalizeExternalPathGrants(nextGrants).map((grant) => ({
    ...grant,
    workspaceId: chat.workspaceId || grant.workspaceId,
    chatId: chat.appChatId
  }))
  return {
    ...chat,
    providerMetadata: canonicalizeExternalPathGrantMetadata(chat.providerMetadata, normalized),
    updatedAt
  }
}
