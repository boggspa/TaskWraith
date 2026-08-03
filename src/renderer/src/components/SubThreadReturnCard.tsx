import type { CSSProperties } from 'react'
import type { ChatMessage, ChatRecord } from '../../../main/store/types'
import { AgentIdentityIcon } from './icons/AgentIdentityIcon'
import { assignAgentIdentityFromSeed } from '../lib/agentIdentitySeed'
import { LiveActivityViewport } from './LiveActivityViewport'
import { MarkdownMessage } from './MarkdownMessage'
import { MessageActionsChip } from './MessageActionsChip'
import { PillButton } from './PillButton'
import { ProviderSatelliteLabel } from './ProviderSatelliteLabel'
import { linkedChildReturnRelation, subThreadReturnBody } from './SubThreadReturnCardModel'

interface SubThreadReturnCardProps {
  message: ChatMessage
  chat?: ChatRecord
  onOpenSubThread?: (chatId: string) => void
  onOpenSubThreadInSidePanel?: (chatId: string, presentation?: 'split' | 'drawer') => void
  onCopyMessage?: (messageId: string, content: string) => void
  onAddMessageToPrompt?: (messageId: string, content: string) => void
  onDeleteMessage?: (messageId: string) => void
  onTogglePinMessage?: (messageId: string) => void
  onOpenSideChatFromMessage?: (message: ChatMessage) => void
  pinned?: boolean
  copied?: boolean
  resultExpanded?: boolean
  onResultExpandedChange?: (expanded: boolean) => void
}

const COLLAPSED_RESULT_MARKDOWN_LIMIT = 6_000
const COLLAPSED_RESULT_PREVIEW_CHARS = 2_400

function textValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

export function SubThreadReturnCard({
  message,
  chat,
  onOpenSubThread,
  onOpenSubThreadInSidePanel,
  onCopyMessage,
  onAddMessageToPrompt,
  onDeleteMessage,
  onTogglePinMessage,
  onOpenSideChatFromMessage,
  pinned = false,
  copied = false,
  resultExpanded,
  onResultExpandedChange
}: SubThreadReturnCardProps) {
  const metadata = message.metadata || {}
  const relation = linkedChildReturnRelation(message)
  const isSideChatReturn = relation === 'sideChat'
  const provider = metadata.subThreadProvider
  const title =
    textValue(metadata.subThreadTitle) ||
    (isSideChatReturn ? 'Untitled side chat' : 'Untitled sub-thread')
  const subThreadId = textValue(metadata.subThreadId)
  // Deterministic per-sub-thread identity (same id -> same character on
  // every delegation surface: this card, the Agent-Invocation card, the
  // delegation timeline). Seeded by the sub-thread chat id.
  const agentIdentity = subThreadId ? assignAgentIdentityFromSeed(subThreadId) : null
  const body = subThreadReturnBody(message.content)
  const renderFullBody = Boolean(resultExpanded) || body.length <= COLLAPSED_RESULT_MARKDOWN_LIMIT
  const previewBody =
    body.length > COLLAPSED_RESULT_PREVIEW_CHARS
      ? `${body.slice(0, COLLAPSED_RESULT_PREVIEW_CHARS).trimEnd()}\n...`
      : body
  const handleOpen = () => {
    if (!subThreadId) return
    if (onOpenSubThreadInSidePanel) {
      onOpenSubThreadInSidePanel(subThreadId)
      return
    }
    onOpenSubThread?.(subThreadId)
  }

  return (
    <article
      className="subthread-return-card"
      style={
        agentIdentity ? ({ ['--agent-rim']: agentIdentity.accent } as CSSProperties) : undefined
      }
    >
      <header className="subthread-return-header">
        <div className="subthread-return-heading">
          <span aria-hidden="true" className="subthread-return-glyph">
            ↩
          </span>
          <span className="subthread-return-label">
            {isSideChatReturn ? 'Side-chat result from' : 'Invocation result from'}
          </span>
          {agentIdentity && (
            <span className="subthread-return-agent" title={agentIdentity.name}>
              <AgentIdentityIcon
                name={agentIdentity.key}
                color={agentIdentity.accent}
                size={36}
                className="subthread-return-agent-icon"
                title={agentIdentity.name}
              />
              <span className="subthread-return-agent-name">{agentIdentity.name}</span>
            </span>
          )}
          <ProviderSatelliteLabel
            provider={typeof provider === 'string' ? provider : undefined}
            className="subthread-return-provider"
          />
          <strong className="subthread-return-title">{title}</strong>
        </div>
        {subThreadId && (onOpenSubThread || onOpenSubThreadInSidePanel) && (
          <div className="subthread-return-actions">
            <PillButton
              size="compact"
              className="subthread-side-chat-button"
              onClick={handleOpen}
              title={
                isSideChatReturn ? 'Open this side chat' : 'Open this sub-thread as a side chat'
              }
              aria-label="Open side chat"
            >
              Side chat
            </PillButton>
          </div>
        )}
      </header>
      <div className="subthread-return-body">
        <LiveActivityViewport
          className="subthread-return-viewport"
          revision={`${message.id}:${body.length}`}
          collapsedMaxHeight={220}
          expanded={resultExpanded}
          onExpandedChange={onResultExpandedChange}
          label={isSideChatReturn ? 'Side-chat result' : 'Sub-thread result'}
          expandLabel="Expand result"
          collapseLabel="Collapse result"
          jumpLabel="Jump to latest result"
        >
          <div className="subthread-return-body-inner">
            {renderFullBody ? (
              <MarkdownMessage content={body} chat={chat} />
            ) : (
              <div
                className="subthread-return-preview"
                aria-label={`Collapsed ${isSideChatReturn ? 'side-chat' : 'sub-thread'} result preview`}
              >
                <MarkdownMessage content={previewBody} chat={chat} />
                <div className="subthread-return-preview-note">
                  Full result is rendered when expanded.
                </div>
              </div>
            )}
          </div>
        </LiveActivityViewport>
      </div>
      {onCopyMessage && (
        <MessageActionsChip
          onCopy={() => onCopyMessage(message.id, body)}
          onAddToPrompt={
            onAddMessageToPrompt && body.trim()
              ? () => onAddMessageToPrompt(message.id, body)
              : undefined
          }
          onTogglePin={onTogglePinMessage ? () => onTogglePinMessage(message.id) : undefined}
          onDelete={onDeleteMessage ? () => onDeleteMessage(message.id) : undefined}
          onOpenSideChat={
            onOpenSideChatFromMessage ? () => onOpenSideChatFromMessage(message) : undefined
          }
          pinned={pinned}
          copied={copied}
          label={isSideChatReturn ? 'side-chat result' : 'sub-thread result'}
        />
      )}
    </article>
  )
}
