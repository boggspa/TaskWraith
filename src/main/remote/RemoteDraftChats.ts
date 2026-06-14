import type { ChatRecord, EnsembleConfig, ProviderId } from '../store/types'

export const REMOTE_DRAFT_METADATA_KEY = 'remoteDraft'

export type RemoteDraftVariant = 'workspace' | 'global' | 'ensemble'

export interface RemoteDraftTarget {
  variant: RemoteDraftVariant
  provider: ProviderId
  title?: string
  workspaceId?: string
  workspacePath?: string
  ensemble?: EnsembleConfig
}

interface RemoteDraftMetadata {
  source: 'ios'
  variant: RemoteDraftVariant
  createdAt: number
  updatedAt: number
  workspaceId?: string
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}

export function normalizeRemoteDraftVariant(variant: string): RemoteDraftVariant {
  if (variant === 'global') return 'global'
  if (variant === 'ensemble') return 'ensemble'
  return 'workspace'
}

function readRemoteDraftMetadata(chat: ChatRecord): RemoteDraftMetadata | null {
  const raw = chat.providerMetadata?.[REMOTE_DRAFT_METADATA_KEY]
  if (!isRecord(raw)) return null
  if (raw.source !== 'ios') return null
  const variant = typeof raw.variant === 'string' ? normalizeRemoteDraftVariant(raw.variant) : null
  if (!variant) return null
  return {
    source: 'ios',
    variant,
    createdAt: typeof raw.createdAt === 'number' ? raw.createdAt : chat.createdAt,
    updatedAt: typeof raw.updatedAt === 'number' ? raw.updatedAt : chat.updatedAt,
    ...(typeof raw.workspaceId === 'string' ? { workspaceId: raw.workspaceId } : {})
  }
}

function isLegacyIosDraft(chat: ChatRecord): boolean {
  return (
    chat.appChatId.startsWith('ios-') &&
    (chat.title === 'New Chat' || chat.title === 'New Ensemble')
  )
}

export function isUnstartedRemoteDraftChat(chat: ChatRecord | null | undefined): chat is ChatRecord {
  if (!chat || chat.archived) return false
  if (!readRemoteDraftMetadata(chat) && !isLegacyIosDraft(chat)) return false
  if ((chat.messages || []).length > 0 || (chat.runs || []).length > 0) return false
  if (chat.pinned || chat.pinnedNotes?.trim()) return false
  if (chat.parentChatId || chat.parentChatRelation || chat.sideChatContext) return false
  if (chat.activeGoal) return false
  if (chat.soloWakeups && Object.keys(chat.soloWakeups).length > 0) return false
  return true
}

export function remoteDraftMatchesTarget(chat: ChatRecord, target: RemoteDraftTarget): boolean {
  if (!isUnstartedRemoteDraftChat(chat)) return false
  const chatKind = chat.chatKind || 'single'
  if (target.variant === 'global') {
    return chat.scope === 'global' && chatKind === 'single'
  }
  if (target.variant === 'ensemble') {
    return chat.scope !== 'global' && chatKind === 'ensemble' && chat.workspaceId === target.workspaceId
  }
  return chat.scope !== 'global' && chatKind === 'single' && chat.workspaceId === target.workspaceId
}

export function findReusableRemoteDraft(
  chats: ChatRecord[],
  target: RemoteDraftTarget,
  excludeId?: string
): ChatRecord | null {
  return (
    [...chats]
      .filter((chat) => chat.appChatId !== excludeId && remoteDraftMatchesTarget(chat, target))
      .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))[0] ?? null
  )
}

function remoteDraftMetadata(
  existing: ChatRecord | undefined,
  target: RemoteDraftTarget,
  now: number
): RemoteDraftMetadata {
  const previous = existing ? readRemoteDraftMetadata(existing) : null
  return {
    source: 'ios',
    variant: target.variant,
    createdAt: previous?.createdAt ?? existing?.createdAt ?? now,
    updatedAt: now,
    ...(target.workspaceId ? { workspaceId: target.workspaceId } : {})
  }
}

export function buildRemoteDraftChat(input: {
  id: string
  target: RemoteDraftTarget
  now: number
  existing?: ChatRecord
}): ChatRecord {
  const { id, target, now, existing } = input
  const providerMetadata = {
    ...(existing?.providerMetadata || {}),
    [REMOTE_DRAFT_METADATA_KEY]: remoteDraftMetadata(existing, target, now)
  }
  const title =
    target.title?.trim() || (target.variant === 'ensemble' ? 'New Ensemble' : 'New Chat')
  const base: ChatRecord = {
    appChatId: id,
    scope: target.variant === 'global' ? 'global' : 'workspace',
    chatKind: target.variant === 'ensemble' ? 'ensemble' : 'single',
    provider: target.provider,
    title,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
    archived: false,
    messages: [],
    runs: [],
    providerMetadata
  }
  if (target.variant !== 'global') {
    base.workspaceId = target.workspaceId || ''
    base.workspacePath = target.workspacePath || ''
  }
  if (target.variant === 'ensemble' && target.ensemble) {
    base.ensemble = target.ensemble
  }
  return base
}

export function remoteDraftIdsToDelete(chats: ChatRecord[], keepId: string): string[] {
  return chats
    .filter((chat) => chat.appChatId !== keepId && isUnstartedRemoteDraftChat(chat))
    .map((chat) => chat.appChatId)
}
