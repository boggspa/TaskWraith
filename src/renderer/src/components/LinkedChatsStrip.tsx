import { useState } from 'react'
import type { ChatRecord, ProviderId } from '../../../main/store/types'
import { isSubThreadChat } from '../lib/chatScope'
import { assignAgentIdentityFromSeed } from '../lib/agentIdentitySeed'
import { AgentIdentityIcon } from './icons/AgentIdentityIcon'
import { ChatPopoutIcon, LinkCircleSymbolIcon, SplitChatIcon } from './AppChromeSymbols'

const SIDE_CHAT_SELECTED_PARTICIPANT_ID_METADATA_KEY = 'sideChatSelectedParticipantId'
const SIDE_CHAT_SELECTED_PARTICIPANT_ROLE_METADATA_KEY = 'sideChatSelectedParticipantRole'

interface LinkedChatsStripProps {
  currentChat: ChatRecord | null
  chats: ChatRecord[]
  runningChatIds: string[]
  onOpenBeside?: (chatId: string) => void
  onOpenDrawer?: (chatId: string) => void
  onOpenMain?: (chatId: string) => void
  onPopOut?: (chatId: string) => void
  defaultCollapsed?: boolean
}

function providerLabel(provider?: ProviderId): string {
  if (provider === 'codex') return 'Codex'
  if (provider === 'claude') return 'Claude'
  if (provider === 'kimi') return 'Kimi'
  if (provider === 'grok') return 'Grok'
  if (provider === 'cursor') return 'Cursor'
  if (provider === 'gemini') return 'Gemini'
  return 'Chat'
}

function linkedKindLabel(chat: ChatRecord): string {
  if (chat.parentChatRelation === 'sideChat') {
    if (chat.sideChatContext?.mode === 'fanOut') return 'Fan-out side chat'
    if (chat.sideChatContext?.mode === 'ensembleClone') return 'Side ensemble'
    if (chat.sideChatContext?.mode === 'guestParticipant') return 'Guest side chat'
    if (chat.sideChatContext?.mode === 'singleProvider') return 'Isolated side chat'
    return chat.chatKind === 'ensemble' ? 'Side ensemble' : 'Isolated side chat'
  }
  return 'Sub-thread'
}

function linkedModeLabel(chat: ChatRecord): string {
  if (chat.parentChatRelation !== 'sideChat') return 'Delegated child'
  if (chat.sideChatContext?.mode === 'ensembleClone') return 'Ensemble clone'
  if (chat.sideChatContext?.mode === 'guestParticipant') return 'Historical guest chat'
  if (chat.sideChatContext?.mode === 'singleProvider') {
    const participantLabel = linkedParticipantLabel(chat)
    return participantLabel ? `Participant: ${participantLabel}` : 'Isolated sidecar'
  }
  if (chat.sideChatContext?.mode === 'fanOut') return 'Fan-out'
  return chat.chatKind === 'ensemble' ? 'Side ensemble' : 'Isolated sidecar'
}

function linkedParticipantLabel(chat: ChatRecord): string {
  const roleValue = chat.providerMetadata?.[SIDE_CHAT_SELECTED_PARTICIPANT_ROLE_METADATA_KEY]
  if (typeof roleValue === 'string' && roleValue.trim()) return roleValue.trim()
  const idValue = chat.providerMetadata?.[SIDE_CHAT_SELECTED_PARTICIPANT_ID_METADATA_KEY]
  return typeof idValue === 'string' && idValue.trim() ? providerLabel(chat.provider) : ''
}

function linkedAgentIdentity(chat: ChatRecord) {
  if (isSubThreadChat(chat)) return assignAgentIdentityFromSeed(chat.appChatId)
  if (
    chat.parentChatRelation !== 'sideChat' ||
    !['singleProvider', 'guestParticipant'].includes(chat.sideChatContext?.mode || '')
  ) {
    return null
  }
  if (chat.sideChatContext?.mode === 'guestParticipant') {
    return assignAgentIdentityFromSeed(`${chat.parentChatId || chat.appChatId}:guest`)
  }
  const participantId = chat.providerMetadata?.[SIDE_CHAT_SELECTED_PARTICIPANT_ID_METADATA_KEY]
  if (typeof participantId !== 'string' || !participantId.trim()) return null
  return assignAgentIdentityFromSeed(
    `${chat.parentChatId || chat.appChatId}:${participantId.trim()}`
  )
}

function linkedRouteLabel(chat: ChatRecord, parentChat: ChatRecord): string {
  const parentProvider = chat.delegationContext?.parentProvider || parentChat.provider
  const parentLabel = providerLabel(parentProvider)
  const childLabel = providerLabel(chat.provider)
  if (isSubThreadChat(chat)) return `${parentLabel} delegated to ${childLabel}`
  if (chat.parentChatRelation !== 'sideChat') return ''
  if (chat.sideChatContext?.mode === 'fanOut') return `${parentLabel} parallel fan-out`
  if (chat.sideChatContext?.mode === 'ensembleClone') return `${parentLabel} ensemble side branch`
  if (chat.sideChatContext?.mode === 'guestParticipant') {
    return `${parentLabel} historical guest transcript`
  }
  const participantLabel = linkedParticipantLabel(chat)
  if (!participantLabel && parentProvider === chat.provider) return `${parentLabel} isolated side chat`
  return participantLabel
    ? `${parentLabel} dedicated branch to ${participantLabel}`
    : `${parentLabel} side branch to ${childLabel}`
}

function linkedContextLabel(chat: ChatRecord): string {
  if (chat.parentChatRelation !== 'sideChat') return 'Delegation context'
  if (chat.sideChatContext?.mode === 'guestParticipant') return 'Historical guest transcript'
  if (chat.sideChatContext?.originMessageId) return 'Seeded from selected message'
  if (chat.sideChatContext?.originRunId) return 'Seeded from run result'
  if (chat.sideChatContext?.transcriptVisibility === 'summary') return 'Seeded from summary'
  if (chat.sideChatContext?.transcriptVisibility === 'snapshot') return 'Copied parent snapshot'
  return 'Isolated context'
}

function isTerminatedSideChat(chat: ChatRecord): boolean {
  if (chat.parentChatRelation !== 'sideChat') return false
  const state = chat.sideChatContext?.lifecycleState
  if (state === 'terminated') return true
  return chat.archived && !state
}

function linkedStateLabel(chat: ChatRecord, running: boolean): string {
  if (running) return 'Running'
  if (chat.parentChatRelation !== 'sideChat') return 'Ready'
  if (chat.sideChatContext?.lifecycleState === 'active') return 'Active'
  if (chat.sideChatContext?.lifecycleState === 'closed') return 'Closed'
  return 'Ready'
}

function countLabel(count: number, singular: string, plural = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : plural}`
}

export function LinkedChatsStrip({
  currentChat,
  chats,
  runningChatIds,
  onOpenBeside,
  onOpenDrawer,
  onOpenMain,
  onPopOut,
  defaultCollapsed = false
}: LinkedChatsStripProps) {
  const [collapsed, setCollapsed] = useState(defaultCollapsed)
  if (!currentChat) return null
  const runningSet = new Set(runningChatIds)
  const linkedChats = chats
    .filter(
      (chat) =>
        !chat.archived &&
        !isTerminatedSideChat(chat) &&
        chat.parentChatId === currentChat.appChatId &&
        (chat.parentChatRelation === 'sideChat' || isSubThreadChat(chat))
    )
    .sort((a, b) => (b.updatedAt || b.createdAt || 0) - (a.updatedAt || a.createdAt || 0))

  if (linkedChats.length === 0) return null

  const visibleChats = linkedChats.slice(0, 4)
  const hiddenCount = linkedChats.length - visibleChats.length
  const guestCount = linkedChats.filter(
    (chat) =>
      chat.parentChatRelation === 'sideChat' && chat.sideChatContext?.mode === 'guestParticipant'
  ).length
  const sideChatCount = linkedChats.filter(
    (chat) =>
      chat.parentChatRelation === 'sideChat' && chat.sideChatContext?.mode !== 'guestParticipant'
  ).length
  const subThreadCount = linkedChats.length - sideChatCount - guestCount
  const runningCount = linkedChats.filter((chat) => runningSet.has(chat.appChatId)).length
  const summaryParts = [
    `${linkedChats.length} linked`,
    runningCount > 0 ? `${runningCount} running` : '',
    sideChatCount > 0 ? countLabel(sideChatCount, 'side chat') : '',
    guestCount > 0 ? countLabel(guestCount, 'guest') : '',
    subThreadCount > 0 ? countLabel(subThreadCount, 'sub-thread') : ''
  ].filter(Boolean)
  const markerLabel = 'Linked chats'
  const compactMarkerLabel = 'Linked'
  const compactSummaryParts = [
    String(linkedChats.length),
    runningCount > 0 ? `${runningCount} running` : ''
  ].filter(Boolean)
  const listId = `linked-chats-strip-list-${currentChat.appChatId}`

  return (
    <div
      className={`linked-chats-strip ${collapsed ? 'is-collapsed' : 'is-expanded'}`}
      aria-label={markerLabel}
    >
      <button
        type="button"
        className="linked-chats-strip-toggle"
        aria-expanded={!collapsed}
        aria-controls={listId}
        onClick={() => setCollapsed((value) => !value)}
        title={`${collapsed ? 'Show linked chats' : 'Hide linked chats'}: ${summaryParts.join(
          ' | '
        )}`}
      >
        <span className="linked-chats-strip-caret" aria-hidden>
          {collapsed ? '+' : '-'}
        </span>
        <span className="linked-chats-strip-label">{compactMarkerLabel}</span>
        <span className="linked-chats-strip-summary">{compactSummaryParts.join(' | ')}</span>
      </button>
      {!collapsed && (
        <div id={listId} className="linked-chats-strip-list">
          {visibleChats.map((chat) => {
            const provider = chat.provider || 'gemini'
            const running = runningSet.has(chat.appChatId)
            const title = chat.title || linkedKindLabel(chat)
            const canOpenBeside = Boolean(onOpenBeside)
            const stateLabel = linkedStateLabel(chat, running)
            const contextLabel = linkedContextLabel(chat)
            const modeLabel = linkedModeLabel(chat)
            const routeLabel = linkedRouteLabel(chat, currentChat)
            const agentIdentity = linkedAgentIdentity(chat)
            const visibleStateLabel = running ? 'Running' : ''
            const titleDetails = [stateLabel, modeLabel, contextLabel, routeLabel]
              .filter(Boolean)
              .join(' | ')
            return (
              <div
                key={chat.appChatId}
                className={`linked-chats-strip-item provider-${provider} ${
                  running ? 'is-running' : ''
                }`}
              >
                <button
                  type="button"
                  className="linked-chats-strip-open"
                  onClick={canOpenBeside ? () => onOpenBeside?.(chat.appChatId) : undefined}
                  disabled={!canOpenBeside}
                  title={`Open beside: ${title}${titleDetails ? ` (${titleDetails})` : ''}`}
                  aria-label={`Open ${title} beside the current chat`}
                >
                  <span
                    className="linked-chats-strip-provider-dot"
                    style={{ background: `var(--provider-${provider}-color)` }}
                    aria-hidden="true"
                  />
                  <span className="linked-chats-strip-provider">{providerLabel(provider)}</span>
                  <span className="linked-chats-strip-kind">{linkedKindLabel(chat)}</span>
                  {agentIdentity && (
                    <span
                      className="linked-chats-strip-agent"
                      title={agentIdentity.name}
                    >
                      <AgentIdentityIcon
                        name={agentIdentity.key}
                        color={agentIdentity.accent}
                        size={20}
                        className="linked-chats-strip-agent-icon"
                        title={agentIdentity.name}
                      />
                      <span>{agentIdentity.name}</span>
                    </span>
                  )}
                  <span className="linked-chats-strip-title">{title}</span>
                  <span className="linked-chats-strip-meta">
                    {visibleStateLabel && (
                      <span className="linked-chats-strip-state">{visibleStateLabel}</span>
                    )}
                    <span className="linked-chats-strip-mode linked-chats-strip-detail">
                      {modeLabel}
                    </span>
                    <span className="linked-chats-strip-context linked-chats-strip-detail">
                      {contextLabel}
                    </span>
                    {routeLabel && (
                      <span className="linked-chats-strip-route linked-chats-strip-detail">
                        {routeLabel}
                      </span>
                    )}
                  </span>
                </button>
                {onOpenDrawer && (
                  <button
                    type="button"
                    className="linked-chats-strip-main linked-chats-strip-action"
                    onClick={() => onOpenDrawer(chat.appChatId)}
                    title={`Open in side drawer: ${title}`}
                    aria-label={`Open ${title} in the side drawer`}
                  >
                    <span className="linked-chats-strip-action-icon" aria-hidden="true">
                      <SplitChatIcon />
                    </span>
                    <span className="sr-only">Open drawer</span>
                  </button>
                )}
                {onOpenMain && (
                  <button
                    type="button"
                    className="linked-chats-strip-main linked-chats-strip-action"
                    onClick={() => onOpenMain(chat.appChatId)}
                    title={`Open as main chat: ${title}`}
                    aria-label={`Open ${title} as the main chat`}
                  >
                    <span className="linked-chats-strip-action-icon" aria-hidden="true">
                      <LinkCircleSymbolIcon />
                    </span>
                    <span className="sr-only">Open as main</span>
                  </button>
                )}
                {onPopOut && (
                  <button
                    type="button"
                    className="linked-chats-strip-main linked-chats-strip-action"
                    onClick={() => onPopOut(chat.appChatId)}
                    title={`Pop out linked chat: ${title}`}
                    aria-label={`Pop out ${title}`}
                  >
                    <span className="linked-chats-strip-action-icon" aria-hidden="true">
                      <ChatPopoutIcon />
                    </span>
                    <span className="sr-only">Pop out</span>
                  </button>
                )}
              </div>
            )
          })}
          {hiddenCount > 0 && (
            <span className="linked-chats-strip-more">+{hiddenCount} more</span>
          )}
        </div>
      )}
    </div>
  )
}
