import { memo } from 'react'
import { TranscriptPanel } from './TranscriptPanel'
import { buildChatViewProps, type BuildChatViewPropsInput } from '../lib/buildChatViewProps'
import { buildWelcomeCopy } from '../lib/welcomeCopy'

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
  welcomeWorkspaceName?: string | null
  welcomeIsGlobalChat?: boolean
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
    a.welcomeWorkspaceName === b.welcomeWorkspaceName &&
    a.welcomeIsGlobalChat === b.welcomeIsGlobalChat &&
    a.refs === b.refs &&
    a.paneIndex === b.paneIndex &&
    a.onFocusPane === b.onFocusPane &&
    a.ariaLabel === b.ariaLabel
  )
}

const fallbackWorkspaceName = (workspacePath?: string | null): string => {
  if (!workspacePath) return 'TaskWraith'
  return workspacePath.split(/[\\/]/).filter(Boolean).pop() || 'TaskWraith'
}

function ChatViewWelcomePane(props: ChatViewPaneProps) {
  const isGlobalChat = props.welcomeIsGlobalChat ?? props.chat?.scope === 'global'
  const workspaceName = isGlobalChat
    ? 'Global Chat'
    : props.welcomeWorkspaceName || fallbackWorkspaceName(props.chat?.workspacePath)
  const copy = buildWelcomeCopy({
    workspaceName,
    providerLabel: props.providerLabel,
    permissionModeLabel: 'Default Approval',
    isGlobalChat,
    hasDiff: false,
    diffCount: 0,
    scheduledTaskCount: 0
  })
  const heading = props.isEnsemble
    ? {
        beforeWorkspace: 'New Ensemble chat in ',
        workspaceName,
        afterWorkspace: isGlobalChat ? '.' : ' Workspace.'
      }
    : copy.heading
  const subheading = props.isEnsemble
    ? 'Multiple providers are ready to work in one shared transcript.'
    : copy.subheading

  return (
    <div className="multiview-pane-welcome">
      <div className="welcome-hero multiview-pane-welcome-hero">
        <h1>
          <span>{heading.beforeWorkspace}</span>
          <strong className={`workspace-name-glow provider-${props.providerClass}`}>
            {heading.workspaceName}
          </strong>
          <span>{heading.afterWorkspace}</span>
        </h1>
        <p>{subheading}</p>
      </div>
      {!props.isEnsemble && (
        <div className="multiview-pane-welcome-starters" aria-hidden>
          {copy.starters.slice(0, 3).map((starter) => (
            <div
              key={starter.id}
              className="multiview-pane-welcome-starter"
              data-intent={starter.intent}
            >
              <span className="multiview-pane-welcome-starter-label">{starter.label}</span>
              <span className="multiview-pane-welcome-starter-description">
                {starter.description}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

function ChatViewPaneInner(props: ChatViewPaneProps) {
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
      {props.isWelcomeChat ? (
        <ChatViewWelcomePane {...props} />
      ) : (
        <TranscriptPanel {...buildChatViewProps(props)} />
      )}
    </div>
  )
}

export const ChatViewPane = memo(ChatViewPaneInner, chatViewPanePropsEqual)
