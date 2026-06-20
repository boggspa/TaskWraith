import { memo } from 'react'
import { TranscriptPanel } from './TranscriptPanel'
import { buildChatViewProps, type BuildChatViewPropsInput } from '../lib/buildChatViewProps'

/**
 * ChatViewPane — a single NON-FOCUSED Multiview pane: a live, read-only
 * transcript viewer. It renders the same `.app-transcript` shell as the main
 * pane (so the glass/scroll styling matches) but WITHOUT the focused pane's
 * global corner chrome or composer. The focused pane is rendered inline by
 * App.tsx as today; only the extra panes use this component.
 *
 * Wrapped in React.memo with a custom comparator so a token landing in ANOTHER
 * pane (which re-creates the top-level `chats`/`runningChatIds` arrays every
 * frame) does NOT reconcile this pane — only a change to THIS chat's own
 * messages / run state does. The cost: a viewer's delegation-card live status
 * may lag a beat behind another chat's run, which is an accepted v1 tradeoff.
 */
export interface ChatViewPaneProps extends BuildChatViewPropsInput {
  paneIndex: number
  /** appearance.composerStyle / interface style for the `interface-*` class. */
  interfaceStyle: string
  /** Provider (or Ollama brand) class for the `provider-*` tint. */
  providerClass: string
  isEnsemble?: boolean
  /** Focus this pane (the single sidebar/composer then drive it). */
  onFocusPane?: (paneIndex: number, chatId: string) => void
  ariaLabel?: string
}

/**
 * Skip re-render unless something this pane actually displays changed. We
 * deliberately ignore the high-churn shared props (chats, runningChatIds,
 * pendingQueuedAppRunIds) and the stable App callbacks — see the component
 * doc for the tradeoff. EVERY render-affecting per-pane prop must be listed.
 */
export function chatViewPanePropsEqual(a: ChatViewPaneProps, b: ChatViewPaneProps): boolean {
  return (
    a.chat === b.chat &&
    a.messages === b.messages &&
    a.isThinking === b.isThinking &&
    a.runCompleteNotice === b.runCompleteNotice &&
    a.isWelcomeChat === b.isWelcomeChat &&
    a.provider === b.provider &&
    a.providerLabel === b.providerLabel &&
    a.currentRun === b.currentRun &&
    a.pendingAgentQuestions === b.pendingAgentQuestions &&
    a.copiedId === b.copiedId &&
    a.compactDensity === b.compactDensity &&
    a.liveActivityViewport === b.liveActivityViewport &&
    a.interfaceStyle === b.interfaceStyle &&
    a.providerClass === b.providerClass &&
    a.isEnsemble === b.isEnsemble &&
    a.refs === b.refs &&
    a.paneIndex === b.paneIndex &&
    a.onFocusPane === b.onFocusPane &&
    a.ariaLabel === b.ariaLabel
  )
}

function ChatViewPaneInner(props: ChatViewPaneProps) {
  const viewProps = buildChatViewProps(props)
  const className = [
    'app-transcript',
    'multiview-pane-transcript',
    `provider-${props.providerClass}`,
    `interface-${props.interfaceStyle}`,
    props.isEnsemble ? 'chat-kind-ensemble' : '',
    props.isWelcomeChat ? 'welcome-mode' : ''
  ]
    .filter(Boolean)
    .join(' ')

  return (
    <div
      className={className}
      data-multiview-pane-chat-id={props.chat?.appChatId ?? undefined}
      role="group"
      aria-label={props.ariaLabel}
      onMouseDownCapture={() => {
        const chatId = props.chat?.appChatId
        if (chatId) props.onFocusPane?.(props.paneIndex, chatId)
      }}
    >
      <TranscriptPanel {...viewProps} />
    </div>
  )
}

export const ChatViewPane = memo(ChatViewPaneInner, chatViewPanePropsEqual)
