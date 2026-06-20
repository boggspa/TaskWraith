import { memo, useRef, type FormEvent, type KeyboardEvent } from 'react'
import type { ReactNode } from 'react'
import type {
  AgenticServiceId,
  AgenticServicesSettings,
  AppSettings,
  ComposerStyle,
  ProviderId,
  WorkspaceRecord
} from '../../../main/store/types'
import { TranscriptPanel } from './TranscriptPanel'
import { buildChatViewProps, type BuildChatViewPropsInput } from '../lib/buildChatViewProps'
import { buildWelcomeCopy } from '../lib/welcomeCopy'
import { hasResolvedMention } from '../lib/mentionHighlight'
import type { WorkspacePolicyService } from '../lib/workspacePolicyServices'
import {
  ArrowUpSendIcon,
  ChatMediaIcon,
  ClaudeReturnSymbolIcon,
  ExclamationShieldIcon,
  FileMenuSelectionIcon,
  GhostCompanionIcon,
  GoalSymbolIcon,
  InfoCircleIcon,
  LinkCircleSymbolIcon,
  ModelSymbolIcon,
  PinnedMessagesIcon,
  PlusSymbolIcon,
  QuestionCircleIcon,
  QueueSymbolIcon,
  ReviewSymbolIcon,
  RunSymbolIcon,
  ScreenWatchSymbolIcon,
  SidebarCornerIcon,
  SkyWeatherIcon,
  StopSymbolIcon,
  XSymbolIcon
} from './AppChromeSymbols'
import {
  CombinedModelPicker,
  type CombinedModelPickerModelOption,
  type CombinedModelPickerReasoningOption
} from './CombinedModelPicker'
import { CombinedPermissionsPicker, type PermissionOption } from './CombinedPermissionsPicker'
import { ComposerHighlightOverlay } from './ComposerHighlightOverlay'
import { ComposerLinkPreviewStrip } from './ComposerLinkPreviewStrip'
import {
  ComposerTextareaContextMenu,
  useComposerTextareaContextMenu
} from './ComposerTextareaContextMenu'
import { ComposerCumulativeTimecode, ComposerRunTimecode } from './ComposerTimecodes'
import { ComposerProviderPicker } from './ComposerProviderPicker'
import { ComposerPlusPicker, type ComposerPlusPickerSection } from './ComposerPlusPicker'
import { ComposerWorkspaceSwitcher } from './ComposerWorkspaceSwitcher'
import { CopyTranscriptButton, type CopyTranscriptResult } from './CopyTranscriptButton'
import { FileTypeIcon } from './FileTypeIcon'
import {
  LiveThreadTokenTally,
  type LiveThreadTokenTallyProps
} from './LiveThreadTokenTally'
import { MultiviewLayoutPicker } from './MultiviewLayoutPicker'
import { WelcomeHeatmaps, type WelcomeHeatmapSlot } from './WelcomeHeatmaps'
import { WelcomeUsageDashboard } from './WelcomeUsageDashboard'
import type {
  WelcomeUsageDashboardData,
  WelcomeUsageTab
} from '../lib/welcomeUsageDashboard'
import {
  getImagePreviewSrc,
  isImageAttachmentPath,
  MAX_IMAGE_ATTACHMENTS,
  type ImageAttachment
} from '../lib/imageAttachments'
import { EMPTY_IMAGE_ATTACHMENTS } from '../lib/stableEmpties'
import type { MultiviewLayout } from '../../../shared/multiviewLayouts'

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
export interface ChatViewPaneProps
  extends Omit<BuildChatViewPropsInput, 'onDeleteMessage' | 'onTogglePinMessage'> {
  paneIndex: number
  /** appearance.composerStyle / interface style for the `interface-*` class. */
  interfaceStyle: ComposerStyle
  /** Provider (or Ollama brand) class for the `provider-*` tint. */
  providerClass: string
  isEnsemble?: boolean
  welcomeWorkspaceName?: string | null
  welcomeIsGlobalChat?: boolean
  prompt?: string
  canRun?: boolean
  onPromptChange?: (paneIndex: number, chatId: string, value: string) => void
  onRun?: (paneIndex: number, chatId: string) => void
  onCancel?: (paneIndex: number, chatId: string) => void
  onSelectProvider?: (paneIndex: number, chatId: string, provider: ProviderId) => void
  providerPickerDisabled?: boolean
  providerRunPauses?: AppSettings['providerRunPauses']
  grokAvailable?: boolean
  cursorAvailable?: boolean
  modelOptions?: CombinedModelPickerModelOption[]
  selectedModelId?: string
  onSelectModel?: (paneIndex: number, chatId: string, modelId: string) => void
  reasoningOptions?: CombinedModelPickerReasoningOption[]
  selectedReasoning?: string
  onSelectReasoning?: (paneIndex: number, chatId: string, value: string) => void
  codexReasoningEffort?: string
  claudeReasoningEffort?: string
  kimiThinkingEnabled?: boolean
  fastModeCapableModelIds?: Set<string>
  fastModeEnabled?: boolean
  onToggleFastMode?: (paneIndex: number, chatId: string) => void
  customModelValue?: string
  onCustomModelChange?: (paneIndex: number, chatId: string, value: string) => void
  onClearCustomModel?: (paneIndex: number, chatId: string) => void
  permissionOptions?: PermissionOption[]
  selectedPermission?: string
  onSelectPermission?: (paneIndex: number, chatId: string, value: string) => void
  grantServices?: WorkspacePolicyService[]
  enabledGrantIds?: Set<AgenticServiceId>
  agenticServices?: AgenticServicesSettings
  onToggleGrant?: (
    paneIndex: number,
    chatId: string,
    service: AgenticServiceId,
    enabled: boolean
  ) => void
  composerDisabled?: boolean
  modelControlsDisabled?: boolean
  permissionControlsDisabled?: boolean
  statusLabel?: string
  runStartedAt?: string | null
  cumulativeRunBaseMs?: number
  imageAttachments?: ImageAttachment[]
  onPickAttachments?: (paneIndex: number, chatId: string) => void
  onRemoveAttachment?: (paneIndex: number, chatId: string, attachmentId: string) => void
  workspaces?: WorkspaceRecord[]
  workspace?: WorkspaceRecord | null
  onPickWorkspace?: (paneIndex: number, chatId: string, workspace: WorkspaceRecord) => void
  onAddWorkspace?: (paneIndex: number, chatId: string) => void
  onSelectNoWorkspace?: (paneIndex: number, chatId: string) => void
  screenWatchActive?: boolean
  screenWatchStreaming?: boolean
  screenWatchTitle?: string
  screenWatchDisabled?: boolean
  onToggleScreenWatch?: (paneIndex: number, chatId: string) => void
  goalStatus?: 'empty' | 'active' | 'paused' | 'blocked' | 'completed'
  goalTitle?: string
  onOpenGoal?: (paneIndex: number, chatId: string) => void
  onCopyTranscript?: (paneIndex: number, chatId: string) => Promise<CopyTranscriptResult>
  multiviewLayout?: MultiviewLayout
  onSelectMultiviewLayout?: (layout: MultiviewLayout) => void
  tokenTally?: LiveThreadTokenTallyProps['baseTally']
  tokenTallyModel?: string
  tokenTallyLiveOutputTokens?: number
  tokenTallyTitle?: string
  tokenTallyDualCostAndRam?: boolean
  welcomeUsageDashboardData?: WelcomeUsageDashboardData
  welcomeUsageTab?: WelcomeUsageTab
  onWelcomeUsageTabChange?: (tab: WelcomeUsageTab) => void
  showWelcomeUsageDashboard?: boolean
  reserveWelcomeUsageDashboard?: boolean
  welcomeHeatmapSlots?: WelcomeHeatmapSlot[]
  showWelcomeHeatmaps?: boolean
  dashboardStatVisibility?: Record<string, boolean>
  dashboardWorkspacesTabEnabled?: boolean
  dashboardWorkspacesShown?: number
  dashboardProvidersTabEnabled?: boolean
  dashboardAutoCycleSeconds?: number
  onWelcomeSuggestion?: (prompt: string) => void
  topLeftChrome?: ReactNode
  topRightChrome?: ReactNode
  onDeleteMessage?: (paneIndex: number, chatId: string, messageId: string) => void
  onTogglePinMessage?: (paneIndex: number, chatId: string, messageId: string) => void
  /** Optional visual-focus callback for pane selection affordances. */
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
    a.welcomeWorkspaceName === b.welcomeWorkspaceName &&
    a.welcomeIsGlobalChat === b.welcomeIsGlobalChat &&
    a.prompt === b.prompt &&
    a.canRun === b.canRun &&
    a.providerPickerDisabled === b.providerPickerDisabled &&
    a.providerRunPauses === b.providerRunPauses &&
    a.grokAvailable === b.grokAvailable &&
    a.cursorAvailable === b.cursorAvailable &&
    a.modelOptions === b.modelOptions &&
    a.selectedModelId === b.selectedModelId &&
    a.reasoningOptions === b.reasoningOptions &&
    a.selectedReasoning === b.selectedReasoning &&
    a.codexReasoningEffort === b.codexReasoningEffort &&
    a.claudeReasoningEffort === b.claudeReasoningEffort &&
    a.kimiThinkingEnabled === b.kimiThinkingEnabled &&
    a.fastModeCapableModelIds === b.fastModeCapableModelIds &&
    a.fastModeEnabled === b.fastModeEnabled &&
    a.customModelValue === b.customModelValue &&
    a.permissionOptions === b.permissionOptions &&
    a.selectedPermission === b.selectedPermission &&
    a.grantServices === b.grantServices &&
    a.enabledGrantIds === b.enabledGrantIds &&
    a.agenticServices === b.agenticServices &&
    a.composerDisabled === b.composerDisabled &&
    a.modelControlsDisabled === b.modelControlsDisabled &&
    a.permissionControlsDisabled === b.permissionControlsDisabled &&
    a.statusLabel === b.statusLabel &&
    a.runStartedAt === b.runStartedAt &&
    a.cumulativeRunBaseMs === b.cumulativeRunBaseMs &&
    a.imageAttachments === b.imageAttachments &&
    a.workspaces === b.workspaces &&
    a.workspace === b.workspace &&
    a.screenWatchActive === b.screenWatchActive &&
    a.screenWatchStreaming === b.screenWatchStreaming &&
    a.screenWatchTitle === b.screenWatchTitle &&
    a.screenWatchDisabled === b.screenWatchDisabled &&
    a.goalStatus === b.goalStatus &&
    a.goalTitle === b.goalTitle &&
    a.multiviewLayout === b.multiviewLayout &&
    a.tokenTally === b.tokenTally &&
    a.tokenTallyModel === b.tokenTallyModel &&
    a.tokenTallyLiveOutputTokens === b.tokenTallyLiveOutputTokens &&
    a.tokenTallyTitle === b.tokenTallyTitle &&
    a.tokenTallyDualCostAndRam === b.tokenTallyDualCostAndRam &&
    a.welcomeUsageDashboardData === b.welcomeUsageDashboardData &&
    a.welcomeUsageTab === b.welcomeUsageTab &&
    a.showWelcomeUsageDashboard === b.showWelcomeUsageDashboard &&
    a.reserveWelcomeUsageDashboard === b.reserveWelcomeUsageDashboard &&
    a.welcomeHeatmapSlots === b.welcomeHeatmapSlots &&
    a.showWelcomeHeatmaps === b.showWelcomeHeatmaps &&
    a.dashboardStatVisibility === b.dashboardStatVisibility &&
    a.dashboardWorkspacesTabEnabled === b.dashboardWorkspacesTabEnabled &&
    a.dashboardWorkspacesShown === b.dashboardWorkspacesShown &&
    a.dashboardProvidersTabEnabled === b.dashboardProvidersTabEnabled &&
    a.dashboardAutoCycleSeconds === b.dashboardAutoCycleSeconds &&
    a.topLeftChrome === b.topLeftChrome &&
    a.topRightChrome === b.topRightChrome &&
    a.onPromptChange === b.onPromptChange &&
    a.onRun === b.onRun &&
    a.onCancel === b.onCancel &&
    a.onAgentQuestionSubmit === b.onAgentQuestionSubmit &&
    a.onAgentQuestionDismiss === b.onAgentQuestionDismiss &&
    a.onRunFallback === b.onRunFallback &&
    a.onPlanChoiceSubmit === b.onPlanChoiceSubmit &&
    a.onOpenSubThreadInSidePanel === b.onOpenSubThreadInSidePanel &&
    a.onOpenSideChatFromMessage === b.onOpenSideChatFromMessage &&
    a.onMessageSelectionCandidate === b.onMessageSelectionCandidate &&
    a.onSelectProvider === b.onSelectProvider &&
    a.onSelectModel === b.onSelectModel &&
    a.onSelectReasoning === b.onSelectReasoning &&
    a.onToggleFastMode === b.onToggleFastMode &&
    a.onCustomModelChange === b.onCustomModelChange &&
    a.onClearCustomModel === b.onClearCustomModel &&
    a.onSelectPermission === b.onSelectPermission &&
    a.onToggleGrant === b.onToggleGrant &&
    a.onPickAttachments === b.onPickAttachments &&
    a.onRemoveAttachment === b.onRemoveAttachment &&
    a.onPickWorkspace === b.onPickWorkspace &&
    a.onAddWorkspace === b.onAddWorkspace &&
    a.onSelectNoWorkspace === b.onSelectNoWorkspace &&
    a.onToggleScreenWatch === b.onToggleScreenWatch &&
    a.onOpenGoal === b.onOpenGoal &&
    a.onCopyTranscript === b.onCopyTranscript &&
    a.onSelectMultiviewLayout === b.onSelectMultiviewLayout &&
    a.onWelcomeUsageTabChange === b.onWelcomeUsageTabChange &&
    a.onWelcomeSuggestion === b.onWelcomeSuggestion &&
    a.onDeleteMessage === b.onDeleteMessage &&
    a.onTogglePinMessage === b.onTogglePinMessage &&
    a.refs === b.refs &&
    a.paneIndex === b.paneIndex &&
    a.onFocusPane === b.onFocusPane &&
    a.ariaLabel === b.ariaLabel
  )
}

const EMPTY_MODEL_OPTIONS: CombinedModelPickerModelOption[] = []
const EMPTY_REASONING_OPTIONS: CombinedModelPickerReasoningOption[] = []
const EMPTY_PERMISSION_OPTIONS: PermissionOption[] = []
const EMPTY_GRANT_SERVICES: WorkspacePolicyService[] = []
const EMPTY_ENABLED_GRANTS = new Set<AgenticServiceId>()

const paneComposerPlaceholder = (props: ChatViewPaneProps): string => {
  if (props.isEnsemble) return 'Ask the ensemble. @ to direct a participant.'
  if (props.provider === 'codex') return 'Ask Codex anything. @ to mention files'
  if (props.provider === 'claude') return 'Describe a task or ask a question'
  if (props.provider === 'gemini') return 'Ask Gemini'
  if (props.provider === 'kimi') return 'Type "/" to quickly access skills'
  return `Enter prompt for ${props.providerLabel}...`
}

const renderPaneSendIcon = (props: ChatViewPaneProps): React.JSX.Element => {
  if (props.isThinking) return <QueueSymbolIcon />
  if (props.interfaceStyle === 'claude') return <ClaudeReturnSymbolIcon />
  if (
    props.interfaceStyle === 'codex' ||
    props.interfaceStyle === 'gemini' ||
    props.interfaceStyle === 'cursor' ||
    props.interfaceStyle === 'grok' ||
    props.interfaceStyle === 'kimi'
  ) {
    return <ArrowUpSendIcon />
  }
  return <RunSymbolIcon />
}

const fallbackWorkspaceName = (workspacePath?: string | null): string => {
  if (!workspacePath) return 'TaskWraith'
  return workspacePath.split(/[\\/]/).filter(Boolean).pop() || 'TaskWraith'
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
  const title = props.chat?.title || props.welcomeWorkspaceName || 'New Chat'
  return (
    <>
      <div className="chat-corner-controls chat-corner-controls-left multiview-pane-corner-controls">
        <button
          className="chat-corner-btn"
          type="button"
          title="Pane chat"
          aria-label="Pane chat"
          onClick={() => props.chat?.appChatId && props.onFocusPane?.(props.paneIndex, props.chat.appChatId)}
        >
          <FileMenuSelectionIcon />
        </button>
        <span className="chat-corner-thread-title" title={title}>
          {title}
        </span>
      </div>
      <div className="chat-corner-controls chat-corner-controls-right multiview-pane-corner-controls">
        <button className="chat-corner-btn" type="button" title="Sky weather effects" aria-label="Sky weather effects">
          <SkyWeatherIcon />
        </button>
        <button className="chat-corner-btn" type="button" title="Ghost companion" aria-label="Ghost companion">
          <GhostCompanionIcon />
        </button>
        <button className="chat-corner-btn" type="button" title="Thread info" aria-label="Thread info">
          <InfoCircleIcon />
        </button>
        <button className="chat-corner-btn" type="button" title="Help" aria-label="Help">
          <QuestionCircleIcon />
        </button>
        <button className="chat-corner-btn" type="button" title="Report issue" aria-label="Report issue">
          <ExclamationShieldIcon />
        </button>
        <button className="chat-corner-btn" type="button" title="Permissions" aria-label="Permissions">
          <ReviewSymbolIcon />
        </button>
        <button className="chat-corner-btn" type="button" title="Models" aria-label="Models">
          <ModelSymbolIcon />
        </button>
        <button className="chat-corner-btn" type="button" title="Run rail" aria-label="Run rail">
          <RunSymbolIcon />
        </button>
        <button className="chat-corner-btn" type="button" title="Screen watch" aria-label="Screen watch">
          <ScreenWatchSymbolIcon />
        </button>
        <button className="chat-corner-btn" type="button" title="Media" aria-label="Media">
          <ChatMediaIcon />
        </button>
        <button className="chat-corner-btn" type="button" title="Pinned messages" aria-label="Pinned messages">
          <PinnedMessagesIcon />
        </button>
        <button className="chat-corner-btn" type="button" title="Inspector" aria-label="Inspector">
          <SidebarCornerIcon direction="right" isOpen={false} />
        </button>
      </div>
    </>
  )
}

function ChatViewWelcomeHero(props: ChatViewPaneProps) {
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
  )
}

function ChatViewWelcomeSuggestions(props: ChatViewPaneProps) {
  if (props.isEnsemble) return null
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
  return (
    <div className="welcome-suggestions multiview-pane-welcome-suggestions">
      {copy.starters.map((starter) => (
        <button
          key={starter.id}
          className="welcome-suggestion-btn"
          type="button"
          data-intent={starter.intent}
          aria-label={`${starter.label}: ${starter.description}`}
          onClick={() => props.onWelcomeSuggestion?.(starter.prompt)}
        >
          <span className="welcome-suggestion-label">{starter.label}</span>
          <span className="welcome-suggestion-description">{starter.description}</span>
        </button>
      ))}
    </div>
  )
}

function ChatViewPaneInner(props: ChatViewPaneProps) {
  const textareaRef = useRef<HTMLTextAreaElement | null>(null)
  const composerContextMenu = useComposerTextareaContextMenu()
  const chatId = props.chat?.appChatId ?? ''
  const hasLocalComposer = Boolean(chatId && props.onRun && props.onPromptChange)
  const prompt = props.prompt ?? ''
  const composerDisabled = Boolean(props.composerDisabled || !props.canRun)
  const canSubmit = Boolean(chatId && !composerDisabled && prompt.trim())
  const modelOptions = props.modelOptions || EMPTY_MODEL_OPTIONS
  const reasoningOptions = props.reasoningOptions || EMPTY_REASONING_OPTIONS
  const permissionOptions = props.permissionOptions || EMPTY_PERMISSION_OPTIONS
  const grantServices = props.grantServices || EMPTY_GRANT_SERVICES
  const enabledGrantIds = props.enabledGrantIds || EMPTY_ENABLED_GRANTS
  const imageAttachments = props.imageAttachments || EMPTY_IMAGE_ATTACHMENTS
  const composerImageAttachments = imageAttachments.filter((attachment) =>
    isImageAttachmentPath(attachment.path)
  )
  const composerFileAttachments = imageAttachments.filter(
    (attachment) => !isImageAttachmentPath(attachment.path)
  )
  const showModelPicker = Boolean(
    modelOptions.length > 0 && props.selectedModelId && props.onSelectModel
  )
  const showCustomModel =
    props.selectedModelId === 'custom' && props.provider !== 'kimi' && props.onCustomModelChange
  const showPermissionsPicker = Boolean(
    permissionOptions.length > 0 &&
      props.selectedPermission &&
      props.onSelectPermission &&
      props.agenticServices
  )
  const hasMentionOverlay = Boolean(
    props.chat && hasResolvedMention(prompt, props.chat.ensemble?.participants || [])
  )
  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (!canSubmit) return
    props.onRun?.(props.paneIndex, chatId)
  }
  const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key !== 'Enter' || event.shiftKey || event.nativeEvent.isComposing) return
    event.preventDefault()
    if (!canSubmit) return
    props.onRun?.(props.paneIndex, chatId)
  }
  const composerPlusSections: ComposerPlusPickerSection[] = [
    {
      id: 'add',
      title: 'Add',
      items: [
        {
          id: 'attachment',
          label: 'Attachment',
          description: 'Add files or images',
          icon: <PlusSymbolIcon />,
          disabled: composerDisabled || !props.onPickAttachments,
          onSelect: () => chatId && props.onPickAttachments?.(props.paneIndex, chatId)
        }
      ]
    }
  ]
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
  const hasTokenTally = Boolean(
    props.tokenTally &&
      (props.tokenTally.totalTokens > 0 || Math.max(0, props.tokenTallyLiveOutputTokens || 0) > 0)
  )
  const goalStatus = props.goalStatus || 'empty'

  return (
    <div
      className={className}
      data-multiview-pane-chat-id={props.chat?.appChatId ?? undefined}
      role="group"
      aria-label={props.ariaLabel}
      onMouseDownCapture={() => {
        const focusChatId = props.chat?.appChatId
        if (focusChatId) props.onFocusPane?.(props.paneIndex, focusChatId)
      }}
    >
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
      {hasLocalComposer && (
        <div className={`composer-area multiview-pane-composer-area interface-${props.interfaceStyle}`}>
          {props.isWelcomeChat && <ChatViewWelcomeHero {...props} />}
          <form
            className={`multiview-pane-composer composer-surface multiview-pane-full-composer interface-${props.interfaceStyle}`}
            onSubmit={handleSubmit}
          >
            {props.isThinking && (
              <div className="composer-chips">
                <span className="composer-chip">{props.statusLabel || 'Running'}</span>
              </div>
            )}
            {imageAttachments.length > 0 && (
              <div
                className="composer-image-strip composer-attachment-tray"
                aria-label="Composer attachments and context"
              >
                {composerImageAttachments.map((image) => (
                  <div
                    key={image.id}
                    className="composer-image-item composer-image-tile is-image"
                    title={image.path}
                    aria-label={`Image attachment ${image.name}`}
                  >
                    <img
                      src={getImagePreviewSrc(image.path)}
                      alt={image.name}
                      className="composer-image-thumb"
                      draggable={false}
                    />
                    <button
                      className="composer-image-remove"
                      type="button"
                      onClick={() =>
                        chatId && props.onRemoveAttachment?.(props.paneIndex, chatId, image.id)
                      }
                      disabled={composerDisabled}
                      title="Remove attachment"
                      aria-label={`Remove ${image.name}`}
                    >
                      <XSymbolIcon />
                    </button>
                  </div>
                ))}
                {composerFileAttachments.map((file) => (
                  <div
                    key={file.id}
                    className="composer-image-item composer-file-card"
                    title={file.path}
                  >
                    <span className="composer-attachment-icon" title={file.name}>
                      <FileTypeIcon
                        path={file.path}
                        size={18}
                        className="composer-attachment-icon-inner"
                        workspacePath={props.currentWorkspacePath}
                      />
                    </span>
                    <span className="composer-image-name" title={file.path}>
                      {file.name}
                    </span>
                    <button
                      className="composer-image-remove"
                      type="button"
                      onClick={() =>
                        chatId && props.onRemoveAttachment?.(props.paneIndex, chatId, file.id)
                      }
                      disabled={composerDisabled}
                      title="Remove attachment"
                      aria-label={`Remove ${file.name}`}
                    >
                      <XSymbolIcon />
                    </button>
                  </div>
                ))}
                <span className="composer-image-count">{`${imageAttachments.length}/${MAX_IMAGE_ATTACHMENTS}`}</span>
              </div>
            )}
            <div className="composer-inner-module multiview-pane-inner-module">
              <div className="composer-textarea-wrap multiview-pane-textarea-wrap">
                {hasMentionOverlay && (
                  <ComposerHighlightOverlay
                    value={prompt}
                    participants={props.chat?.ensemble?.participants}
                    textareaRef={textareaRef}
                    syncEpoch={`${props.interfaceStyle}|multiview|${chatId}`}
                  />
                )}
                <textarea
                  ref={textareaRef}
                  className={`composer-textarea multiview-pane-textarea${
                    hasMentionOverlay ? ' has-mention-overlay' : ''
                  }`}
                  value={prompt}
                  onContextMenu={composerContextMenu.handleContextMenu}
                  onChange={(event) =>
                    chatId && props.onPromptChange?.(props.paneIndex, chatId, event.target.value)
                  }
                  onKeyDown={handleKeyDown}
                  placeholder={paneComposerPlaceholder(props)}
                  aria-label={`Prompt for ${props.isEnsemble ? 'Ensemble' : props.providerLabel}`}
                  rows={2}
                  disabled={composerDisabled}
                />
              </div>
              <ComposerTextareaContextMenu
                anchor={composerContextMenu.anchor}
                spellcheckContext={composerContextMenu.spellcheckContext}
                textareaRef={textareaRef}
                onValueChange={(value) =>
                  chatId && props.onPromptChange?.(props.paneIndex, chatId, value)
                }
                onClose={() => composerContextMenu.setAnchor(null)}
              />
              <ComposerLinkPreviewStrip text={prompt} />
              <div className="composer-bottom-controls multiview-pane-bottom-controls">
                <div className="composer-control-footer multiview-pane-control-footer">
                  <div className="composer-inline-pickers multiview-pane-inline-pickers">
                    <div className="composer-inline-pickers-left">
                      <ComposerPlusPicker
                        provider={props.provider}
                        composerStyle={props.interfaceStyle}
                        sections={composerPlusSections}
                        disabled={composerDisabled || !props.onPickAttachments}
                        triggerIcon={<PlusSymbolIcon />}
                      />
                      <ComposerProviderPicker
                        provider={props.provider}
                        composerStyle={props.interfaceStyle}
                        grokAvailable={props.grokAvailable ?? false}
                        cursorAvailable={props.cursorAvailable ?? false}
                        providerRunPauses={props.providerRunPauses}
                        onSelect={(provider) =>
                          chatId && props.onSelectProvider?.(props.paneIndex, chatId, provider)
                        }
                        disabled={props.providerPickerDisabled || !props.onSelectProvider}
                        triggerIcon={<LinkCircleSymbolIcon />}
                        title={
                          props.providerPickerDisabled
                            ? 'Pane provider is locked for this chat'
                            : 'Pane provider'
                        }
                      />
                      {showModelPicker && (
                        <CombinedModelPicker
                          provider={props.provider}
                          composerStyle={props.interfaceStyle}
                          modelOptions={modelOptions}
                          selectedModelId={props.selectedModelId || modelOptions[0]?.id || ''}
                          onSelectModel={(modelId) =>
                            chatId && props.onSelectModel?.(props.paneIndex, chatId, modelId)
                          }
                          reasoningOptions={reasoningOptions}
                          selectedReasoning={props.selectedReasoning || ''}
                          onSelectReasoning={(value) =>
                            chatId && props.onSelectReasoning?.(props.paneIndex, chatId, value)
                          }
                          codexReasoningEffort={props.codexReasoningEffort}
                          claudeReasoningEffort={props.claudeReasoningEffort}
                          kimiThinkingEnabled={props.kimiThinkingEnabled}
                          fastModeCapableModelIds={props.fastModeCapableModelIds}
                          fastModeEnabled={props.fastModeEnabled}
                          onToggleFastMode={
                            props.onToggleFastMode
                              ? () => chatId && props.onToggleFastMode?.(props.paneIndex, chatId)
                              : undefined
                          }
                          disabled={props.modelControlsDisabled}
                        />
                      )}
                      {showCustomModel && (
                        <span className="composer-inline-custom-model multiview-pane-custom-model">
                          <input
                            className="composer-inline-input"
                            type="text"
                            value={props.customModelValue || ''}
                            onChange={(event) =>
                              chatId &&
                              props.onCustomModelChange?.(
                                props.paneIndex,
                                chatId,
                                event.target.value
                              )
                            }
                            placeholder="Model ID"
                            disabled={props.modelControlsDisabled}
                          />
                          <button
                            className="composer-inline-clear"
                            type="button"
                            onClick={() =>
                              chatId && props.onClearCustomModel?.(props.paneIndex, chatId)
                            }
                            disabled={props.modelControlsDisabled}
                            title="Cancel custom model"
                            aria-label="Cancel custom model"
                          >
                            ×
                          </button>
                        </span>
                      )}
                      {showPermissionsPicker && props.agenticServices && (
                        <CombinedPermissionsPicker
                          provider={props.provider}
                          composerStyle={props.interfaceStyle}
                          permissionOptions={permissionOptions}
                          selectedPermission={props.selectedPermission || 'default'}
                          onSelectPermission={(value) =>
                            chatId && props.onSelectPermission?.(props.paneIndex, chatId, value)
                          }
                          grantServices={grantServices}
                          enabledGrantIds={enabledGrantIds}
                          agenticServices={props.agenticServices}
                          onToggleGrant={(service, enabled) =>
                            chatId &&
                            props.onToggleGrant?.(props.paneIndex, chatId, service, enabled)
                          }
                          disabled={props.permissionControlsDisabled}
                        />
                    )}
                  </div>
                  <div className="composer-inline-actions multiview-pane-inline-actions">
                      {props.isThinking && (
                        <span className="composer-chip multiview-pane-status" aria-live="polite">
                          {props.statusLabel || 'Running'}
                        </span>
                      )}
                      <span className="composer-send-cluster multiview-pane-send-cluster">
                        {props.isThinking && props.onCancel && (
                          <button
                            type="button"
                            className="composer-action-btn stop-btn multiview-pane-action"
                            onClick={() => chatId && props.onCancel?.(props.paneIndex, chatId)}
                            title="Stop pane run"
                            aria-label="Stop pane run"
                          >
                            <StopSymbolIcon />
                          </button>
                        )}
                        <button
                          type="submit"
                          className={`composer-action-btn run-btn multiview-pane-action${
                            props.isThinking ? ' queue' : ''
                          }`}
                          disabled={!canSubmit}
                          title={
                            composerDisabled
                              ? 'Pane workspace is unavailable'
                              : props.isThinking
                                ? 'Queue pane prompt'
                                : 'Run pane prompt'
                          }
                          aria-label={props.isThinking ? 'Queue pane prompt' : 'Run pane prompt'}
                        >
                          {renderPaneSendIcon(props)}
                        </button>
                      </span>
                    </div>
                  </div>
                </div>
              </div>
            </div>
            <div
              className="composer-telemetry-row multiview-pane-telemetry-row"
              data-has-token-tally={hasTokenTally ? 'true' : 'false'}
            >
              <ComposerRunTimecode running={props.isThinking} startedAt={props.runStartedAt || null} />
              <ComposerCumulativeTimecode
                running={props.isThinking}
                startedAt={props.runStartedAt || null}
                cumulativeBaseMs={props.cumulativeRunBaseMs || 0}
              />
              <button
                type="button"
                className={`composer-screen-watch-button${props.screenWatchActive ? ' is-attached' : ''}${
                  props.screenWatchStreaming ? ' is-streaming' : ''
                }`}
                onClick={() => chatId && props.onToggleScreenWatch?.(props.paneIndex, chatId)}
                title={props.screenWatchTitle || 'Screen Watch'}
                aria-label={props.screenWatchTitle || 'Screen Watch'}
                disabled={props.screenWatchDisabled || !props.onToggleScreenWatch}
                data-streaming={props.screenWatchStreaming ? 'true' : 'false'}
              >
                <ScreenWatchSymbolIcon />
                {props.screenWatchStreaming && (
                  <span className="composer-screen-watch-button-dot" aria-hidden="true" />
                )}
              </button>
              <span className="composer-goal-control-wrap">
                <button
                  type="button"
                  className={`composer-goal-button is-${goalStatus}`}
                  onClick={() => chatId && props.onOpenGoal?.(props.paneIndex, chatId)}
                  title={props.goalTitle || 'Set active goal'}
                  aria-label={props.goalTitle || 'Set active goal'}
                  disabled={!props.onOpenGoal}
                  data-goal-status={goalStatus}
                >
                  <GoalSymbolIcon />
                  {(goalStatus === 'active' ||
                    goalStatus === 'paused' ||
                    goalStatus === 'blocked') && (
                    <span className="composer-goal-button-dot" aria-hidden="true" />
                  )}
                  {goalStatus === 'completed' && (
                    <span className="composer-goal-button-check" aria-hidden="true">
                      ✓
                    </span>
                  )}
                </button>
              </span>
              {props.onCopyTranscript && (
                <CopyTranscriptButton
                  disabled={!props.chat || props.chat.archived || props.messages.length === 0}
                  resetKey={props.chat?.appChatId || null}
                  onCopy={() => props.onCopyTranscript!(props.paneIndex, chatId)}
                />
              )}
              {props.multiviewLayout && props.onSelectMultiviewLayout && (
                <MultiviewLayoutPicker
                  layout={props.multiviewLayout}
                  onSelectLayout={props.onSelectMultiviewLayout}
                  provider={props.provider}
                  composerStyle={props.interfaceStyle}
                />
              )}
              {!props.welcomeIsGlobalChat &&
                props.workspaces &&
                props.workspace &&
                props.onPickWorkspace &&
                props.onAddWorkspace &&
                props.onSelectNoWorkspace && (
                  <ComposerWorkspaceSwitcher
                    workspaces={props.workspaces}
                    currentWorkspace={props.workspace}
                    onPickExisting={(workspace) =>
                      chatId && props.onPickWorkspace?.(props.paneIndex, chatId, workspace)
                    }
                    onAddNewWorkspace={() =>
                      chatId && props.onAddWorkspace?.(props.paneIndex, chatId)
                    }
                    onSelectNoWorkspace={() =>
                      chatId && props.onSelectNoWorkspace?.(props.paneIndex, chatId)
                    }
                    composerStyle={props.interfaceStyle}
                  />
                )}
              {hasTokenTally &&
                props.tokenTally &&
                props.currency &&
                props.providerRates && (
                  <LiveThreadTokenTally
                    baseTally={props.tokenTally}
                    currency={props.currency}
                    dualCostAndRam={props.tokenTallyDualCostAndRam}
                    model={props.tokenTallyModel}
                    overestimatePercent={props.currencyOverestimatePercent || 0}
                    provider={props.provider}
                    providerRates={props.providerRates}
                    running={props.isThinking}
                    liveOutputTokens={props.tokenTallyLiveOutputTokens || 0}
                    title={props.tokenTallyTitle || 'Pane token tally'}
                  />
                )}
            </div>
          </form>
          {props.isWelcomeChat && <ChatViewWelcomeSuggestions {...props} />}
          {props.isWelcomeChat &&
            props.showWelcomeHeatmaps &&
            props.welcomeHeatmapSlots &&
            props.welcomeHeatmapSlots.length > 0 && (
              <WelcomeHeatmaps slots={props.welcomeHeatmapSlots} layout="single" />
            )}
        </div>
      )}
    </div>
  )
}

export const ChatViewPane = memo(ChatViewPaneInner, chatViewPanePropsEqual)
