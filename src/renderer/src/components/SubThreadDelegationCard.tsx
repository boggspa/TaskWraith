import type { CSSProperties } from 'react'
import type { ChatMessage, ChatRecord, ProviderId } from '../../../main/store/types'
import { agentInvocationRouteLabel } from '../lib/AgentInvocationPresentation'
import { assignAgentIdentityFromSeed } from '../lib/agentIdentitySeed'
import { AgentIdentityIcon } from './icons/AgentIdentityIcon'
import { PillButton } from './PillButton'
import { ProviderSatelliteLabel } from './ProviderSatelliteLabel'
import { resolveDelegationStatus, type DelegationCardStatus } from './SubThreadDelegationCardModel'

interface SubThreadDelegationCardProps {
  message: ChatMessage
  /** All chats — used to look up the live sub-thread record by id so the
   * card can render Created / Running / Completed / Returned / Failed status. */
  chats: ChatRecord[]
  /** Which chat ids currently have an active run on the run-queue. The
   * status display ticks "Running ▶" while the sub-thread's id is in
   * this set. */
  runningChatIds?: string[]
  onOpenSubThread?: (chatId: string) => void
  onOpenSubThreadInSidePanel?: (chatId: string, presentation?: 'split' | 'drawer') => void
}

function textValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function statusGlyph(status: DelegationCardStatus): string {
  switch (status.kind) {
    case 'created':
      return '·'
    case 'running':
      return '▶'
    case 'completed':
      return '✓'
    case 'failed':
      return '✗'
    case 'cancelled':
      return '⊘'
    case 'returned':
      return '↩'
    default:
      return '·'
  }
}

function statusLabel(status: DelegationCardStatus): string {
  switch (status.kind) {
    case 'created':
      return 'Created'
    case 'running':
      // "Active" pairs with the contrast-aware accent shimmer-sweep
      // on `.subthread-delegation-status.status-running`.
      return 'Active'
    case 'completed':
      return 'Completed'
    case 'failed':
      return status.reason || 'Failed'
    case 'cancelled':
      return status.reason || 'Cancelled'
    case 'returned':
      return 'Returned'
    default:
      return 'Pending'
  }
}

export function SubThreadDelegationCard({
  message,
  chats,
  runningChatIds = [],
  onOpenSubThread,
  onOpenSubThreadInSidePanel
}: SubThreadDelegationCardProps) {
  const metadata = message.metadata || {}
  const subThreadId = textValue(metadata.subThreadId)
  // Same deterministic identity as the result card + timeline (seeded by
  // the sub-thread chat id) so one sub-thread = one character everywhere.
  const agentIdentity = subThreadId ? assignAgentIdentityFromSeed(subThreadId) : null
  const parentProvider =
    typeof metadata.parentProvider === 'string'
      ? (metadata.parentProvider as ProviderId)
      : undefined
  const targetProvider =
    typeof metadata.subThreadProvider === 'string'
      ? (metadata.subThreadProvider as ProviderId)
      : undefined
  const subThreadTitle = textValue(metadata.subThreadTitle) || 'Untitled sub-thread'
  const promptPreview =
    textValue(metadata.delegationPromptPreview) || textValue(metadata.delegationPrompt) || ''
  const returnResultToParent = metadata.returnResultToParent === true

  const subThread = subThreadId ? chats.find((chat) => chat.appChatId === subThreadId) : undefined
  const runningSet = new Set(runningChatIds)
  const status = resolveDelegationStatus(subThread, runningSet)
  const dispatchErrorMessage = textValue(subThread?.delegationContext?.dispatchError?.message)

  const handleOpen = () => {
    if (!subThreadId) return
    if (onOpenSubThreadInSidePanel) {
      onOpenSubThreadInSidePanel(subThreadId)
      return
    }
    if (onOpenSubThread) onOpenSubThread(subThreadId)
  }

  const isClickable = Boolean(subThreadId && (onOpenSubThreadInSidePanel || onOpenSubThread))
  const resultReturned = returnResultToParent && status.kind === 'returned'

  return (
    <article
      className={`subthread-delegation-card status-${status.kind} provider-${targetProvider || 'unknown'} ${isClickable ? 'clickable' : ''}`}
      style={agentIdentity ? ({ ['--agent-rim']: agentIdentity.accent } as CSSProperties) : undefined}
      role={isClickable ? 'button' : undefined}
      tabIndex={isClickable ? 0 : undefined}
      onClick={isClickable ? handleOpen : undefined}
      onKeyDown={(event) => {
        if (!isClickable) return
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault()
          handleOpen()
        }
      }}
      title={isClickable ? 'Open side chat' : undefined}
    >
      <header className="subthread-delegation-header">
        <div className="subthread-delegation-heading">
          <span className="agent-invocation-label">Agent Invocation</span>
          {agentIdentity && (
            <span className="subthread-delegation-agent" title={agentIdentity.name}>
              <AgentIdentityIcon
                name={agentIdentity.key}
                color={agentIdentity.accent}
                size={36}
                className="subthread-delegation-agent-icon"
                title={agentIdentity.name}
              />
              <span className="subthread-delegation-agent-name">{agentIdentity.name}</span>
            </span>
          )}
          <div className="subthread-delegation-arc">
            <ProviderSatelliteLabel provider={parentProvider} />
            <span className="subthread-delegation-arc-arrow">→</span>
            <ProviderSatelliteLabel provider={targetProvider} />
          </div>
        </div>
        <span className={`subthread-delegation-status status-${status.kind}`}>
          <span className="subthread-delegation-status-glyph">{statusGlyph(status)}</span>
          <span>{statusLabel(status)}</span>
        </span>
      </header>
      <div className="subthread-delegation-body">
        <div className="subthread-delegation-title" title={subThreadTitle}>
          {subThreadTitle}
        </div>
        {promptPreview && (
          <div className="subthread-delegation-prompt" title={promptPreview}>
            {promptPreview}
          </div>
        )}
        <div className="agent-invocation-route-note">
          {agentInvocationRouteLabel('taskwraith-subthread')}
          {isClickable ? ' · opens as side chat' : ''}
        </div>
      </div>
      {subThreadId && (onOpenSubThread || onOpenSubThreadInSidePanel) && (
        <div className="subthread-delegation-footer subthread-delegation-actions">
          <PillButton
            size="compact"
            className="subthread-side-chat-button"
            onClick={(event) => {
              event.stopPropagation()
              handleOpen()
            }}
            title="Open this sub-thread as a side chat"
            aria-label="Open side chat"
          >
            Side chat
          </PillButton>
        </div>
      )}
      {resultReturned && (
        <div className="subthread-delegation-footer">
          <span aria-hidden="true">↩</span>
          <span>Result returned to this thread</span>
        </div>
      )}
      {dispatchErrorMessage && (
        <div className="subthread-delegation-footer">
          <span aria-hidden="true">!</span>
          <span>{dispatchErrorMessage}</span>
        </div>
      )}
    </article>
  )
}
