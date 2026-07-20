import { memo, useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import type { ComposerStyle } from '../../../main/store/types'
import { TranscriptPanel, transcriptRunningChatIdsSignature } from './TranscriptPanel'
import { SubThreadStatusTicker } from './SubThreadStatusTicker'
import { Composer, type ComposerProps } from './Composer'
import { buildChatViewProps, type BuildChatViewPropsInput } from '../lib/buildChatViewProps'
import type { MessageFeedbackDetails } from '../lib/messageFeedback'
import { FileMenuSelectionIcon } from './AppChromeSymbols'
import { MainPaneActionPill } from './MainPaneActionPill'
import { ProviderBadgeIcon } from './Sidebar'
import { WelcomeUsageDashboard } from './WelcomeUsageDashboard'
import type { WelcomeUsageDashboardData } from '../lib/welcomeUsageDashboard'
import { bindComposerReservation } from '../lib/composerReservation'
import { useTranscriptScrollState } from '../app/state/useTranscriptScrollState'
import {
  AgentAuraLayer,
  LivingWorkspaceLayer,
  SkyWeatherVisual,
  type AgentAuraProviderKey,
  type AgentAuraStatus,
  type AdvancedFxIntensity,
  type HostWeatherVisualState
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
  'onDeleteMessage' | 'onTogglePinMessage' | 'onMessageFeedback' | 'onAddMessageToPrompt'
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
  // ── Per-pane sky + living-workspace FX ────────────────────────────────────
  // Each pane paints its OWN sky/living-workspace INLINE (behind its content,
  // on top of its own slab) so the FX show at ANY opacity (incl. fully-opaque
  // panes). App resolves these from the pane's effective sky toggle
  // (`paneFx[i]?.sky ?? globalSky`) — `showLivingWorkspace` additionally follows
  // the global living-workspace flag. `weather` is App's shared host weather and
  // `intensity` reuses the aura intensity. Optional so test fixtures stay light.
  showSky?: boolean
  showLivingWorkspace?: boolean
  weather?: HostWeatherVisualState | null
  intensity?: AdvancedFxIntensity
  welcomeWorkspaceName?: string | null
  welcomeIsGlobalChat?: boolean
  // ── Welcome usage dashboard (rendered by the pane shell, above the
  //    transcript/composer). The composer + its model/permission/workspace/
  //    attachment/goal/telemetry controls now live in the shared <Composer>
  //    (driven by `composerProps`), so those props were removed from this
  //    interface in the multiview composer-parity slice.
  welcomeUsageDashboardData?: WelcomeUsageDashboardData
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
  onAddMessageToPrompt?: (
    paneIndex: number,
    chatId: string,
    messageId: string,
    content: string
  ) => void
  onTogglePinMessage?: (paneIndex: number, chatId: string, messageId: string) => void
  onMessageFeedback?: (
    paneIndex: number,
    chatId: string,
    messageId: string,
    vote: 'up' | 'down',
    details?: MessageFeedbackDetails
  ) => void
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
  menu?: ReactNode
  menuOpen?: boolean
  onClick?: (paneIndex: number, chatId: string) => void
}

/**
 * App rebuilds the pane action registry while rendering the Multiview grid.
 * Compare the visible/actionable model instead of array, icon, and callback
 * identities so unrelated streaming frames can still hit ChatViewPane's memo
 * boundary. An open menu keeps node-identity comparison for correctness because
 * its target rows may change while visible.
 */
export function chatViewPaneChromeActionsEqual(
  a: ChatViewPaneChromeAction[] | undefined,
  b: ChatViewPaneChromeAction[] | undefined
): boolean {
  if (a === b) return true
  if (!a || !b || a.length !== b.length) return false
  return a.every((left, index) => chatViewPaneChromeActionEqual(left, b[index]))
}

export function chatViewPaneChromeActionEqual(
  left: ChatViewPaneChromeAction | undefined,
  right: ChatViewPaneChromeAction | undefined
): boolean {
  if (left === right) return true
  if (!left || !right) return false
  const menuContentEqual =
    !left.menuOpen && !right.menuOpen
      ? Boolean(left.menu) === Boolean(right.menu)
      : left.menu === right.menu
  return (
    left.id === right.id &&
    left.title === right.title &&
    left.ariaLabel === right.ariaLabel &&
    left.active === right.active &&
    left.disabled === right.disabled &&
    left.count === right.count &&
    left.menuOpen === right.menuOpen &&
    menuContentEqual
  )
}

const WORKSPACE_POPOUT_ACTION_IDS = [
  'popout-workbench',
  'popout-diff-studio',
  'popout-file-editor'
] as const

export function chatViewPaneCanOpenWorkspacePopout(
  actions: ChatViewPaneChromeAction[] | undefined
): boolean {
  return WORKSPACE_POPOUT_ACTION_IDS.every((id) => {
    const action = actions?.find((candidate) => candidate.id === id)
    return Boolean(action?.onClick && !action.disabled)
  })
}

/**
 * Skip re-render unless something this pane actually displays changed. We
 * deliberately ignore the high-churn shared props (chats, runningChatIds)
 * and the stable App callbacks — see the component
 * doc for the tradeoff. EVERY render-affecting per-pane prop must be listed.
 */
export function chatViewPanePropsEqual(a: ChatViewPaneProps, b: ChatViewPaneProps): boolean {
  return (
    a.chat === b.chat &&
    a.messages === b.messages &&
    a.isThinking === b.isThinking &&
    a.runCompleteNotice === b.runCompleteNotice &&
    a.contextCompactionProgress === b.contextCompactionProgress &&
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
    // Sub-thread status ticker depends on which child chats are running.
    // Compare by content signature so identity churn from other panes still
    // skips, while an active-child start/stop reconciles this pane.
    transcriptRunningChatIdsSignature(a.runningChatIds) ===
      transcriptRunningChatIdsSignature(b.runningChatIds) &&
    // Per-pane agent-aura — MUST be compared or the pane won't re-tint when its
    // own run/approval/queue state (auraStatus) or provider/intensity changes.
    a.showAura === b.showAura &&
    a.auraProvider === b.auraProvider &&
    a.auraStatus === b.auraStatus &&
    a.auraIntensity === b.auraIntensity &&
    // Per-pane sky + living-workspace — MUST be compared or a pane won't toggle
    // its own sky/ghost FX or re-paint when the weather/intensity changes.
    a.showSky === b.showSky &&
    a.showLivingWorkspace === b.showLivingWorkspace &&
    a.weather === b.weather &&
    a.intensity === b.intensity &&
    a.welcomeWorkspaceName === b.welcomeWorkspaceName &&
    a.welcomeIsGlobalChat === b.welcomeIsGlobalChat &&
    // Welcome usage dashboard (pane-shell-owned).
    a.welcomeUsageDashboardData === b.welcomeUsageDashboardData &&
    a.showWelcomeUsageDashboard === b.showWelcomeUsageDashboard &&
    a.reserveWelcomeUsageDashboard === b.reserveWelcomeUsageDashboard &&
    a.dashboardStatVisibility === b.dashboardStatVisibility &&
    a.dashboardWorkspacesTabEnabled === b.dashboardWorkspacesTabEnabled &&
    a.dashboardWorkspacesShown === b.dashboardWorkspacesShown &&
    a.dashboardProvidersTabEnabled === b.dashboardProvidersTabEnabled &&
    a.dashboardAutoCycleSeconds === b.dashboardAutoCycleSeconds &&
    // Chrome.
    a.topLeftChrome === b.topLeftChrome &&
    a.topRightChrome === b.topRightChrome &&
    chatViewPaneChromeActionEqual(a.topLeftChromeAction, b.topLeftChromeAction) &&
    chatViewPaneChromeActionsEqual(a.topRightChromeActions, b.topRightChromeActions) &&
    // Transcript handlers (the composer's own handlers moved into <Composer>).
    a.onAgentQuestionSubmit === b.onAgentQuestionSubmit &&
    a.onAgentQuestionDismiss === b.onAgentQuestionDismiss &&
    a.onEnsemblePollVote === b.onEnsemblePollVote &&
    a.onPlanChoiceSubmit === b.onPlanChoiceSubmit &&
    a.onOpenSubThreadInSidePanel === b.onOpenSubThreadInSidePanel &&
    a.onOpenSideChatFromMessage === b.onOpenSideChatFromMessage &&
    a.onMessageSelectionCandidate === b.onMessageSelectionCandidate &&
    a.onAddMessageToPrompt === b.onAddMessageToPrompt &&
    a.onDeleteMessage === b.onDeleteMessage &&
    a.onTogglePinMessage === b.onTogglePinMessage &&
    a.onMessageFeedback === b.onMessageFeedback &&
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
  const [panePopoutMenuOpen, setPanePopoutMenuOpen] = useState(false)
  const panePopoutMenuRef = useRef<HTMLDivElement>(null)
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
  const workspaceLabel = props.welcomeIsGlobalChat ? null : props.welcomeWorkspaceName
  const defaultLeftAction: ChatViewPaneChromeAction = {
    id: 'pane-chat',
    title: 'Focus pane',
    ariaLabel: 'Focus pane',
    icon: <FileMenuSelectionIcon />,
    onClick: props.onFocusPane
  }
  const leftAction = props.topLeftChromeAction || defaultLeftAction
  const actionById = new Map(
    (props.topRightChromeActions || []).map((action) => [action.id, action] as const)
  )
  const invokeAction = (action: ChatViewPaneChromeAction | undefined): void => {
    if (!action || action.disabled || !action.onClick || !chatId) return
    action.onClick(props.paneIndex, chatId)
  }
  const invokePopoutAction = (action: ChatViewPaneChromeAction | undefined): void => {
    setPanePopoutMenuOpen(false)
    invokeAction(action)
  }
  const skyAction = actionById.get('sky-weather')
  const ghostAction = actionById.get('ghost-companion')
  const changelogAction = actionById.get('changelog')
  const firstLaunchAction = actionById.get('help')
  const bugReportAction = actionById.get('bug-report')
  const popoutAction = actionById.get('popout-chat')
  const workbenchPopoutAction = actionById.get('popout-workbench')
  const diffStudioPopoutAction = actionById.get('popout-diff-studio')
  const fileEditorPopoutAction = actionById.get('popout-file-editor')
  const runAction = actionById.get('preview')
  const homeAction = actionById.get('home')
  const renderAction = (action: ChatViewPaneChromeAction) => {
    const button = (
      <button
        className={`chat-corner-btn${action.active ? ' active' : ''}`}
        type="button"
        title={action.title}
        aria-label={action.ariaLabel || action.title}
        aria-pressed={typeof action.active === 'boolean' ? action.active : undefined}
        aria-haspopup={action.menu ? 'menu' : undefined}
        aria-expanded={action.menu ? Boolean(action.menuOpen) : undefined}
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
    if (action.menu) {
      return (
        <div
          key={action.id}
          className="side-chat-menu-wrap pane-preview-menu-wrap"
          data-preview-menu-root="true"
        >
          {button}
          {action.menu}
        </div>
      )
    }
    return (
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
  }

  return (
    <>
      <div className="chat-corner-controls chat-corner-controls-left multiview-pane-corner-controls">
        {renderAction(leftAction)}
        <div className="chat-corner-thread-context">
          <ProviderBadgeIcon provider={props.isEnsemble ? 'ensemble' : props.provider} />
          <span className="chat-corner-thread-title" title={title}>
            {title}
          </span>
          {workspaceLabel && workspaceLabel !== title && (
            <span className="chat-corner-workspace-name" title={workspaceLabel}>
              {workspaceLabel}
            </span>
          )}
        </div>
      </div>
      {props.topRightChromeActions && props.topRightChromeActions.length > 0 && (
        <MainPaneActionPill
          idScope={`multiview-pane-${props.paneIndex}`}
          className="multiview-pane-corner-controls"
          fxEnabled={Boolean(
            (skyAction || ghostAction) && !(skyAction?.disabled && ghostAction?.disabled)
          )}
          skyEnabled={Boolean(skyAction?.active)}
          ghostEnabled={Boolean(ghostAction?.active)}
          weatherDescription={props.weather?.description}
          onToggleSky={() => invokeAction(skyAction)}
          onToggleGhost={() => invokeAction(ghostAction)}
          changelogOpen={Boolean(changelogAction?.active)}
          firstLaunchOpen={Boolean(firstLaunchAction?.active)}
          bugReportOpen={Boolean(bugReportAction?.active)}
          onToggleChangelog={() => invokeAction(changelogAction)}
          onToggleFirstLaunch={() => invokeAction(firstLaunchAction)}
          onToggleBugReport={() => invokeAction(bugReportAction)}
          popoutMenuOpen={panePopoutMenuOpen}
          setPopoutMenuOpen={setPanePopoutMenuOpen}
          popoutMenuRef={panePopoutMenuRef}
          canOpenWorkspacePopout={chatViewPaneCanOpenWorkspacePopout(
            props.topRightChromeActions
          )}
          hasCurrentChat={Boolean(chatId)}
          onOpenWorkbench={() => invokePopoutAction(workbenchPopoutAction)}
          onOpenDiffStudio={() => invokePopoutAction(diffStudioPopoutAction)}
          onOpenFileEditor={() => invokePopoutAction(fileEditorPopoutAction)}
          onOpenChatPopout={() => invokePopoutAction(popoutAction)}
          runTitle={runAction?.title || 'Preview unavailable'}
          runMenuOpen={Boolean(runAction?.menuOpen)}
          runHasMenu={Boolean(runAction?.menu)}
          runDisabled={!runAction || Boolean(runAction.disabled)}
          runMenu={runAction?.menu}
          onRun={() => invokeAction(runAction)}
          homeOpen={Boolean(homeAction?.active)}
          onToggleHome={() => invokeAction(homeAction)}
        />
      )}
    </>
  )
}

function ChatViewPaneInner(props: ChatViewPaneProps) {
  const rootRef = useRef<HTMLDivElement | null>(null)
  const paneComposerAreaRef = useRef<HTMLDivElement | null>(null)
  const chatId = props.chat?.appChatId ?? ''
  const hasComposerProps = Boolean(props.composerProps)
  const paneScrollState = useTranscriptScrollState({
    chatId: chatId || null,
    messages: props.messages,
    runCompleteNotice: props.runCompleteNotice,
    transcriptMounted: !props.isWelcomeChat,
    streamingActive: props.isThinking,
    transcriptScrollRef: props.refs.scrollRef,
    transcriptContentRef: props.refs.contentRef,
    autoFollowRef: props.refs.autoFollowRef,
    setAutoFollowRef: props.refs.setAutoFollow,
    chatScrollStateByIdRef: props.refs.chatScrollStateByIdRef
  })
  useLayoutEffect(
    () => props.refs.bindRelockToLatest(paneScrollState.relockToLatest),
    [paneScrollState.relockToLatest, props.refs]
  )
  useEffect(() => {
    const transcript = rootRef.current
    const composerArea = paneComposerAreaRef.current
    if (!transcript || !composerArea) return
    return bindComposerReservation({ transcript, composerArea })
  }, [chatId, hasComposerProps])
  // The composer is now the shared <Composer> (rendered below via
  // `props.composerProps`); all of this pane's composer state/handlers live in
  // that component. The retained body only drives the pane shell className,
  // transcript, shared welcome dashboard, and pane chrome.
  const className = [
    'app-transcript',
    'multiview-pane-transcript',
    `provider-${props.providerClass}`,
    props.isEnsemble ? 'chat-kind-ensemble' : '',
    props.welcomeIsGlobalChat ? 'chat-scope-global' : '',
    props.isWelcomeChat ? 'welcome-mode' : ''
  ]
    .filter(Boolean)
    .join(' ')

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
      {/* Per-pane ambient FX — INLINE behind this pane's content (the layers are
       * `position:absolute; inset:0; pointer-events:none`), painted on top of
       * the pane's own slab so they show at ANY opacity. Gated by this pane's
       * effective sky toggle (living-workspace additionally follows the global
       * living flag). Replaces the old shared backdrop. */}
      {props.showLivingWorkspace && (
        <LivingWorkspaceLayer
          weather={props.weather ?? null}
          intensity={props.intensity ?? 'cinematic'}
        />
      )}
      {props.showSky && <SkyWeatherVisual weather={props.weather ?? null} />}
      <ChatViewPaneChrome {...props} />
      {props.isWelcomeChat &&
        props.showWelcomeUsageDashboard &&
        props.welcomeUsageDashboardData && (
          <div className="welcome-usage-region welcome-usage-region-small multiview-pane-welcome-usage">
            <WelcomeUsageDashboard
              data={props.welcomeUsageDashboardData}
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
      {!props.isWelcomeChat && (
        <div className="multiview-pane-content">
          <SubThreadStatusTicker
            currentChat={props.chat}
            chats={props.chats}
            runningChatIds={props.runningChatIds}
            onOpenSubThread={props.onOpenSubThread}
          />
          <TranscriptPanel
            {...buildChatViewProps({
              ...props,
              autoFollowRef: paneScrollState.autoFollowRef,
              externalRestoreAnchorMessageId: paneScrollState.externalRestoreAnchorMessageId,
              onManualTranscriptJump: paneScrollState.beginManualTranscriptJump,
              onJumpToLatest: paneScrollState.handleJumpToLatest,
              onProgrammaticScrollWrite: paneScrollState.markProgrammaticScroll,
              onDeleteMessage: (messageId) =>
                chatId && props.onDeleteMessage?.(props.paneIndex, chatId, messageId),
              onAddMessageToPrompt: props.onAddMessageToPrompt
                ? (messageId, content) =>
                    chatId &&
                    props.onAddMessageToPrompt?.(props.paneIndex, chatId, messageId, content)
                : undefined,
              onTogglePinMessage: props.onTogglePinMessage
                ? (messageId) =>
                    chatId && props.onTogglePinMessage?.(props.paneIndex, chatId, messageId)
                : undefined,
              onMessageFeedback: props.onMessageFeedback
                ? (messageId, vote, details) =>
                    chatId &&
                    props.onMessageFeedback?.(props.paneIndex, chatId, messageId, vote, details)
                : undefined
            })}
          />
        </div>
      )}
      {props.composerProps && (
        <Composer
          {...props.composerProps}
          composerAreaRef={paneComposerAreaRef}
          showWelcomeNotifications={false}
        />
      )}
    </div>
  )
}

export const ChatViewPane = memo(ChatViewPaneInner, chatViewPanePropsEqual)
