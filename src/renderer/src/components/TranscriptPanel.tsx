import {
  Fragment,
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore
} from 'react'
import type { CSSProperties, ReactElement } from 'react'
import type {
  ChatMessage,
  ChatRecord,
  ChatRun,
  DiffFileSummary,
  DiffFileSummaryOwner,
  ProviderId,
  ToolActivity
} from '../../../main/store/types'
import {
  activityStackHasLiveWork,
  collapsedSystemNoticeLabel,
  shouldAutoCollapseActivityStack,
  summarizeCollapsedSuperGroup
} from '../lib/collapsedActivityStack'
import { isEnsembleRoundDispatchLive } from '../../../shared/ensembleRoundLifecycle'
import {
  closeoutProviderFromMetadata,
  TASKWRAITH_CLOSEOUT_KIND
} from '../../../shared/taskWraithCloseout'
import { ensembleRoundStatusClass } from '../lib/ensembleRoundStatusClass'
import { getChatProvider } from '../lib/chatScope'
import { getProviderLabel } from '../lib/providerLabels'
import { resolveProviderHueClass } from '../lib/ollamaDisplayBrand'
import { formatAssistantMessageLabel } from '../lib/assistantMessageLabel'
import { readMessageFeedbackVote, type MessageFeedbackDetails } from '../lib/messageFeedback'
import { shortModelName } from '../lib/composerChipFormat'
import { shouldSurfaceProposedPlanCard } from '../lib/ensemblePlanPolicy'
import { deriveParticipantRenameContinuity } from '../lib/sessionActivityLedger'
import { shouldCollapseUserMessage, truncateUserMessagePreview } from '../lib/UserMessageCollapse'
import {
  buildRunCompleteBlockers,
  resolveRunCompleteStatus,
  runCompleteProducedWork
} from '../lib/runCompleteSummary'
import { decideMeasurePass, MAX_MEASURE_REWRITE_PASSES } from '../lib/transcriptMeasureConvergence'
import {
  deriveActiveEnsembleWorkingPresentation,
  deriveActiveEnsembleWorkingPresentations,
  type WorkingIndicatorPresentation
} from '../lib/workingIndicatorPresentation'
import { buildWorkingIndicatorTokenTargets } from '../lib/workingIndicatorTelemetry'
import {
  TRANSCRIPT_VIRTUALIZATION_ENABLED,
  DEFAULT_OVERSCAN_PX,
  buildHeightOffsets,
  projectRow,
  projectRows,
  selectWindow,
  findScrollAnchor,
  sumHeights,
  sumHeightOffsets,
  totalHeightFromOffsets,
  geometryKey,
  getRowHeight,
  measurementKey,
  measurementContentVersion,
  widthBucket,
  type VirtualRow,
  type VirtualWindow
} from '../lib/TranscriptVirtualWindow'
import {
  buildTranscriptUserGutterMarkers,
  findActiveGutterMarkerKey,
  isHiddenRoundMarkerRowKey
} from '../lib/TranscriptUserMessageGutter'
import {
  buildTranscriptParticipantFilterItems,
  filterTranscriptMessagesByParticipantKeys
} from '../lib/transcriptParticipantFilter'
import {
  transcriptChatRenderSignature,
  transcriptMessageRenderSignature,
  transcriptRowRenderSignatureEqual,
  type TranscriptRowRenderSignature
} from '../lib/transcriptRowRenderCache'
import { resolveLiveRevealMessageId, resolveLiveToolMessageId } from '../lib/liveRevealMessage'
import type { PlanChoiceState } from '../lib/planModeChoice'
import type { DisplayCurrency } from '../lib/formatCost'
import type { RendererProviderRates } from '../lib/providerRateEstimate'
import { shouldSuppressRunCompleteSummary, type RunCompleteNotice } from '../lib/runCompleteNotice'
import { formatTranscriptClock } from '../lib/dateTimeFormat'
import { EMPTY_CHAT_MESSAGES } from '../lib/stableEmpties'
import {
  groupAdjacentToolMessagesWithRanges,
  groupFanoutLaneMessagesStable,
  groupedTranscriptMessageIds,
  shouldGroupAdjacentToolMessages,
  type FanoutLaneGroupingState,
  type TranscriptGroupedMessageRange
} from '../lib/transcriptToolMessageGrouping'
import {
  buildEnsembleRoundCardRowsWithRanges,
  buildRoundTranscriptCopyText,
  getSessionRoundExpansionSnapshot,
  isEnsembleRoundHeaderMessage,
  readEnsembleRoundHeader,
  roundExpansionForChat,
  setSessionRoundExpanded,
  subscribeSessionRoundExpansion
} from '../lib/ensembleRoundCards'
import { isEnsembleFanoutViewportHeaderMessage } from '../lib/ensembleFanoutViewportGroups'
import {
  createTranscriptScrollAnimator,
  type TranscriptScrollAnimator
} from '../lib/transcriptSmoothScroll'
import {
  transcriptAuxiliaryChatsSignature,
  transcriptPanelPropsEqual,
  transcriptRunningChatIdsSignature
} from '../lib/transcriptPanelMemoProps'
import { ActivityStack, type ThinkingTraceActionsConfig } from './ActivityStack'
import {
  CollapsedActivityStackRow,
  CollapsedStackIconStrip,
  CollapsedTranscriptRow
} from './CollapsedTranscriptRow'
import { EnsembleRoundCardHeader } from './EnsembleRoundCardHeader'
import { EnsembleFanoutViewportHeader } from './EnsembleFanoutViewportHeader'
import { EnsembleFanoutResultCard } from './EnsembleFanoutResultCard'
import {
  isEnsembleFanoutLaneWorking,
  isEnsembleFanoutResultMessage
} from './EnsembleFanoutResultCardModel'
import { AgentQuestionCard, type AgentQuestionState } from './AgentQuestionCard'
import { AgentQuestionTombstoneCard } from './AgentQuestionTombstoneCard'
import {
  agentQuestionTombstoneKey,
  buildAgentQuestionTombstone,
  indexAgentQuestionReplies,
  isAgentQuestionMarker,
  type AgentQuestionTombstone
} from '../lib/agentQuestionTombstone'
import { isGuestParticipantReplyMessage } from './GuestParticipantReplyCardModel'
import { SubThreadDelegationCard } from './SubThreadDelegationCard'
import { isSubThreadDelegationMessage } from './SubThreadDelegationCardModel'
import { SubThreadReturnCard } from './SubThreadReturnCard'
import { isSubThreadReturnMessage, subThreadReturnBody } from './SubThreadReturnCardModel'
import { ThreadMessageTranscriptCard } from './ThreadMessageTranscriptCard'
import { isThreadMessageTranscriptMessage } from './ThreadMessageTranscriptCardModel'
import { ParticipantHealthCard } from './ParticipantHealthCard'
import {
  ContextCompactionCard,
  ContextCompactionGlyph,
  contextCompactionMessageFailed,
  contextCompactionMessageMetaLabel
} from './ContextCompactionCard'
import {
  buildParticipantContextRows,
  currentContextTokens
} from '../lib/contextMeter'
import {
  contextPercent,
  isContextWindowProviderId,
  resolveContextWindow
} from '../../../shared/contextWindows'
import { CONTEXT_PRESSURE_WARN_PERCENT } from '../../../shared/contextCompaction'
import type { ContextCompactionProgressEvent } from '../../../shared/contextCompaction'
import { ProviderRunFailureCard } from './ProviderRunFailureCard'
import { SeatChangeRow } from './SeatChangeRow'
import { MarkdownMessage } from './MarkdownMessage'
import { RevealingMarkdownMessage } from './RevealingMarkdownMessage'
import { ProposedPlanCard } from './ProposedPlanCard'
import type { ProposedPlanState } from '../lib/proposedPlan'
import { MessageActionsChip } from './MessageActionsChip'
import { PillButton } from './PillButton'
import {
  TranscriptMessageContextMenu,
  type TranscriptMessageContextMenuSelection
} from './TranscriptMessageContextMenu'
import { ChatMessageMediaStrip, collectMessageMediaRefs, type ChatMediaRef } from './ChatMediaPanel'
import { collectInlineImageRefIds } from '../lib/resolveMarkdownImageRef'
import { FileTypeIcon } from './FileTypeIcon'
import { PooledAgentIcon } from './icons/PooledAgentIcon'
import { ProviderBrandLogo } from './icons/ProviderBrandLogo'
import { ThinkingIndicator } from './AppChromeSymbols'
import { MemoizedParticipantWorkingTelemetry } from './ParticipantWorkingTelemetry'
import {
  humanCollaboratorMetadata,
  isDeliveredExternalContribution,
  isHumanCollaboratorComment
} from '../../../main/collaboration/HumanCollaboratorMessages'
import { TranscriptUserMessageGutter } from './TranscriptUserMessageGutter'
import { TranscriptParticipantFilterRail } from './TranscriptParticipantFilterRail'
import {
  DIFF_HOVER_PREVIEW_TOOLTIP_ID,
  DiffHoverPreviewOverlay,
  type DiffHoverPreviewState,
  canShowDiffHoverPreview,
  diffHoverPreviewBoundaryForElement,
  useDiffHoverPreviewDismiss,
  useDiffHoverPreviewState
} from './DiffHoverPreview'
import { buildToolEditDiffSnapshotForPath } from '../lib/toolEditDiffSnapshot'

function ContextCompactionProgressRow({
  event
}: {
  event: ContextCompactionProgressEvent
}): React.JSX.Element {
  const provider = event.provider as ProviderId | undefined
  const providerClass = event.hueClass || provider
  const label = event.label || (provider ? getProviderLabel(provider) : 'Context')
  return (
    <div
      key={`${event.chatId}:${event.participantId || event.provider || 'chat'}`}
      className="message-group context-compaction-progress-row"
      role="status"
      aria-live="polite"
      aria-atomic="true"
    >
      <span className="sr-only">{label} compacting context</span>
      <div className={`message-meta${providerClass ? ` provider-${providerClass}` : ''}`}>
        <span className="message-meta-label">{label}</span>
      </div>
      <ThinkingIndicator label="Compacting context" ariaLabel={`${label} compacting context`} />
    </div>
  )
}

/** Token-growth stall window before a high-pressure working row is presumed
 * to be compacting (providers that auto-compact without emitting any frame —
 * the "participant goes quiet, then the record appears" report). */
const WORKING_QUIET_COMPACTION_MS = 20_000

/**
 * Context-pressure hint riding the working indicator: at ≥80% occupancy the
 * row discloses the percent ("context 87%"), and if token growth then stalls
 * for 20s at that pressure it escalates to "likely compacting" — a TENTATIVE
 * presumption for lanes whose native auto-compaction emits no start signal.
 * Confirmed compaction (a real `started` event) flips the whole indicator to
 * "Compacting context" upstream, which supersedes this hint.
 */
function WorkingContextPressureHint({
  percent,
  estimatedTokens
}: {
  percent: number
  estimatedTokens: number
}): ReactElement | null {
  const [quiet, setQuiet] = useState(false)
  // Growth timestamps are recorded in an effect keyed on estimatedTokens
  // (render-time ref writes + Date.now() violate react-hooks/purity); the
  // one-commit lag is irrelevant against the 20s stall threshold. Null until
  // the first commit, which the interval reads as "not quiet yet".
  const lastGrowthAtMsRef = useRef<number | null>(null)
  useEffect(() => {
    lastGrowthAtMsRef.current = Date.now()
  }, [estimatedTokens])
  useEffect(() => {
    const timer = window.setInterval(() => {
      const lastGrowthAtMs = lastGrowthAtMsRef.current
      setQuiet(
        lastGrowthAtMs !== null && Date.now() - lastGrowthAtMs >= WORKING_QUIET_COMPACTION_MS
      )
    }, 1000)
    return () => window.clearInterval(timer)
  }, [])
  if (!(percent >= CONTEXT_PRESSURE_WARN_PERCENT)) return null
  const rounded = Math.round(percent)
  return (
    <span
      className={`working-context-pressure-hint${percent >= 90 ? ' is-critical' : ''}${
        quiet ? ' is-quiet' : ''
      }`}
      title={
        quiet
          ? 'No token growth for 20s at high context pressure — the provider is likely auto-compacting its context.'
          : 'Live context occupancy. Providers auto-compact near their window limit.'
      }
    >
      {quiet ? `quiet at ${rounded}% context — likely compacting` : `context ${rounded}%`}
    </span>
  )
}

function providerIdFromUnknown(value: unknown): ProviderId | undefined {
  switch (value) {
    case 'gemini':
    case 'codex':
    case 'claude':
    case 'kimi':
    case 'grok':
    case 'cursor':
    case 'ollama':
    case 'antigravity':
    case 'pi':
    case 'mistral':
      return value
    default:
      return undefined
  }
}

function stringFromUnknown(value: unknown): string {
  return typeof value === 'string' && value.trim() ? value.trim() : ''
}

function activitySpeakerMessage(message: ChatMessage, chat: ChatRecord | null): ChatMessage {
  const metadata: Record<string, unknown> = { ...(message.metadata || {}) }
  const firstActivityWithMetadata = message.toolActivities?.find((activity) => activity.metadata)
  const activityMetadata = firstActivityWithMetadata?.metadata
  const participantId =
    stringFromUnknown(metadata.ensembleParticipantId) ||
    stringFromUnknown(activityMetadata?.ensembleParticipantId)
  const participant = participantId
    ? chat?.ensemble?.participants?.find((item) => item.id === participantId)
    : undefined
  const ensembleProvider =
    providerIdFromUnknown(metadata.ensembleProvider) ||
    providerIdFromUnknown(activityMetadata?.ensembleProvider) ||
    participant?.provider

  if (chat?.chatKind === 'ensemble' && ensembleProvider) {
    metadata.ensembleProvider = ensembleProvider
    if (participantId) metadata.ensembleParticipantId = participantId
    if (!metadata.ensembleRole && participant?.role) metadata.ensembleRole = participant.role
    if (!metadata.ensembleModel && participant?.model) metadata.ensembleModel = participant.model
    if (!metadata.ensembleReasoningEffort && participant?.reasoningEffort) {
      metadata.ensembleReasoningEffort = participant.reasoningEffort
    }
    if (
      typeof metadata.ensembleThinkingEnabled !== 'boolean' &&
      typeof participant?.thinkingEnabled === 'boolean'
    ) {
      metadata.ensembleThinkingEnabled = participant.thinkingEnabled
    }
  }

  return {
    ...message,
    role: 'assistant',
    metadata
  }
}

function ActivityStackSpeakerHeader({
  message,
  chat,
  run,
  fallbackProvider,
  fallbackProviderLabel
}: {
  message: ChatMessage
  chat: ChatRecord | null
  run?: ChatRun | null
  fallbackProvider: ProviderId
  fallbackProviderLabel: string
}): ReactElement {
  const firstActivityWithMetadata = message.toolActivities?.find((activity) => activity.metadata)
  const activityProvider = providerIdFromUnknown(firstActivityWithMetadata?.metadata?.provider)
  const labelProvider = providerIdFromUnknown(run?.provider) || activityProvider || fallbackProvider
  const {
    label,
    provider,
    providerClass,
    modelBadge,
    pooledAgentIdentity
  } = formatAssistantMessageLabel(
    activitySpeakerMessage(message, chat),
    labelProvider ? getProviderLabel(labelProvider) : fallbackProviderLabel,
    labelProvider,
    {
      isEnsembleChat: chat?.chatKind === 'ensemble',
      soloModelId: run?.actualModel || run?.requestedModel || null
    }
  )
  const providerHook = providerClass || provider

  return (
    <div className="activity-stack-speaker-header" aria-label={`Activity from ${label}`}>
      <div className={`message-meta${providerHook ? ` provider-${providerHook}` : ''}`}>
        <span className="message-meta-label">
          {pooledAgentIdentity && (
            <PooledAgentIcon
              identity={pooledAgentIdentity}
              size={14}
              className="message-meta-agent-icon"
            />
          )}
          {label}
        </span>
        {modelBadge && (
          <span
            className="message-meta-model-badge"
            title={`Model: ${modelBadge}`}
            aria-label={`Model ${modelBadge}`}
          >
            {modelBadge}
          </span>
        )}
      </div>
    </div>
  )
}

export type TranscriptPanelProps = {
  scrollRef: React.RefObject<HTMLDivElement | null>
  /**
   * Ref pinned to the SINGLE inner content div (`.transcript-inner`)
   * inside the scroll container. The App-level scroll effect attaches
   * one `ResizeObserver` to this node so ANY late-mount layout growth
   * (CodeMirror code blocks, `ActivityStack` rows revealing
   * tool-result output, shell-command stdout measuring, future
   * content types) triggers a coalesced rAF re-pin via the shared
   * `shouldRepinAfterTranscriptResize` gate. This is the
   * follow-up to a12f913 — that fix observed individual code blocks,
   * which missed Codex transcripts heavy with `Ran /bin/zsh -lc '...'`
   * activity rows. One observer on the content div catches them all
   * without per-component plumbing.
   */
  contentRef: React.RefObject<HTMLDivElement | null>
  endRef: React.RefObject<HTMLDivElement | null>
  messages: ChatMessage[]
  isWelcomeChat: boolean
  isThinking: boolean
  pendingPlanChoice: PlanChoiceState | null
  pendingProposedPlan: ProposedPlanState | null
  pendingAgentQuestions: readonly AgentQuestionState[]
  contextCompactionProgress?: readonly ContextCompactionProgressEvent[]
  onAgentQuestionSubmit: (questionId: string, answer: string, isCustom: boolean) => void
  onAgentQuestionDismiss: (questionId: string) => void
  onEnsemblePollVote?: (chatId: string, pollId: string, choice: string) => void
  runCompleteNotice: RunCompleteNotice | null
  runCompleteDurationText: string | null
  currentChat: ChatRecord | null
  /**
   * True when the rendered chat has `scope === 'global'` (General/Global Chats).
   * Presentation-only: gates friendlier, less-technical rendering. Derived by
   * the host via `isGlobalChat(...)` so this component stays presentation-pure.
   */
  isGlobal?: boolean
  currentRun?: ChatRun | null
  currentWorkspacePath?: string
  currentProviderLabel: string
  /**
   * Provider id for the chat's primary speaker. Forwarded to the
   * assistant-message label so each message's `.message-meta` gets
   * a `provider-{name}` class hook — that lets the CSS colour the
   * "Codex" / "Claude" / "Gemini" / "Kimi" label in the provider's
   * theme tint without needing a separate JSX rewrite per provider.
   * Falls back to the chat-level provider when the message itself
   * doesn't carry an ensembleProvider in its metadata.
   */
  currentProvider: ProviderId
  /**
   * Slice B (1.0.3) — ensemble-aware "Thinking…" label. When an
   * ensemble round is mid-flight, this resolves to the active
   * participant's provider label (e.g. "Kimi" while Kimi is speaking);
   * otherwise it equals `currentProviderLabel`.
   */
  thinkingProviderLabel?: string
  /**
   * Companion provider id for {@link thinkingProviderLabel}. Drives
   * the `.message-meta.provider-{name}` class on the live thinking
   * indicator so the per-provider tint applies there too — same
   * treatment as completed assistant messages.
   */
  thinkingProvider?: ProviderId | null
  /**
   * Optional presentation-only provider class. Used for local Ollama
   * model brands that should look like Qwen / Google / OpenAI in the
   * transcript while remaining runtime provider `ollama`.
   */
  thinkingProviderClass?: string | null
  /**
   * Short model name (e.g. "5.5", "Opus 4.7", "K2.7 Coding", "2.5 Pro") for
   * the in-flight ensemble participant. Rendered as a dim chip after
   * the "Codex Thinking…" label so the user knows *which configured
   * model* is producing the live output. Null for solo chats and
   * legacy ensembles without per-participant model data.
   */
  thinkingModelBadge?: string | null
  displayFileChangeSummaries: DiffFileSummary[]
  /**
   * Files edited by the just-completed round (ensemble) or run (solo) only,
   * with round-scoped line counts. When at least one round file AND at least
   * one other session file exist, the Task-complete file list renders a
   * "This round" section first, a chunky divider, then the remaining
   * session files. Absent/empty → the flat session list renders unchanged.
   */
  roundFileChangeSummaries?: DiffFileSummary[]
  fileChangeSummaryText: string
  fileChangeShouldShowStats: boolean
  fileChangeDisplayAdds: number
  fileChangeDisplayDels: number
  /** Phase I3.2 — all chats, so the inline delegation card can look up
   * the live sub-thread record by id and reflect its status. */
  chats: ChatRecord[]
  /** Phase I3.2 — chat ids currently running on the run-queue so the
   * delegation card and the chat-header ticker can show live state. */
  runningChatIds: string[]
  onPlanChoiceSubmit: (messageId: string, option: string) => void
  onProposedPlanApprove: (messageId: string, planBody: string) => void
  onProposedPlanDismiss: (messageId: string) => void
  onProposedPlanCustom: (messageId: string, feedback: string) => void
  onOpenSubThread: (chatId: string) => void
  onOpenSubThreadInSidePanel?: (chatId: string, presentation?: 'split' | 'drawer') => void
  onOpenFileChangeInWorkbench?: (summary: DiffFileSummary) => void
  /** Phase K1B: when set, RunCard's "Inspect →" affordance enters Run
   * mode for the clicked run. Plumbed from App.tsx down. */
  onInspectRun?: (runId: string) => void
  onOpenSideChatFromRun?: (runId: string) => void
  /** Phase L3 slice 6 — `settings.compactDensity` plumbed through so
   * every `ActivityStack` inside the transcript renders in the same
   * density as the rest of the chat. */
  compactDensity: boolean
  /** Cursor-style live activity viewport toggle (`settings.liveActivityViewport`),
   * forwarded to every `ActivityStack` so in-flight thinking + tool activity
   * streams inside the masked auto-following region. */
  liveActivityViewport?: boolean
  /**
   * 1.0.4-AQ4 — per-message actions on hover.
   *
   * `onCopyMessage(messageId, content)` copies the raw `msg.content`
   * string to the clipboard. 1.0.8: takes the message id too so the
   * shared copy-feedback hook can show a transient "Copied" on the
   * originating chip. Pure — does not mutate chat state.
   *
   * `onDeleteMessage(messageId)` removes the message from
   * `currentChat.messages`. The host applies a `confirm()` gate so
   * the destructive action requires intent. Both user and assistant
   * bubbles use the same handler; the host can differentiate by
   * checking the role itself if it ever wants to gate
   * differently (e.g. forbid deleting in-flight assistant runs).
   */
  onCopyMessage: (messageId: string, content: string) => void
  onAddMessageToPrompt?: (messageId: string, content: string) => void
  onDeleteMessage: (messageId: string) => void
  onTogglePinMessage?: (messageId: string) => void
  /** Thumbs feedback on an assistant message (up/down; host writes the receipt). */
  onMessageFeedback?: (messageId: string, vote: 'up' | 'down', details?: MessageFeedbackDetails) => void
  onPromoteCollaboratorComment?: (messageId: string) => void
  onMessageSelectionCandidate?: (message: ChatMessage) => void
  onOpenSideChatFromMessage?: (message: ChatMessage) => void
  sideChatSeedMessageId?: string | null
  jumpToMessageRequest?: { messageId: string; rowKey?: string; requestId: number } | null
  /** Temporarily force-mount this transferred reading anchor so the host's
   * exact-offset restore can find it even when the destination virtual window
   * initially lands elsewhere after a width change. */
  externalRestoreAnchorMessageId?: string | null
  onManualTranscriptJump?: () => void
  onJumpToLatest?: () => void
  onPreviewImage: (ref: ChatMediaRef) => void
  /** Pop an A/V attachment out into its own Multiview pane (the docked media
   *  player). Optional — omitted when Multiview isn't available to the host. */
  onDetachToPane?: (ref: ChatMediaRef) => void
  /**
   * 1.0.8 — shared copy-to-clipboard feedback (see {@link useCopyFeedback}).
   * `copiedId` is the id currently showing its "Copied" confirmation;
   * `copy(id, text)` performs the write and arms the reset timer. Drives
   * the message chips (keyed on message id) and the latest-response copy
   * button (keyed on the latest assistant message id).
   */
  copiedId: string | null
  copy: (id: string, text: string) => void
  /**
   * 1.0.6-TV1 — when true, the transcript mounts only the visible window
   * + overscan (spacer-above / spacer-below) instead of the full message
   * list. Defaults to {@link TRANSCRIPT_VIRTUALIZATION_ENABLED} when
   * omitted; tests pass `true` to exercise the windowed path while the
   * global flag is still off. The non-virtualised branch is byte-for-byte
   * the original render and is deleted in TV3 after soak.
   */
  virtualize?: boolean
  /**
   * 1.0.6-TV1 — the App-level auto-follow ref. Read (never written) by
   * the windowing layer: when engaged the window pins to the bottom (so
   * the last row is always mounted and the existing snap behaves
   * identically), and the pre-paint anchor correction runs ONLY when it
   * is disengaged. A stable ref, so it never perturbs the memo.
   */
  autoFollowRef?: React.MutableRefObject<boolean>
  /**
   * Arm the parent scroll evaluator's programmatic-scroll guard for the
   * virtual-window anchor-correction write below. Without it the anchor
   * write reaches the App scroll listener as an un-owned scroll and, when it
   * lands at the live edge moving down, spuriously re-engages auto-follow.
   * Called with the ACTUAL post-write `scrollTop` (browser-clamped). Stable
   * callback, so it never perturbs the memo.
   */
  onProgrammaticScrollWrite?: (landedScrollTop: number) => void
  /**
   * Legacy run-details cost formatting inputs. The current compact card is
   * token-only, but upstream panes still pass these props while cost displays
   * remain available elsewhere in the app.
   */
  currency?: DisplayCurrency
  currencyOverestimatePercent?: number
  showRunCompleteSummary?: boolean
  /**
   * Settings → General: collapse older Ensemble rounds into cards. When
   * undefined or true (the default) completed rounds collapse into
   * expandable round cards; explicit `false` restores the flat transcript.
   */
  collapseOlderRounds?: boolean
  /**
   * Body-portaled user-message rail. Keep this on the focused/main transcript
   * only so secondary panes do not draw rails outside their pane bounds.
   */
  userMessageGutterEnabled?: boolean
  /**
   * Legacy run-details provider rate table. Kept on the public prop surface
   * while the surrounding panes still pass provider rate data through.
   */
  providerRates?: RendererProviderRates
}

export const FILE_CHANGE_SUMMARY_COLLAPSED_LIMIT = 12

// "Almost 1s" both ways: hovering a file-change row must feel deliberate
// before the diff bubble appears, and slipping off the row (or the bubble)
// must not snap it away mid-read.
const FILE_CHANGE_DIFF_PREVIEW_OPEN_DELAY_MS = 900
const FILE_CHANGE_DIFF_PREVIEW_CLOSE_DELAY_MS = 900
export const FILE_CHANGE_SUMMARY_PAGE_SIZE = 24
export const FILE_CHANGE_SUMMARY_MAX_VISIBLE = 120

export {
  transcriptAuxiliaryChatsEqual,
  transcriptAuxiliaryChatsSignature,
  transcriptChatIdentityEqual,
  transcriptPanelPropsEqual,
  transcriptRunningChatIdsSignature
} from '../lib/transcriptPanelMemoProps'

export interface FileChangeSummaryWindow {
  canShowFewer: boolean
  canShowMore: boolean
  hiddenCount: number
  items: DiffFileSummary[]
  nextCount: number
  nextShowCount: number
  visibleCount: number
}

export function buildFileChangeSummaryWindow(
  summaries: DiffFileSummary[],
  requestedVisibleCount = FILE_CHANGE_SUMMARY_COLLAPSED_LIMIT
): FileChangeSummaryWindow {
  const totalCount = summaries.length
  const maxVisibleCount = Math.min(totalCount, FILE_CHANGE_SUMMARY_MAX_VISIBLE)
  const visibleCount = Math.min(
    Math.max(FILE_CHANGE_SUMMARY_COLLAPSED_LIMIT, requestedVisibleCount),
    maxVisibleCount
  )
  const nextCount = Math.min(
    visibleCount + FILE_CHANGE_SUMMARY_PAGE_SIZE,
    totalCount,
    FILE_CHANGE_SUMMARY_MAX_VISIBLE
  )
  const hiddenCount = Math.max(0, totalCount - visibleCount)

  return {
    canShowFewer: visibleCount > FILE_CHANGE_SUMMARY_COLLAPSED_LIMIT,
    canShowMore: nextCount > visibleCount,
    hiddenCount,
    items: summaries.slice(0, visibleCount),
    nextCount,
    nextShowCount: Math.max(0, nextCount - visibleCount),
    visibleCount
  }
}

export interface FileChangeSummarySections {
  /** Round rows first, then the remaining session rows; the window slices this. */
  combined: DiffFileSummary[]
  /** Index of the first remaining-session row — the chunky divider slot. */
  boundary: number
  roundCount: number
  remainingCount: number
  roundAdds: number
  roundDels: number
  /** False when no round row carries line counts — hide the header ± pill. */
  roundHasLineStats: boolean
}

/**
 * Split the Task-complete file list into "This round" / remaining-session
 * sections. Returns null (flat list) unless BOTH sections are non-empty:
 * an empty round means we could not attribute round edits (or none were
 * made), and an empty remainder means the round IS the whole session —
 * either way a split adds noise without information.
 */
export function buildFileChangeSummarySections(
  displaySummaries: DiffFileSummary[],
  roundSummaries: DiffFileSummary[] | undefined
): FileChangeSummarySections | null {
  if (!roundSummaries || roundSummaries.length === 0) return null
  if (displaySummaries.length === 0) return null
  const roundPaths = new Set(roundSummaries.map((item) => item.path))
  const remaining = displaySummaries.filter((item) => !roundPaths.has(item.path))
  if (remaining.length === 0) return null
  let roundAdds = 0
  let roundDels = 0
  let roundHasLineStats = false
  for (const item of roundSummaries) {
    if (item.additions !== undefined || item.deletions !== undefined) roundHasLineStats = true
    roundAdds += item.additions || 0
    roundDels += item.deletions || 0
  }
  return {
    combined: [...roundSummaries, ...remaining],
    boundary: roundSummaries.length,
    roundCount: roundSummaries.length,
    remainingCount: remaining.length,
    roundAdds,
    roundDels,
    roundHasLineStats
  }
}

/** Stable empty heights array so the disabled path allocates nothing. */
const EMPTY_TRANSCRIPT_HEIGHTS: number[] = []
/** Stable zero-only height offset array for the disabled path. */
const EMPTY_TRANSCRIPT_HEIGHT_OFFSETS: number[] = [0]
/** Stable empty rows array for the non-virtualised render path. */
const EMPTY_VIRTUAL_ROWS: VirtualRow[] = []
const EMPTY_HIDDEN_ROW_KEYS: ReadonlySet<string> = new Set()

const EMPTY_FOLDING_SUPER_GROUPS: ReadonlySet<string> = new Set()

/**
 * How long a freshly settled super group keeps its member rows mounted in the
 * `.is-super-folding` state before committing to the real hidden state. Must
 * outlast the CSS height transition (260ms) so the commit lands on rows that
 * are already 0px tall — the removal is then invisible.
 */
const SUPER_FOLD_COMMIT_MS = 300

/**
 * Level-1 roll-up: how long a freshly collapsed stack row keeps its
 * `.is-stack-collapsing` class. The CSS animation (260ms) rolls the row from
 * its last measured slot height down to the one-liner instead of teleporting.
 */
const STACK_COLLAPSE_COMMIT_MS = 300

function prefersReducedMotionNow(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches
  )
}
/** Stable empty expansion set so unopened tool rows share one reference. */
const EMPTY_ACTIVITY_EXPANSION: Set<string> = new Set()
/** Stable empty set so the no-one-working case never remounts a card's rim. */
const EMPTY_WORKING_LANE_IDS: ReadonlySet<string> = new Set<string>()

function escapeDomSelectorValue(value: string): string {
  return typeof CSS !== 'undefined' && typeof CSS.escape === 'function'
    ? CSS.escape(value)
    : value.replace(/["\\]/g, '\\$&')
}

/**
 * Position-independent identity for a tool stack row's lifted UI state: the
 * first CONSTITUENT tool message id. A grouped tool row's merged id mutates
 * from `<id>` to `tool-group-<id>` the moment a second message joins the
 * group (remounting the row), and `rowKey` embeds the list index — both churn
 * while activity streams in. The first constituent id survives group growth,
 * remounts, and index shifts.
 */
export function toolStackStateKey(message: ChatMessage): string {
  return groupedTranscriptMessageIds(message)[0] || message.id
}

/**
 * Message-shape half of the plain-system-notice predicate — the checks that
 * need only the record itself. The render loop AND the super-group fold both
 * use this so a row can never be hidden as a group member while rendering as
 * a special card. Per-row state (pending questions/plan choice, pinned,
 * highlight target) is applied by each caller.
 */
function plainSystemNoticeMessage(msg: ChatMessage): boolean {
  // NOTE: `contextCompaction` records deliberately QUALIFY as plain notices —
  // they fold into settled one-liners / super-groups like every other
  // transcript row (their `content` is the pre-formatted summary line). The
  // per-row render special-cases them back to `ContextCompactionCard` when
  // un-collapsed or expanded.
  return (
    msg.role === 'system' &&
    !isEnsembleRoundHeaderMessage(msg) &&
    !isEnsembleFanoutViewportHeaderMessage(msg) &&
    !isHumanCollaboratorComment(msg) &&
    // A DELIVERED contribution is a person's words, not app chrome. Left in,
    // it folds to an anonymous "System" one-liner and — next to any other
    // plain notice, which the round-status line always is — disappears
    // entirely behind "System · 2 system notices".
    !isDeliveredExternalContribution(msg) &&
    !isSubThreadDelegationMessage(msg) &&
    !isSubThreadReturnMessage(msg) &&
    !isEnsembleFanoutResultMessage(msg) &&
    msg.metadata?.kind !== 'ensembleParticipantHealth' &&
    msg.metadata?.kind !== 'providerRunFailure' &&
    msg.metadata?.kind !== TASKWRAITH_CLOSEOUT_KIND &&
    msg.metadata?.kind !== 'ensembleBossmanPoll' &&
    // An ANSWERED question keeps its full card (AgentQuestionTombstoneCard), so
    // it must never fold. It used to: once the question left
    // `pendingAgentQuestions` the marker satisfied every check here, and the
    // super-group swept the whole exchange into "System · 2 system notices" —
    // the question, its options and the user's choice all vanished. A decision
    // the user made deserves the same standing as the agent's own message.
    msg.metadata?.kind !== 'agentQuestion' &&
    // Authoritative seat changes render as the animated SeatChangeRow card —
    // never as a foldable one-liner (owner spec: the row collapses with its
    // ROUND, but must not truncate into system-notice stacks).
    !msg.metadata?.seatChange &&
    !msg.metadata?.proposedPlan &&
    !(Array.isArray(msg.metadata?.mediaRefs) && msg.metadata.mediaRefs.length > 0) &&
    Boolean(msg.content && msg.content.trim())
  )
}

/** Participant identity for merging adjacent stack summaries: ensemble seats
 * key on their participant id (then provider), guests on their chat; solo
 * chats collapse to one shared key, which is correct — one speaker. */
function superGroupParticipantKey(msg: ChatMessage): string {
  const metadata = msg.metadata || {}
  return String(
    metadata.ensembleParticipantId || metadata.ensembleProvider || metadata.guestChatId || ''
  )
}

/** One merged fold of adjacent collapsed one-liners (see the super-group memo
 * in TranscriptPanel). Every member id maps to the same info object. */
interface CollapsedSuperGroupInfo {
  leadId: string
  memberIds: string[]
  size: number
  activities: ToolActivity[]
  systemCount: number
  firstSystemPreview: string
  /** First stack member — supplies the speaker header; null = all-system. */
  headerMessage: ChatMessage | null
}

function useProjectedTranscriptRows(
  messages: ChatMessage[],
  runBoundaryIds: ReadonlySet<string> | null | undefined,
  unboundedActivityBodies = false
): VirtualRow[] {
  const cacheRef = useRef<{
    messages: ChatMessage[]
    rows: VirtualRow[]
    rowByMessageIndex: Map<number, VirtualRow>
    unboundedActivityBodies: boolean
  } | null>(null)

  return useMemo(() => {
    const cached =
      cacheRef.current?.unboundedActivityBodies === unboundedActivityBodies
        ? cacheRef.current
        : null
    if (cached && Array.isArray(messages)) {
      const minLength = Math.min(cached.messages.length, messages.length)
      let sharedPrefix = 0
      while (sharedPrefix < minLength) {
        const previousMessage = cached.messages[sharedPrefix]
        const nextMessage = messages[sharedPrefix]
        if (previousMessage !== nextMessage) break
        const cachedRow = cached.rowByMessageIndex.get(sharedPrefix)
        const nextBoundary = runBoundaryIds ? runBoundaryIds.has(nextMessage.id) : false
        if (cachedRow && cachedRow.hasRunBoundary !== nextBoundary) break
        sharedPrefix += 1
      }

      // Common streaming shape: unchanged prefix plus a changed/appended/removed
      // tail. Reuse old row objects for the prefix so row lookup, windowing, and
      // render caching do not churn through stable transcript history.
      if (sharedPrefix > 0 && sharedPrefix >= minLength - 1) {
        const rows = cached.rows.filter((row) => row.index < sharedPrefix)
        for (let index = sharedPrefix; index < messages.length; index += 1) {
          const row = projectRow(messages[index], index, runBoundaryIds, unboundedActivityBodies)
          if (row) rows.push(row)
        }
        const rowByMessageIndex = new Map<number, VirtualRow>()
        for (const row of rows) rowByMessageIndex.set(row.index, row)
        cacheRef.current = { messages, rows, rowByMessageIndex, unboundedActivityBodies }
        return rows
      }
    }

    const rows = projectRows(messages, runBoundaryIds, unboundedActivityBodies)
    const rowByMessageIndex = new Map<number, VirtualRow>()
    for (const row of rows) rowByMessageIndex.set(row.index, row)
    cacheRef.current = { messages, rows, rowByMessageIndex, unboundedActivityBodies }
    return rows
  }, [messages, runBoundaryIds])
}

function offsetGroupedRanges(
  ranges: readonly TranscriptGroupedMessageRange[],
  offset: number
): TranscriptGroupedMessageRange[] {
  if (offset === 0) return ranges as TranscriptGroupedMessageRange[]
  return ranges.map((range) => ({
    message: range.message,
    startIndex: range.startIndex + offset,
    endIndex: range.endIndex + offset
  }))
}

function regroupStartFromChangedIndex(
  messages: readonly ChatMessage[],
  changedIndex: number,
  canJoin: (previous: ChatMessage, next: ChatMessage) => boolean
): number {
  if (messages.length === 0) return 0
  let start = Math.max(0, Math.min(changedIndex, messages.length - 1))
  while (start > 0 && canJoin(messages[start - 1], messages[start])) {
    start -= 1
  }
  return start
}

function useIncrementalMessageGrouping(
  messages: ChatMessage[],
  groupWithRanges: (messages: readonly ChatMessage[]) => TranscriptGroupedMessageRange[],
  regroupStart: (messages: readonly ChatMessage[], changedIndex: number) => number,
  resetKey = ''
): ChatMessage[] {
  const cacheRef = useRef<{
    input: ChatMessage[]
    ranges: TranscriptGroupedMessageRange[]
    output: ChatMessage[]
    resetKey: string
  } | null>(null)

  return useMemo(() => {
    const cached = cacheRef.current
    if (cached && cached.resetKey === resetKey) {
      const minLength = Math.min(cached.input.length, messages.length)
      let sharedPrefix = 0
      while (sharedPrefix < minLength && cached.input[sharedPrefix] === messages[sharedPrefix]) {
        sharedPrefix += 1
      }
      if (sharedPrefix === cached.input.length && sharedPrefix === messages.length) {
        return cached.output
      }

      let start = regroupStart(messages, sharedPrefix)
      let prefixRanges = cached.ranges.filter((range) => range.endIndex <= start)
      const coveredUntil =
        prefixRanges.length > 0 ? prefixRanges[prefixRanges.length - 1].endIndex : 0
      if (coveredUntil !== start) {
        start = 0
        prefixRanges = []
      }
      const suffixRanges = offsetGroupedRanges(groupWithRanges(messages.slice(start)), start)
      const ranges = [...prefixRanges, ...suffixRanges]
      const output = ranges.map((range) => range.message)
      cacheRef.current = { input: messages, ranges, output, resetKey }
      return output
    }

    const ranges = groupWithRanges(messages)
    const output = ranges.map((range) => range.message)
    cacheRef.current = { input: messages, ranges, output, resetKey }
    return output
  }, [groupWithRanges, messages, regroupStart, resetKey])
}

function useFanoutLaneMessageGrouping(messages: ChatMessage[]): ChatMessage[] {
  const cacheRef = useRef<FanoutLaneGroupingState | null>(null)
  return useMemo(() => {
    const next = groupFanoutLaneMessagesStable(messages, cacheRef.current)
    cacheRef.current = next
    return next.output
  }, [messages])
}

const toolGroupingRegroupStart = (
  messages: readonly ChatMessage[],
  changedIndex: number
): number =>
  regroupStartFromChangedIndex(messages, changedIndex, (previous, next) =>
    shouldGroupAdjacentToolMessages(previous, next)
  )

function ensembleRoundGroupingKey(message: ChatMessage): string | null {
  const value = message.metadata?.ensembleRoundId
  return typeof value === 'string' && value.length > 0 ? value : null
}

const roundCardGroupingRegroupStart = (
  messages: readonly ChatMessage[],
  changedIndex: number
): number =>
  regroupStartFromChangedIndex(messages, changedIndex, (previous, next) => {
    const key = ensembleRoundGroupingKey(next)
    return Boolean(key && key === ensembleRoundGroupingKey(previous))
  })

function booleanMapSignature(map: ReadonlyMap<string, boolean>): string {
  if (map.size === 0) return ''
  return Array.from(map.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${key}:${value ? 1 : 0}`)
    .join('\u0000')
}

type EnsembleActiveRound = NonNullable<NonNullable<ChatRecord['ensemble']>['activeRound']>
type EnsembleRoundSummaries = NonNullable<NonNullable<ChatRecord['ensemble']>['roundSummaries']>

function ensembleActiveRoundProjectionKey(round: EnsembleActiveRound | null | undefined): string {
  if (!round) return ''
  return [round.roundId || '', isEnsembleRoundDispatchLive(round) ? 'live' : 'settled'].join(
    '\u0000'
  )
}

function ensembleRoundSummariesSignature(
  summaries: EnsembleRoundSummaries | null | undefined
): string {
  if (!summaries) return ''
  return Object.keys(summaries)
    .sort()
    .map((roundId) => {
      const summary = summaries[roundId]?.summary
      return `${roundId}:${typeof summary === 'string' ? summary : ''}`
    })
    .join('\u0000')
}

function ensembleFanoutRunProjectionKey(runs: readonly ChatRun[] | null | undefined): string {
  if (!runs) return ''
  return runs
    .filter((run) => typeof run.ensembleRoundId === 'string' && run.ensembleRoundId.length > 0)
    .map((run) =>
      [
        run.runId,
        run.ensembleRoundId || '',
        run.ensembleLaneId || '',
        run.startedAt || '',
        run.status || '',
        run.endedAt || '',
        run.cancelled ? 'cancelled' : ''
      ].join(':')
    )
    .join('\u0000')
}

function formatTranscriptMessageFooterTime(timestamp: string | undefined): {
  dateTime: string
  label: string
  title: string
} | null {
  const raw = typeof timestamp === 'string' ? timestamp.trim() : ''
  if (!raw) return null
  const date = new Date(raw)
  if (!Number.isFinite(date.getTime())) return null

  return {
    dateTime: raw,
    label: formatTranscriptClock(date) ?? date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
    title: date.toLocaleString([], {
      dateStyle: 'medium',
      timeStyle: 'medium'
    })
  }
}

function workingStatusLabel(presentation: WorkingIndicatorPresentation): string {
  const activity =
    presentation.activity === 'compacting' ? 'compacting context' : 'working'
  return presentation.roleLabel
    ? `${presentation.roleLabel} (${presentation.providerLabel || 'Agent'}) ${activity}`
    : `${presentation.providerLabel || 'Agent'} ${activity}`
}

function workingIndicatorLabel(presentation: WorkingIndicatorPresentation): string {
  return presentation.activity === 'compacting' ? 'Compacting' : 'Working'
}

function workingIndicatorKey(
  presentation: WorkingIndicatorPresentation,
  index: number
): string {
  return [
    presentation.participantId || '',
    presentation.runId || '',
    presentation.startedAt || '',
    presentation.providerClass || presentation.provider || 'agent',
    presentation.roleLabel || '',
    presentation.modelBadge || '',
    index
  ].join(':')
}

function workingAccentStyle(presentation: WorkingIndicatorPresentation): CSSProperties | undefined {
  const providerClass = (presentation.providerClass || presentation.provider || '').replace(
    /[^a-z0-9-]/gi,
    ''
  )
  if (!providerClass) return undefined
  return {
    '--message-working-accent': `var(--provider-${providerClass}-color, var(--accent))`
  } as CSSProperties
}

function fileChangeOwnerLabel(owner: DiffFileSummaryOwner): string {
  if (owner.role) return owner.role
  if (owner.provider) return getProviderLabel(owner.provider)
  return 'Agent'
}

function fileChangeOwnerTitle(owner: DiffFileSummaryOwner, order?: number): string {
  const provider = owner.provider ? getProviderLabel(owner.provider) : ''
  const role = owner.role || ''
  const label = provider && role ? `${provider} / ${role}` : role || provider || 'Agent'
  return order ? `#${order} ${label}` : label
}

function normalizeFileChangeOwners(
  owners: DiffFileSummary['owners'] | undefined
): DiffFileSummaryOwner[] {
  if (!Array.isArray(owners)) return []
  return owners.filter((owner) => owner && (owner.provider || owner.participantId || owner.role))
}

function FileChangeOwnerCell({ owners }: { owners?: DiffFileSummary['owners'] }): ReactElement {
  const normalizedOwners = normalizeFileChangeOwners(owners)
  if (normalizedOwners.length === 0) {
    return <span className="file-change-summary-owner is-empty" aria-hidden="true" />
  }
  if (normalizedOwners.length === 1) {
    const owner = normalizedOwners[0]
    return (
      <span className="file-change-summary-owner" title={fileChangeOwnerTitle(owner)}>
        {owner.provider && (
          <span className={`file-change-summary-owner-icon provider-${owner.provider}`} aria-hidden>
            <ProviderBrandLogo provider={owner.provider} />
          </span>
        )}
        <span className="file-change-summary-owner-label">{fileChangeOwnerLabel(owner)}</span>
      </span>
    )
  }
  return (
    <span className="file-change-summary-owner is-multiple" aria-label="File editors">
      {normalizedOwners.map((owner, index) => {
        const order = owner.order ?? index + 1
        return (
          <span
            className="file-change-summary-owner-chip"
            key={`${owner.participantId || owner.provider || owner.role || 'owner'}-${index}`}
            title={fileChangeOwnerTitle(owner, order)}
          >
            {owner.provider && (
              <span className={`file-change-summary-owner-icon provider-${owner.provider}`} aria-hidden>
                <ProviderBrandLogo provider={owner.provider} />
              </span>
            )}
            <span className="file-change-summary-owner-index">#{order}</span>
          </span>
        )
      })}
    </span>
  )
}

const FILE_CHANGE_PATH_LABEL_MAX = 44

function truncateFilePathFromHead(path: string): string {
  if (path.length <= FILE_CHANGE_PATH_LABEL_MAX) return path
  return `...${path.slice(-(FILE_CHANGE_PATH_LABEL_MAX - 3))}`
}

function filePathTailSegments(path: string): string {
  const raw = typeof path === 'string' ? path : ''
  if (!raw) return ''
  const normalized = raw.replace(/\\/g, '/')
  const segments = normalized.split('/').filter(Boolean)
  if (segments.length <= 2) return truncateFilePathFromHead(raw)
  return truncateFilePathFromHead(`.../${segments.slice(-2).join('/')}`)
}

function FileChangePathCell({ path }: { path: string }): ReactElement {
  return (
    <span className="file-change-summary-path" title={path}>
      <span className="file-change-summary-path-head" aria-hidden="true">
        {path}
      </span>
      <span className="file-change-summary-path-tail">{filePathTailSegments(path)}</span>
    </span>
  )
}

function TranscriptMessageFooter({
  message,
  label,
  copyContent,
  align,
  onCopyMessage,
  onAddMessageToPrompt,
  onTogglePinMessage,
  onMessageFeedback,
  onDeleteMessage,
  onOpenSideChatFromMessage,
  pinned,
  copied
}: {
  message: ChatMessage
  label: string
  copyContent?: string
  align: 'start' | 'end'
  onCopyMessage: (messageId: string, content: string) => void
  onAddMessageToPrompt?: (messageId: string, content: string) => void
  onTogglePinMessage?: (messageId: string) => void
  onMessageFeedback?: (messageId: string, vote: 'up' | 'down', details?: MessageFeedbackDetails) => void
  onDeleteMessage?: (messageId: string) => void
  onOpenSideChatFromMessage?: (message: ChatMessage) => void
  pinned: boolean
  copied: boolean
}): React.JSX.Element | null {
  const timestamp = formatTranscriptMessageFooterTime(message.timestamp)
  const hasActionContent = copyContent !== undefined
  const canOpenSideChatFromMessage =
    Boolean(onOpenSideChatFromMessage) && message.metadata?.kind !== 'channelInbound'
  // Thumbs feedback is an ASSISTANT-only signal (rate what the agent produced,
  // never the user's own turn or a channel-inbound relay).
  const canRateMessage =
    Boolean(onMessageFeedback) &&
    message.role === 'assistant' &&
    message.metadata?.kind !== 'channelInbound'
  const thumbsVote = readMessageFeedbackVote(message)

  if (!timestamp && !hasActionContent) return null

  return (
    <div className={`message-footer message-footer-${align}`}>
      {hasActionContent && (
        <MessageActionsChip
          onCopy={() => onCopyMessage(message.id, copyContent)}
          onAddToPrompt={
            onAddMessageToPrompt && copyContent.trim()
              ? () => onAddMessageToPrompt(message.id, copyContent)
              : undefined
          }
          onTogglePin={onTogglePinMessage ? () => onTogglePinMessage(message.id) : undefined}
          onThumbsUp={
            canRateMessage && onMessageFeedback
              ? () => onMessageFeedback(message.id, 'up')
              : undefined
          }
          onThumbsDown={
            canRateMessage && onMessageFeedback
              ? () => onMessageFeedback(message.id, 'down')
              : undefined
          }
          onDelete={onDeleteMessage ? () => onDeleteMessage(message.id) : undefined}
          onOpenSideChat={
            canOpenSideChatFromMessage ? () => onOpenSideChatFromMessage?.(message) : undefined
          }
          pinned={pinned}
          thumbsVote={thumbsVote}
          copied={copied}
          label={label}
        />
      )}
      {timestamp && (
        <time
          className="message-footer-time"
          dateTime={timestamp.dateTime}
          title={timestamp.title}
        >
          {timestamp.label}
        </time>
      )}
    </div>
  )
}

/**
 * 1.0.6-TV1 — In-house transcript windowing glue (renderer side).
 *
 * Pure window math lives in `lib/TranscriptVirtualWindow.ts`; this hook
 * is the thin React/DOM layer that drives it inside `TranscriptPanel`.
 * It mounts only the visible band + overscan and collapses everything
 * else into a top/bottom spacer, so render work + DOM node count stop
 * scaling with total chat length.
 *
 * Coexistence with the hardened scroll machinery in `App` (`autoFollowRef`
 * + the four rAF re-pin sites + `lib/TranscriptScroll` predicates):
 *
 *   - The scroll container, its refs, `scrollHeight`, and every re-pin
 *     site are untouched. Spacers + mounted rows always sum to the real
 *     content height, so `scrollTop = scrollHeight` still means "true
 *     bottom" and every predicate keeps working byte-for-byte.
 *   - When auto-follow is engaged (streaming / pinned at the bottom) the
 *     window is forced to the END (effective scrollTop = totalHeight −
 *     viewport) so the last row is always mounted and `bottomSpacerPx`
 *     is 0. The bottom path behaves exactly as the non-virtualised
 *     transcript and the chat-switch snap never lands on a blank spacer.
 *   - The single imperative scroll write is the pre-paint anchor
 *     correction, gated to `!autoFollow`: it pins the row under the
 *     viewport top across height changes so content above the viewport
 *     mounting/measuring never makes the visible content jump.
 *
 * It attaches a deliberately READ-ONLY passive scroll listener to the
 * scroller (a documented, intentional deviation from "no second scroll
 * listener"): it never writes `scrollTop`, never touches `autoFollowRef`,
 * and schedules no re-pin — it only rAF-coalesces a window-recompute tick
 * and captures the scroll anchor, so it cannot perturb the auto-follow /
 * re-pin coalescing. Row growth is measured with a shared `ResizeObserver`
 * on individual blocks (NOT the scroll container — a block's rect is
 * independent of the ancestor `scrollTop`, per `TranscriptScroll.ts`), so
 * the historical observer-feedback loop cannot return.
 */
/* eslint-disable react-hooks/refs -- Virtualisation intentionally keeps scroll/measurement state in refs for synchronous window selection. */
function useTranscriptVirtualization(params: {
  enabled: boolean
  rows: VirtualRow[]
  scrollRef: React.RefObject<HTMLDivElement | null>
  /**
   * 1.0.7 — the `.transcript-inner` element (capped at
   * --composer-content-max-width). Width is bucketed off THIS, not the scroll
   * container, so a scrollbar appear/disappear (which changes the scroller's
   * clientWidth but not the capped inner's) can't flip the width bucket and
   * invalidate the measurement cache. Falls back to the scroller when absent.
   */
  contentRef?: React.RefObject<HTMLDivElement | null>
  chatId?: string | null
  autoFollowRef?: React.MutableRefObject<boolean>
  onProgrammaticScrollWrite?: (landedScrollTop: number) => void
  compactDensity: boolean
  forcedRowIndex?: number | null
  activeLiveRowKey?: string | null
  /**
   * 1.0.6-TV2 — row ids whose tool stack currently has something
   * expanded. Folded into the measurement-cache key (the geometry bit)
   * so a collapsed vs expanded row caches distinct heights, and into
   * the live height lookup so toggling re-flows the spacers.
   */
  expandedRowIds?: ReadonlySet<string>
  /**
   * RowKeys rendering as EMPTY zero-space blocks (collapsed super-group
   * members). Their height is pinned to 0 here because the measure pass
   * cannot learn it: a non-positive offsetTop delta is skipped by design,
   * so these rows would otherwise sit on their type estimates forever and
   * desync the spacers from real layout.
   */
  hiddenRowKeys?: ReadonlySet<string>
}): {
  window: VirtualWindow
  blockRef: (el: HTMLDivElement | null) => void
  spacerBottomRef: React.RefObject<HTMLDivElement | null>
  heights: readonly number[]
  syncScrollPosition: (scrollTop: number) => void
  /**
   * Scroll-spy: the virtual-row index the reading line (top-third of the
   * viewport) currently sits on, derived from the SAME `effectiveScrollTop` +
   * held `windowHeights` that drive the window — a pure read, never a scroll
   * write. Null on the non-virtualised path. Consumers map it to a user-message
   * marker via `findActiveGutterMarkerKey`.
   */
  spyRowIndex: number | null
  /** Scroll-progress fraction (0..1) for the rail's read-position fill. */
  spyProgress: number
  /**
   * Fraction (0..1) of the transcript's total content height currently visible
   * in the viewport — sizes the rail's skeuomorphic "reading lens" carriage.
   * 1 when everything fits (lens hidden), 0 on the non-virtualised path.
   */
  spyViewportFraction: number
} {
  const {
    enabled,
    rows,
    scrollRef,
    contentRef,
    chatId,
    autoFollowRef,
    onProgrammaticScrollWrite,
    compactDensity,
    forcedRowIndex,
    activeLiveRowKey,
    expandedRowIds,
    hiddenRowKeys
  } = params

  const measurementsRef = useRef<Map<string, number>>(new Map())
  /** Last measured height per rowKey|bucket|expanded — the content-version-miss
   * fallback (see getRowHeight). Cleared with measurementsRef. */
  const geometryHeightsRef = useRef<Map<string, number>>(new Map())
  const scrollTopRef = useRef(0)
  const viewportRef = useRef(0)
  const bucketRef = useRef(0)
  const heightsRef = useRef<number[]>(EMPTY_TRANSCRIPT_HEIGHTS)
  const heightOffsetsRef = useRef<number[]>(EMPTY_TRANSCRIPT_HEIGHT_OFFSETS)
  const rowsRef = useRef<VirtualRow[]>(rows)
  const measurementChatIdRef = useRef<string | null | undefined>(chatId)
  // The row the viewport is anchored to + the total height ABOVE it as of the
  // last layout pass, PLUS the sub-row offset of the viewport top within that
  // row. The pre-paint correction restores scrollTop ABSOLUTELY to
  // Σ(heights before anchor) + offsetWithin (never a relative += delta) so it
  // is self-correcting and cannot accumulate as rows above hydrate. The old
  // relative form sampled "height above" at scroll-time (estimates) vs
  // post-measure (measured), so the delta was structurally non-zero while rows
  // above were still hydrating — the scroll-up-bumps-down / scroll-down-jumps-up
  // fight. An absolute target lands the viewport exactly where the anchor row
  // stays fixed, whether rows above resolved taller or shorter than estimate.
  const anchorRef = useRef<{ rowKey: string; aboveHeight: number; offsetWithin: number } | null>(
    null
  )
  const blockElsRef = useRef<Map<string, HTMLDivElement>>(new Map())
  const spacerBottomRef = useRef<HTMLDivElement>(null)
  const observerRef = useRef<ResizeObserver | null>(null)
  const measureRafRef = useRef<number | null>(null)
  const scrollRafRef = useRef<number | null>(null)
  // 1.0.7 — convergence guard for the pre-paint measurement effect. Counts
  // consecutive passes that only REWROTE existing measurement keys (no new
  // keys). A row whose measured height oscillates between two values for the
  // same key — seen mid-chat in Ensemble (concurrent participant streams +
  // scrollbar/sub-pixel reflow) — would otherwise bump setState on every
  // synchronous pass forever and trip React's nested-update limit, crashing
  // the transcript surface. `measureWarnedRef` makes the diagnostic one-shot
  // per oscillation episode. See lib/transcriptMeasureConvergence.ts.
  const measureRewritePassesRef = useRef(0)
  const measureWarnedRef = useRef(false)
  // 1.0.7 — set true immediately before the anchor correction writes
  // `scroller.scrollTop`, so the passive scroll listener can recognise that
  // scroll event as our OWN write and skip re-baselining the anchor / bumping.
  // Without this the programmatic write re-enters the listener → re-baseline
  // from a mid-convergence heights snapshot → non-zero delta → another write,
  // which is the async (~50ms) leg of the ensemble flicker loop.
  const anchorWriteRef = useRef(false)
  // 1.0.7 — true when the PREVIOUS pre-paint pass fully converged (no new key,
  // no rewrite). The Phase-1 anchor correction only runs when this is true, so
  // it never restores scrollTop while heights are still settling (which would
  // jitter the viewport every frame and evict the just-mounted big rows). It
  // waits for measurement to finish, then restores the anchor absolutely, once.
  const measureConvergedRef = useRef(true)
  // Flips true the first time the scroller reports a real scroll position
  // (the chat-switch snap-to-bottom counts). Before that, `scrollTopRef`
  // is still 0, so we force the bottom window to avoid flashing the top;
  // after it, the window tracks the actual scroll position so scroll-up
  // loads older rows.
  const hasScrolledRef = useRef(false)
  const skipNextAnchorCorrectionRef = useRef(false)

  // Re-render signals. State (not refs) so a change forces a recompute;
  // the heavy work is gone (only the small window mounts) so a per-frame
  // recompute is cheap.
  const [scrollTick, setScrollTick] = useState(0)
  const [measureTick, setMeasureTick] = useState(0)
  const bumpScroll = useCallback(() => setScrollTick((t) => (t + 1) % 0x7fffffff), [])
  const bumpMeasure = useCallback(() => setMeasureTick((t) => (t + 1) % 0x7fffffff), [])
  useEffect(() => {
    if (measurementChatIdRef.current === chatId) return
    measurementChatIdRef.current = chatId
    measurementsRef.current.clear()
    geometryHeightsRef.current.clear()
    blockElsRef.current.clear()
    anchorRef.current = null
    hasScrolledRef.current = false
    bumpMeasure()
    bumpScroll()
  }, [bumpMeasure, bumpScroll, chatId])
  const syncScrollPosition = useCallback(
    (nextScrollTop: number): void => {
      if (!enabled) return
      const scroller = scrollRef.current
      const scrollTop = Number.isFinite(nextScrollTop) ? Math.max(0, nextScrollTop) : 0
      scrollTopRef.current = scrollTop
      if (scroller) {
        viewportRef.current = scroller.clientHeight
        const widthEl = contentRef?.current ?? scroller
        bucketRef.current = widthBucket(widthEl.clientWidth)
      }
      hasScrolledRef.current = true
      anchorRef.current = null
      skipNextAnchorCorrectionRef.current = true
      bumpScroll()
    },
    [bumpScroll, contentRef, enabled, scrollRef]
  )

  // Slot heights (measured-or-estimated, gap folded in). Recomputed only
  // when the rows change or a measurement/bucket/density signal fires —
  // never on plain scroll, so scrolling stays allocation-light.
  const heights = useMemo(() => {
    if (!enabled) return EMPTY_TRANSCRIPT_HEIGHTS
    const m = measurementsRef.current
    const bucket = bucketRef.current
    return rows.map((row) =>
      hiddenRowKeys?.has(row.rowKey)
        ? 0
        : getRowHeight(
            row,
            m,
            bucket,
            expandedRowIds?.has(row.rowKey) ?? false,
            measurementContentVersion(row, activeLiveRowKey),
            geometryHeightsRef.current
          )
    )
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, rows, measureTick, expandedRowIds, activeLiveRowKey, hiddenRowKeys])
  heightsRef.current = heights
  const heightOffsets = useMemo(
    () => (enabled ? buildHeightOffsets(heights) : EMPTY_TRANSCRIPT_HEIGHT_OFFSETS),
    [enabled, heights]
  )
  heightOffsetsRef.current = heightOffsets
  rowsRef.current = rows

  // Window selection. Inline (not memoised) because it reads scroll refs;
  // it re-runs on every tick, which is cheap.
  //
  // Drive the window from the REAL browser scroll position. The App
  // scroll machinery keeps `scrollTop` pinned to the bottom while
  // auto-following / streaming, so reading the live position mounts the
  // bottom window in that case AND follows the user when they scroll up.
  // We must NOT force the bottom from the `autoFollow` flag: if it failed
  // to disengage (or re-engaged), the window stayed welded to the bottom
  // and scroll-up only revealed the empty top spacer — the reported bug.
  // The bottom is forced ONLY for the first frames after a chat loads,
  // before the snap-to-bottom has run and `scrollTopRef` still reads 0.
  const totalHeight = enabled ? totalHeightFromOffsets(heightOffsets) : 0
  const forceBottomOnLoad = Boolean(autoFollowRef?.current) && !hasScrolledRef.current
  const effectiveScrollTop = forceBottomOnLoad
    ? Math.max(0, totalHeight - viewportRef.current)
    : scrollTopRef.current
  // 1.0.7 — window selection from a STABLE heights snapshot. This is the core
  // fix for the ensemble virtualization oscillation. Previously the window was
  // selected from live `heights`, which recompute on every `measureTick` — so
  // the instant a mounted row reported its real (large) height, the window
  // re-selected a smaller span, dropped that very row, re-measured, and limit-
  // cycled (the ~50ms flicker that settled on the short System rows). The
  // mounted set must NOT be an input to the computation that re-picks it.
  //
  // `windowHeights` is refreshed on scroll/resize (`scrollTick`) and on row-set
  // / expansion changes, but is HELD across a pure measurement bump. Within a
  // frame the window is fixed; Phase-2 measures exactly that window's rows and
  // writes the cache; live `heights` still feed the spacers + anchor so total
  // height and the bottom-pin invariant stay exact. The next genuine scroll
  // then re-selects ONCE from now-measured heights and lands correctly. The
  // 900px overscan absorbs the estimate error during the single settle frame.
  // Standard virtualiser hysteresis: select on scroll, measure within the
  // selection, never let measurement re-trigger selection.
  const windowHeights = useMemo(
    () => heights,
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [enabled, rows, expandedRowIds, activeLiveRowKey, scrollTick] // deliberately NOT measureTick
  )
  const windowHeightOffsets = useMemo(
    () => (enabled ? buildHeightOffsets(windowHeights) : EMPTY_TRANSCRIPT_HEIGHT_OFFSETS),
    [enabled, windowHeights]
  )
  const virtualWindow: VirtualWindow = enabled
    ? selectWindow({
        scrollTop: effectiveScrollTop,
        viewportHeight: viewportRef.current,
        heights: windowHeights,
        heightOffsets: windowHeightOffsets,
        overscanPx: DEFAULT_OVERSCAN_PX,
        forceIndex: forcedRowIndex
      })
    : { startIndex: 0, endIndex: rows.length, topSpacerPx: 0, bottomSpacerPx: 0 }

  // Scroll-spy anchor (reading position). Same inputs as the window — the held
  // `windowHeights` snapshot + `effectiveScrollTop` — so it recomputes on scroll
  // (scrollTick) but is HELD across a pure measurement bump, sharing the window's
  // anti-flicker hysteresis. The reference line is the top-third of the viewport
  // (the common scroll-spy `-30% / -70%` convention) so a turn reads "current"
  // once it's comfortably into the reading pane, not at the literal top pixel.
  // Pure arithmetic over the FULL heights array (covers off-window rows that
  // virtualisation has unmounted) — never a scroll write, never touches
  // autoFollowRef. During `forceBottomOnLoad` `effectiveScrollTop` is the synthetic
  // bottom, so it resolves to the latest turn (never flashes the first message).
  const spyRowIndex =
    enabled && windowHeights.length > 0
      ? findScrollAnchor(
          effectiveScrollTop + viewportRef.current * 0.3,
          windowHeights,
          windowHeightOffsets
        ).index
      : null

  // Scroll-progress fraction (0..1) for the rail's read-position fill. The rail
  // is body-portaled (position:fixed, NOT a descendant of the scroller), so a CSS
  // `scroll()` timeline can't bind to the transcript — we derive the fraction here
  // from the same held snapshot and hand it to the gutter as a plain number. 0
  // when nothing scrolls (short chats), which reads better than a full bar.
  const spyMaxScroll = enabled ? Math.max(0, totalHeight - viewportRef.current) : 0
  const spyProgress =
    spyMaxScroll > 0 ? Math.max(0, Math.min(1, effectiveScrollTop / spyMaxScroll)) : 0

  // Visible-content fraction for the rail's reading lens: viewport ÷ total
  // content height, from the same held snapshot as spyProgress. 1 (not 0) when
  // the whole transcript fits, so the lens layout can distinguish "everything
  // visible → hide lens" from "unmeasured → hide lens" with one code path.
  const spyViewportFraction =
    enabled && totalHeight > 0
      ? Math.max(0, Math.min(1, viewportRef.current / totalHeight))
      : 0

  // Read-only passive scroll + resize listener: refresh metrics, capture
  // the anchor, and request a window recompute. Never writes scrollTop.
  useEffect(() => {
    if (!enabled) return
    const scroller = scrollRef.current
    if (!scroller) return
    const readMetricsInto = (el: HTMLDivElement): boolean => {
      scrollTopRef.current = el.scrollTop
      viewportRef.current = el.clientHeight
      // 1.0.7 — bucket width off the capped `.transcript-inner` (contentRef),
      // not the scroll container: a scrollbar appear/disappear changes the
      // scroller's clientWidth but not the inner's, so this can't flip the
      // bucket and invalidate the whole measurement cache. Fall back to the
      // scroller when contentRef hasn't mounted yet.
      const widthEl = contentRef?.current ?? el
      const nextBucket = widthBucket(widthEl.clientWidth)
      const bucketChanged = nextBucket !== bucketRef.current
      bucketRef.current = nextBucket
      return bucketChanged
    }
    readMetricsInto(scroller)
    bumpScroll()

    const refresh = (): void => {
      if (scrollRafRef.current !== null) return
      scrollRafRef.current = requestAnimationFrame(() => {
        scrollRafRef.current = null
        const el = scrollRef.current
        if (!el) return
        // 1.0.7 — if this scroll event is the anchor correction's OWN
        // `scrollTop +=` write, re-read metrics but DON'T re-baseline the
        // anchor or bump. Re-baselining here from a mid-convergence heights
        // snapshot is what produced a fresh non-zero delta every pass → another
        // write → the async oscillation. Consuming the flag makes the anchor
        // correction one-shot: the baseline only moves on real user scrolls.
        if (anchorWriteRef.current) {
          anchorWriteRef.current = false
          readMetricsInto(el)
          return
        }
        // The scroller has reported a real position (incl. the
        // snap-to-bottom): from here the window tracks the live scrollTop.
        hasScrolledRef.current = true
        const bucketChanged = readMetricsInto(el)
        // Re-baseline the anchor at the new scroll position. Capturing the
        // height-above HERE (not in the layout effect) is what makes the
        // correction compose with scroll: a scroll-driven render then sees
        // a zero delta, so it never fights the user; only a genuine height
        // change above the anchor produces a non-zero nudge.
        const a = findScrollAnchor(
          scrollTopRef.current,
          heightsRef.current,
          heightOffsetsRef.current
        )
        const anchorRow = rowsRef.current[a.index]
        anchorRef.current = anchorRow
          ? {
              rowKey: anchorRow.rowKey,
              aboveHeight: sumHeightOffsets(heightOffsetsRef.current, 0, a.index),
              offsetWithin: a.offsetWithin
            }
          : null
        if (bucketChanged) bumpMeasure()
        bumpScroll()
      })
    }
    scroller.addEventListener('scroll', refresh, { passive: true })
    window.addEventListener('resize', refresh)
    return () => {
      scroller.removeEventListener('scroll', refresh)
      window.removeEventListener('resize', refresh)
      if (scrollRafRef.current !== null) {
        cancelAnimationFrame(scrollRafRef.current)
        scrollRafRef.current = null
      }
    }
  }, [enabled, scrollRef, bumpScroll, bumpMeasure])

  // Shared ResizeObserver on individual mounted blocks → re-measure on
  // async growth (CodeMirror, ActivityStack output reveal, image load).
  useEffect(() => {
    if (!enabled) return
    if (typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(() => {
      if (measureRafRef.current !== null) return
      measureRafRef.current = requestAnimationFrame(() => {
        measureRafRef.current = null
        bumpMeasure()
      })
    })
    observerRef.current = ro
    for (const el of blockElsRef.current.values()) {
      if (el.isConnected) ro.observe(el)
    }
    return () => {
      ro.disconnect()
      observerRef.current = null
      if (measureRafRef.current !== null) {
        cancelAnimationFrame(measureRafRef.current)
        measureRafRef.current = null
      }
    }
  }, [enabled, bumpMeasure])

  // Density change alters --space-lg (the row gap baked into slot
  // heights), so every cached measurement is stale — clear + re-measure.
  useEffect(() => {
    if (!enabled) return
    measurementsRef.current.clear()
    geometryHeightsRef.current.clear()
    const frame = window.requestAnimationFrame(() => bumpMeasure())
    return () => window.cancelAnimationFrame(frame)
  }, [enabled, compactDensity, bumpMeasure])

  // Pre-paint: anchor correction (Phase 1) + slot measurement (Phase 2).
  // No dependency array — runs after every commit; both phases are cheap
  // and converge (only fire `bumpMeasure` when a height actually moved).
  useLayoutEffect(() => {
    if (!enabled) return
    const scroller = scrollRef.current
    if (!scroller) return

    // Phase 1 — keep the anchored row visually fixed when rows ABOVE it change
    // height (estimate→measured, late-mount growth). ABSOLUTE restore: target
    // scrollTop = Σ(heights before anchor) + offsetWithin, recomputed from the
    // CURRENT heights every pass. Unlike the old relative `+= delta` (whose two
    // height samples came from different estimate-vs-measured snapshots and so
    // never zeroed while rows above hydrated — the scroll-up-bumps-down and
    // scroll-down-jumps-up fight), an absolute target is self-correcting and
    // cannot accumulate: it lands the viewport exactly where the anchor row
    // stays fixed regardless of whether rows above resolved taller or shorter.
    //
    // GATED on prior-pass convergence: while measurement is still settling we
    // leave scrollTop alone (a restore mid-settle would jitter the viewport and
    // evict the just-mounted big rows); once Phase 2 reports a converged pass we
    // restore ONCE from settled heights. Also gated on a real "not at the
    // bottom" DOM measure — with a 24px dead-band so scrollHeight growth near
    // the bottom can't flap the correction on/off — rather than the autoFollow
    // flag, so it runs whenever the user has scrolled up and is skipped at the
    // bottom where the App machinery owns scrollTop.
    const distanceFromBottom = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight
    const atBottom = distanceFromBottom <= 24
    const skipAnchorCorrection = skipNextAnchorCorrectionRef.current
    skipNextAnchorCorrectionRef.current = false
    if (!skipAnchorCorrection && measureConvergedRef.current && !atBottom && anchorRef.current) {
      const anchor = anchorRef.current
      const idx = rowsRef.current.findIndex((r) => r.rowKey === anchor.rowKey)
      if (idx >= 0) {
        const aboveHeight = sumHeightOffsets(heightOffsetsRef.current, 0, idx)
        const target = Math.max(0, aboveHeight + anchor.offsetWithin)
        if (Math.abs(target - scroller.scrollTop) > 0.5) {
          // 1.0.7 — flag the programmatic write so the passive scroll listener
          // recognises the resulting scroll event as our own and skips the
          // re-baseline/bump (Fix 4), keeping the restore one-shot.
          anchorWriteRef.current = true
          // Arm the PARENT scroll evaluator BEFORE the write — setting
          // `scrollTop` dispatches a synchronous scroll event, and without a
          // pre-arm the App-level auto-follow listener can hit the 2px engage
          // band (movedDown, no gesture) and re-lock follow before the guard
          // exists. Refresh after the write with the browser-clamped landed
          // position so overshoot-to-bottom remains matched.
          onProgrammaticScrollWrite?.(target)
          scroller.scrollTop = target
          onProgrammaticScrollWrite?.(scroller.scrollTop)
        }
        anchor.aboveHeight = aboveHeight
      }
    }

    // Phase 2 — measure mounted slot heights via offsetTop deltas (which
    // include the row gap), keyed by `measurementKey`. Request one more
    // pass when something moved; converges once stable.
    const measurements = measurementsRef.current
    const bucket = bucketRef.current
    const mountedRows = rowsRef.current.slice(virtualWindow.startIndex, virtualWindow.endIndex)
    const spacerBottom = spacerBottomRef.current
    for (const [rowKey, el] of blockElsRef.current) {
      if (el.isConnected) continue
      observerRef.current?.unobserve(el)
      blockElsRef.current.delete(rowKey)
    }
    let sawNewKey = false
    let sawRewrite = false
    let sawLiveGrowth = false
    for (let i = 0; i < mountedRows.length; i++) {
      const row = mountedRows[i]
      // 1.0.7 — element + measurement maps key on `rowKey` (`${id}#${index}`),
      // NOT the bare message id. Historical/imported data can carry duplicate
      // message ids; keying on id alone collapsed those rows to one element +
      // one measurement slot, scrambling heights + order (the load/unload,
      // System-rows-pinned-to-top bug). `rowKey` is unique per list position.
      const el = blockElsRef.current.get(row.rowKey)
      if (!el || !el.isConnected) continue
      const nextEl =
        i + 1 < mountedRows.length
          ? blockElsRef.current.get(mountedRows[i + 1].rowKey)
          : spacerBottom
      const slot = nextEl && nextEl.isConnected ? nextEl.offsetTop - el.offsetTop : el.offsetHeight
      if (!(slot > 0)) continue
      const isActiveLiveRow = activeLiveRowKey === row.rowKey
      const key = measurementKey(
        row.rowKey,
        measurementContentVersion(row, activeLiveRowKey),
        bucket,
        expandedRowIds?.has(row.rowKey) ?? false
      )
      geometryHeightsRef.current.set(
        geometryKey(row.rowKey, bucket, expandedRowIds?.has(row.rowKey) ?? false),
        slot
      )
      const prev = measurements.get(key)
      if (prev === undefined) {
        measurements.set(key, slot)
        sawNewKey = true
      } else if (Math.abs(prev - slot) > 0.5) {
        const nextSlot = isActiveLiveRow ? Math.max(prev, slot) : slot
        if (Math.abs(prev - nextSlot) > 0.5) {
          measurements.set(key, nextSlot)
          if (isActiveLiveRow && nextSlot > prev) {
            sawLiveGrowth = true
          } else {
            sawRewrite = true
          }
        }
      }
    }
    // 1.0.7 — gate the re-measure bump through the convergence guard. A new key
    // (genuine content/growth) always converges and resets the budget; a run of
    // rewrite-only passes (oscillation) is capped so it can't spin React's
    // nested-update limit and crash the transcript surface.
    const decision = decideMeasurePass({
      sawNewKey: sawNewKey || sawLiveGrowth,
      sawRewrite,
      rewritePasses: measureRewritePassesRef.current,
      alreadyWarned: measureWarnedRef.current
    })
    measureRewritePassesRef.current = decision.nextRewritePasses
    measureWarnedRef.current = decision.nextAlreadyWarned
    // 1.0.7 — record whether THIS pass fully converged (nothing changed). The
    // next pre-paint pass's Phase-1 anchor restore reads this so it only fires
    // once heights have settled — never mid-measure.
    measureConvergedRef.current = !sawNewKey && !sawLiveGrowth && !sawRewrite
    if (decision.shouldWarn) {
      console.warn(
        '[transcript] measurement did not converge after ' +
          `${MAX_MEASURE_REWRITE_PASSES} passes; freezing heights to avoid a render loop. ` +
          'A mounted row height is likely oscillating (concurrent streams / scrollbar reflow).'
      )
    }
    if (decision.bump) bumpMeasure()
  })

  const blockRef = useCallback((el: HTMLDivElement | null) => {
    if (!el) return
    // `data-vrow-id` carries the collision-proof `rowKey` (`${id}#${index}`),
    // so `blockElsRef` is keyed by rowKey — duplicate message ids can't share
    // an element entry.
    const rowKey = el.dataset.vrowId
    if (!rowKey) return
    const previous = blockElsRef.current.get(rowKey)
    if (previous && previous !== el) observerRef.current?.unobserve(previous)
    blockElsRef.current.set(rowKey, el)
    observerRef.current?.observe(el)
  }, [])

  return {
    window: virtualWindow,
    blockRef,
    spacerBottomRef,
    heights,
    syncScrollPosition,
    spyRowIndex,
    spyProgress,
    spyViewportFraction
  }
}
/* eslint-enable react-hooks/refs */

function EnsemblePollCard({
  chat,
  pollId,
  onVote
}: {
  chat: ChatRecord | null
  pollId: string
  onVote?: (chatId: string, pollId: string, choice: string) => void
}): ReactElement | null {
  const poll = chat?.ensemble?.bossmanControlState?.polls?.find((entry) => entry.id === pollId)
  if (!chat || !poll) return null
  const userVote = poll.votes.find((vote) => vote.voterLabel === 'User')
  const canVote = poll.includeUser === true && poll.status === 'open' && !userVote
  const participantVotes = poll.votes.filter((vote) => vote.voterLabel !== 'User')
  return (
    <div className="plan-choice-card agent-question-card ensemble-poll-card">
      <div className="plan-choice-question agent-question-card-question">{poll.question}</div>
      {poll.timeoutAt && poll.status === 'open' && (
        <div className="agent-question-card-context">Open until {poll.timeoutAt}</div>
      )}
      {canVote ? (
        <div className="plan-choice-actions">
          {poll.options.map((option) => (
            <button
              key={option}
              type="button"
              className="plan-choice-action-btn"
              onClick={() => onVote?.(chat.appChatId, poll.id, option)}
              aria-label={`Vote: ${option}`}
            >
              {option}
            </button>
          ))}
        </div>
      ) : (
        <div className="agent-question-card-context">
          {userVote ? `Your vote: ${userVote.choice}` : `Poll ${poll.status}`}
        </div>
      )}
      {participantVotes.length > 0 && (
        <div className="agent-question-card-context">
          {participantVotes
            .map((vote) => `${vote.voterLabel || 'Participant'}: ${vote.choice}`)
            .join(' · ')}
        </div>
      )}
    </div>
  )
}

export const TranscriptPanel = memo(
  function TranscriptPanel({
    scrollRef,
    contentRef,
    endRef,
    messages,
    isWelcomeChat,
    isThinking,
    pendingPlanChoice,
    pendingProposedPlan,
    pendingAgentQuestions,
    contextCompactionProgress = [],
    onAgentQuestionSubmit,
    onAgentQuestionDismiss,
    onEnsemblePollVote,
    runCompleteNotice,
    runCompleteDurationText,
    currentChat,
    currentRun,
    currentWorkspacePath,
    currentProviderLabel,
    currentProvider,
    thinkingProviderLabel,
    thinkingProvider,
    thinkingProviderClass,
    thinkingModelBadge,
    displayFileChangeSummaries,
    roundFileChangeSummaries,
    fileChangeSummaryText,
    fileChangeShouldShowStats,
    fileChangeDisplayAdds,
    fileChangeDisplayDels,
    chats,
    runningChatIds,
    onPlanChoiceSubmit,
    onProposedPlanApprove,
    onProposedPlanDismiss,
    onProposedPlanCustom,
    onOpenSubThread,
    onOpenSubThreadInSidePanel,
    onOpenFileChangeInWorkbench,
    onInspectRun,
    onOpenSideChatFromRun,
    compactDensity,
    liveActivityViewport,
    onCopyMessage,
    onAddMessageToPrompt,
    onDeleteMessage,
    onTogglePinMessage,
    onMessageFeedback,
    onPromoteCollaboratorComment,
    onMessageSelectionCandidate,
    onOpenSideChatFromMessage,
    sideChatSeedMessageId,
    jumpToMessageRequest,
    externalRestoreAnchorMessageId,
    onManualTranscriptJump,
    onJumpToLatest,
    onPreviewImage,
    onDetachToPane,
    copiedId,
    copy,
    virtualize,
    autoFollowRef,
    onProgrammaticScrollWrite,
    showRunCompleteSummary,
    collapseOlderRounds,
    userMessageGutterEnabled,
    isGlobal
  }: TranscriptPanelProps) {
    const visibleMessages = useMemo(() => {
      if (isWelcomeChat) return EMPTY_CHAT_MESSAGES
      // Queued-run cards were removed from the transcript; drop any historical
      // `queuedRunRequest` system messages so they no longer surface.
      return messages.filter((message) => message?.metadata?.kind !== 'queuedRunRequest')
    }, [isWelcomeChat, messages])
    const hasLiveContextCompactionProgress = useMemo(
      () => contextCompactionProgress.some((event) => event.status === 'started'),
      [contextCompactionProgress]
    )
    const ensembleWorkingPresentation = useMemo(
      () => deriveActiveEnsembleWorkingPresentation(currentChat, contextCompactionProgress),
      [contextCompactionProgress, currentChat]
    )
    const ensembleWorkingPresentations = useMemo(
      () => deriveActiveEnsembleWorkingPresentations(currentChat, contextCompactionProgress),
      [contextCompactionProgress, currentChat]
    )
    const workingProviderLabel =
      ensembleWorkingPresentation?.providerLabel || thinkingProviderLabel || currentProviderLabel
    const workingProvider = ensembleWorkingPresentation?.provider ?? thinkingProvider
    const workingProviderClass =
      ensembleWorkingPresentation?.providerClass ?? thinkingProviderClass
    const workingRoleLabel = ensembleWorkingPresentation?.roleLabel || null
    const workingModelBadge =
      ensembleWorkingPresentation?.modelBadge ?? thinkingModelBadge ?? null
    const workingPresentations = useMemo<WorkingIndicatorPresentation[]>(
      () =>
        ensembleWorkingPresentations.length > 0
          ? ensembleWorkingPresentations
          : [
              {
                participantId: ensembleWorkingPresentation?.participantId ?? null,
                runId: ensembleWorkingPresentation?.runId ?? currentRun?.runId ?? null,
                startedAt: ensembleWorkingPresentation?.startedAt ?? currentRun?.startedAt ?? null,
                tokenAccumulatorBase: ensembleWorkingPresentation?.tokenAccumulatorBase ?? 0,
                providerLabel: workingProviderLabel || currentProviderLabel || 'Agent',
                provider: workingProvider ?? null,
                providerClass: workingProviderClass || (workingProvider ? String(workingProvider) : null),
                roleLabel: workingRoleLabel,
                modelBadge: workingModelBadge,
                activity: contextCompactionProgress.some(
                  (event) => event.status === 'started' && !event.participantId
                )
                  ? 'compacting'
                  : 'working'
              }
            ],
      [
        contextCompactionProgress,
        currentRun?.runId,
        currentRun?.startedAt,
        currentProviderLabel,
        ensembleWorkingPresentations,
        workingModelBadge,
        workingProvider,
        workingProviderClass,
        workingProviderLabel,
        workingRoleLabel
      ]
    )
    const workingTokenTargets = useMemo(
      () =>
        buildWorkingIndicatorTokenTargets(
          currentChat?.runs || [],
          currentChat?.messages || [],
          workingPresentations.map((presentation) => ({
            runId: presentation.runId,
            tokenAccumulatorBase: presentation.tokenAccumulatorBase
          }))
        ),
      [currentChat?.messages, currentChat?.runs, workingPresentations]
    )
    // Seats whose "working…" row is live right now, so each fan-out lane card
    // can shimmer its rim while its own seat is busy — the point being that a
    // straggler is findable at a glance when several lanes run at once.
    //
    // Gated on the SAME condition as the working row below
    // (`isThinking || hasLiveContextCompactionProgress`) and read from the SAME
    // presentations, so a card's shimmer starts and stops with that seat's row
    // rather than tracking a second, subtly different idea of "live". A
    // presentation with no participantId is the non-Ensemble fallback row and
    // belongs to no lane, so it lights nothing.
    const workingLaneParticipantIds = useMemo<ReadonlySet<string>>(() => {
      if (!isThinking && !hasLiveContextCompactionProgress) return EMPTY_WORKING_LANE_IDS
      const ids = new Set<string>()
      for (const presentation of workingPresentations) {
        if (presentation.participantId) ids.add(presentation.participantId)
      }
      return ids
    }, [hasLiveContextCompactionProgress, isThinking, workingPresentations])
    // Working-row context pressure — self-derived from the chat record with
    // the same meter lib the donut uses, so the indicator can disclose "before"
    // (occupancy ≥ warn) and presume "whilst" (token-growth stall at pressure)
    // without any new prop plumbing through the multiview panes.
    const workingContextPressure = useMemo(() => {
      const runs = currentChat?.runs || []
      const latestRun = [...runs].reverse().find((run) => run?.stats)
      const soloWindow = resolveContextWindow(
        isContextWindowProviderId(currentProvider) ? currentProvider : undefined,
        latestRun?.actualModel || latestRun?.requestedModel || ''
      )
      const soloUsed = currentContextTokens(runs, { liveOutputTokens: 0, isRunning: true })
      const byParticipant = new Map<string, number>()
      const participants = currentChat?.ensemble?.participants || []
      if (participants.length > 0) {
        for (const row of buildParticipantContextRows(runs, participants)) {
          byParticipant.set(row.id, row.percent)
        }
      }
      return { solo: contextPercent(soloUsed, soloWindow), byParticipant }
    }, [currentChat?.runs, currentChat?.ensemble?.participants, currentProvider])
    const [messageContextMenu, setMessageContextMenu] =
      useState<TranscriptMessageContextMenuSelection | null>(null)
    const {
      closePreview: closeFileChangeDiffPreview,
      keepPreviewOpen: keepFileChangeDiffPreviewOpen,
      preview: fileChangeDiffPreview,
      scheduleClosePreview: scheduleCloseFileChangeDiffPreview,
      scheduleShowPreview: scheduleShowFileChangeDiffPreview,
      showPreview: showFileChangeDiffPreview
    } = useDiffHoverPreviewState(
      FILE_CHANGE_DIFF_PREVIEW_CLOSE_DELAY_MS,
      FILE_CHANGE_DIFF_PREVIEW_OPEN_DELAY_MS
    )
    const [fileChangeSummaryVisibleCount, setFileChangeSummaryVisibleCount] = useState(
      FILE_CHANGE_SUMMARY_COLLAPSED_LIMIT
    )
    const fileChangeSections = useMemo(
      () => buildFileChangeSummarySections(displayFileChangeSummaries, roundFileChangeSummaries),
      [displayFileChangeSummaries, roundFileChangeSummaries]
    )
    // Round rows lead when the sectioned layout is active; the show-more
    // window slices the combined list so the round section is always the
    // first thing revealed.
    const fileChangeDisplayList = fileChangeSections?.combined ?? displayFileChangeSummaries
    const fileChangeSummaryWindow = useMemo(
      () => buildFileChangeSummaryWindow(fileChangeDisplayList, fileChangeSummaryVisibleCount),
      [fileChangeDisplayList, fileChangeSummaryVisibleCount]
    )
    // Row-level render cache: stream updates replace one message object, so
    // unchanged rows can reuse their previous element instead of rebuilding all
    // markdown/tool row JSX on every chat-level commit. Pruned to mounted rows.
    const rowElementCacheRef = useRef<
      Map<string, { signature: TranscriptRowRenderSignature; element: ReactElement }>
    >(new Map())
    const closeMessageContextMenu = useCallback(() => {
      setMessageContextMenu(null)
    }, [])
    // Snapshot fallback for summaries with no captured git diff (non-git
    // workspaces, tool-derived live summaries): synthesize hunks from the
    // run's write-tool payloads. Computed lazily on hover and cached per
    // (messages identity, path) — a stream update swaps the messages array,
    // which invalidates the whole cache.
    const toolEditSnapshotCacheRef = useRef<{
      messages: ChatMessage[] | null
      byPath: Map<string, string | null>
    }>({ messages: null, byPath: new Map() })
    const resolveFileChangeDiffText = useCallback(
      (summary: DiffFileSummary): { diffText?: string; snapshot?: boolean } => {
        if (summary.diffText?.trim()) return { diffText: summary.diffText }
        const cache = toolEditSnapshotCacheRef.current
        if (cache.messages !== visibleMessages) {
          cache.messages = visibleMessages
          cache.byPath.clear()
        }
        if (!cache.byPath.has(summary.path)) {
          cache.byPath.set(
            summary.path,
            buildToolEditDiffSnapshotForPath(
              visibleMessages,
              summary.path,
              currentWorkspacePath || currentChat?.workspacePath
            )
          )
        }
        const diffText = cache.byPath.get(summary.path) || undefined
        return diffText ? { diffText, snapshot: true } : {}
      },
      [currentChat?.workspacePath, currentWorkspacePath, visibleMessages]
    )
    const openFileChangeDiffPreview = useCallback(
      (
        event: { currentTarget: HTMLElement },
        summary: DiffFileSummary,
        options?: { focusTarget?: DiffHoverPreviewState['focusTarget']; immediate?: boolean }
      ) => {
        if (!canShowDiffHoverPreview(summary, Boolean(onOpenFileChangeInWorkbench))) return
        const anchorElement = event.currentTarget
        const produce = (): DiffHoverPreviewState | null => {
          if (!anchorElement.isConnected) return null
          const resolved = resolveFileChangeDiffText(summary)
          return {
            anchor: anchorElement.getBoundingClientRect(),
            boundary: diffHoverPreviewBoundaryForElement(anchorElement),
            summary: {
              actionLabel: onOpenFileChangeInWorkbench
                ? 'Click row to open Diff Studio'
                : 'Click row to preview',
              path: summary.path,
              status: summary.status,
              additions: summary.additions,
              deletions: summary.deletions,
              diffText: resolved.diffText,
              snapshot: resolved.snapshot,
              source: 'run-summary'
            },
            focusTarget: options?.focusTarget,
            action: onOpenFileChangeInWorkbench
              ? {
                  label: 'Open Diff Studio',
                  onActivate: () => {
                    closeFileChangeDiffPreview()
                    onOpenFileChangeInWorkbench(summary)
                  }
                }
              : undefined
          }
        }
        // Keyboard focus and clicks open instantly; only pointer hover waits
        // out the open delay.
        if (options?.immediate || options?.focusTarget) {
          const nextPreview = produce()
          if (nextPreview) showFileChangeDiffPreview(nextPreview)
          return
        }
        scheduleShowFileChangeDiffPreview(produce)
      },
      [
        closeFileChangeDiffPreview,
        onOpenFileChangeInWorkbench,
        resolveFileChangeDiffText,
        scheduleShowFileChangeDiffPreview,
        showFileChangeDiffPreview
      ]
    )
    const activateFileChangeSummary = useCallback(
      (event: React.MouseEvent<HTMLElement>, summary: DiffFileSummary) => {
        if (!onOpenFileChangeInWorkbench) {
          openFileChangeDiffPreview(event, summary, { immediate: true })
          return
        }
        closeFileChangeDiffPreview()
        onOpenFileChangeInWorkbench(summary)
      },
      [closeFileChangeDiffPreview, onOpenFileChangeInWorkbench, openFileChangeDiffPreview]
    )
    useDiffHoverPreviewDismiss(fileChangeDiffPreview, closeFileChangeDiffPreview)
    useEffect(() => {
      closeFileChangeDiffPreview()
      setFileChangeSummaryVisibleCount(FILE_CHANGE_SUMMARY_COLLAPSED_LIMIT)
    }, [
      closeFileChangeDiffPreview,
      currentChat?.appChatId,
      currentRun?.runId,
      fileChangeDisplayList
    ])
    const showMoreFileChangeSummaries = useCallback(() => {
      setFileChangeSummaryVisibleCount((current) =>
        buildFileChangeSummaryWindow(fileChangeDisplayList, current).nextCount
      )
    }, [fileChangeDisplayList])
    const showFewerFileChangeSummaries = useCallback(() => {
      setFileChangeSummaryVisibleCount(FILE_CHANGE_SUMMARY_COLLAPSED_LIMIT)
    }, [])
    const openMessageContextMenu = useCallback(
      (
        event: React.MouseEvent,
        message: ChatMessage,
        copyContent: string,
        label: string,
        options: {
          copySource?: TranscriptMessageContextMenuSelection['copySource']
          copyOnly?: boolean
        } = {}
      ): void => {
        const browserSelection = window.getSelection()
        const selectedText =
          browserSelection &&
          !browserSelection.isCollapsed &&
          browserSelection.anchorNode &&
          browserSelection.focusNode &&
          contentRef.current?.contains(browserSelection.anchorNode) &&
          contentRef.current?.contains(browserSelection.focusNode)
            ? browserSelection.toString()
            : ''
        event.preventDefault()
        event.stopPropagation()
        setMessageContextMenu({
          anchor: { x: event.clientX, y: event.clientY },
          message,
          copyContent,
          selectedText,
          copySource: options.copySource || 'message-content',
          label,
          pinned: typeof message.metadata?.pinnedAt === 'number',
          copyOnly: options.copyOnly
        })
      },
      [contentRef]
    )
    const copyTranscriptSelection = useCallback((text: string): void => {
      if (!text || typeof navigator === 'undefined' || !navigator.clipboard?.writeText) return
      void navigator.clipboard.writeText(text).catch(() => undefined)
    }, [])
    const activeMessageContextMenu = useMemo(() => {
      if (!messageContextMenu) return null
      const latestMessage =
        visibleMessages.find((message) => message.id === messageContextMenu.message.id) ||
        messageContextMenu.message
      const copyContent =
        messageContextMenu.copySource === 'subthread-return-body'
          ? subThreadReturnBody(latestMessage.content)
          : messageContextMenu.copySource === 'static'
            ? messageContextMenu.copyContent
            : latestMessage.content || ''
      return {
        ...messageContextMenu,
        message: latestMessage,
        copyContent,
        pinned: typeof latestMessage.metadata?.pinnedAt === 'number'
      }
    }, [messageContextMenu, visibleMessages])
    useEffect(() => {
      if (!messageContextMenu) return
      if (visibleMessages.some((message) => message.id === messageContextMenu.message.id)) return
      setMessageContextMenu(null)
    }, [messageContextMenu, visibleMessages])
    const shouldShowRunCompleteNotice =
      Boolean(runCompleteNotice && !isWelcomeChat && !shouldSuppressRunCompleteSummary(runCompleteNotice))
    // The run-complete card's title is a dynamic status, not a fixed "Task
    // complete": blockers the orchestrator flagged for the round REPLACE the
    // title (and tint it) instead of contradicting it from an advisory banner
    // underneath. Read-only — the orchestrator persists the signals; the
    // resolver is a pure mapping over them.
    const runCompleteBlockers = useMemo(
      () => (isGlobal ? [] : buildRunCompleteBlockers(currentChat)),
      [currentChat, isGlobal]
    )
    const runCompleteStatus = useMemo(() => {
      if (!runCompleteNotice) return null
      const noticeRunId = currentRun?.runId
      return resolveRunCompleteStatus({
        exitCode: runCompleteNotice.exitCode,
        isGlobal,
        blockers: runCompleteBlockers,
        producedWork: runCompleteProducedWork({
          chat: currentChat,
          fileChangeCount: displayFileChangeSummaries.length,
          // Solo runs have no round participants to read an outcome from, so
          // a non-empty assistant reply for this run counts as work. Strictly
          // scoped to the finished run: without a run id an older reply from
          // earlier in the thread would launder a dead run into "work done".
          hadAssistantOutput: Boolean(
            noticeRunId &&
            messages.some(
              (message) =>
                message.role === 'assistant' &&
                message.runId === noticeRunId &&
                Boolean(message.content?.trim())
            )
          )
        }),
        // Non-ensemble pause: the run ended on a question the user hasn't
        // answered yet. Both queues are per-chat and are cleared on answer or
        // dismiss, so anything still in them is genuinely outstanding; prefer
        // this run's own question when the run id is known.
        awaitingAnswer:
          pendingAgentQuestions.some(
            (question) => !noticeRunId || question.appRunId === noticeRunId
          ) || Boolean(pendingPlanChoice)
      })
    }, [
      currentChat,
      currentRun?.runId,
      displayFileChangeSummaries.length,
      isGlobal,
      messages,
      pendingAgentQuestions,
      pendingPlanChoice,
      runCompleteBlockers,
      runCompleteNotice
    ])
    const runBoundaryByMessageId = useMemo(() => {
      const runs = currentChat?.runs || []
      const runById = new Map<string, ChatRun>()
      const promptRunByMessageId = new Map<string, ChatRun>()
      for (const run of runs) {
        if (run.runId) runById.set(run.runId, run)
        if (run.promptMessageId) promptRunByMessageId.set(run.promptMessageId, run)
      }

      const boundaries = new Map<string, ChatRun>()
      let previousRunId: string | null = null
      for (const message of visibleMessages) {
        const run =
          (message.runId ? runById.get(message.runId) : undefined) ||
          promptRunByMessageId.get(message.id)
        if (!run?.runId) continue
        if (run.runId !== previousRunId) {
          boundaries.set(message.id, run)
        }
        previousRunId = run.runId
      }
      return boundaries
    }, [currentChat?.runs, visibleMessages])
    // Per-message expansion state for long user-message bubbles. Keyed by
    // message.id so toggling one brief does not collapse others. Default for
    // every long message is collapsed — see UserMessageCollapse for thresholds.
    // Manual round expansion is session-local but keyed by chat. Switching
    // away and back must not erase the round the reader opened; keeping the
    // destination map available during render also lets scroll-anchor restore
    // target a body row before its deferred positioning pass runs.
    const roundExpansionChatId = currentChat?.appChatId ?? null
    const manualRoundExpansionByChatId = useSyncExternalStore(
      subscribeSessionRoundExpansion,
      getSessionRoundExpansionSnapshot,
      getSessionRoundExpansionSnapshot
    )
    const manualRoundExpansion = useMemo(
      () => roundExpansionForChat(manualRoundExpansionByChatId, roundExpansionChatId),
      [manualRoundExpansionByChatId, roundExpansionChatId]
    )
    const setRoundExpanded = useCallback(
      (roundId: string, expanded: boolean) => {
        if (!roundExpansionChatId) return
        setSessionRoundExpanded(roundExpansionChatId, roundId, expanded)
      },
      [roundExpansionChatId]
    )
    const [expandedUserMessages, setExpandedUserMessages] = useState<Set<string>>(new Set())
    const toggleUserMessageExpanded = useCallback((id: string) => {
      setExpandedUserMessages((prev) => {
        const next = new Set(prev)
        if (next.has(id)) {
          next.delete(id)
        } else {
          next.add(id)
        }
        return next
      })
    }, [])

    // 1.0.6-TV2 — lifted ActivityStack expansion. Keyed by message id
    // (the tool row's id), value is the stack's set of open activity
    // ids. Held here (not inside ActivityStack) so a tool row scrolled
    // out of the virtualised window and back keeps whatever the user had
    // expanded — same survival pattern as `expandedUserMessages`.
    const [activityExpansionByRow, setActivityExpansionByRow] = useState<Map<string, Set<string>>>(
      new Map()
    )
    const setActivityExpansionForRow = useCallback((rowId: string, next: Set<string>) => {
      setActivityExpansionByRow((prev) => {
        const map = new Map(prev)
        if (next.size === 0) map.delete(rowId)
        else map.set(rowId, next)
        return map
      })
    }, [])
    const [expandedSubThreadResults, setExpandedSubThreadResults] = useState<Set<string>>(
      new Set()
    )
    const setSubThreadResultExpanded = useCallback((rowId: string, expanded: boolean) => {
      setExpandedSubThreadResults((prev) => {
        const next = new Set(prev)
        if (expanded) next.add(rowId)
        else next.delete(rowId)
        return next
      })
    }, [])
    const [expandedFanoutResults, setExpandedFanoutResults] = useState<Set<string>>(new Set())
    const setFanoutResultExpanded = useCallback((rowId: string, expanded: boolean) => {
      setExpandedFanoutResults((prev) => {
        const next = new Set(prev)
        if (expanded) next.add(rowId)
        else next.delete(rowId)
        return next
      })
    }, [])
    // A settled fan-out wave folds once later round activity begins. Opening
    // its durable summary re-inserts only that wave's lane-card rows while the
    // rest of the visible round keeps its current disclosure state.
    const [expandedFanoutViewports, setExpandedFanoutViewports] = useState<Set<string>>(
      new Set()
    )
    const setFanoutViewportExpanded = useCallback((viewportId: string, expanded: boolean) => {
      setExpandedFanoutViewports((prev) => {
        const next = new Set(prev)
        if (expanded) next.add(viewportId)
        else next.delete(viewportId)
        return next
      })
    }, [])
    // 1.0.7 — lifted live-viewport expansion (the collapsed tool/thinking
    // viewport's Expand toggle). Held here — NOT inside ActivityStack — for
    // the same survival reason as `activityExpansionByRow`, but keyed by
    // `toolStackStateKey` (first constituent tool message id) instead of
    // rowKey: the grouped row's id AND rowKey both churn while activity
    // streams in (group growth 1→2 rewrites the merged id; new rows shift
    // indexes), and each churn remounted the stack and snapped an expanded
    // viewport shut mid-stream.
    const [expandedLiveViewportStacks, setExpandedLiveViewportStacks] = useState<Set<string>>(
      new Set()
    )
    const setLiveViewportExpandedForStack = useCallback((stackKey: string, expanded: boolean) => {
      setExpandedLiveViewportStacks((prev) => {
        const next = new Set(prev)
        if (expanded) next.add(stackKey)
        else next.delete(stackKey)
        return next
      })
    }, [])
    // Settled-stack auto-collapse override: stacks the user re-opened after
    // they folded into a one-line summary. Keyed by `toolStackStateKey` for
    // the same churn-survival reason as `expandedLiveViewportStacks`.
    const [expandedCollapsedStacks, setExpandedCollapsedStacks] = useState<Set<string>>(new Set())
    const setCollapsedStackExpanded = useCallback((stackKey: string, expanded: boolean) => {
      setExpandedCollapsedStacks((prev) => {
        const next = new Set(prev)
        if (expanded) next.add(stackKey)
        else next.delete(stackKey)
        return next
      })
    }, [])
    // Second-level fold: super-groups of adjacent collapsed one-liners the
    // user re-opened. Keyed by the group's lead (first member) message id.
    const [expandedSuperGroups, setExpandedSuperGroups] = useState<Set<string>>(new Set())
    const setSuperGroupExpanded = useCallback((leadId: string, expanded: boolean) => {
      setExpandedSuperGroups((prev) => {
        const next = new Set(prev)
        if (expanded) next.add(leadId)
        else next.delete(leadId)
        return next
      })
    }, [])
    // Row ids whose tool stack has something open — the measurementKey
    // geometry bit, so collapsed vs expanded rows cache distinct heights.
    const expandedRowIds = useMemo(() => {
      const ids = new Set<string>()
      for (const [rowId, set] of activityExpansionByRow) {
        if (set.size > 0) ids.add(rowId)
      }
      for (const rowId of expandedSubThreadResults) {
        ids.add(rowId)
      }
      for (const rowId of expandedFanoutResults) {
        ids.add(rowId)
      }
      return ids
    }, [activityExpansionByRow, expandedSubThreadResults, expandedFanoutResults])
    const [activeParticipantFilterKeys, setActiveParticipantFilterKeys] = useState<Set<string>>(
      new Set()
    )
    const participantFilterItems = useMemo(
      () => buildTranscriptParticipantFilterItems(currentChat),
      [
        currentChat?.chatKind,
        currentChat?.ensemble?.participants,
        currentChat?.ensemble?.bossmanParticipantId,
        currentChat?.ensemble?.captainParticipantIds,
        currentChat?.ensemble?.secondInCommandParticipantId
      ]
    )
    const toggleParticipantFilter = useCallback((key: string) => {
      setActiveParticipantFilterKeys((prev) => {
        const next = new Set(prev)
        if (next.has(key)) next.delete(key)
        else next.add(key)
        return next
      })
    }, [])
    useEffect(() => {
      if (activeParticipantFilterKeys.size === 0) return
      const validKeys = new Set(participantFilterItems.map((item) => item.key))
      setActiveParticipantFilterKeys((prev) => {
        let changed = false
        const next = new Set<string>()
        for (const key of prev) {
          if (validKeys.has(key)) next.add(key)
          else changed = true
        }
        return changed ? next : prev
      })
    }, [activeParticipantFilterKeys.size, participantFilterItems])

    // 1.0.6-TV1 — windowing. `virtualize` defaults to the global flag;
    // tests pass it explicitly. When off, `useTranscriptVirtualization`
    // is inert and the full-list branch below renders exactly as before.
    //
    // 1.0.7 — virtualization is ON for ALL chat kinds including ensembles. An
    // earlier patch (e4feee5) disabled it for ensembles to dodge a flicker, but
    // that abandoned the benefit for exactly the densest transcripts. The
    // flicker's real root cause — a window↔measurement oscillation fed by (a)
    // 4–5× under-estimated dense rows, (b) a scrollbar→width-bucket cache
    // invalidation, and (c) the window being re-selected from the live heights
    // its own mounted rows mutate — is now fixed at source: content-scaled
    // estimates, `scrollbar-gutter: stable` + inner-width bucketing, a stable
    // window-selection snapshot (select-on-scroll, not on every measure), and a
    // one-shot anchor correction. So ensembles keep windowing and converge.
    const virtualizeEnabled = virtualize ?? TRANSCRIPT_VIRTUALIZATION_ENABLED
    const toolGroupedMessages = useIncrementalMessageGrouping(
      visibleMessages,
      groupAdjacentToolMessagesWithRanges,
      toolGroupingRegroupStart
    )
    const groupedMessages = useFanoutLaneMessageGrouping(toolGroupedMessages)
    const messageById = useMemo(() => {
      const map = new Map<string, ChatMessage>()
      for (const message of visibleMessages) {
        map.set(message.id, message)
      }
      return map
    }, [visibleMessages])
    const toolActivityMessageIdByActivityId = useMemo(() => {
      const map = new Map<string, string>()
      for (const message of visibleMessages) {
        if (message.role !== 'tool') continue
        for (const activity of message.toolActivities || []) {
          if (activity.id) map.set(activity.id, message.id)
        }
      }
      return map
    }, [visibleMessages])
    const participantFilteredMessages = useMemo(
      () =>
        filterTranscriptMessagesByParticipantKeys(groupedMessages, activeParticipantFilterKeys),
      [activeParticipantFilterKeys, groupedMessages]
    )
    const participantFilterActive = activeParticipantFilterKeys.size > 0
    const roundCardChat = useMemo(
      () => currentChat,
      [
        currentChat?.appChatId,
        currentChat?.chatKind,
        currentChat?.ensemble?.activeRound,
        currentChat?.ensemble?.lastRoundSummary,
        currentChat?.ensemble?.roundSummaries,
        currentChat?.runs
      ]
    )
    const roundCardCollapseEnabled = participantFilterActive ? false : collapseOlderRounds !== false
    const manualRoundExpansionKey = useMemo(
      () => booleanMapSignature(manualRoundExpansion),
      [manualRoundExpansion]
    )
    const fanoutViewportExpansionKey = useMemo(
      () => Array.from(expandedFanoutViewports).sort().join('\u0000'),
      [expandedFanoutViewports]
    )
    const activeRoundProjectionKey = useMemo(
      () => ensembleActiveRoundProjectionKey(roundCardChat?.ensemble?.activeRound),
      [roundCardChat?.ensemble?.activeRound]
    )
    const roundSummariesKey = useMemo(
      () => ensembleRoundSummariesSignature(roundCardChat?.ensemble?.roundSummaries),
      [roundCardChat?.ensemble?.roundSummaries]
    )
    const fanoutRunProjectionKey = useMemo(
      () => ensembleFanoutRunProjectionKey(roundCardChat?.runs),
      [roundCardChat?.runs]
    )
    const roundCardResetKey = useMemo(
      () =>
        [
          roundCardChat?.appChatId || '',
          roundCardChat?.chatKind || '',
          roundCardCollapseEnabled ? 'collapse' : 'flat',
          isThinking ? 'live' : 'idle',
          activeRoundProjectionKey,
          roundCardChat?.ensemble?.lastRoundSummary || '',
          roundSummariesKey,
          fanoutRunProjectionKey,
          manualRoundExpansionKey,
          fanoutViewportExpansionKey
        ].join('\u0001'),
      [
        activeRoundProjectionKey,
        fanoutRunProjectionKey,
        fanoutViewportExpansionKey,
        isThinking,
        manualRoundExpansionKey,
        roundCardChat?.appChatId,
        roundCardChat?.chatKind,
        roundCardChat?.ensemble?.lastRoundSummary,
        roundCardCollapseEnabled,
        roundSummariesKey
      ]
    )
    const buildRoundCardRanges = useCallback(
      (messages: readonly ChatMessage[]) =>
        buildEnsembleRoundCardRowsWithRanges({
          chat: roundCardChat,
          displayMessages: messages as ChatMessage[],
          collapseOlderRounds: roundCardCollapseEnabled,
          manualRoundExpansion,
          expandedFanoutViewportIds: expandedFanoutViewports,
          hasLiveRunEvidence: isThinking
        }),
      [
        expandedFanoutViewports,
        isThinking,
        manualRoundExpansion,
        roundCardChat,
        roundCardCollapseEnabled
      ]
    )
    // Ensemble round cards: completed rounds collapse into expandable
    // header rows (older collapsed by default). The range-based path keeps
    // unchanged transcript prefixes cached while the live tail grows.
    const displayMessages = useIncrementalMessageGrouping(
      participantFilteredMessages,
      buildRoundCardRanges,
      roundCardGroupingRegroupStart,
      roundCardResetKey
    )
    // Map every (pre-collapse) message id → its round id, so navigation
    // (jump-to-message, pinned, side-chat seed) can auto-expand the round
    // a target lives in before scrolling — otherwise a jump into a
    // collapsed round would silently no-op. Built off the full
    // `groupedMessages` list (not the collapsed `displayMessages`).
    const roundIdByMessageId = useMemo(() => {
      const map = new Map<string, string>()
      if (currentChat?.chatKind !== 'ensemble') return map
      for (const message of groupedMessages) {
        const roundId =
          typeof message.metadata?.ensembleRoundId === 'string'
            ? message.metadata.ensembleRoundId
            : null
        if (!roundId) continue
        map.set(message.id, roundId)
        for (const gid of groupedTranscriptMessageIds(message)) {
          map.set(gid, roundId)
        }
      }
      return map
    }, [groupedMessages, currentChat?.chatKind])
    // User messages hidden inside COLLAPSED round cards, keyed by the round
    // header message id whose row replaces them in `displayMessages`. Feeds
    // the gutter builder so collapsing a round never drops its prompts from
    // the jump rail — the marker anchors at the header and the click path
    // auto-expands before focusing.
    const collapsedRoundUserMessages = useMemo(() => {
      const map = new Map<string, ChatMessage[]>()
      if (currentChat?.chatKind !== 'ensemble') return map
      let byRound: Map<string, ChatMessage[]> | null = null
      for (const message of displayMessages) {
        const header = readEnsembleRoundHeader(message)
        if (!header || header.expanded) continue
        if (!byRound) {
          byRound = new Map()
          for (const candidate of groupedMessages) {
            if (candidate.role !== 'user') continue
            const roundId =
              typeof candidate.metadata?.ensembleRoundId === 'string'
                ? candidate.metadata.ensembleRoundId
                : null
            if (!roundId) continue
            const bucket = byRound.get(roundId)
            if (bucket) bucket.push(candidate)
            else byRound.set(roundId, [candidate])
          }
        }
        const hidden = byRound.get(header.roundId)
        if (hidden && hidden.length > 0) map.set(message.id, hidden)
      }
      return map
    }, [currentChat?.chatKind, displayMessages, groupedMessages])
    const ensureRoundExpandedForMessage = useCallback(
      (messageId: string) => {
        const roundId = roundIdByMessageId.get(messageId)
        if (!roundId) return
        if (manualRoundExpansion.get(roundId) === true) return
        setRoundExpanded(roundId, true)
      },
      [manualRoundExpansion, roundIdByMessageId, setRoundExpanded]
    )

    // Phase 3 — type-out reveal (Variant B), default ON. The
    // live last-assistant bubble of a running chat reveals progressively via
    // RevealingMarkdownMessage. Its mounted subtree survives terminal settling
    // (preserving focus/code state) and returns to the plain renderer only after
    // virtualization naturally unmounts it; untouched history stays plain.
    // Keep the old localStorage flag as an escape hatch for debugging:
    // `taskwraith.experimentalReveal=false` restores the plain renderer.
    const revealEnabled = useMemo(() => {
      try {
        return localStorage.getItem('taskwraith.experimentalReveal') !== 'false'
      } catch {
        return true
      }
    }, [])
    useLayoutEffect(() => {
      if (!externalRestoreAnchorMessageId) return
      ensureRoundExpandedForMessage(externalRestoreAnchorMessageId)
    }, [ensureRoundExpandedForMessage, externalRestoreAnchorMessageId])
    const revealChatId = currentChat?.appChatId ?? null
    const revealChatIsRunning =
      revealChatId != null && Array.isArray(runningChatIds) && runningChatIds.includes(revealChatId)
    const revealRunId = currentRun?.runId ?? currentChat?.runs?.find((run) => !run.endedAt)?.runId
    const liveRevealMessageId = useMemo(
      () =>
        resolveLiveRevealMessageId(displayMessages, {
          revealEnabled,
          revealChatIsRunning,
          revealRunId
        }),
      [displayMessages, revealEnabled, revealChatIsRunning, revealRunId]
    )
    const liveToolMessageId = useMemo(
      () =>
        liveRevealMessageId
          ? null
          : resolveLiveToolMessageId(displayMessages, {
              revealChatIsRunning,
              revealRunId
            }),
      [displayMessages, liveRevealMessageId, revealChatIsRunning, revealRunId]
    )
    const liveMeasurementMessageId = liveRevealMessageId || liveToolMessageId
    const displayRunBoundaryByMessageId = useMemo(() => {
      const map = new Map(runBoundaryByMessageId)
      for (const message of displayMessages) {
        if (map.has(message.id)) continue
        const boundaryId = groupedTranscriptMessageIds(message).find((id) => map.has(id))
        if (boundaryId) map.set(message.id, map.get(boundaryId)!)
      }
      return map
    }, [displayMessages, runBoundaryByMessageId])

    const projectedRows = useProjectedTranscriptRows(
      displayMessages,
      null,
      liveActivityViewport === false
    )
    const projectedRowLookup = useMemo(() => {
      const byRowKey = new Map<string, VirtualRow>()
      const byMessageId = new Map<string, VirtualRow>()
      const byConstituentId = new Map<string, VirtualRow>()
      const indexByRowKey = new Map<string, number>()
      for (let index = 0; index < projectedRows.length; index += 1) {
        const row = projectedRows[index]
        byRowKey.set(row.rowKey, row)
        indexByRowKey.set(row.rowKey, index)
        if (!byMessageId.has(row.id)) byMessageId.set(row.id, row)
        const message = displayMessages[row.index]
        if (!message) continue
        for (const id of groupedTranscriptMessageIds(message)) {
          if (!byConstituentId.has(id)) byConstituentId.set(id, row)
        }
      }
      return { byRowKey, byMessageId, byConstituentId, indexByRowKey }
    }, [displayMessages, projectedRows])
    const liveMeasurementRowKey = useMemo(() => {
      if (!liveMeasurementMessageId) return null
      return (
        projectedRows.find(
          (row) =>
            row.id === liveMeasurementMessageId && row.index === displayMessages.length - 1
        )?.rowKey ?? null
      )
    }, [displayMessages.length, liveMeasurementMessageId, projectedRows])
    const liveRevealRowKey = liveRevealMessageId ? liveMeasurementRowKey : null
    const liveRevealLifecycleKey = liveRevealRowKey
      ? `${revealChatId || 'chat'}:${liveRevealRowKey}`
      : null
    const [revealLifecycleRowKeys, setRevealLifecycleRowKeys] = useState<Set<string>>(
      () => new Set()
    )
    useEffect(() => {
      setRevealLifecycleRowKeys(new Set())
    }, [revealChatId])
    useEffect(() => {
      if (!liveRevealLifecycleKey) return
      setRevealLifecycleRowKeys((current) => {
        if (current.has(liveRevealLifecycleKey)) return current
        const next = new Set(current)
        next.add(liveRevealLifecycleKey)
        return next
      })
    }, [liveRevealLifecycleKey])
    const finishRevealLifecycle = useCallback((lifecycleKey: string) => {
      setRevealLifecycleRowKeys((current) => {
        if (!current.has(lifecycleKey)) return current
        const next = new Set(current)
        next.delete(lifecycleKey)
        return next
      })
    }, [])
    // Geometry companion to `expandedLiveViewportStacks`: the virtualizer's
    // measurement cache keys on rowKey + an expanded bit, so rows with an
    // expanded live viewport must resolve their CURRENT rowKey each render
    // (stack keys are position-independent; rowKeys are not).
    // Settled-stack collapse boundary: the trailing message never collapses
    // (a freshly-settled stack stays open until the next assistant/panel
    // message actually arrives below it).
    const lastDisplayMessageId =
      displayMessages.length > 0 ? displayMessages[displayMessages.length - 1].id : null

    // Super-group fold: maximal runs (≥2) of adjacent would-be one-liners —
    // same-participant settled stacks plus interleaved plain system notices —
    // condense into ONE merged summary line. The lead (first member) renders
    // the merged line; other members render empty (their ROWS stay in place,
    // so gutter/scroll-spy ordinals and virtualization are untouched).
    // Membership must mirror the per-row collapse conditions exactly, or a
    // row could be hidden as a member while rendering as a special card.
    const superGroupByMessageId = useMemo(() => {
      const map = new Map<string, CollapsedSuperGroupInfo>()
      const pendingQuestionIds = new Set(
        pendingAgentQuestions.map((question) => question.messageId)
      )
      const membershipOf = (msg: ChatMessage): 'stack' | 'system' | null => {
        if (msg.id === lastDisplayMessageId) return null
        if (typeof msg.metadata?.pinnedAt === 'number') return null
        if (msg.role === 'tool' && (msg.toolActivities?.length || 0) > 0) {
          return activityStackHasLiveWork(msg.toolActivities || []) ? null : 'stack'
        }
        if (
          plainSystemNoticeMessage(msg) &&
          !pendingQuestionIds.has(msg.id) &&
          pendingPlanChoice?.messageId !== msg.id
        ) {
          return 'system'
        }
        return null
      }
      let run: {
        msgs: ChatMessage[]
        kinds: ('stack' | 'system')[]
        key: string | null
      } | null = null
      const flush = (): void => {
        if (!run || run.msgs.length < 2) {
          run = null
          return
        }
        const activities: ToolActivity[] = []
        let systemCount = 0
        let firstSystemPreview = ''
        let headerMessage: ChatMessage | null = null
        run.msgs.forEach((member, index) => {
          if (run!.kinds[index] === 'stack') {
            activities.push(...(member.toolActivities || []))
            if (!headerMessage) headerMessage = member
          } else {
            systemCount += 1
            if (!firstSystemPreview) firstSystemPreview = collapsedSystemNoticeLabel(member.content)
          }
        })
        const info: CollapsedSuperGroupInfo = {
          leadId: run.msgs[0].id,
          memberIds: run.msgs.map((member) => member.id),
          size: run.msgs.length,
          activities,
          systemCount,
          firstSystemPreview,
          headerMessage
        }
        for (const member of run.msgs) map.set(member.id, info)
        run = null
      }
      for (const msg of displayMessages) {
        const kind = membershipOf(msg)
        if (!kind) {
          flush()
          continue
        }
        const key = kind === 'stack' ? superGroupParticipantKey(msg) : null
        if (!run) {
          run = { msgs: [msg], kinds: [kind], key }
          continue
        }
        if (kind === 'stack') {
          if (run.key !== null && key !== run.key) {
            flush()
            run = { msgs: [msg], kinds: [kind], key }
            continue
          }
          // A system-led run adopts the first stack's participant identity.
          if (run.key === null) run.key = key
        }
        run.msgs.push(msg)
        run.kinds.push(kind)
      }
      flush()
      return map
    }, [
      displayMessages,
      lastDisplayMessageId,
      pendingAgentQuestions,
      pendingPlanChoice
    ])

    const expandedRowIdsWithLiveViewports = useMemo(() => {
      if (
        expandedLiveViewportStacks.size === 0 &&
        expandedCollapsedStacks.size === 0 &&
        expandedSuperGroups.size === 0
      ) {
        return expandedRowIds
      }
      const ids = new Set(expandedRowIds)
      for (const stackKey of expandedLiveViewportStacks) {
        const row =
          projectedRowLookup.byMessageId.get(stackKey) ||
          projectedRowLookup.byConstituentId.get(stackKey)
        if (row) ids.add(row.rowKey)
      }
      // Re-opened collapsed stacks occupy the tall geometry bucket so the
      // virtualizer caches distinct heights for the two visual states.
      for (const stackKey of expandedCollapsedStacks) {
        const row =
          projectedRowLookup.byMessageId.get(stackKey) ||
          projectedRowLookup.byConstituentId.get(stackKey)
        if (row) ids.add(row.rowKey)
      }
      // A re-opened super group changes EVERY member row's height (hidden ↔
      // one-liner), so all members join the tall bucket together.
      for (const leadId of expandedSuperGroups) {
        const group = superGroupByMessageId.get(leadId)
        if (!group) continue
        for (const memberId of group.memberIds) {
          const row =
            projectedRowLookup.byMessageId.get(memberId) ||
            projectedRowLookup.byConstituentId.get(memberId)
          if (row) ids.add(row.rowKey)
        }
      }
      return ids
    }, [
      expandedLiveViewportStacks,
      expandedCollapsedStacks,
      expandedSuperGroups,
      superGroupByMessageId,
      expandedRowIds,
      projectedRowLookup
    ])
    // Fold-out phase for freshly settled super groups: for SUPER_FOLD_COMMIT_MS
    // the member rows stay mounted with `.is-super-folding`, whose CSS
    // transitions their height to 0, so a long tail folds up smoothly instead
    // of teleporting into the one-liner. Derived during render (first-seen
    // stamps live in a ref, mirroring rowElementCacheRef) because the class
    // must land in the SAME render pass that first collapses the group — an
    // intermediate hidden render would unmount the member DOM nodes and the
    // height transition could never fire. Groups already collapsed when the
    // chat mounts are baseline (no fold animation on open); reduced motion
    // commits instantly.
    const [foldTick, setFoldTick] = useState(0)
    const superFoldStateRef = useRef<{
      /** `undefined` = no derive yet — the first pass is ALWAYS baseline,
       * even when the resolved chat id is null (single-pass test renders,
       * no-chat states), so first-render groups hide instantly. */
      chatId: string | null | undefined
      seen: Set<string>
      committed: Set<string>
    }>({ chatId: undefined, seen: new Set(), committed: new Set() })
    const foldingSuperGroups = useMemo(() => {
      void foldTick // re-derives after the commit timer moves leads to committed
      if (superGroupByMessageId.size === 0) return EMPTY_FOLDING_SUPER_GROUPS
      const foldState = superFoldStateRef.current
      const foldChatId = currentChat?.appChatId ?? null
      const isBaselinePass = foldState.chatId !== foldChatId
      if (isBaselinePass) {
        foldState.chatId = foldChatId
        foldState.seen.clear()
        foldState.committed.clear()
      }
      const reducedMotion = prefersReducedMotionNow()
      const liveLeads = new Set<string>()
      const folding = new Set<string>()
      for (const group of superGroupByMessageId.values()) {
        if (liveLeads.has(group.leadId)) continue
        liveLeads.add(group.leadId)
        if (!foldState.seen.has(group.leadId)) {
          foldState.seen.add(group.leadId)
          // Baseline (chat open) and reduced motion commit instantly; only
          // groups that settle while the chat is on screen animate.
          if (isBaselinePass || reducedMotion) foldState.committed.add(group.leadId)
        }
        if (!foldState.committed.has(group.leadId) && !expandedSuperGroups.has(group.leadId)) {
          folding.add(group.leadId)
        }
      }
      for (const leadId of foldState.seen) {
        if (!liveLeads.has(leadId)) {
          foldState.seen.delete(leadId)
          foldState.committed.delete(leadId)
        }
      }
      return folding.size > 0 ? folding : EMPTY_FOLDING_SUPER_GROUPS
    }, [superGroupByMessageId, expandedSuperGroups, currentChat?.appChatId, foldTick])
    // Arm-once commit timers. A deps-cleanup timer would re-arm on every
    // streaming render (memo identities churn each frame) and starve the
    // commit; an armed timer instead runs to completion, and any late
    // arrivals get the next arming after the tick re-render.
    const superFoldCommitTimerRef = useRef<number | null>(null)
    const stackCollapseStateRef = useRef<{
      chatId: string | null | undefined
      lastCollapsed: Map<string, boolean>
      entering: Map<string, number>
    }>({ chatId: undefined, lastCollapsed: new Map(), entering: new Map() })
    const stackCollapseCommitTimerRef = useRef<number | null>(null)
    const [, setStackCollapseTick] = useState(0)
    useEffect(() => {
      if (foldingSuperGroups.size === 0 || superFoldCommitTimerRef.current !== null) return
      const observed = [...foldingSuperGroups]
      superFoldCommitTimerRef.current = window.setTimeout(() => {
        superFoldCommitTimerRef.current = null
        for (const leadId of observed) superFoldStateRef.current.committed.add(leadId)
        setFoldTick((tick) => tick + 1)
      }, SUPER_FOLD_COMMIT_MS)
    }, [foldingSuperGroups])
    useEffect(() => {
      if (
        stackCollapseStateRef.current.entering.size === 0 ||
        stackCollapseCommitTimerRef.current !== null
      ) {
        return
      }
      const observed = [...stackCollapseStateRef.current.entering.keys()]
      stackCollapseCommitTimerRef.current = window.setTimeout(() => {
        stackCollapseCommitTimerRef.current = null
        for (const key of observed) stackCollapseStateRef.current.entering.delete(key)
        setStackCollapseTick((tick) => tick + 1)
      }, STACK_COLLAPSE_COMMIT_MS)
    })
    useEffect(
      () => () => {
        if (superFoldCommitTimerRef.current !== null) {
          window.clearTimeout(superFoldCommitTimerRef.current)
        }
        if (stackCollapseCommitTimerRef.current !== null) {
          window.clearTimeout(stackCollapseCommitTimerRef.current)
        }
      },
      []
    )
    // Rows hidden inside a COLLAPSED super group render an empty block whose
    // CSS zeroes all spacing, so their real slot height is 0 — but a 0px slot
    // can never record a measurement (the measure pass skips non-positive
    // deltas), which would leave the virtualizer on per-type ESTIMATES for
    // every hidden row (phantom spacer height, scroll-position drift across
    // groups). Resolve their rowKeys so the height table can pin them to 0.
    /**
     * Settled `ask_user_question` cards, keyed by their marker row.
     *
     * Everything needed already sits in `chat.messages` — the question text,
     * options and context on the marker; the answer on the reply row — so this
     * only reads it back. A question that is still PENDING is excluded: the live
     * card owns that state, and a frozen copy beside it would show a question
     * the user can still answer.
     */
    const agentQuestionTombstones = useMemo(() => {
      const pendingMarkerIds = new Set(pendingAgentQuestions.map((q) => q.messageId))
      const map = new Map<string, AgentQuestionTombstone>()
      const replies = indexAgentQuestionReplies(displayMessages)
      for (const msg of displayMessages) {
        if (!isAgentQuestionMarker(msg) || pendingMarkerIds.has(msg.id)) continue
        const tombstone = buildAgentQuestionTombstone(msg, replies)
        if (tombstone) map.set(msg.id, tombstone)
      }
      return map
    }, [displayMessages, pendingAgentQuestions])

    /** Reply rows the tombstone now speaks for — rendering both would print the
     *  answer twice, back to back. */
    const suppressedReplyMessageIds = useMemo(() => {
      const ids = new Set<string>()
      for (const tombstone of agentQuestionTombstones.values()) {
        if (tombstone.replyMessageId) ids.add(tombstone.replyMessageId)
      }
      return ids
    }, [agentQuestionTombstones])

    const superHiddenRowKeys = useMemo(() => {
      if (superGroupByMessageId.size === 0) return EMPTY_HIDDEN_ROW_KEYS
      const keys = new Set<string>()
      const seenLeads = new Set<string>()
      for (const group of superGroupByMessageId.values()) {
        if (seenLeads.has(group.leadId)) continue
        seenLeads.add(group.leadId)
        if (expandedSuperGroups.has(group.leadId)) continue
        // Folding members are mid-animation at nonzero heights — pinning them
        // to 0 now would desync the height table; they join once committed.
        if (foldingSuperGroups.has(group.leadId)) continue
        for (const memberId of group.memberIds) {
          if (memberId === group.leadId) continue
          const row =
            projectedRowLookup.byMessageId.get(memberId) ||
            projectedRowLookup.byConstituentId.get(memberId)
          if (row) keys.add(row.rowKey)
        }
      }
      return keys.size > 0 ? keys : EMPTY_HIDDEN_ROW_KEYS
    }, [superGroupByMessageId, expandedSuperGroups, foldingSuperGroups, projectedRowLookup])

    /**
     * Every row that renders to zero height, for the virtualizer's height table.
     *
     * Suppressed question replies join the super-group's hidden members here
     * rather than being dropped from the row list: same rowKey, same row count,
     * so gutter ordinals and scroll-spy are untouched. The measure pass skips
     * non-positive slots, so a 0px row can never record its own height — pinning
     * it here is REQUIRED or it sits on a phantom type estimate forever.
     */
    const hiddenRowKeys = useMemo(() => {
      if (suppressedReplyMessageIds.size === 0) return superHiddenRowKeys
      const keys = new Set(superHiddenRowKeys)
      for (const messageId of suppressedReplyMessageIds) {
        const row =
          projectedRowLookup.byMessageId.get(messageId) ||
          projectedRowLookup.byConstituentId.get(messageId)
        if (row) keys.add(row.rowKey)
      }
      return keys.size > 0 ? keys : EMPTY_HIDDEN_ROW_KEYS
    }, [superHiddenRowKeys, suppressedReplyMessageIds, projectedRowLookup])
    const [pendingFocusTarget, setPendingFocusTarget] = useState<{
      messageId: string
      rowKey?: string
      attempt: number
    } | null>(null)
    const findProjectedRowForMessage = useCallback(
      (messageId: string, rowKey?: string) => {
        if (rowKey) {
          const byRowKey = projectedRowLookup.byRowKey.get(rowKey)
          if (byRowKey) return byRowKey
        }
        return (
          projectedRowLookup.byMessageId.get(messageId) ||
          projectedRowLookup.byConstituentId.get(messageId)
        )
      },
      [projectedRowLookup]
    )
    const pendingFocusRowIndex = useMemo(() => {
      if (!pendingFocusTarget) return null
      const row = findProjectedRowForMessage(pendingFocusTarget.messageId, pendingFocusTarget.rowKey)
      if (!row) return null
      const rowPosition = projectedRowLookup.indexByRowKey.get(row.rowKey) ?? -1
      return rowPosition >= 0 ? rowPosition : null
    }, [findProjectedRowForMessage, pendingFocusTarget, projectedRowLookup])
    const externalRestoreAnchorRowIndex = useMemo(() => {
      if (!externalRestoreAnchorMessageId) return null
      const row = findProjectedRowForMessage(externalRestoreAnchorMessageId)
      if (!row) return null
      const rowPosition = projectedRowLookup.indexByRowKey.get(row.rowKey) ?? -1
      return rowPosition >= 0 ? rowPosition : null
    }, [externalRestoreAnchorMessageId, findProjectedRowForMessage, projectedRowLookup])
    const virtualRows = virtualizeEnabled ? projectedRows : EMPTY_VIRTUAL_ROWS
    const {
      window: virtualWindow,
      blockRef: virtualBlockRef,
      spacerBottomRef,
      heights: virtualHeights,
      syncScrollPosition: syncVirtualizerScrollPosition,
      spyRowIndex,
      spyProgress,
      spyViewportFraction
    } = useTranscriptVirtualization({
      enabled: virtualizeEnabled,
      rows: virtualRows,
      scrollRef,
      contentRef,
      chatId: currentChat?.appChatId ?? null,
      autoFollowRef,
      onProgrammaticScrollWrite,
      compactDensity,
      forcedRowIndex: pendingFocusRowIndex ?? externalRestoreAnchorRowIndex,
      activeLiveRowKey: liveMeasurementRowKey,
      expandedRowIds: expandedRowIdsWithLiveViewports,
      hiddenRowKeys
    })
    const virtualHeightOffsets = useMemo(
      () => (virtualizeEnabled ? buildHeightOffsets(virtualHeights) : EMPTY_TRANSCRIPT_HEIGHT_OFFSETS),
      [virtualHeights, virtualizeEnabled]
    )
    const userGutterMarkers = useMemo(
      () =>
        buildTranscriptUserGutterMarkers(
          displayMessages,
          projectedRows,
          virtualizeEnabled ? virtualHeights : undefined,
          collapsedRoundUserMessages
        ),
      [
        collapsedRoundUserMessages,
        displayMessages,
        projectedRows,
        virtualHeights,
        virtualizeEnabled
      ]
    )
    // Scroll-spy: resolve the virtualiser's current anchor-row index to the
    // nearest user-message marker at or above it. Recomputes each scroll frame,
    // but the resolved key changes only when the reader crosses into a new turn.
    const activeScrollRowKey = useMemo(
      () =>
        spyRowIndex === null ? null : findActiveGutterMarkerKey(userGutterMarkers, spyRowIndex),
      [userGutterMarkers, spyRowIndex]
    )
    const [highlightedMessageTarget, setHighlightedMessageTarget] = useState<{
      messageId: string
      rowKey?: string
    } | null>(null)
    const highlightTimerRef = useRef<number | null>(null)
    // Shared glide animator for every rail-initiated jump (marker / ↑ / ↓).
    // Lazily created; cancelled on chat switch + unmount. User input on the
    // scroller interrupts it, so it can never fight a live reader.
    const scrollAnimatorRef = useRef<TranscriptScrollAnimator | null>(null)
    const getScrollAnimator = useCallback((): TranscriptScrollAnimator => {
      if (!scrollAnimatorRef.current) {
        scrollAnimatorRef.current = createTranscriptScrollAnimator()
      }
      return scrollAnimatorRef.current
    }, [])
    useEffect(() => {
      return () => scrollAnimatorRef.current?.cancel()
    }, [])
    const chatId = currentChat?.appChatId ?? null
    const currentChatRenderSignature = useMemo(
      () => transcriptChatRenderSignature(currentChat),
      [currentChat]
    )
    const auxiliaryChatsSignature = useMemo(() => transcriptAuxiliaryChatsSignature(chats), [chats])
    const runningChatIdsSignature = useMemo(
      () => transcriptRunningChatIdsSignature(runningChatIds),
      [runningChatIds]
    )
    const previousChatIdRef = useRef<string | null>(chatId)
    useLayoutEffect(() => {
      if (previousChatIdRef.current === chatId) return
      previousChatIdRef.current = chatId
      setMessageContextMenu(null)
      setExpandedUserMessages(new Set())
      setActivityExpansionByRow(new Map())
      setExpandedSubThreadResults(new Set())
      setActiveParticipantFilterKeys(new Set())
      rowElementCacheRef.current.clear()
      stackCollapseStateRef.current.lastCollapsed.clear()
      stackCollapseStateRef.current.entering.clear()
      setHighlightedMessageTarget(null)
      setPendingFocusTarget(null)
      scrollAnimatorRef.current?.cancel()
      if (highlightTimerRef.current !== null) {
        window.clearTimeout(highlightTimerRef.current)
        highlightTimerRef.current = null
      }
    }, [chatId])
    const prepareManualTranscriptJump = useCallback(() => {
      if (autoFollowRef) autoFollowRef.current = false
      onManualTranscriptJump?.()
    }, [autoFollowRef, onManualTranscriptJump])
    const focusMessageBlock = useCallback(
      (messageId: string, rowKey?: string): boolean => {
        const scroller = scrollRef.current
        if (!scroller) return false
        const row = findProjectedRowForMessage(messageId, rowKey)
        const target = row
          ? scroller.querySelector<HTMLElement>(
              `[data-vrow-id="${escapeDomSelectorValue(row.rowKey)}"]`
            )
          : scroller.querySelector<HTMLElement>(
              `[data-message-id="${escapeDomSelectorValue(messageId)}"]`
            )
        if (!target) return false
        const targetRowKey = row?.rowKey || rowKey
        prepareManualTranscriptJump()
        const targetRect = target.getBoundingClientRect()
        const scrollerRect = scroller.getBoundingClientRect()
        const targetTop = scroller.scrollTop + targetRect.top - scrollerRect.top
        const topOffset = Math.max(56, Math.round(scroller.clientHeight * 0.22))
        const nextScrollTop = Math.max(0, targetTop - topOffset)
        // Runs when the glide lands (or immediately under reduced motion):
        // settle any residual drift from mid-glide re-measures with one small
        // instant correction, then pulse the arrival highlight — the pulse
        // reads best when it fires as the message comes to rest, not 1.5s
        // before arrival.
        const settleAndHighlight = (): void => {
          const settled = row
            ? scroller.querySelector<HTMLElement>(
                `[data-vrow-id="${escapeDomSelectorValue(row.rowKey)}"]`
              )
            : scroller.querySelector<HTMLElement>(
                `[data-message-id="${escapeDomSelectorValue(messageId)}"]`
              )
          if (settled) {
            const settledRect = settled.getBoundingClientRect()
            const liveScrollerRect = scroller.getBoundingClientRect()
            const desired = Math.max(
              0,
              scroller.scrollTop + settledRect.top - liveScrollerRect.top - topOffset
            )
            if (Math.abs(desired - scroller.scrollTop) > 1) {
              scroller.scrollTop = desired
              syncVirtualizerScrollPosition(desired)
            }
          }
          setHighlightedMessageTarget({ messageId, rowKey: targetRowKey })
          if (highlightTimerRef.current !== null) {
            window.clearTimeout(highlightTimerRef.current)
          }
          highlightTimerRef.current = window.setTimeout(() => {
            highlightTimerRef.current = null
            setHighlightedMessageTarget((current) =>
              current?.messageId === messageId && current?.rowKey === targetRowKey ? null : current
            )
          }, 1800)
        }
        getScrollAnimator().animateTo(scroller, nextScrollTop, {
          onFrame: syncVirtualizerScrollPosition,
          onDone: settleAndHighlight
        })
        setPendingFocusTarget((current) =>
          current?.messageId === messageId &&
          (!current.rowKey || !targetRowKey || current.rowKey === targetRowKey)
            ? null
            : current
        )
        return true
      },
      [
        findProjectedRowForMessage,
        getScrollAnimator,
        prepareManualTranscriptJump,
        scrollRef,
        syncVirtualizerScrollPosition
      ]
    )

    const estimateScrollToMessage = useCallback(
      (messageId: string, rowKey?: string, options?: { animate?: boolean }): void => {
        const scroller = scrollRef.current
        if (!scroller) return
        const row = findProjectedRowForMessage(messageId, rowKey)
        if (!row) return
        prepareManualTranscriptJump()
        const rowHeights =
          virtualizeEnabled && virtualHeights.length === projectedRows.length
            ? virtualHeights
            : projectedRows.map((candidate) => candidate.estimatedHeight)
        const rowPosition = projectedRowLookup.indexByRowKey.get(row.rowKey) ?? -1
        if (rowPosition < 0) return
        const estimatedTop =
          virtualizeEnabled && virtualHeights.length === projectedRows.length
            ? sumHeightOffsets(virtualHeightOffsets, 0, rowPosition)
            : sumHeights(rowHeights, 0, rowPosition)
        const nextScrollTop = Math.max(
          0,
          estimatedTop - Math.round(scroller.clientHeight * 0.35)
        )
        if (options?.animate) {
          // First hop of a rail jump: glide toward the estimated position. If
          // the user grabs the scroll mid-glide, abandon the pending focus —
          // their input owns the viewport from that moment.
          getScrollAnimator().animateTo(scroller, nextScrollTop, {
            onFrame: syncVirtualizerScrollPosition,
            onInterrupted: () => setPendingFocusTarget(null)
          })
          return
        }
        scroller.scrollTop = nextScrollTop
        syncVirtualizerScrollPosition(nextScrollTop)
      },
      [
        findProjectedRowForMessage,
        getScrollAnimator,
        prepareManualTranscriptJump,
        projectedRowLookup,
        projectedRows,
        scrollRef,
        syncVirtualizerScrollPosition,
        virtualHeightOffsets,
        virtualHeights,
        virtualizeEnabled
      ]
    )

    const scrollToMessage = useCallback(
      (messageId: string, rowKey?: string): void => {
        // Markers for user messages hidden in a collapsed round carry a
        // SYNTHETIC rowKey that never matches a projected row (by design —
        // see hiddenRoundMarkerRowKey). Strip it here so every downstream
        // lookup (focus, estimate, pending-target clearing) runs id-only;
        // carrying it forward would seed a pending focus target whose rowKey
        // can never be satisfied, which pins the retry loop open forever.
        const effectiveRowKey = isHiddenRoundMarkerRowKey(rowKey) ? undefined : rowKey
        // If the target lives in a collapsed ensemble round, expand it
        // first; the pending-focus retry loop below then finds the row
        // once it re-renders into the window.
        ensureRoundExpandedForMessage(messageId)
        if (focusMessageBlock(messageId, effectiveRowKey)) return

        setPendingFocusTarget({ messageId, rowKey: effectiveRowKey, attempt: 0 })
        estimateScrollToMessage(messageId, effectiveRowKey, { animate: true })
      },
      [ensureRoundExpandedForMessage, estimateScrollToMessage, focusMessageBlock]
    )

    const jumpToTranscriptStart = useCallback(() => {
      const scroller = scrollRef.current
      if (!scroller) return
      prepareManualTranscriptJump()
      getScrollAnimator().animateTo(scroller, 0, { onFrame: syncVirtualizerScrollPosition })
    }, [getScrollAnimator, prepareManualTranscriptJump, scrollRef, syncVirtualizerScrollPosition])

    const jumpToTranscriptEnd = useCallback(() => {
      if (onJumpToLatest) {
        onJumpToLatest()
        const scroller = scrollRef.current
        if (scroller) syncVirtualizerScrollPosition(scroller.scrollHeight)
        return
      }
      const scroller = scrollRef.current
      if (!scroller) return
      getScrollAnimator().animateTo(scroller, scroller.scrollHeight, {
        onFrame: syncVirtualizerScrollPosition,
        // Re-arm auto-follow only on ARRIVAL — arming it at glide start would
        // let the streaming re-pin writes fight the animation frames.
        onDone: () => {
          if (autoFollowRef) autoFollowRef.current = true
        }
      })
    }, [autoFollowRef, getScrollAnimator, onJumpToLatest, scrollRef, syncVirtualizerScrollPosition])

    useEffect(() => {
      const request = jumpToMessageRequest
      if (!request?.messageId) return
      scrollToMessage(request.messageId, request.rowKey)
    }, [
      jumpToMessageRequest?.requestId,
      jumpToMessageRequest?.messageId,
      jumpToMessageRequest?.rowKey,
      scrollToMessage
    ])

    useEffect(() => {
      return () => {
        if (highlightTimerRef.current !== null) {
          window.clearTimeout(highlightTimerRef.current)
          highlightTimerRef.current = null
        }
      }
    }, [])

    // Messages mounted this frame, each paired with its collision-proof
    // `rowKey` (`${id}#${index}`). The window slice when virtualised, else the
    // full list. Keying React + the element map on `rowKey` (not `msg.id`)
    // means duplicate message ids — which exist in historical/imported data —
    // can never make two rows share a DOM node / measurement slot.
    const renderedRows: Array<{ msg: ChatMessage; rowKey: string }> = virtualizeEnabled
      ? virtualRows
          .slice(virtualWindow.startIndex, virtualWindow.endIndex)
          .map((r) => {
            const msg = displayMessages[r.index]
            return msg ? { msg, rowKey: r.rowKey } : null
          })
          .filter((r): r is { msg: ChatMessage; rowKey: string } => Boolean(r))
      : displayMessages.map((msg, index) => ({ msg, rowKey: `${msg.id}#${index}` }))


    useEffect(() => {
      const mountedRowKeys = new Set(renderedRows.map((row) => row.rowKey))
      for (const rowKey of rowElementCacheRef.current.keys()) {
        if (!mountedRowKeys.has(rowKey)) rowElementCacheRef.current.delete(rowKey)
      }
    }, [renderedRows])

    useLayoutEffect(() => {
      if (!pendingFocusTarget) return
      // While a glide toward this target is in flight, hold the retry loop:
      // don't burn attempts or issue competing scroll writes. The effect
      // re-runs naturally each glide frame (renderedRows changes as the
      // window follows), so the first post-landing pass resumes the search.
      if (scrollAnimatorRef.current?.isAnimating()) return
      if (focusMessageBlock(pendingFocusTarget.messageId, pendingFocusTarget.rowKey)) {
        // Termination guarantee: a successful focus means the target is on
        // screen, so this pending target is DONE regardless of whether
        // focusMessageBlock's rowKey-matched clear fired (an id-fallback
        // resolution reports a different rowKey; without this force-clear
        // the effect would re-focus every render — the "maximum update
        // depth" loop). Identity compare so a newer jump is never clobbered.
        setPendingFocusTarget((current) => (current === pendingFocusTarget ? null : current))
        return
      }
      if (pendingFocusTarget.attempt >= 10) return

      estimateScrollToMessage(pendingFocusTarget.messageId, pendingFocusTarget.rowKey, {
        animate: pendingFocusTarget.attempt === 0
      })
      const frame = window.requestAnimationFrame(() => {
        setPendingFocusTarget((current) =>
          current?.messageId === pendingFocusTarget.messageId &&
          current?.rowKey === pendingFocusTarget.rowKey &&
          current?.attempt === pendingFocusTarget.attempt
            ? { ...current, attempt: current.attempt + 1 }
            : current
        )
      })
      return () => window.cancelAnimationFrame(frame)
    }, [estimateScrollToMessage, focusMessageBlock, pendingFocusTarget, renderedRows])

    return (
      <div
        className={`transcript-scroll${isGlobal ? ' is-global' : ''}`}
        data-scope={isGlobal ? 'global' : 'workspace'}
        ref={scrollRef}
      >
        {userMessageGutterEnabled !== false && (
          <TranscriptUserMessageGutter
            key={currentChat?.appChatId || 'transcript-user-gutter'}
            markers={userGutterMarkers}
            activeScrollRowKey={activeScrollRowKey}
            scrollProgress={spyProgress}
            scrollViewportFraction={spyViewportFraction}
            scrollRef={scrollRef}
            contentRef={contentRef}
            currentChat={currentChat}
            onJumpToMessage={scrollToMessage}
            onJumpToStart={jumpToTranscriptStart}
            onJumpToEnd={jumpToTranscriptEnd}
          />
        )}
        <TranscriptParticipantFilterRail
          currentChat={currentChat}
          items={participantFilterItems}
          activeFilterKeys={activeParticipantFilterKeys}
          scrollRef={scrollRef}
          contentRef={contentRef}
          onToggleFilter={toggleParticipantFilter}
        />
        <div
          className={`transcript-inner${virtualizeEnabled ? ' transcript-virtualized' : ''}`}
          ref={contentRef}
        >
          {virtualizeEnabled && (
            <div
              className="vlist-spacer-top"
              style={{ height: virtualWindow.topSpacerPx }}
              aria-hidden
            />
          )}
          {renderedRows.map(({ msg, rowKey }) => {
            const isDelegationCard = isSubThreadDelegationMessage(msg)
            const isReturnCard = isSubThreadReturnMessage(msg)
            const isThreadMessageCard = isThreadMessageTranscriptMessage(msg)
            const isFanoutResultCard = isEnsembleFanoutResultMessage(msg)
            const isGuestReply = isGuestParticipantReplyMessage(msg)
            const isCollaboratorComment = isHumanCollaboratorComment(msg)
            // Deliberately a SEPARATE const rather than widening the one above:
            // `isCollaboratorComment` also gates the "Insert as draft" promote
            // action, and offering that on a contribution that has ALREADY been
            // delivered invites the host to re-inject it as their own prompt.
            const isDeliveredExternal = isDeliveredExternalContribution(msg)
            const deliveredExternalName =
              (isDeliveredExternal &&
                typeof msg.metadata?.collaboratorDisplayName === 'string' &&
                msg.metadata.collaboratorDisplayName) ||
              'Collaborator'
            const isToolActivityStack = msg.role === 'tool' && (msg.toolActivities?.length || 0) > 0
            const hasToolActivitiesForActions = (msg.toolActivities?.length || 0) > 0
            const isParticipantHealth = msg.metadata?.kind === 'ensembleParticipantHealth'
            const isProviderRunFailure = msg.metadata?.kind === 'providerRunFailure'
            const isContextCompaction = msg.metadata?.kind === 'contextCompaction'
            const isTaskWraithCloseout = msg.metadata?.kind === TASKWRAITH_CLOSEOUT_KIND
            const isRoundHeader = isEnsembleRoundHeaderMessage(msg)
            const isFanoutViewportHeader = isEnsembleFanoutViewportHeaderMessage(msg)
            const collaboratorMeta = isCollaboratorComment ? humanCollaboratorMetadata(msg) : null
            const boundaryRun = displayRunBoundaryByMessageId.get(msg.id)
            const isSideChatSeedMessage = Boolean(
              sideChatSeedMessageId && msg.id === sideChatSeedMessageId
            )
            const isPinned = typeof msg.metadata?.pinnedAt === 'number'
            const groupedToolMessageIds = hasToolActivitiesForActions
              ? groupedTranscriptMessageIds(msg).filter(
                  (messageId) => messageById.get(messageId)?.role === 'tool'
                )
              : []
            const toolActivityActionMessageIds = hasToolActivitiesForActions
              ? groupedToolMessageIds.length > 0
                ? groupedToolMessageIds
                : [msg.id]
              : []
            const toolActivityActionStateKey = hasToolActivitiesForActions
              ? `${toolActivityActionMessageIds
                  .map((messageId) => {
                    const sourceMessage = messageById.get(messageId) || (messageId === msg.id ? msg : undefined)
                    return [
                      messageId,
                      sourceMessage?.metadata?.pinnedAt || '',
                      sourceMessage ? readMessageFeedbackVote(sourceMessage) || '' : ''
                    ].join(':')
                  })
                  .join('\u0000')}|copy:${copiedId?.includes(':thinking') ? copiedId : ''}`
              : ''
            const thinkingTraceActions: ThinkingTraceActionsConfig | undefined = hasToolActivitiesForActions
              ? {
                  messageId: toolActivityActionMessageIds[0] || msg.id,
                  label: 'thinking trace',
                  copiedId,
                  pinned: isPinned,
                  thumbsVote: readMessageFeedbackVote(msg),
                  messageIdForActivity: (activity) =>
                    toolActivityMessageIdByActivityId.get(activity.id) ||
                    toolActivityActionMessageIds[0] ||
                    msg.id,
                  stateForMessage: (messageId) => {
                    const sourceMessage = messageById.get(messageId) || msg
                    return {
                      pinned: typeof sourceMessage.metadata?.pinnedAt === 'number',
                      thumbsVote: readMessageFeedbackVote(sourceMessage)
                    }
                  },
                  copy,
                  onAddToPrompt: onAddMessageToPrompt,
                  onTogglePin: onTogglePinMessage,
                  onThumbsUp: onMessageFeedback
                    ? (messageId) => onMessageFeedback(messageId, 'up')
                    : undefined,
                  onThumbsDown: onMessageFeedback
                    ? (messageId) => onMessageFeedback(messageId, 'down')
                    : undefined,
                  onDelete: onDeleteMessage,
                  onOpenSideChat: onOpenSideChatFromMessage
                    ? (messageId, content) => {
                        const sourceMessage = messageById.get(messageId) || msg
                        onOpenSideChatFromMessage({ ...sourceMessage, content })
                      }
                    : undefined
                }
              : undefined
            const roundHeaderData = isRoundHeader ? readEnsembleRoundHeader(msg) : null
            const footerCopyContent = isRoundHeader
              ? buildRoundTranscriptCopyText(
                  groupedMessages,
                  roundHeaderData?.roundId ||
                    (typeof msg.metadata?.ensembleRoundId === 'string'
                      ? msg.metadata.ensembleRoundId
                      : '')
                )
              : !isDelegationCard &&
                  !isReturnCard &&
                  !isFanoutViewportHeader &&
                  !isToolActivityStack &&
                  !isParticipantHealth &&
                  !isProviderRunFailure &&
                  !isContextCompaction &&
                  typeof msg.content === 'string'
                ? msg.content
                : undefined
            const footerLabel = isRoundHeader
              ? 'round transcript'
              : isFanoutViewportHeader
                ? 'fan-out'
              : msg.role === 'user'
                ? 'user message'
                : isThreadMessageCard
                  ? 'peer thread message'
                : isFanoutResultCard
                  ? 'fan-out result'
                : isGuestReply
                  ? 'guest participant message'
                  : isCollaboratorComment || isDeliveredExternal
                    ? 'collaborator message'
                    : msg.role === 'tool'
                      ? 'tool message'
                      : `${msg.role} message`
            const isPinnedMessageTarget = highlightedMessageTarget
              ? highlightedMessageTarget.rowKey
                ? highlightedMessageTarget.rowKey === rowKey
                : highlightedMessageTarget.messageId === msg.id
              : false
            const activityExpansionIds = activityExpansionByRow.get(rowKey)
            const liveViewportStackKey = isToolActivityStack ? toolStackStateKey(msg) : ''
            const liveViewportExpanded = liveViewportStackKey
              ? expandedLiveViewportStacks.has(liveViewportStackKey)
              : false
            const liveViewportActive = isToolActivityStack && rowKey === liveMeasurementRowKey
            // Settled-stack auto-collapse: fold the whole stack into a
            // one-line summary once the conversation has moved past it.
            const stackAutoCollapsible =
              isToolActivityStack &&
              shouldAutoCollapseActivityStack({
                activities: msg.toolActivities || [],
                isLiveRow: liveViewportActive,
                isLastRow: msg.id === lastDisplayMessageId
              })
            const collapsedStackExpanded =
              stackAutoCollapsible && liveViewportStackKey
                ? expandedCollapsedStacks.has(liveViewportStackKey)
                : false
            const pendingQuestionsForRow = pendingAgentQuestions.filter(
              (question) => question.messageId === msg.id
            )
            // Plain system notices fold the same way: one line ("System ·
            // @-mention: extra turn appended…") once the conversation moved
            // past them. Special system cards (round headers, health /
            // compaction / failure / closeout, collaborator comments) and
            // rows carrying interactive attachments keep their full
            // rendering; pinned notices stay open (the user marked them).
            const isPlainSystemNotice =
              plainSystemNoticeMessage(msg) &&
              pendingQuestionsForRow.length === 0 &&
              !(pendingPlanChoice && pendingPlanChoice.messageId === msg.id)
            const systemAutoCollapsible =
              isPlainSystemNotice &&
              msg.id !== lastDisplayMessageId &&
              !isPinned &&
              !isPinnedMessageTarget
            const collapsedSystemExpanded =
              systemAutoCollapsible && expandedCollapsedStacks.has(msg.id)
            let collapsedStackKey = stackAutoCollapsible
              ? `collapsible:${collapsedStackExpanded ? 'open' : 'closed'}`
              : systemAutoCollapsible
                ? `system:${collapsedSystemExpanded ? 'open' : 'closed'}`
                : ''
            // Second-level fold: adjacent one-liners condensed into one line.
            const superGroup = superGroupByMessageId.get(msg.id) || null
            const isSuperLead = Boolean(superGroup && superGroup.leadId === msg.id)
            const superGroupExpanded = Boolean(
              superGroup && expandedSuperGroups.has(superGroup.leadId)
            )
            const superGroupFoldPhase = Boolean(
              superGroup && !superGroupExpanded && foldingSuperGroups.has(superGroup.leadId)
            )
            const superGroupFolding = superGroupFoldPhase && !isSuperLead
            // The lead swaps to the merged one-liner while its members fold —
            // it fades the new line in rather than height-folding.
            const superLeadEntering = superGroupFoldPhase && isSuperLead
            const superGroupHidden = Boolean(
              superGroup && !superGroupExpanded && !isSuperLead && !superGroupFolding
            )
            // The settled question card reports this answer already, so the
            // user-reply row it was appended as renders to zero height rather
            // than printing the same text again directly beneath the card.
            const questionReplyHidden = suppressedReplyMessageIds.has(msg.id)
            const questionTombstone = agentQuestionTombstones.get(msg.id) ?? null
            const superGroupKey = superGroup
              ? `${superGroup.leadId}:${superGroup.size}:${
                  superGroupExpanded ? 'open' : superGroupFoldPhase ? 'folding' : 'closed'
                }:${isSuperLead ? 'lead' : 'member'}`
              : ''
            const superSummary =
              isSuperLead && superGroup
                ? summarizeCollapsedSuperGroup({
                    activities: superGroup.activities,
                    systemCount: superGroup.systemCount,
                    firstSystemPreview: superGroup.firstSystemPreview
                  })
                : null
            // Level-1 roll-up: when a settled stack first swaps to its
            // one-liner, animate the row height down from the slot's last
            // measured height instead of teleporting. Super-group members are
            // excluded — the fold-out phase owns their height; first sighting
            // of a row (chat open, fresh mount) never animates.
            let stackCollapseEntering = false
            let stackCollapseFromPx = 0
            if (isToolActivityStack && liveViewportStackKey && virtualizeEnabled) {
              const collapseState = stackCollapseStateRef.current
              const renderedCollapsed =
                stackAutoCollapsible &&
                !collapsedStackExpanded &&
                !superGroupHidden &&
                !superGroupFolding &&
                !(isSuperLead && superSummary)
              const prevCollapsed = collapseState.lastCollapsed.get(liveViewportStackKey)
              collapseState.lastCollapsed.set(liveViewportStackKey, renderedCollapsed)
              if (!renderedCollapsed) {
                collapseState.entering.delete(liveViewportStackKey)
              } else if (
                prevCollapsed === false &&
                !collapseState.entering.has(liveViewportStackKey) &&
                !prefersReducedMotionNow()
              ) {
                const projIndex = Number(rowKey.slice(rowKey.lastIndexOf('#') + 1))
                const measured = Number.isFinite(projIndex) ? virtualHeights[projIndex] : undefined
                if (typeof measured === 'number' && measured > 72) {
                  collapseState.entering.set(liveViewportStackKey, Math.round(measured))
                }
              }
              const fromPx = collapseState.entering.get(liveViewportStackKey)
              if (fromPx) {
                stackCollapseEntering = true
                stackCollapseFromPx = fromPx
                collapsedStackKey = `${collapsedStackKey}:entering`
              }
            }
            const pendingPlanChoiceKey =
              pendingPlanChoice && pendingPlanChoice.messageId === msg.id
                ? [
                    pendingPlanChoice.messageId,
                    pendingPlanChoice.question,
                    pendingPlanChoice.options.join('\u0000')
                  ].join(':')
                : ''
            const shouldSurfacePlanCard = msg.metadata?.proposedPlan
              ? shouldSurfaceProposedPlanCard({
                  chatKind: currentChat?.chatKind,
                  bossmanParticipantId: currentChat?.ensemble?.bossmanParticipantId,
                  fallbackOwnerParticipantId: undefined,
                  messageParticipantId:
                    typeof msg.metadata?.ensembleParticipantId === 'string'
                      ? msg.metadata?.ensembleParticipantId
                      : undefined,
                  isPlanMode: currentChat?.workflowMode === 'plan',
                  hasExplicitProposedPlanBlock: Boolean(msg.metadata?.proposedPlan)
                })
              : false
            const isModalOwnedPendingPlan =
              pendingProposedPlan?.messageId === msg.id &&
              msg.metadata?.proposedPlan?.status === 'pending'
            const pendingAgentQuestionsKey = pendingQuestionsForRow
              .map((question) => `${question.questionId}:${question.askedAt}`)
              .join('\u0000')
            const auxiliaryKey =
              isDelegationCard || isReturnCard
                ? `${runningChatIdsSignature}|${auxiliaryChatsSignature}`
                : ''
            const pendingProposedPlanKey = pendingProposedPlan?.messageId === msg.id
              ? `${pendingProposedPlan?.messageId || ''}:plan-modal`
              : ''
            const auxiliaryKeyWithPendingPlan = auxiliaryKey
              ? `${auxiliaryKey}|${pendingProposedPlanKey}`
              : pendingProposedPlanKey
            const auxiliaryKeyWithToolActions = [
              auxiliaryKeyWithPendingPlan,
              toolActivityActionStateKey
            ]
              .filter(Boolean)
              .join('|')
            const isLiveRevealRow = rowKey === liveRevealRowKey
            const revealLifecycleKey = `${revealChatId || 'chat'}:${rowKey}`
            const usesRevealLifecycle =
              revealEnabled &&
              (msg.role === 'assistant' || isGuestReply) &&
              (isLiveRevealRow || revealLifecycleRowKeys.has(revealLifecycleKey))
            const revealKey = usesRevealLifecycle
              ? `reveal:${revealRunId || msg.runId || msg.id}:${isLiveRevealRow ? 'live' : 'drain'}`
              : 'plain'
            const assistantRun =
              msg.runId && currentChat?.runs
                ? currentChat.runs.find((run) => run.runId === msg.runId) ||
                  (currentRun?.runId === msg.runId ? currentRun : null)
                : currentRun?.runId === msg.runId
                  ? currentRun
                  : null
            const assistantRunModel = assistantRun?.actualModel || assistantRun?.requestedModel || null
            const assistantRevealProvider =
              providerIdFromUnknown(msg.metadata?.ensembleProvider) ||
              providerIdFromUnknown(msg.metadata?.guestProvider) ||
              providerIdFromUnknown(assistantRun?.provider) ||
              currentProvider
            const assistantRevealModel =
              stringFromUnknown(msg.metadata?.ensembleModel) ||
              stringFromUnknown(msg.metadata?.guestModel) ||
              stringFromUnknown(msg.metadata?.providerModel) ||
              assistantRunModel
            const activityStackHeader = isToolActivityStack ? (
              <ActivityStackSpeakerHeader
                message={msg}
                chat={currentChat}
                run={boundaryRun || assistantRun}
                fallbackProvider={currentProvider}
                fallbackProviderLabel={currentProviderLabel}
              />
            ) : null
            const assistantRunModelKey =
              msg.role === 'assistant' || isGuestReply
                ? `${assistantRun?.runId || ''}:${assistantRunModel || ''}`
                : ''
            const renameContinuity =
              msg.role === 'assistant'
                ? deriveParticipantRenameContinuity(
                    msg,
                    currentChat?.ensemble?.participants,
                    currentChat?.ensemble?.sessionActivityLedger
                  )
                : null
            const renameContinuityKey = renameContinuity
              ? `${renameContinuity.fromRole}\u0000${renameContinuity.currentRole}`
              : ''
            const rowSignature: TranscriptRowRenderSignature = {
              rowKey,
              message: msg,
              messageSignature: transcriptMessageRenderSignature(msg),
              ...(boundaryRun ? { boundaryRun } : {}),
              chatSignature: currentChatRenderSignature,
              providerLabel: currentProviderLabel,
              provider: currentProvider,
              ...(currentWorkspacePath ? { workspacePath: currentWorkspacePath } : {}),
              compactDensity,
              liveActivityViewport,
              liveActivityViewportActive: liveViewportActive,
              virtualized: virtualizeEnabled,
              isGlobal,
              sideChatSeed: isSideChatSeedMessage,
              highlighted: isPinnedMessageTarget,
              copied: copiedId === msg.id,
              pinned: isPinned,
              feedbackVote: readMessageFeedbackVote(msg),
              expandedUser: expandedUserMessages.has(msg.id),
              activityExpansionKey: activityExpansionIds
                ? Array.from(activityExpansionIds).sort().join('\u0000')
                : '',
              subThreadExpanded: expandedSubThreadResults.has(rowKey),
              fanoutExpanded: isFanoutViewportHeader
                ? expandedFanoutViewports.has(msg.id)
                : expandedFanoutResults.has(rowKey),
              liveViewportExpanded,
              collapsedStackKey,
              superGroupKey,
              pendingPlanChoiceKey,
              pendingAgentQuestionsKey,
              agentQuestionTombstoneKey: agentQuestionTombstoneKey(
                questionTombstone,
                questionReplyHidden
              ),
              assistantRunModelKey,
              renameContinuityKey,
              auxiliaryKey: auxiliaryKeyWithToolActions,
              revealKey,
              callbackRefs: [
                onMessageSelectionCandidate,
                onOpenSubThread,
                onOpenSubThreadInSidePanel,
                onInspectRun,
                onOpenSideChatFromRun,
                onCopyMessage,
                onAddMessageToPrompt,
                onTogglePinMessage,
                onMessageFeedback,
                onDeleteMessage,
                onOpenSideChatFromMessage,
                onPromoteCollaboratorComment,
                onOpenFileChangeInWorkbench,
                onPlanChoiceSubmit,
                onProposedPlanApprove,
                onProposedPlanDismiss,
                onProposedPlanCustom,
                onAgentQuestionSubmit,
                onAgentQuestionDismiss,
                onPreviewImage,
                onDetachToPane,
                setActivityExpansionForRow,
                setSubThreadResultExpanded,
                setFanoutResultExpanded,
                setFanoutViewportExpanded,
                setLiveViewportExpandedForStack,
                setCollapsedStackExpanded,
                setSuperGroupExpanded,
                toggleUserMessageExpanded,
                setRoundExpanded
              ]
            }
            const cachedRow = rowElementCacheRef.current.get(rowKey)
            if (cachedRow && transcriptRowRenderSignatureEqual(cachedRow.signature, rowSignature)) {
              return cachedRow.element
            }
            const element = (
              <div
                key={`message-block-${rowKey}`}
                className={`transcript-message-block${
                  isSideChatSeedMessage ? ' is-side-chat-seed' : ''
                }${isPinnedMessageTarget ? ' is-pinned-message-target' : ''}${
                  // Hidden super-group members keep their block mounted (row
                  // ordinals + measurement stability) but must contribute ZERO
                  // layout space — without this class each empty block donated
                  // one --space-lg of flex-gap/margin, stacking into the
                  // "random gap below the merged one-liner" that scaled with
                  // member count. CSS zeroes it per rendering mode.
                  superGroupHidden ? ' is-super-hidden' : ''
                }${questionReplyHidden ? ' is-row-hidden' : ''}${
                  // Fold-out phase: member stays mounted while CSS transitions
                  // its height to 0; the hidden state commits ~300ms later on
                  // an already-invisible row.
                  superGroupFolding ? ' is-super-folding' : ''
                }${superLeadEntering ? ' is-super-lead-entering' : ''}${
                  stackCollapseEntering ? ' is-stack-collapsing' : ''
                }`}
                style={
                  stackCollapseEntering
                    ? ({ '--collapse-from': `${stackCollapseFromPx}px` } as React.CSSProperties)
                    : undefined
                }
                data-vrow-id={rowKey}
                data-message-id={msg.id}
                // Selecting the side-chat seed on pointer hover made this full-row
                // highlight chase the cursor through the transcript. Keep the
                // keyboard path, while pointer users choose a seed explicitly.
                onFocus={() => onMessageSelectionCandidate?.(msg)}
                ref={virtualizeEnabled ? virtualBlockRef : undefined}
              >
                {superGroupHidden || questionReplyHidden ? null : (
                  <>
                    {isSuperLead && superGroup && superSummary ? (
                      <CollapsedTranscriptRow
                        header={
                          superGroup.headerMessage ? (
                            <ActivityStackSpeakerHeader
                              message={superGroup.headerMessage}
                              chat={currentChat}
                              fallbackProvider={currentProvider}
                              fallbackProviderLabel={currentProviderLabel}
                            />
                          ) : null
                        }
                        metaLabel={superGroup.headerMessage ? undefined : 'System'}
                        label={superSummary.label}
                        labelParts={superSummary.parts}
                        icons={<CollapsedStackIconStrip families={superSummary.families} />}
                        diffStats={superSummary.diff}
                        compact={!superGroup.headerMessage}
                        errored={superSummary.errorCount > 0}
                        expanded={superGroupExpanded}
                        onToggle={(expanded) => setSuperGroupExpanded(superGroup.leadId, expanded)}
                        ariaTargetLabel={`${superGroup.size} collapsed transcript steps`}
                      />
                    ) : null}
                    {isSuperLead && !superGroupExpanded ? null : isRoundHeader ? (
                  <EnsembleRoundCardHeader
                    key={msg.id}
                    message={msg}
                    onSetExpanded={setRoundExpanded}
                  />
                ) : isFanoutViewportHeader ? (
                  <EnsembleFanoutViewportHeader
                    key={msg.id}
                    message={msg}
                    onSetExpanded={setFanoutViewportExpanded}
                  />
                ) : isDelegationCard || isReturnCard ? (
                  <div
                    key={msg.id}
                    className={`message-group ${
                      isReturnCard ? 'subthread-return-message' : ''
                    } ${isDelegationCard ? 'subthread-delegation-message' : ''}${
                      isGuestReply ? ' guest-participant-reply-message' : ''
                    }${isCollaboratorComment ? ' human-collaborator-comment-message' : ''
                    }`}
                    onContextMenu={
                      isReturnCard
                        ? (event) =>
                            openMessageContextMenu(
                              event,
                              msg,
                              subThreadReturnBody(msg.content),
                              'sub-thread result',
                              { copySource: 'subthread-return-body' }
                            )
                        : undefined
                    }
                  >
                    {isDelegationCard ? (
                      <SubThreadDelegationCard
                        message={msg}
                        chats={chats}
                        runningChatIds={runningChatIds}
                        onOpenSubThread={onOpenSubThread}
                        onOpenSubThreadInSidePanel={onOpenSubThreadInSidePanel}
                      />
                    ) : (
                      <SubThreadReturnCard
                        message={msg}
                        chat={currentChat || undefined}
                        onOpenSubThread={onOpenSubThread}
                        onOpenSubThreadInSidePanel={onOpenSubThreadInSidePanel}
                        onCopyMessage={onCopyMessage}
                        onAddMessageToPrompt={onAddMessageToPrompt}
                        onTogglePinMessage={onTogglePinMessage}
                        onDeleteMessage={onDeleteMessage}
                        onOpenSideChatFromMessage={onOpenSideChatFromMessage}
                        pinned={isPinned}
                        copied={copiedId === msg.id}
                        resultExpanded={expandedSubThreadResults.has(rowKey)}
                        onResultExpandedChange={(expanded) =>
                          setSubThreadResultExpanded(rowKey, expanded)
                        }
                      />
                    )}
                  </div>
                ) : isThreadMessageCard ? (
                  <div
                    key={msg.id}
                    className="message-group thread-message-transcript-message"
                    onContextMenu={(event) =>
                      openMessageContextMenu(
                        event,
                        msg,
                        msg.content || '',
                        'peer thread message',
                        { copySource: 'static' }
                      )
                    }
                  >
                    <ThreadMessageTranscriptCard message={msg} />
                  </div>
                ) : isFanoutResultCard ? (
                  <div
                    key={msg.id}
                    className="message-group ensemble-fanout-result-message"
                    onContextMenu={(event) =>
                      openMessageContextMenu(event, msg, msg.content || '', 'fan-out result', {
                        copySource: 'static'
                      })
                    }
                  >
                    <EnsembleFanoutResultCard
                      message={msg}
                      chat={currentChat || undefined}
                      workspacePath={currentWorkspacePath}
                      streamRunId={
                        typeof msg.runId === 'string' && msg.runId
                          ? msg.runId
                          : boundaryRun?.runId
                      }
                      working={isEnsembleFanoutLaneWorking(msg, workingLaneParticipantIds)}
                      expanded={expandedFanoutResults.has(rowKey)}
                      onExpandedChange={(expanded) => setFanoutResultExpanded(rowKey, expanded)}
                      compactDensity={compactDensity}
                      expandedActivityIds={activityExpansionIds ?? EMPTY_ACTIVITY_EXPANSION}
                      onExpandedActivityIdsChange={(next) =>
                        setActivityExpansionForRow(rowKey, next)
                      }
                      onOpenFileChangeInWorkbench={onOpenFileChangeInWorkbench}
                      onPreviewImage={onPreviewImage}
                      onDetachToPane={onDetachToPane}
                      thinkingTraceActions={thinkingTraceActions}
                    />
                  </div>
                ) : isToolActivityStack && stackAutoCollapsible ? (
                  <CollapsedActivityStackRow
                    key={msg.id}
                    header={activityStackHeader}
                    activities={msg.toolActivities || []}
                    showDiffStats
                    expanded={collapsedStackExpanded}
                    onToggle={(expanded) =>
                      setCollapsedStackExpanded(liveViewportStackKey, expanded)
                    }
                  >
                    <ActivityStack
                      activities={msg.toolActivities || []}
                      header={null}
                      workspacePath={currentWorkspacePath}
                      provider={getChatProvider(currentChat)}
                      chatId={currentChat?.appChatId}
                      runId={msg.runId || boundaryRun?.runId}
                      chat={currentChat || undefined}
                      compactDensity={compactDensity}
                      liveActivityViewport={liveActivityViewport}
                      liveActivityViewportActive={false}
                      liveActivityViewportExpanded={liveViewportExpanded}
                      onLiveActivityViewportExpandedChange={(expanded) =>
                        setLiveViewportExpandedForStack(liveViewportStackKey, expanded)
                      }
                      expandedActivityIds={activityExpansionIds ?? EMPTY_ACTIVITY_EXPANSION}
                      onExpandedActivityIdsChange={(next) =>
                        setActivityExpansionForRow(rowKey, next)
                      }
                      onOpenFileChangeInWorkbench={onOpenFileChangeInWorkbench}
                      showDiffStats
                      thinkingTraceActions={thinkingTraceActions}
                    />
                  </CollapsedActivityStackRow>
                ) : isToolActivityStack ? (
                  <ActivityStack
                    key={msg.id}
                    activities={msg.toolActivities || []}
                    header={activityStackHeader}
                    workspacePath={currentWorkspacePath}
                    provider={getChatProvider(currentChat)}
                    chatId={currentChat?.appChatId}
                    runId={msg.runId || boundaryRun?.runId}
                    chat={currentChat || undefined}
                    compactDensity={compactDensity}
                    liveActivityViewport={liveActivityViewport}
                    liveActivityViewportActive={liveViewportActive}
                    liveActivityViewportExpanded={liveViewportExpanded}
                    onLiveActivityViewportExpandedChange={(expanded) =>
                      setLiveViewportExpandedForStack(liveViewportStackKey, expanded)
                    }
                    expandedActivityIds={activityExpansionIds ?? EMPTY_ACTIVITY_EXPANSION}
                    onExpandedActivityIdsChange={(next) => setActivityExpansionForRow(rowKey, next)}
                    onOpenFileChangeInWorkbench={onOpenFileChangeInWorkbench}
                    showDiffStats
                    thinkingTraceActions={thinkingTraceActions}
                  />
                ) : msg.role === 'tool' ? (
                  <div key={msg.id} className="message-group tool-message-fallback">
                    <div className="message-meta">Tool</div>
                    <div
                      className="message-bubble system tool-message-fallback-bubble"
                      onContextMenu={(event) =>
                        openMessageContextMenu(event, msg, msg.content || '', 'tool message')
                      }
                    >
                      {msg.content ? (
                        <MarkdownMessage content={msg.content} chat={currentChat || undefined} />
                      ) : (
                        <span>Tool event recorded without displayable details.</span>
                      )}
                    </div>
                  </div>
                ) : isParticipantHealth ? (
                  /*
                    1.0.5-EW29 — Structured participant-health pre-flight
                    summary. Rendered as a chip-strip card instead of a
                    plain system-message bubble. The card component
                    derives everything it needs (provider, role, status,
                    failure reason) from `msg.metadata.entries`. The
                    text variant on `msg.content` is the fallback for
                    older transcripts / exports.
                  */
                  <ParticipantHealthCard key={msg.id} message={msg} />
                ) : isContextCompaction && !systemAutoCollapsible ? (
                  /*
                    Provider context compaction (auto or manual), rendered in
                    the tool-call row idiom. Reached only while the record is
                    NOT fold-eligible (tail row, pinned, jump target) — once
                    the conversation moves past it, the systemAutoCollapsible
                    lane below folds it into a one-liner exactly like other
                    settled rows, with this row as the expanded body.
                    `msg.content` carries the plain-text summary as the
                    fallback for older transcripts, exports, and the iOS
                    system-row projection.
                  */
                  <ContextCompactionCard key={msg.id} message={msg} />
                ) : isProviderRunFailure ? (
                  <ProviderRunFailureCard
                    key={msg.id}
                    message={msg}
                    onCopy={onCopyMessage}
                    onAddToPrompt={onAddMessageToPrompt}
                    onContextMenu={(event, copyText) =>
                      openMessageContextMenu(event, msg, copyText, 'provider failure', {
                        copyOnly: true,
                        copySource: 'static'
                      })
                    }
                    copied={copiedId === msg.id}
                  />
                ) : msg.metadata?.seatChange ? (
                  <SeatChangeRow key={msg.id} message={msg} />
                ) : systemAutoCollapsible ? (
                  <CollapsedTranscriptRow
                    key={msg.id}
                    header={null}
                    metaLabel={
                      isContextCompaction ? contextCompactionMessageMetaLabel(msg) : 'System'
                    }
                    label={collapsedSystemNoticeLabel(msg.content)}
                    icons={
                      isContextCompaction ? (
                        <span
                          className={`collapsed-context-compaction-glyph ${
                            contextCompactionMessageFailed(msg) ? 'is-failed' : 'is-completed'
                          }`}
                          aria-hidden
                        >
                          <ContextCompactionGlyph failed={contextCompactionMessageFailed(msg)} />
                        </span>
                      ) : undefined
                    }
                    errored={isContextCompaction && contextCompactionMessageFailed(msg)}
                    compact
                    expanded={collapsedSystemExpanded}
                    onToggle={(expanded) => setCollapsedStackExpanded(msg.id, expanded)}
                    ariaTargetLabel={
                      isContextCompaction ? 'context compaction record' : 'system notice'
                    }
                  >
                    {collapsedSystemExpanded ? (
                      isContextCompaction ? (
                        <ContextCompactionCard message={msg} />
                      ) : (
                        <div className="message-group">
                          <div
                            className={`message-bubble system${ensembleRoundStatusClass(msg)}`}
                            onContextMenu={(event) =>
                              openMessageContextMenu(event, msg, msg.content || '', 'system message')
                            }
                          >
                            <MarkdownMessage content={msg.content} chat={currentChat || undefined} />
                          </div>
                        </div>
                      )
                    ) : null}
                  </CollapsedTranscriptRow>
                ) : (
                  <div
                    key={msg.id}
                    className={`message-group ${
                      isReturnCard ? 'subthread-return-message' : ''
                    } ${isDelegationCard ? 'subthread-delegation-message' : ''}${
                      isGuestReply ? ' guest-participant-reply-message' : ''
                    }${
                      isCollaboratorComment || isDeliveredExternal
                        ? ' human-collaborator-comment-message'
                        : ''
                    }${
                      isTaskWraithCloseout ? ' taskwraith-closeout-message' : ''
                    }`}
                  >
                    {(() => {
                      // Provider-aware label rendering. Solo chats: the
                      // chat-level provider colours the whole label.
                      // Ensemble chats: each message carries its own
                      // `ensembleProvider` metadata so each assistant
                      // message gets coloured by *who actually spoke*
                      // even when the chat-level provider differs.
                      // CSS in `main.css` keys off `.provider-{name}`
                      // on `.message-meta` to tint with
                      // `--provider-{name}-color`.
                      if (msg.role === 'user') {
                        // `user-meta` class is the seam the per-user
                        // `userBubbleColor` appearance setting hooks
                        // into to tint the "You" label with the same
                        // hue as the bubble. See `[data-user-bubble-
                        // color]` rules in `main.css`.
                        return <div className="message-meta user-meta">You</div>
                      }
                      if (msg.role === 'error') {
                        return <div className="message-meta">Error</div>
                      }
                      if (isDeliveredExternal) {
                        // `humanCollaboratorMetadata` returns null for this kind,
                        // so the name is read off the message directly. Label +
                        // badge as separate elements, not the flat
                        // "Alex / External" string `displayParticipantLabel`
                        // carries: the caution tint lives on the badge, and
                        // flattening it loses exactly the signal it exists for.
                        return (
                          <div className="message-meta human-collaborator-meta">
                            <span className="message-meta-label">{deliveredExternalName}</span>
                            <span
                              className="message-meta-model-badge human-collaborator-badge"
                              title="External, untrusted collaborator contribution — you approved it, and it was delivered at this seat's turn"
                            >
                              External
                            </span>
                            {msg.metadata?.outOfPosition === true && (
                              /* The round ended before this seat's position, so
                               * the end-of-round sweep delivered it. Say so,
                               * rather than implying the panel reached them. */
                              <span
                                className="message-meta-model-badge human-collaborator-badge"
                                title="The round ended before this seat's turn; delivered by the end-of-round sweep."
                              >
                                Out of position
                              </span>
                            )}
                          </div>
                        )
                      }
                      if (isCollaboratorComment) {
                        return (
                          <div className="message-meta human-collaborator-meta">
                            <span className="message-meta-label">
                              {collaboratorMeta?.collaboratorDisplayName || 'Collaborator'}
                            </span>
                            <span
                              className="message-meta-model-badge human-collaborator-badge"
                              title="External, untrusted collaborator comment"
                            >
                              External
                            </span>
                            {collaboratorMeta?.contributionKind === 'requestHostAction' && (
                              /* P2b: a structured request for the HOST to act —
                               * it went to you for review, never to the AI. */
                              <span
                                className="message-meta-model-badge human-collaborator-badge human-collaborator-action-request"
                                title="The collaborator asked you to take an action. Review it; nothing reaches the AI unless you insert and send it."
                              >
                                Action request
                              </span>
                            )}
                          </div>
                        )
                      }
                      if (isTaskWraithCloseout) {
                        const closeoutProvider = closeoutProviderFromMetadata(msg.metadata)
                        const source = msg.metadata?.closeoutSource
                        // Deterministic-fallback close-outs render "TaskWraith"
                        // with no source badge — the "deterministic" chip read as
                        // noise. Provider-generated close-outs still note their
                        // source ("via Claude" / "via Foundation Models").
                        const closeoutModel =
                          typeof msg.metadata?.closeoutModel === 'string'
                            ? msg.metadata.closeoutModel.replace(/^Apple\s+/, '').trim()
                            : ''
                        const closeoutProviderClass = closeoutProvider
                          ? resolveProviderHueClass(closeoutProvider, closeoutModel)
                          : null
                        const badge =
                          source === 'deterministicFallback'
                            ? null
                            : closeoutProvider
                              ? `via ${getProviderLabel(closeoutProvider)}`
                              : closeoutModel
                                ? `via ${closeoutModel}`
                                : 'generated'
                        return (
                          <div className="message-meta taskwraith-closeout-meta">
                            <span className="message-meta-label">TaskWraith</span>
                            {badge && (
                              <span
                                className={`message-meta-model-badge taskwraith-closeout-badge${
                                  closeoutProviderClass
                                    ? ` provider-${closeoutProviderClass}`
                                    : ''
                                }`}
                                title={
                                  closeoutProvider
                                    ? `Close-out generated via ${getProviderLabel(closeoutProvider)}`
                                    : closeoutModel
                                      ? `Close-out summarized on-device by ${msg.metadata?.closeoutModel}`
                                      : 'TaskWraith close-out'
                                }
                              >
                                {badge}
                              </span>
                            )}
                          </div>
                        )
                      }
                      if (msg.role === 'assistant' || isGuestReply) {
                        const rawChatPooledIdentity =
                          currentChat?.providerMetadata?.pooledAgentIdentity
                        const chatPooledIdentity =
                          rawChatPooledIdentity && typeof rawChatPooledIdentity === 'object'
                            ? (rawChatPooledIdentity as NonNullable<
                                ChatMessage['metadata']
                              >['pooledAgentIdentity'])
                            : undefined
                        const assistantLabelMessage =
                          chatPooledIdentity && !msg.metadata?.pooledAgentIdentity
                            ? {
                                ...msg,
                                metadata: {
                                  ...(msg.metadata || {}),
                                  ...(typeof currentChat?.providerMetadata?.pooledAgentId === 'string'
                                    ? {
                                        pooledAgentId:
                                          currentChat.providerMetadata.pooledAgentId
                                      }
                                    : {}),
                                  pooledAgentIdentity: chatPooledIdentity
                                }
                              }
                            : msg
                        const {
                          label,
                          provider,
                          providerClass,
                          modelBadge,
                          pooledAgentIdentity
                        } =
                          formatAssistantMessageLabel(
                            assistantLabelMessage,
                            currentProviderLabel,
                            currentProvider,
                            {
                              isEnsembleChat: currentChat?.chatKind === 'ensemble',
                              soloModelId: assistantRunModel
                            }
                          )
                        // 1.0.7 — participant-rename continuity. The
                        // header keeps the FROZEN role label; this quiet
                        // badge tells the reader the seat has since been
                        // renamed (e.g. "Planner" here is the seat now
                        // called "Architect") so they can follow one
                        // participant across a mid-session rename. Ledger-
                        // preferred, with a frozen-vs-current fallback —
                        // see deriveParticipantRenameContinuity.
                        return (
                          <div
                            className={`message-meta${
                              providerClass || provider
                                ? ` provider-${providerClass || provider}`
                                : ''
                            }`}
                          >
                            <span className="message-meta-label">
                              {pooledAgentIdentity && (
                                <PooledAgentIcon
                                  identity={pooledAgentIdentity}
                                  size={14}
                                  className="message-meta-agent-icon"
                                />
                              )}
                              {label}
                            </span>
                            {modelBadge && (
                              <span
                                className="message-meta-model-badge"
                                title={`Model: ${modelBadge}`}
                                aria-label={`Model ${modelBadge}`}
                              >
                                {modelBadge}
                              </span>
                            )}
                            {renameContinuity && (
                              <span
                                className="message-meta-renamed-from"
                                title={`Now: ${renameContinuity.currentRole}`}
                                aria-label={`Renamed from ${renameContinuity.fromRole}; now ${renameContinuity.currentRole}`}
                              >
                                renamed from {renameContinuity.fromRole}
                              </span>
                            )}
                          </div>
                        )
                      }
                      // Ensemble status messages (`yielded` / `failed` /
                      // `skipped`) currently arrive with `role: 'system'`
                      // because the orchestrator emits them as system-
                      // origin chrome. They carry the participant's
                      // identity in metadata though — so render them as
                      // the participant (with provider tint) rather than
                      // a generic "System" label. Reads more naturally
                      // for users (e.g. the reason text on a yield is
                      // really the participant's voice, not the app's).
                      const statusMeta =
                        msg.metadata?.kind === 'ensembleParticipantStatus'
                          ? {
                              provider: msg.metadata?.ensembleProvider as ProviderId | undefined,
                              role:
                                typeof msg.metadata?.ensembleRole === 'string'
                                  ? msg.metadata.ensembleRole
                                  : '',
                              model:
                                typeof msg.metadata?.ensembleModel === 'string'
                                  ? msg.metadata.ensembleModel
                                  : ''
                            }
                          : null
                      if (statusMeta?.provider) {
                        const statusProviderClass = resolveProviderHueClass(
                          statusMeta.provider,
                          statusMeta.model
                        )
                        const label = statusMeta.role
                          ? `${getProviderLabel(statusMeta.provider)} / ${statusMeta.role}`
                          : getProviderLabel(statusMeta.provider)
                        const statusModelBadge = statusMeta.model
                          ? shortModelName(statusMeta.provider, '', statusMeta.model)
                          : ''
                        return (
                          <div className={`message-meta provider-${statusProviderClass}`}>
                            <span className="message-meta-label">{label}</span>
                            {statusModelBadge && (
                              <span
                                className="message-meta-model-badge"
                                title={`Model: ${statusModelBadge}`}
                                aria-label={`Model ${statusModelBadge}`}
                              >
                                {statusModelBadge}
                              </span>
                            )}
                          </div>
                        )
                      }
                      return <div className="message-meta">System</div>
                    })()}
                    {msg.role === 'user' ? (
                      (() => {
                        // Long pasted briefs would otherwise dominate the scroll
                        // viewport. Collapse them by default and let the user
                        // expand inline with "Show more". Toggle state lives in
                        // `expandedUserMessages` so each bubble is independent.
                        const collapsible = shouldCollapseUserMessage(msg.content)
                        const isExpanded = expandedUserMessages.has(msg.id)
                        const showCollapsed = collapsible && !isExpanded
                        const preview = showCollapsed
                          ? truncateUserMessagePreview(msg.content)
                          : msg.content
                        const mediaRefs = collectMessageMediaRefs(msg)
                        // Drop from the attachment strip any image already shown
                        // inline in the (possibly truncated) rendered body.
                        const inlineImageIds = collectInlineImageRefIds(
                          preview,
                          mediaRefs,
                          currentChat?.workspacePath
                        )
                        const stripRefs = inlineImageIds.size
                          ? mediaRefs.filter((ref) => !inlineImageIds.has(ref.id))
                          : mediaRefs
                        return (
                          <div
                            className={`message-bubble user${
                              collapsible ? ' is-collapsible' : ''
                            }${showCollapsed ? ' is-collapsed' : ''}`}
                            onContextMenu={(event) =>
                              openMessageContextMenu(event, msg, msg.content, 'user message')
                            }
                          >
                            <div className="user-message-content">
                              <MarkdownMessage
                                content={preview}
                                chat={currentChat || undefined}
                                mediaRefs={mediaRefs}
                                workspacePath={currentChat?.workspacePath}
                                onPreviewImage={onPreviewImage}
                              />
                            </div>
                            {stripRefs.length > 0 && (
                              <ChatMessageMediaStrip
                                refs={stripRefs}
                                workspacePath={currentChat?.workspacePath}
                                onPreviewImage={onPreviewImage}
                                onDetachToPane={onDetachToPane}
                              />
                            )}
                            {collapsible && (
                              <button
                                type="button"
                                className="user-message-toggle"
                                onClick={() => toggleUserMessageExpanded(msg.id)}
                                aria-expanded={isExpanded}
                                title={isExpanded ? 'Collapse message' : 'Show full message'}
                              >
                                {isExpanded ? 'Show less' : 'Show more'}
                              </button>
                            )}
                          </div>
                        )
                      })()
                    ) : (
                      (() => {
                        const mediaRefs = collectMessageMediaRefs(msg)
                        const messageStreamRunId =
                          typeof msg.runId === 'string' && msg.runId
                            ? msg.runId
                            : boundaryRun?.runId
                        // Drop from the attachment strip any image already shown
                        // inline in the rendered body (deduped by resolved ref id).
                        const inlineImageIds = collectInlineImageRefIds(
                          msg.content,
                          mediaRefs,
                          currentChat?.workspacePath
                        )
                        const stripRefs = inlineImageIds.size
                          ? mediaRefs.filter((ref) => !inlineImageIds.has(ref.id))
                          : mediaRefs
                        return (
                          <div
                            className={`message-bubble ${
                              isCollaboratorComment || isDeliveredExternal
                                ? 'system human-collaborator-comment'
                                : isGuestReply
                                  ? 'assistant guest-participant-reply'
                                  : msg.role
                            }${ensembleRoundStatusClass(msg)}`}
                            onContextMenu={
                              (msg.role === 'assistant' || msg.role === 'system' || isGuestReply) &&
                              msg.content
                                ? (event) =>
                                    openMessageContextMenu(
                                      event,
                                      msg,
                                      msg.content || '',
                                      `${
                                        isGuestReply
                                          ? 'guest participant'
                                          : isDeliveredExternal
                                            ? 'collaborator'
                                            : msg.role
                                      } message`
                                    )
                                : undefined
                            }
                          >
                            {msg.role === 'assistant' || msg.role === 'system' || isGuestReply ? (
                              usesRevealLifecycle ? (
                                <RevealingMarkdownMessage
                                  content={msg.content}
                                  chat={currentChat || undefined}
                                  isLive={isLiveRevealRow}
                                  messageId={rowKey}
                                  messageTimestamp={msg.timestamp}
                                  provider={assistantRevealProvider}
                                  model={assistantRevealModel}
                                  mediaRefs={mediaRefs}
                                  workspacePath={currentChat?.workspacePath}
                                  onPreviewImage={onPreviewImage}
                                  streamRunId={messageStreamRunId}
                                  onRevealUnmounted={() =>
                                    finishRevealLifecycle(revealLifecycleKey)
                                  }
                                />
                              ) : (
                                <MarkdownMessage
                                  content={msg.content}
                                  chat={currentChat || undefined}
                                  mediaRefs={mediaRefs}
                                  workspacePath={currentChat?.workspacePath}
                                  onPreviewImage={onPreviewImage}
                                  streamRunId={messageStreamRunId}
                                />
                              )
                            ) : (
                              msg.content
                            )}
                            {stripRefs.length > 0 && (
                              <ChatMessageMediaStrip
                                refs={stripRefs}
                                workspacePath={currentChat?.workspacePath}
                                onPreviewImage={onPreviewImage}
                                onDetachToPane={onDetachToPane}
                              />
                            )}
                            {isCollaboratorComment && onPromoteCollaboratorComment && (
                              <div className="human-collaborator-actions">
                                {/* P2a copy: promotion only creates a host-owned
                                  * DRAFT — the host still reviews and sends. Never
                                  * label this "Run" or "Prompt" (spec §6). */}
                                <button
                                  type="button"
                                  className="human-collaborator-promote-btn"
                                  onClick={() => onPromoteCollaboratorComment(msg.id)}
                                  title="Insert this collaborator request into the composer as a draft you review before sending"
                                >
                                  Insert as draft
                                </button>
                                {collaboratorMeta?.promotedAt && (
                                  <span className="human-collaborator-status">
                                    Inserted as draft
                                  </span>
                                )}
                              </div>
                            )}
                          </div>
                        )
                      })()
                    )}
                    {pendingPlanChoice && pendingPlanChoice.messageId === msg.id && (
                      <div className="plan-choice-card">
                        <div className="plan-choice-question">{pendingPlanChoice.question}</div>
                        <div className="plan-choice-actions">
                          {pendingPlanChoice.options.map((option) => (
                            <button
                              key={option}
                              type="button"
                              className="plan-choice-action-btn"
                              onClick={() => onPlanChoiceSubmit(msg.id, option)}
                              title={`Continue with "${option}"`}
                            >
                              {option}
                            </button>
                          ))}
                        </div>
                      </div>
                    )}
                    {shouldSurfacePlanCard &&
                      msg.metadata?.proposedPlan &&
                      !isModalOwnedPendingPlan && (
                      <ProposedPlanCard
                        title={msg.metadata.proposedPlan.title}
                        body={msg.metadata.proposedPlan.body}
                        status={msg.metadata.proposedPlan.status}
                        artifactPath={msg.metadata.proposedPlan.artifactPath}
                        chat={currentChat || undefined}
                        onApprove={(planBody) => onProposedPlanApprove(msg.id, planBody)}
                        onDismiss={() => onProposedPlanDismiss(msg.id)}
                        onCustom={(feedback) => onProposedPlanCustom(msg.id, feedback)}
                      />
                    )}
                    {questionTombstone && (
                      <AgentQuestionTombstoneCard
                        tombstone={questionTombstone}
                        provider={
                          (msg.metadata?.ensembleProvider as ProviderId | undefined) ??
                          currentProvider ??
                          null
                        }
                        providerLabel={currentProviderLabel}
                      />
                    )}
                    {pendingQuestionsForRow.map((question) => (
                      <AgentQuestionCard
                        key={question.questionId}
                        state={question}
                        onAnswer={(answer, isCustom) =>
                          onAgentQuestionSubmit(question.questionId, answer, isCustom)
                        }
                        onDismiss={() => onAgentQuestionDismiss(question.questionId)}
                      />
                    ))}
                    {msg.metadata?.kind === 'ensembleBossmanPoll' &&
                      typeof msg.metadata.pollId === 'string' && (
                        <EnsemblePollCard
                          chat={currentChat}
                          pollId={msg.metadata.pollId}
                          onVote={onEnsemblePollVote}
                        />
                      )}
                  </div>
                )}
                  </>
                )}
                {superGroupHidden || questionReplyHidden ? null : (
                <TranscriptMessageFooter
                  message={msg}
                  label={footerLabel}
                  copyContent={footerCopyContent}
                  align={msg.role === 'user' ? 'end' : 'start'}
                  onCopyMessage={onCopyMessage}
                  onAddMessageToPrompt={onAddMessageToPrompt}
                  onTogglePinMessage={onTogglePinMessage}
                  onMessageFeedback={onMessageFeedback}
                  onDeleteMessage={onDeleteMessage}
                  onOpenSideChatFromMessage={onOpenSideChatFromMessage}
                  pinned={isPinned}
                  copied={copiedId === msg.id}
                />
                )}
              </div>
            )
            rowElementCacheRef.current.set(rowKey, { signature: rowSignature, element })
            return element
          })}
          {virtualizeEnabled && (
            <div
              className="vlist-spacer-bottom"
              ref={spacerBottomRef}
              style={{ height: virtualWindow.bottomSpacerPx }}
              aria-hidden
            />
          )}
          {/*
            1.0.5-EW36 — Belt-and-braces fallback for the
            `ask_user_question` modal. The primary render path is
            inline next to the synthetic `agentQuestion` system
            marker (line ~5437); the chat-updated merge guard at
            line ~10864 keeps that marker alive across re-syncs.
            This fallback covers the residual case where the
            marker is somehow missing (race / store reset / future
            regression in the merge logic): if the user has a
            pending question with no matching message in
            visibleMessages, render the card here at the tail of
            the transcript so they can still answer. Without this
            the agent times out after 10 minutes with no
            user-recoverable surface.
          */}
          {pendingAgentQuestions
            .filter((question) => !visibleMessages.some((m) => m.id === question.messageId))
            .map((question) => (
              <div
                key={`pending-agent-question-fallback-${question.questionId}`}
                className="message-group agent-question-fallback"
              >
                <AgentQuestionCard
                  key={question.questionId}
                  state={question}
                  onAnswer={(answer, isCustom) =>
                    onAgentQuestionSubmit(question.questionId, answer, isCustom)
                  }
                  onDismiss={() => onAgentQuestionDismiss(question.questionId)}
                />
              </div>
            ))}
          {contextCompactionProgress.map((event) => (
            <ContextCompactionProgressRow
              key={`${event.chatId}:${event.participantId || event.provider || 'chat'}`}
              event={event}
            />
          ))}
          {(isThinking || hasLiveContextCompactionProgress) && (
            <div
              key="thinking-indicator"
              className={`message-group${workingPresentations.length > 1 ? ' message-working-stack' : ''}`}
              role="status"
              aria-live="polite"
              aria-atomic="true"
            >
              <span className="sr-only">
                {workingPresentations.map(workingStatusLabel).join('; ')}
              </span>
              {workingPresentations.map((presentation, index) => {
                const providerClass = presentation.providerClass || presentation.provider
                const tokenTarget = workingTokenTargets.get(presentation.runId)
                return (
                  <div
                    key={workingIndicatorKey(presentation, index)}
                    className="message-working-stack-row"
                    style={workingAccentStyle(presentation)}
                  >
                    <div
                      className={`message-meta${
                        providerClass ? ` provider-${providerClass}` : ''
                      }`}
                    >
                      <span className="message-meta-label">
                        {presentation.providerLabel || currentProviderLabel}
                      </span>
                      {presentation.roleLabel && (
                        <span
                          className="message-meta-model-badge message-meta-role-badge"
                          title={`Role: ${presentation.roleLabel}`}
                          aria-label={`Role ${presentation.roleLabel}`}
                        >
                          {presentation.roleLabel}
                        </span>
                      )}
                      {presentation.modelBadge && (
                        <span
                          className="message-meta-model-badge"
                          title={`Model: ${presentation.modelBadge}`}
                          aria-label={`Model ${presentation.modelBadge}`}
                        >
                          {presentation.modelBadge}
                        </span>
                      )}
                    </div>
                    <ThinkingIndicator
                      label={workingIndicatorLabel(presentation)}
                      ariaLabel={workingStatusLabel(presentation)}
                      telemetry={
                        <MemoizedParticipantWorkingTelemetry
                          key={
                            presentation.runId ||
                            presentation.startedAt ||
                            presentation.participantId ||
                            `working-${index}`
                          }
                          runId={presentation.runId}
                          startedAt={presentation.startedAt}
                          tokenAccumulatorBase={presentation.tokenAccumulatorBase}
                          fallbackTargetTokens={
                            tokenTarget?.targetTokens ?? presentation.tokenAccumulatorBase
                          }
                          estimatedCurrentTurnTokens={
                            tokenTarget?.estimatedCurrentTurnTokens ?? 0
                          }
                        />
                      }
                    />
                    {presentation.activity === 'working' && (
                      <WorkingContextPressureHint
                        key={`pressure-${presentation.participantId || presentation.runId || index}`}
                        percent={
                          presentation.participantId
                            ? workingContextPressure.byParticipant.get(
                                presentation.participantId
                              ) ?? 0
                            : workingContextPressure.solo
                        }
                        estimatedTokens={tokenTarget?.estimatedCurrentTurnTokens ?? 0}
                      />
                    )}
                  </div>
                )
              })}
            </div>
          )}
          {showRunCompleteSummary !== false && shouldShowRunCompleteNotice && runCompleteNotice && (
            <div
              className={`run-complete-card${isGlobal ? ' is-global-stripped' : ''}`}
              role="status"
              aria-live="assertive"
              aria-atomic="true"
            >
              <span className="sr-only">{runCompleteStatus?.srLabel}</span>
              <div className="run-complete-main">
                <div className="run-complete-metadata">
                  <strong
                    className={
                      runCompleteStatus && runCompleteStatus.tone !== 'neutral'
                        ? `tone-${runCompleteStatus.tone}`
                        : undefined
                    }
                    title={runCompleteStatus?.detail || undefined}
                  >
                    {runCompleteStatus?.label}
                  </strong>
                  {!isGlobal && (
                    <span className="run-complete-time-row">
                      <span>
                        {new Date(runCompleteNotice.timestamp).toLocaleTimeString([], {
                          hour: '2-digit',
                          minute: '2-digit',
                          second: '2-digit'
                        })}
                      </span>
                      {runCompleteDurationText && <span>{runCompleteDurationText}</span>}
                    </span>
                  )}
                  {/* Only a clean finish is "awaiting your next prompt" — a blocked
                      or paused round would contradict its own title. */}
                  {!isGlobal && runCompleteStatus?.kind === 'complete' && (
                    <span>Awaiting your next prompt.</span>
                  )}
                </div>
                <div className="run-complete-actions">
                  {(() => {
                    const latestAssistantMessage = [...messages]
                      .reverse()
                      .find((m) => m.role === 'assistant')
                    const latestCopyId = latestAssistantMessage
                      ? `run-complete-copy-${latestAssistantMessage.id}`
                      : null
                    const isCopied = latestCopyId !== null && copiedId === latestCopyId
                    return (
                      <PillButton
                        size="compact"
                        className={`run-copy-btn${isCopied ? ' is-copied' : ''}`}
                        onClick={() => {
                          if (latestAssistantMessage?.content && latestCopyId) {
                            copy(latestCopyId, latestAssistantMessage.content)
                          }
                        }}
                        disabled={!latestAssistantMessage?.content}
                        title={isCopied ? 'Copied' : 'Copy latest assistant response'}
                        aria-label={
                          isCopied ? 'Latest response copied' : 'Copy latest assistant response'
                        }
                      >
                        {isCopied ? 'Copied' : 'Copy'}
                      </PillButton>
                    )
                  })()}
                  {isGlobal && currentRun?.runId && onInspectRun && (
                    <PillButton
                      size="compact"
                      onClick={() => onInspectRun(currentRun.runId)}
                      title="Inspect this run"
                      aria-label="Inspect this run"
                    >
                      Inspect
                    </PillButton>
                  )}
                  {!isGlobal && currentRun?.runId && onOpenSideChatFromRun && (
                    <PillButton
                      size="compact"
                      onClick={() => onOpenSideChatFromRun(currentRun.runId)}
                      title="Open side chat seeded from this run result"
                      aria-label="Open side chat from run result"
                    >
                      Side chat
                    </PillButton>
                  )}
                </div>
              </div>
              {(!isGlobal || displayFileChangeSummaries.length > 0) && (
              <div className="file-change-summary-card">
                <div className="file-change-summary-header">
                  <strong>File changes</strong>
                  <div className="file-change-summary-meta">
                    <span>{fileChangeSummaryText}</span>
                    {fileChangeShouldShowStats && (
                      <span className="file-change-summary-stats">
                        <span className="file-change-stat file-change-stat-add composer-diff-add">
                          +{fileChangeDisplayAdds}
                        </span>
                        <span className="file-change-stat file-change-stat-delete composer-diff-del">
                          -{fileChangeDisplayDels}
                        </span>
                      </span>
                    )}
                  </div>
                </div>
                <div className="file-change-summary-list">
                  {displayFileChangeSummaries.length > 0 ? (
                    <>
                      {fileChangeSummaryWindow.items.map((item, index) => {
                        const inRoundSection =
                          fileChangeSections !== null && index < fileChangeSections.boundary
                        // Round rows can repeat a session path (normalisation
                        // drift between the live and exact lanes) — prefix
                        // keeps keys unique either way.
                        const rowKey = inRoundSection
                          ? `round-${item.path}-${item.status}`
                          : `${item.path}-${item.status}`
                        const sectionLead =
                          fileChangeSections === null ? null : index === 0 ? (
                            <div className="file-change-summary-section-row is-round-section">
                              <span className="file-change-summary-section-label">This round</span>
                              <span className="file-change-summary-section-count">
                                {fileChangeSections.roundCount}{' '}
                                {fileChangeSections.roundCount === 1 ? 'file' : 'files'}
                              </span>
                              {fileChangeSections.roundHasLineStats && (
                                <span className="file-change-summary-section-stats">
                                  <span className="file-change-stat file-change-stat-add composer-diff-add">
                                    +{fileChangeSections.roundAdds}
                                  </span>
                                  <span className="file-change-stat file-change-stat-delete composer-diff-del">
                                    -{fileChangeSections.roundDels}
                                  </span>
                                </span>
                              )}
                            </div>
                          ) : index === fileChangeSections.boundary ? (
                            <>
                              <div
                                className="file-change-summary-section-divider"
                                aria-hidden="true"
                              />
                              <div className="file-change-summary-section-row is-session-section">
                                <span className="file-change-summary-section-label">
                                  Earlier in session
                                </span>
                                <span className="file-change-summary-section-count">
                                  {fileChangeSections.remainingCount}{' '}
                                  {fileChangeSections.remainingCount === 1 ? 'file' : 'files'}
                                </span>
                              </div>
                            </>
                          ) : null
                        const rowContent = (
                          <span className="file-change-summary-row-content">
                            <span className={`file-change-summary-status status-${item.status}`}>
                              {item.status === 'modified' ? 'edited' : item.status}
                            </span>
                            <FileTypeIcon
                              path={item.path}
                              size={14}
                              className="file-change-summary-type-icon"
                              workspacePath={currentWorkspacePath}
                            />
                            <FileChangePathCell path={item.path} />
                            <FileChangeOwnerCell owners={item.owners} />
                            {(item.additions !== undefined || item.deletions !== undefined) && (
                              <span className="file-change-summary-item-stats">
                                <span className="file-change-stat file-change-stat-add composer-diff-add">
                                  +{item.additions || 0}
                                </span>
                                <span className="file-change-stat file-change-stat-delete composer-diff-del">
                                  -{item.deletions || 0}
                                </span>
                              </span>
                            )}
                          </span>
                        )
                        if (!item.diffText && !onOpenFileChangeInWorkbench) {
                          return (
                            <Fragment key={rowKey}>
                              {sectionLead}
                              <div className="file-change-summary-item">{rowContent}</div>
                            </Fragment>
                          )
                        }
                        const hasDiffPreview = Boolean(item.diffText)
                        const canShowHoverPreview = canShowDiffHoverPreview(
                          item,
                          Boolean(onOpenFileChangeInWorkbench)
                        )
                        const fileChangeActionLabel = onOpenFileChangeInWorkbench
                          ? `Open Workbench diff for ${item.path}`
                          : `Preview diff for ${item.path}`
                        return (
                          <Fragment key={rowKey}>
                            {sectionLead}
                            <div
                              className={`file-change-summary-item file-change-summary-item-interactive ${
                                hasDiffPreview ? 'has-diff-preview' : 'has-workbench-link'
                              }`}
                              onMouseEnter={
                                canShowHoverPreview
                                  ? (event) => openFileChangeDiffPreview(event, item)
                                  : undefined
                              }
                              onMouseLeave={
                                canShowHoverPreview
                                  ? scheduleCloseFileChangeDiffPreview
                                  : undefined
                              }
                            >
                              <button
                                className="file-change-summary-main-action"
                                type="button"
                                aria-describedby={
                                  canShowHoverPreview &&
                                  fileChangeDiffPreview?.summary.path === item.path
                                    ? DIFF_HOVER_PREVIEW_TOOLTIP_ID
                                    : undefined
                                }
                                aria-label={fileChangeActionLabel}
                                onFocus={
                                  canShowHoverPreview
                                    ? (event) =>
                                        openFileChangeDiffPreview(event, item, {
                                          focusTarget: 'preview'
                                        })
                                    : undefined
                                }
                                onBlur={
                                  canShowHoverPreview
                                    ? scheduleCloseFileChangeDiffPreview
                                    : undefined
                                }
                                onClick={(event) => activateFileChangeSummary(event, item)}
                              >
                                {rowContent}
                              </button>
                              {hasDiffPreview && (
                                <button
                                  type="button"
                                  className="file-change-summary-diff-bubble"
                                  aria-describedby={
                                    fileChangeDiffPreview?.summary.path === item.path
                                      ? DIFF_HOVER_PREVIEW_TOOLTIP_ID
                                      : undefined
                                  }
                                  aria-label={`Preview diff for ${item.path}`}
                                  onMouseEnter={(event) => openFileChangeDiffPreview(event, item)}
                                  onMouseLeave={scheduleCloseFileChangeDiffPreview}
                                  onFocus={(event) =>
                                    openFileChangeDiffPreview(event, item, {
                                      focusTarget: 'preview'
                                    })
                                  }
                                  onBlur={scheduleCloseFileChangeDiffPreview}
                                  onClick={(event) => {
                                    event.preventDefault()
                                    event.stopPropagation()
                                    openFileChangeDiffPreview(event, item, { immediate: true })
                                  }}
                                  onKeyDown={(event) => {
                                    if (event.key === 'Enter' || event.key === ' ') {
                                      event.preventDefault()
                                      event.stopPropagation()
                                      openFileChangeDiffPreview(event, item, { focusTarget: 'action' })
                                    }
                                  }}
                                >
                                  Diff
                                </button>
                              )}
                            </div>
                          </Fragment>
                        )
                      })}
                      {fileChangeSummaryWindow.canShowMore ? (
                        <button
                          className="file-change-summary-item file-change-summary-overflow has-workbench-link"
                          type="button"
                          aria-label={`Show ${fileChangeSummaryWindow.nextShowCount} more changed files`}
                          onClick={showMoreFileChangeSummaries}
                        >
                          Show {fileChangeSummaryWindow.nextShowCount} more files
                        </button>
                      ) : fileChangeSummaryWindow.canShowFewer ? (
                        <button
                          className="file-change-summary-item file-change-summary-overflow has-workbench-link"
                          type="button"
                          aria-label="Show fewer changed files"
                          onClick={showFewerFileChangeSummaries}
                        >
                          Show fewer files
                        </button>
                      ) : null}
                      {!fileChangeSummaryWindow.canShowMore &&
                        fileChangeSummaryWindow.hiddenCount > 0 && (
                          <div className="file-change-summary-item file-change-summary-overflow">
                            +{fileChangeSummaryWindow.hiddenCount} more files omitted from summary
                          </div>
                      )}
                    </>
                  ) : (
                    <div className="file-change-summary-item file-change-summary-empty">
                      No file changes detected for this run.
                    </div>
                  )}
                </div>
              </div>
              )}
            </div>
          )}
          <div ref={endRef} />
        </div>
        <TranscriptMessageContextMenu
          selection={activeMessageContextMenu}
          onCopyMessage={onCopyMessage}
          onCopySelection={copyTranscriptSelection}
          onAddMessageToPrompt={onAddMessageToPrompt}
          onTogglePinMessage={onTogglePinMessage}
          onMessageFeedback={onMessageFeedback}
          onOpenSideChatFromMessage={onOpenSideChatFromMessage}
          onDeleteMessage={onDeleteMessage}
          onClose={closeMessageContextMenu}
        />
        <DiffHoverPreviewOverlay
          preview={fileChangeDiffPreview}
          onFocus={keepFileChangeDiffPreviewOpen}
          onBlur={scheduleCloseFileChangeDiffPreview}
          onMouseEnter={keepFileChangeDiffPreviewOpen}
          onMouseLeave={scheduleCloseFileChangeDiffPreview}
        />
      </div>
    )
  },
  transcriptPanelPropsEqual
)
