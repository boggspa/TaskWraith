import type { ChatRecord, SideChatLifecycleState, SideChatMode } from '../../../main/store/types'
import { assignAgentIdentityFromSeed } from './agentIdentitySeed'
import { isSubThreadChat } from './chatScope'

export type SideChatCreateMode = SideChatMode

export const SIDE_CHAT_SELECTED_PARTICIPANT_ID_METADATA_KEY = 'sideChatSelectedParticipantId'
export const SIDE_CHAT_SELECTED_PARTICIPANT_ROLE_METADATA_KEY = 'sideChatSelectedParticipantRole'
export const SIDE_CHAT_HIDDEN_CONTEXT_PROMPT_METADATA_KEY = 'sideChatHiddenContextPrompt'
export const SIDE_CHAT_HIDDEN_CONTEXT_CONSUMED_AT_METADATA_KEY = 'sideChatHiddenContextConsumedAt'

export function getPendingSideChatHiddenContextPrompt(
  chat: ChatRecord | null | undefined
): string {
  if (!chat || chat.parentChatRelation !== 'sideChat') return ''
  if (chat.providerMetadata?.[SIDE_CHAT_HIDDEN_CONTEXT_CONSUMED_AT_METADATA_KEY]) return ''
  const value = chat.providerMetadata?.[SIDE_CHAT_HIDDEN_CONTEXT_PROMPT_METADATA_KEY]
  return typeof value === 'string' ? value.trim() : ''
}

export function getSideChatMode(chat: ChatRecord): SideChatCreateMode {
  if (chat.sideChatContext?.mode) return chat.sideChatContext.mode
  return chat.chatKind === 'ensemble' ? 'ensembleClone' : 'singleProvider'
}

export function getSideChatLifecycleState(chat: ChatRecord): SideChatLifecycleState {
  const state = chat.sideChatContext?.lifecycleState
  if (state === 'active' || state === 'closed' || state === 'terminated') return state
  return chat.archived ? 'terminated' : 'active'
}

export function getSideChatSelectedParticipantId(chat: ChatRecord): string {
  const value = chat.providerMetadata?.[SIDE_CHAT_SELECTED_PARTICIPANT_ID_METADATA_KEY]
  return typeof value === 'string' ? value : ''
}

export function isTerminatedSideChat(chat: ChatRecord): boolean {
  return chat.parentChatRelation === 'sideChat' && getSideChatLifecycleState(chat) === 'terminated'
}

export function isTopLevelWorkspaceChat(chat: ChatRecord): boolean {
  return !chat.parentChatId && chat.parentChatRelation !== 'sideChat' && !isSubThreadChat(chat)
}

export function getLinkedChatAgentIdentity(chat: ChatRecord | null | undefined) {
  if (!chat) return null
  if (isSubThreadChat(chat)) return assignAgentIdentityFromSeed(chat.appChatId)
  if (
    chat.parentChatRelation !== 'sideChat' ||
    !['singleProvider', 'guestParticipant'].includes(getSideChatMode(chat))
  )
    return null
  if (getSideChatMode(chat) === 'guestParticipant') {
    return assignAgentIdentityFromSeed(`${chat.parentChatId || chat.appChatId}:guest`)
  }
  const participantId = getSideChatSelectedParticipantId(chat)
  if (!participantId) return null
  return assignAgentIdentityFromSeed(`${chat.parentChatId || chat.appChatId}:${participantId}`)
}

export function getLinkedChatKindLabel(chat: ChatRecord): string {
  if (chat.parentChatRelation === 'sideChat') {
    const mode = getSideChatMode(chat)
    if (mode === 'fanOut') return 'Fan-out side chat'
    if (mode === 'ensembleClone') return 'Side ensemble'
    if (mode === 'guestParticipant') return 'Guest'
    return 'Isolated side chat'
  }
  return 'Sub-thread'
}

export function applySideChatLifecycle(
  chat: ChatRecord,
  lifecycleState: SideChatLifecycleState,
  terminationReason?: string
): ChatRecord {
  if (chat.parentChatRelation !== 'sideChat') return chat
  const now = Date.now()
  const sideChatContext: ChatRecord['sideChatContext'] = {
    createdAt: chat.sideChatContext?.createdAt || chat.createdAt || now,
    ...(chat.sideChatContext || {}),
    lifecycleState
  }
  if (lifecycleState === 'active') {
    sideChatContext.openedAt = now
    sideChatContext.closedAt = undefined
    sideChatContext.terminatedAt = undefined
    sideChatContext.terminationReason = undefined
  } else if (lifecycleState === 'closed') {
    sideChatContext.closedAt = now
    sideChatContext.terminatedAt = undefined
    sideChatContext.terminationReason = undefined
  } else {
    sideChatContext.closedAt = now
    sideChatContext.terminatedAt = now
    sideChatContext.terminationReason = terminationReason || 'ended_by_user'
  }
  return {
    ...chat,
    sideChatContext,
    ...(lifecycleState === 'terminated' ? { archived: true, updatedAt: now } : {})
  }
}
