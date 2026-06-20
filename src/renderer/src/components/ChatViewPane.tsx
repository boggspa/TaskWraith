import { memo, useLayoutEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import type { ComposerStyle } from '../../../main/store/types'
import { TranscriptPanel } from './TranscriptPanel'
import { Composer, type ComposerProps } from './Composer'
import { buildChatViewProps, type BuildChatViewPropsInput } from '../lib/buildChatViewProps'
import { FileMenuSelectionIcon } from './AppChromeSymbols'
import { WelcomeUsageDashboard } from './WelcomeUsageDashboard'
import type { WelcomeUsageDashboardData, WelcomeUsageTab } from '../lib/welcomeUsageDashboard'
import {
  AgentAuraLayer,
  type AgentAuraProviderKey,
  type AgentAuraStatus,
  type AdvancedFxIntensity
} from './FxLayers'

/**
 * ChatViewPane — a pane-scoped Multiview chat surface. It renders the same
 * `.app-transcript` shell as the main pane and includes a first-class composer
 * module for every populated pane, so a secondary pane is not a read-only
 * viewer that has to be promoted before the user can write to it.
 *
 * Wrapped in React.memo with a custom comparator so a token landing in ANOTHER
 * pane (which re-creates the top-level `chats`/`runningChatIds` arrays every
 * frame) does NOT reconcile this pane — only a change to THIS chat's own
 * messages / run state does. The cost: a viewer's delegation-card live status
 * may lag a beat behind another chat's run, which is an accepted v1 tradeoff.
 */
export interface ChatViewPaneProps extends Omit<
  BuildChatViewPropsInput,
  'onDeleteMessage' | 'onTogglePinMessage'
> {
  paneIndex: number
  /**
   * Pane-scoped Composer context. When supplied, the pane renders the SAME
   * `<Composer>` component as the focused main pane (built by App from the
   * shared `composerCtx` template with this pane's per-chat fields + pane-scoped
   * handlers overridden). Optional only so the prop-comparator/test fixtures
   * stay light; the live Multiview path always provides it.
   */
  composerProps?: ComposerProps
  /** appearance.composerStyle / interface style for the `interface-*` class. */
  interfaceStyle: ComposerStyle
  /** Provider (or Ollama brand) class for the `provider-*` tint. */
  providerClass: string
  isEnsemble?: boolean
  // ── Per-pane agent-aura (provider glow) ───────────────────────────────────
  // A non-focused pane renders its OWN `<AgentAuraLayer>` (the focused pane
  // already glows via App's inline `.app-transcript` FX layers). These mirror
  // App's app-global aura inputs but scoped to THIS pane's chat: `auraProvider`
  // is the pane's `auraProviderKey` ('ensemble' for ensemble chats, else the
  // provider); `auraStatus` is a per-pane `runFxStatus`; `auraIntensity` is the
  // app-global advanced-fx intensity. `showAura` gates on the same global
  // FX-enabled flag App uses for the focused aura — when false, no layer renders.
  // Optional so prop-comparator/test fixtures stay light; the live Multiview
  // path always supplies them.
  showAura?: boolean
  auraProvider?: AgentAuraProviderKey
  auraStatus?: AgentAuraStatus
  auraIntensity?: AdvancedFxIntensity
  welcomeWorkspaceName?: string | null
  welcomeIsGlobalChat?: boolean
  // ── Welcome usage dashboard (rendered by the pane shell, above the
  //    transcript/composer). The composer + its model/permission/workspace/
  //    attachment/goal/telemetry controls now live in the shared <Composer>
  //    (driven by `composerProps`), so those props were removed from this
  //    interface in the multiview composer-parity slice.
  welcomeUsageDashboardData?: WelcomeUsageDashboardData
  welcomeUsageTab?: WelcomeUsageTab
  onWelcomeUsageTabChange?: (tab: WelcomeUsageTab) => void
  showWelcomeUsageDashboard?: boolean
  reserveWelcomeUsageDashboard?: boolean
  dashboardStatVisibility?: Record<string, boolean>
  dashboardWorkspacesTabEnabled?: boolean
  dashboardWorkspacesShown?: number
  dashboardProvidersTabEnabled?: boolean
  dashboardAutoCycleSeconds?: number
  topLeftChrome?: ReactNode
  topRightChrome?: ReactNode
  topLeftChromeAction?: ChatViewPaneChromeAction
  topRightChromeActions?: ChatViewPaneChromeAction[]
  onDeleteMessage?: (paneIndex: number, chatId: string, messageId: string) => void
  onTogglePinMessage?: (paneIndex: number, chatId: string, messageId: string) => void
  /** Optional visual-focus callback for pane selection affordances. */
  onFocusPane?: (paneIndex: number, chatId: string) => void
  ariaLabel?: string
}

export interface ChatViewPaneChromeAction {
  id: string
  title: string
  icon: ReactNode
  ariaLabel?: string
  active?: boolean
  disabled?: boolean
  count?: number
  onClick?: (paneIndex: number, chatId: string) => void
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
    a.currentWorkspacePath === b.currentWorkspacePath &&
    a.pendingPlanChoice === b.pendingPlanChoice &&
    a.pendingAgentQuestions === b.pendingAgentQuestions &&
    a.thinkingProviderLabel === b.thinkingProviderLabel &&
    a.thinkingProvider === b.thinkingProvider &&
    a.thinkingProviderClass === b.thinkingProviderClass &&
    a.thinkingModelBadge === b.thinkingModelBadge &&
    a.copiedId === b.copiedId &&
    a.compactDensity === b.compactDensity &&
    a.liveActivityViewport === b.liveActivityViewport &&
    a.interfaceStyle === b.interfaceStyle &&
    a.providerClass === b.providerClass &&
    a.isEnsemble === b.isEnsemble &&
    // Per-pane agent-aura — MUST be compared or the pane won't re-tint when its
    // own run/approval/queue state (auraStatus) or provider/intensity changes.
    a.showAura === b.showAura &&
    a.auraProvider === b.auraProvider &&
    a.auraStatus === b.auraStatus &&
    a.auraIntensity === b.auraIntensity &&
    a.welcomeWorkspaceName === b.welcomeWorkspaceName &&
    a.welcomeIsGlobalChat === b.welcomeIsGlobalChat &&
    // Welcome usage dashboard (pane-shell-owned).
    a.welcomeUsageDashboardData === b.welcomeUsageDashboardData &&
    a.welcomeUsageTab === b.welcomeUsageTab &&
    a.showWelcomeUsageDashboard === b.showWelcomeUsageDashboard &&
    a.reserveWelcomeUsageDashboard === b.reserveWelcomeUsageDashboard &&
    a.dashboardStatVisibility === b.dashboardStatVisibility &&
    a.dashboardWorkspacesTabEnabled === b.dashboardWorkspacesTabEnabled &&
    a.dashboardWorkspacesShown === b.dashboardWorkspacesShown &&
    a.dashboardProvidersTabEnabled === b.dashboardProvidersTabEnabled &&
    a.dashboardAutoCycleSeconds === b.dashboardAutoCycleSeconds &&
    a.onWelcomeUsageTabChange === b.onWelcomeUsageTabChange &&
    // Chrome.
    a.topLeftChrome === b.topLeftChrome &&
    a.topRightChrome === b.topRightChrome &&
    a.topLeftChromeAction === b.topLeftChromeAction &&
    a.topRightChromeActions === b.topRightChromeActions &&
    // Transcript handlers (the composer's own handlers moved into <Composer>).
    a.onAgentQuestionSubmit === b.onAgentQuestionSubmit &&
    a.onAgentQuestionDismiss === b.onAgentQuestionDismiss &&
    a.onRunFallback === b.onRunFallback &&
    a.onPlanChoiceSubmit === b.onPlanChoiceSubmit &&
    a.onOpenSubThreadInSidePanel === b.onOpenSubThreadInSidePanel &&
    a.onOpenSideChatFromMessage === b.onOpenSideChatFromMessage &&
    a.onMessageSelectionCandidate === b.onMessageSelectionCandidate &&
    a.onDeleteMessage === b.onDeleteMessage &&
    a.onTogglePinMessage === b.onTogglePinMessage &&
    a.refs === b.refs &&
    a.paneIndex === b.paneIndex &&
    // The shared <Composer> is driven entirely by this object; a new identity
    // (App rebuilds it per render with this pane's values) reconciles the pane.
    a.composerProps === b.composerProps &&
    a.onFocusPane === b.onFocusPane &&
    a.ariaLabel === b.ariaLabel
  )
}

function ChatViewPaneChrome(props: ChatViewPaneProps) {
  if (props.topLeftChrome || props.topRightChrome) {
    return (
      <>
        {props.topLeftChrome}
        {props.topRightChrome}
      </>
    )
  }
  const chatId = props.chat?.appChatId ?? ''
  const title = props.chat?.title || props.welcomeWorkspaceName || 'New Chat'
  const defaultLeftAction: ChatViewPaneChromeAction = {
    id: 'pane-chat',
    title: 'Pane chat',
    ariaLabel: 'Pane chat',
    icon: <FileMenuSelectionIcon />,
    onClick: props.onFocusPane
  }
  const leftAction = props.topLeftChromeAction || defaultLeftAction
  const renderAction = (action: ChatViewPaneChromeAction) => (
    <button
      key={action.id}
      className={`chat-corner-btn${action.active ? ' active' : ''}`}
      type="button"
      title={action.title}
      aria-label={action.ariaLabel || action.title}
      aria-pressed={typeof action.active === 'boolean' ? action.active : undefined}
      disabled={action.disabled || !action.onClick || !chatId}
      onClick={(event) => {
        event.stopPropagation()
        if (!chatId || action.disabled) return
        action.onClick?.(props.paneIndex, chatId)
      }}
    >
      {action.icon}
      {typeof action.count === 'number' && action.count > 0 && (
        <span className="chat-corner-count">{action.count > 99 ? '99+' : action.count}</span>
      )}
    </button>
  )

  return (
    <>
      <div className="chat-corner-controls chat-corner-controls-left multiview-pane-corner-controls">
        {renderAction(leftAction)}
        <span className="chat-corner-thread-title" title={title}>
          {title}
        </span>
      </div>
      {props.topRightChromeActions && props.topRightChromeActions.length > 0 && (
        <div className="chat-corner-controls chat-corner-controls-right multiview-pane-corner-controls">
          {props.topRightChromeActions.map(renderAction)}
        </div>
      )}
    </>
  )
}

function ChatViewPaneInner(props: ChatViewPaneProps) {
  const rootRef = useRef<HTMLDivElement | null>(null)
  const [welcomeSizeClass, setWelcomeSizeClass] = useState<'normal' | 'compact' | 'tight'>('normal')
  const chatId = props.chat?.appChatId ?? ''
  // The composer is now the shared <Composer> (rendered below via
  // `props.composerProps`); all of this pane's composer state/handlers live in
  // that component. The retained body only drives the pane shell: the
  // `.app-transcript` className, the welcome size-class observer, and the
  // transcript/chrome render.
  const className = [
    'app-transcript',
    'multiview-pane-transcript',
    `provider-${props.providerClass}`,
    `interface-${props.interfaceStyle}`,
    props.isEnsemble ? 'chat-kind-ensemble' : '',
    props.isWelcomeChat ? 'welcome-mode' : '',
    props.isWelcomeChat && welcomeSizeClass === 'compact' ? 'welcome-compact-height' : '',
    props.isWelcomeChat && welcomeSizeClass === 'tight' ? 'welcome-tight-height' : ''
  ]
    .filter(Boolean)
    .join(' ')

  useLayoutEffect(() => {
    if (!props.isWelcomeChat) {
      setWelcomeSizeClass('normal')
      return
    }
    const target = rootRef.current
    if (!target || typeof window === 'undefined' || typeof window.ResizeObserver !== 'function') {
      return
    }
    const updateSizeClass = () => {
      const height = target.getBoundingClientRect().height
      const nextClass = height <= 560 ? 'tight' : height <= 900 ? 'compact' : 'normal'
      setWelcomeSizeClass((current) => (current === nextClass ? current : nextClass))
    }
    updateSizeClass()
    const observer = new window.ResizeObserver(updateSizeClass)
    observer.observe(target)
    return () => observer.disconnect()
  }, [props.isWelcomeChat])

  return (
    <div
      ref={rootRef}
      className={className}
      data-multiview-pane-chat-id={props.chat?.appChatId ?? undefined}
      role="group"
      aria-label={props.ariaLabel}
      onMouseDownCapture={() => {
        const focusChatId = props.chat?.appChatId
        if (focusChatId) props.onFocusPane?.(props.paneIndex, focusChatId)
      }}
    >
      {/* Per-pane provider glow. First child so it sits behind pane content
       * (it's `position:absolute; inset:0; pointer-events:none`). The focused
       * pane glows via App's inline FX layers; this gives resting panes the
       * same aura keyed to THEIR chat. `.multiview-cell` is `overflow:hidden`
       * so the outer glow is clipped at the cell edge — same as the focused
       * pane's aura, so it's consistent.
       * TODO(per-pane): run-data-viz — a per-pane <RunDataVizLayer> needs this
       * pane's queue/raw-event counts, which aren't plumbed per-pane yet. */}
      {props.showAura && props.auraProvider && props.auraStatus && props.auraIntensity && (
        <AgentAuraLayer
          provider={props.auraProvider}
          status={props.auraStatus}
          intensity={props.auraIntensity}
          hasHandoff={false}
        />
      )}
      <ChatViewPaneChrome {...props} />
      {props.isWelcomeChat &&
        props.showWelcomeUsageDashboard &&
        props.welcomeUsageDashboardData &&
        props.welcomeUsageTab &&
        props.onWelcomeUsageTabChange && (
          <div className="welcome-usage-region welcome-usage-region-small multiview-pane-welcome-usage">
            <WelcomeUsageDashboard
              data={props.welcomeUsageDashboardData}
              tab={props.welcomeUsageTab}
              onTabChange={props.onWelcomeUsageTabChange}
              displayCurrency={props.currency}
              overestimatePercent={props.currencyOverestimatePercent}
              dashboardStatVisibility={props.dashboardStatVisibility}
              workspacesTabEnabled={props.dashboardWorkspacesTabEnabled}
              workspacesShown={props.dashboardWorkspacesShown}
              providersTabEnabled={props.dashboardProvidersTabEnabled}
              autoCycleSeconds={props.dashboardAutoCycleSeconds}
            />
          </div>
        )}
      {props.isWelcomeChat && props.reserveWelcomeUsageDashboard && (
        <div
          className="welcome-usage-region welcome-usage-region-small welcome-usage-region-reserved multiview-pane-welcome-usage"
          aria-hidden
        />
      )}
      <div className="multiview-pane-content">
        {props.isWelcomeChat ? (
          <div className="multiview-pane-welcome-spacer" aria-hidden />
        ) : (
          <TranscriptPanel
            {...buildChatViewProps({
              ...props,
              onDeleteMessage: (messageId) =>
                chatId && props.onDeleteMessage?.(props.paneIndex, chatId, messageId),
              onTogglePinMessage: props.onTogglePinMessage
                ? (messageId) =>
                    chatId && props.onTogglePinMessage?.(props.paneIndex, chatId, messageId)
                : undefined
            })}
          />
        )}
      </div>
      {props.composerProps && <Composer {...props.composerProps} />}
    </div>
  )
}

export const ChatViewPane = memo(ChatViewPaneInner, chatViewPanePropsEqual)
