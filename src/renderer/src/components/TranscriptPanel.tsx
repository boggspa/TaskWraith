import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { ReactElement } from 'react'
import type {
  ChatMessage,
  ChatRecord,
  ChatRun,
  DiffFileSummary,
  ProviderId
} from '../../../main/store/types'
import { ensembleRoundStatusClass } from '../lib/ensembleRoundStatusClass'
import { getChatProvider } from '../lib/chatScope'
import { getProviderLabel } from '../lib/providerLabels'
import { formatAssistantMessageLabel } from '../lib/assistantMessageLabel'
import { readMessageFeedbackVote, type MessageFeedbackDetails } from '../lib/messageFeedback'
import { shortModelName } from '../lib/composerChipFormat'
import { shouldSurfaceProposedPlanCard } from '../lib/ensemblePlanPolicy'
import { deriveParticipantRenameContinuity } from '../lib/sessionActivityLedger'
import { shouldCollapseUserMessage, truncateUserMessagePreview } from '../lib/UserMessageCollapse'
import {
  buildEnsembleRoundSummaryRows,
  buildEscalationChips,
  buildRunCompleteSummaryRows
} from '../lib/runCompleteSummary'
import { decideMeasurePass, MAX_MEASURE_REWRITE_PASSES } from '../lib/transcriptMeasureConvergence'
import { deriveQueuedLifecycleProjection } from '../lib/queuedMessageRows'
import { deriveActiveEnsembleWorkingPresentation } from '../lib/workingIndicatorPresentation'
import {
  TRANSCRIPT_VIRTUALIZATION_ENABLED,
  DEFAULT_OVERSCAN_PX,
  projectRows,
  selectWindow,
  findScrollAnchor,
  sumHeights,
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
  transcriptChatRenderSignature,
  transcriptRowRenderSignatureEqual,
  type TranscriptRowRenderSignature
} from '../lib/transcriptRowRenderCache'
import { resolveLiveRevealMessageId } from '../lib/liveRevealMessage'
import type { PlanChoiceState } from '../lib/planModeChoice'
import type { DisplayCurrency } from '../lib/formatCost'
import type { RendererProviderRates } from '../lib/providerRateEstimate'
import { shouldSuppressRunCompleteSummary, type RunCompleteNotice } from '../lib/runCompleteNotice'
import { formatTranscriptClock } from '../lib/dateTimeFormat'
import { EMPTY_CHAT_MESSAGES } from '../lib/stableEmpties'
import {
  groupAdjacentToolMessages,
  groupFanoutLaneMessages,
  groupedTranscriptMessageIds
} from '../lib/transcriptToolMessageGrouping'
import {
  buildEnsembleRoundCardRows,
  isEnsembleRoundHeaderMessage,
  readEnsembleRoundHeader
} from '../lib/ensembleRoundCards'
import {
  createTranscriptScrollAnimator,
  type TranscriptScrollAnimator
} from '../lib/transcriptSmoothScroll'
import { ActivityStack } from './ActivityStack'
import { EnsembleRoundCardHeader } from './EnsembleRoundCardHeader'
import { EnsembleFanoutResultCard } from './EnsembleFanoutResultCard'
import { isEnsembleFanoutResultMessage } from './EnsembleFanoutResultCardModel'
import { AgentQuestionCard, type AgentQuestionState } from './AgentQuestionCard'
import { isGuestParticipantReplyMessage } from './GuestParticipantReplyCardModel'
import { SubThreadDelegationCard } from './SubThreadDelegationCard'
import { isSubThreadDelegationMessage } from './SubThreadDelegationCardModel'
import { SubThreadReturnCard } from './SubThreadReturnCard'
import { isSubThreadReturnMessage, subThreadReturnBody } from './SubThreadReturnCardModel'
import { ParticipantHealthCard } from './ParticipantHealthCard'
import { ContextCompactionCard } from './ContextCompactionCard'
import type { ContextCompactionProgressEvent } from '../../../shared/contextCompaction'
import { ProviderRunFailureCard } from './ProviderRunFailureCard'
import { MarkdownMessage } from './MarkdownMessage'
import { RevealingMarkdownMessage } from './RevealingMarkdownMessage'
import { ProposedPlanCard } from './ProposedPlanCard'
import type { ProposedPlanState } from '../lib/proposedPlan'
import { MessageActionsChip } from './MessageActionsChip'
import {
  TranscriptMessageContextMenu,
  type TranscriptMessageContextMenuSelection
} from './TranscriptMessageContextMenu'
import { ChatMessageMediaStrip, collectMessageMediaRefs, type ChatMediaRef } from './ChatMediaPanel'
import { collectInlineImageRefIds } from '../lib/resolveMarkdownImageRef'
import { FileTypeIcon } from './FileTypeIcon'
import { RunCard } from './RunCard'
import { PooledAgentIcon } from './icons/PooledAgentIcon'
import { ThinkingIndicator } from './AppChromeSymbols'
import {
  humanCollaboratorMetadata,
  isHumanCollaboratorComment
} from '../../../main/collaboration/HumanCollaboratorMessages'
import { TranscriptUserMessageGutter } from './TranscriptUserMessageGutter'
import {
  DIFF_HOVER_PREVIEW_TOOLTIP_ID,
  DiffHoverPreviewOverlay,
  type DiffHoverPreviewState,
  canShowDiffHoverPreview,
  diffHoverPreviewBoundaryForElement,
  useDiffHoverPreviewDismiss,
  useDiffHoverPreviewState
} from './DiffHoverPreview'

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
   * Short model name (e.g. "5.5", "Opus 4.7", "K2.7 Code", "2.5 Pro") for
   * the in-flight ensemble participant. Rendered as a dim chip after
   * the "Codex Thinking…" label so the user knows *which configured
   * model* is producing the live output. Null for solo chats and
   * legacy ensembles without per-participant model data.
   */
  thinkingModelBadge?: string | null
  displayFileChangeSummaries: DiffFileSummary[]
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
  /** Set of `appRunId`s whose run-queue job is still in `'queued'`
   * status. Used to hide the in-transcript "Queued (#N): …" system
   * card while the queued-messages above-row is showing the same
   * item live. Once the job dispatches (status leaves `'queued'`),
   * the appRunId drops from this set and the transcript card
   * reappears as the historical "this run was queued" record. */
  pendingQueuedAppRunIds?: Set<string>
  queuedRunStatusByAppRunId?: Partial<Record<string, string>>
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
  onDeleteMessage: (messageId: string) => void
  onTogglePinMessage?: (messageId: string) => void
  /** Thumbs feedback on an assistant message (up/down; host writes the receipt). */
  onMessageFeedback?: (messageId: string, vote: 'up' | 'down', details?: MessageFeedbackDetails) => void
  onPromoteCollaboratorComment?: (messageId: string) => void
  onMessageSelectionCandidate?: (message: ChatMessage) => void
  onOpenSideChatFromMessage?: (message: ChatMessage) => void
  sideChatSeedMessageId?: string | null
  jumpToMessageRequest?: { messageId: string; rowKey?: string; requestId: number } | null
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
   * 1.0.7 — display currency + conservative-overestimate bias (Settings →
   * General), threaded in so the ensemble run-complete card's Cost row routes
   * through `formatCost`. Defaults to USD / 0 when omitted.
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
   * 1.0.7 — per-provider rate table (USD per 1M tokens) from the
   * `providerRates:get` IPC. Used ONLY to project a clearly-badged
   * API-equivalent cost for subscription/credit seats that emit no
   * `cost_usd` (Codex / Grok / Cursor). Absent → no estimate.
   */
  providerRates?: RendererProviderRates
}

export const FILE_CHANGE_SUMMARY_COLLAPSED_LIMIT = 12
export const FILE_CHANGE_SUMMARY_PAGE_SIZE = 24
export const FILE_CHANGE_SUMMARY_MAX_VISIBLE = 120

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

/** Stable empty heights array so the disabled path allocates nothing. */
const EMPTY_TRANSCRIPT_HEIGHTS: number[] = []
/** Stable empty rows array for the non-virtualised render path. */
const EMPTY_VIRTUAL_ROWS: VirtualRow[] = []
/** Stable empty expansion set so unopened tool rows share one reference. */
const EMPTY_ACTIVITY_EXPANSION: Set<string> = new Set()

function escapeDomSelectorValue(value: string): string {
  return typeof CSS !== 'undefined' && typeof CSS.escape === 'function'
    ? CSS.escape(value)
    : value.replace(/["\\]/g, '\\$&')
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

function TranscriptMessageFooter({
  message,
  label,
  copyContent,
  align,
  onCopyMessage,
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
    autoFollowRef,
    onProgrammaticScrollWrite,
    compactDensity,
    forcedRowIndex,
    activeLiveRowKey,
    expandedRowIds
  } = params

  const measurementsRef = useRef<Map<string, number>>(new Map())
  const scrollTopRef = useRef(0)
  const viewportRef = useRef(0)
  const bucketRef = useRef(0)
  const heightsRef = useRef<number[]>(EMPTY_TRANSCRIPT_HEIGHTS)
  const rowsRef = useRef<VirtualRow[]>(rows)
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
      getRowHeight(
        row,
        m,
        bucket,
        expandedRowIds?.has(row.id) ?? false,
        measurementContentVersion(row, activeLiveRowKey)
      )
    )
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, rows, measureTick, expandedRowIds, activeLiveRowKey])
  heightsRef.current = heights
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
  const totalHeight = enabled ? sumHeights(heights, 0, heights.length) : 0
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
  const virtualWindow: VirtualWindow = enabled
    ? selectWindow({
        scrollTop: effectiveScrollTop,
        viewportHeight: viewportRef.current,
        heights: windowHeights,
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
      ? findScrollAnchor(effectiveScrollTop + viewportRef.current * 0.3, windowHeights).index
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
        const a = findScrollAnchor(scrollTopRef.current, heightsRef.current)
        const anchorRow = rowsRef.current[a.index]
        anchorRef.current = anchorRow
          ? {
              rowKey: anchorRow.rowKey,
              aboveHeight: sumHeights(heightsRef.current, 0, a.index),
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
        const aboveHeight = sumHeights(heightsRef.current, 0, idx)
        const target = Math.max(0, aboveHeight + anchor.offsetWithin)
        if (Math.abs(target - scroller.scrollTop) > 0.5) {
          // 1.0.7 — flag the programmatic write so the passive scroll listener
          // recognises the resulting scroll event as our own and skips the
          // re-baseline/bump (Fix 4), keeping the restore one-shot.
          anchorWriteRef.current = true
          scroller.scrollTop = target
          // Arm the PARENT scroll evaluator too — `anchorWriteRef` is private
          // to this component, so without this the App-level auto-follow
          // listener sees an un-owned scroll and can re-engage follow when the
          // write lands at the live edge. Pass the browser-clamped landed
          // position (a target that overshoots to the bottom is the exact
          // re-engage trigger otherwise).
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
        expandedRowIds?.has(row.id) ?? false
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
    pendingQueuedAppRunIds,
    queuedRunStatusByAppRunId,
    onCopyMessage,
    onDeleteMessage,
    onTogglePinMessage,
    onMessageFeedback,
    onPromoteCollaboratorComment,
    onMessageSelectionCandidate,
    onOpenSideChatFromMessage,
    sideChatSeedMessageId,
    jumpToMessageRequest,
    onManualTranscriptJump,
    onJumpToLatest,
    onPreviewImage,
    onDetachToPane,
    copiedId,
    copy,
    virtualize,
    autoFollowRef,
    onProgrammaticScrollWrite,
    currency,
    currencyOverestimatePercent,
    showRunCompleteSummary,
    collapseOlderRounds,
    userMessageGutterEnabled,
    isGlobal,
    providerRates
  }: TranscriptPanelProps) {
    const visibleMessages = useMemo(() => {
      const source = isWelcomeChat ? EMPTY_CHAT_MESSAGES : messages
      const projected = deriveQueuedLifecycleProjection({
        messages: source,
        pendingQueuedAppRunIds,
        queuedRunStatusByAppRunId
      })
      // Dedup: when a queued-message system card's job is still in
      // the `queued` set, suppress the card here — the queued-
      // messages above-row is the live representation. Once the job
      // dispatches, the card resurfaces as a historical "this was
      // queued" record. Untagged messages always pass through.
      if (!pendingQueuedAppRunIds || pendingQueuedAppRunIds.size === 0) return projected
      return projected.filter((msg) => {
        if (msg.metadata?.kind !== 'queuedRunRequest') return true
        const appRunId = typeof msg.metadata?.appRunId === 'string' ? msg.metadata.appRunId : null
        if (!appRunId) return true
        return !pendingQueuedAppRunIds.has(appRunId)
      })
    }, [isWelcomeChat, messages, pendingQueuedAppRunIds, queuedRunStatusByAppRunId])
    const ensembleWorkingPresentation = useMemo(
      () => deriveActiveEnsembleWorkingPresentation(currentChat),
      [currentChat]
    )
    const workingProviderLabel =
      ensembleWorkingPresentation?.providerLabel || thinkingProviderLabel || currentProviderLabel
    const workingProvider = ensembleWorkingPresentation?.provider ?? thinkingProvider
    const workingProviderClass =
      ensembleWorkingPresentation?.providerClass ?? thinkingProviderClass
    const workingRoleLabel = ensembleWorkingPresentation?.roleLabel || null
    const workingModelBadge =
      ensembleWorkingPresentation?.modelBadge ?? thinkingModelBadge ?? null
    const [messageContextMenu, setMessageContextMenu] =
      useState<TranscriptMessageContextMenuSelection | null>(null)
    const {
      closePreview: closeFileChangeDiffPreview,
      keepPreviewOpen: keepFileChangeDiffPreviewOpen,
      preview: fileChangeDiffPreview,
      scheduleClosePreview: scheduleCloseFileChangeDiffPreview,
      showPreview: showFileChangeDiffPreview
    } = useDiffHoverPreviewState()
    const [fileChangeSummaryVisibleCount, setFileChangeSummaryVisibleCount] = useState(
      FILE_CHANGE_SUMMARY_COLLAPSED_LIMIT
    )
    const fileChangeSummaryWindow = useMemo(
      () =>
        buildFileChangeSummaryWindow(
          displayFileChangeSummaries,
          fileChangeSummaryVisibleCount
        ),
      [displayFileChangeSummaries, fileChangeSummaryVisibleCount]
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
    const openFileChangeDiffPreview = useCallback(
      (
        event: { currentTarget: HTMLElement },
        summary: DiffFileSummary,
        options?: { focusTarget?: DiffHoverPreviewState['focusTarget'] }
      ) => {
        if (!canShowDiffHoverPreview(summary, Boolean(onOpenFileChangeInWorkbench))) return
        showFileChangeDiffPreview({
          anchor: event.currentTarget.getBoundingClientRect(),
          boundary: diffHoverPreviewBoundaryForElement(event.currentTarget),
          summary: {
            actionLabel: onOpenFileChangeInWorkbench
              ? 'Click row to open Diff Studio'
              : 'Click row to preview',
            path: summary.path,
            status: summary.status,
            additions: summary.additions,
            deletions: summary.deletions,
            diffText: summary.diffText,
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
        })
      },
      [closeFileChangeDiffPreview, onOpenFileChangeInWorkbench, showFileChangeDiffPreview]
    )
    const activateFileChangeSummary = useCallback(
      (event: React.MouseEvent<HTMLElement>, summary: DiffFileSummary) => {
        if (!onOpenFileChangeInWorkbench) {
          openFileChangeDiffPreview(event, summary)
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
      displayFileChangeSummaries
    ])
    const showMoreFileChangeSummaries = useCallback(() => {
      setFileChangeSummaryVisibleCount((current) =>
        buildFileChangeSummaryWindow(displayFileChangeSummaries, current).nextCount
      )
    }, [displayFileChangeSummaries])
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
        event.preventDefault()
        event.stopPropagation()
        setMessageContextMenu({
          anchor: { x: event.clientX, y: event.clientY },
          message,
          copyContent,
          copySource: options.copySource || 'message-content',
          label,
          pinned: typeof message.metadata?.pinnedAt === 'number',
          copyOnly: options.copyOnly
        })
      },
      []
    )
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
    const runCompleteSummaryRows = useMemo(() => {
      // Ensemble chats: aggregate across every participant in the
      // round so the user sees ALL contributing models (not just the
      // last speaker's), round-envelope duration, and summed tokens.
      // Solo chats: the original single-run summary.
      if (currentChat?.chatKind === 'ensemble' && currentChat.ensemble?.activeRound) {
        return buildEnsembleRoundSummaryRows(currentChat, runCompleteNotice?.exitCode !== 0, {
          currency,
          overestimatePercent: currencyOverestimatePercent,
          providerRates
        })
      }
      return buildRunCompleteSummaryRows(currentRun)
    }, [
      currentChat,
      currentRun,
      runCompleteNotice?.exitCode,
      currency,
      currencyOverestimatePercent,
      providerRates
    ])
    // 1.0.7 (M5 surfacing) — advisory chips for the dark-shipped escalation
    // signals on the current round. Read-only: the orchestrator persists
    // these; we just surface label + recommended action.
    const escalationChips = useMemo(() => buildEscalationChips(currentChat), [currentChat])
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
    // Per-round manual expand/collapse overrides for the ensemble
    // round-card transcript. Keyed by ensemble roundId; value true =
    // expanded. Absent → the default (latest round expanded, older
    // collapsed) applies. Reset on chat change like the other transcript
    // expansion state below.
    const [manualRoundExpansion, setManualRoundExpansion] = useState<Map<string, boolean>>(new Map())
    const setRoundExpanded = useCallback((roundId: string, expanded: boolean) => {
      setManualRoundExpansion((prev) => {
        const next = new Map(prev)
        next.set(roundId, expanded)
        return next
      })
    }, [])
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
    const groupedMessages = useMemo(
      () => groupFanoutLaneMessages(groupAdjacentToolMessages(visibleMessages)),
      [visibleMessages]
    )
    // Ensemble round cards: completed rounds collapse into expandable
    // header rows (older collapsed by default). Returns `groupedMessages`
    // unchanged for non-ensemble chats or when the setting is off, so the
    // flat render path + referential stability are preserved there.
    const displayMessages = useMemo(
      () =>
        buildEnsembleRoundCardRows({
          chat: currentChat,
          displayMessages: groupedMessages,
          collapseOlderRounds: collapseOlderRounds !== false,
          manualRoundExpansion,
          hasLiveRunEvidence: isThinking
        }),
      [currentChat, groupedMessages, collapseOlderRounds, manualRoundExpansion, isThinking]
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
        setManualRoundExpansion((prev) => {
          if (prev.get(roundId) === true) return prev
          const next = new Map(prev)
          next.set(roundId, true)
          return next
        })
      },
      [roundIdByMessageId]
    )

    // Phase 3 — type-out reveal (Variant B), default ON. The
    // live last-assistant bubble of a running chat reveals progressively via
    // RevealingMarkdownMessage; everything else stays the plain MarkdownMessage.
    // Keep the old localStorage flag as an escape hatch for debugging:
    // `taskwraith.experimentalReveal=false` restores the plain renderer.
    const revealEnabled = useMemo(() => {
      try {
        return localStorage.getItem('taskwraith.experimentalReveal') !== 'false'
      } catch {
        return true
      }
    }, [])
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
    const displayRunBoundaryByMessageId = useMemo(() => {
      const map = new Map(runBoundaryByMessageId)
      for (const message of displayMessages) {
        if (map.has(message.id)) continue
        const boundaryId = groupedTranscriptMessageIds(message).find((id) => map.has(id))
        if (boundaryId) map.set(message.id, map.get(boundaryId)!)
      }
      return map
    }, [displayMessages, runBoundaryByMessageId])

    const displayRunBoundaryIds = useMemo(
      () => new Set(displayRunBoundaryByMessageId.keys()),
      [displayRunBoundaryByMessageId]
    )
    const projectedRows = useMemo(
      () => projectRows(displayMessages, displayRunBoundaryIds),
      [displayMessages, displayRunBoundaryIds]
    )
    const liveRevealRowKey = useMemo(() => {
      if (!liveRevealMessageId) return null
      return (
        projectedRows.find(
          (row) => row.id === liveRevealMessageId && row.index === displayMessages.length - 1
        )?.rowKey ?? null
      )
    }, [displayMessages.length, liveRevealMessageId, projectedRows])
    const [pendingFocusTarget, setPendingFocusTarget] = useState<{
      messageId: string
      rowKey?: string
      attempt: number
    } | null>(null)
    const findProjectedRowForMessage = useCallback(
      (messageId: string, rowKey?: string) => {
        if (rowKey) {
          const byRowKey = projectedRows.find((candidate) => candidate.rowKey === rowKey)
          if (byRowKey) return byRowKey
        }
        return (
          projectedRows.find((candidate) => candidate.id === messageId) ||
          projectedRows.find((candidate) => {
            const message = displayMessages[candidate.index]
            return message ? groupedTranscriptMessageIds(message).includes(messageId) : false
          })
        )
      },
      [displayMessages, projectedRows]
    )
    const pendingFocusRowIndex = useMemo(() => {
      if (!pendingFocusTarget) return null
      const row = findProjectedRowForMessage(pendingFocusTarget.messageId, pendingFocusTarget.rowKey)
      if (!row) return null
      const rowPosition = projectedRows.findIndex((candidate) => candidate.rowKey === row.rowKey)
      return rowPosition >= 0 ? rowPosition : null
    }, [findProjectedRowForMessage, pendingFocusTarget, projectedRows])
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
      autoFollowRef,
      onProgrammaticScrollWrite,
      compactDensity,
      forcedRowIndex: pendingFocusRowIndex,
      activeLiveRowKey: liveRevealRowKey,
      expandedRowIds
    })
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
    const previousChatIdRef = useRef<string | null>(chatId)
    useLayoutEffect(() => {
      if (previousChatIdRef.current === chatId) return
      previousChatIdRef.current = chatId
      setMessageContextMenu(null)
      setExpandedUserMessages(new Set())
      setManualRoundExpansion(new Map())
      setActivityExpansionByRow(new Map())
      setExpandedSubThreadResults(new Set())
      rowElementCacheRef.current.clear()
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
        const rowPosition = projectedRows.findIndex((candidate) => candidate.rowKey === row.rowKey)
        if (rowPosition < 0) return
        const estimatedTop = sumHeights([...rowHeights], 0, rowPosition)
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
        projectedRows,
        scrollRef,
        syncVirtualizerScrollPosition,
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
            const isFanoutResultCard = isEnsembleFanoutResultMessage(msg)
            const isGuestReply = isGuestParticipantReplyMessage(msg)
            const isCollaboratorComment = isHumanCollaboratorComment(msg)
            const isToolActivityStack = msg.role === 'tool' && (msg.toolActivities?.length || 0) > 0
            const isParticipantHealth = msg.metadata?.kind === 'ensembleParticipantHealth'
            const isProviderRunFailure = msg.metadata?.kind === 'providerRunFailure'
            const isContextCompaction = msg.metadata?.kind === 'contextCompaction'
            const isRoundHeader = isEnsembleRoundHeaderMessage(msg)
            const collaboratorMeta = isCollaboratorComment ? humanCollaboratorMetadata(msg) : null
            const boundaryRun = displayRunBoundaryByMessageId.get(msg.id)
            const isSideChatSeedMessage = Boolean(
              sideChatSeedMessageId && msg.id === sideChatSeedMessageId
            )
            const isPinned = typeof msg.metadata?.pinnedAt === 'number'
            const footerCopyContent =
              !isDelegationCard &&
              !isReturnCard &&
              !isToolActivityStack &&
              !isParticipantHealth &&
              !isProviderRunFailure &&
              !isContextCompaction &&
              typeof msg.content === 'string'
                ? msg.content
                : undefined
            const footerLabel =
              msg.role === 'user'
                ? 'user message'
                : isFanoutResultCard
                  ? 'fan-out result'
                : isGuestReply
                  ? 'guest participant message'
                  : isCollaboratorComment
                    ? 'collaborator message'
                    : msg.role === 'tool'
                      ? 'tool message'
                      : `${msg.role} message`
            const isPinnedMessageTarget = highlightedMessageTarget
              ? highlightedMessageTarget.rowKey
                ? highlightedMessageTarget.rowKey === rowKey
                : highlightedMessageTarget.messageId === msg.id
              : false
            const activityExpansionIds = activityExpansionByRow.get(msg.id)
            const pendingQuestionsForRow = pendingAgentQuestions.filter(
              (question) => question.messageId === msg.id
            )
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
                ? `${runningChatIds.join('\u0000')}|${chats
                    .map((chat) => `${chat.appChatId}:${chat.title || ''}:${chat.updatedAt || ''}`)
                    .join('\u0000')}`
                : ''
            const pendingProposedPlanKey = pendingProposedPlan?.messageId === msg.id
              ? `${pendingProposedPlan?.messageId || ''}:plan-modal`
              : ''
            const auxiliaryKeyWithPendingPlan = auxiliaryKey
              ? `${auxiliaryKey}|${pendingProposedPlanKey}`
              : pendingProposedPlanKey
            const isLiveRevealRow = rowKey === liveRevealRowKey
            const revealKey = isLiveRevealRow ? `live:${revealRunId || msg.id}` : 'plain'
            const rowSignature: TranscriptRowRenderSignature = {
              rowKey,
              message: msg,
              ...(boundaryRun ? { boundaryRun } : {}),
              chatSignature: currentChatRenderSignature,
              providerLabel: currentProviderLabel,
              provider: currentProvider,
              ...(currentWorkspacePath ? { workspacePath: currentWorkspacePath } : {}),
              compactDensity,
              liveActivityViewport,
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
              subThreadExpanded: expandedSubThreadResults.has(msg.id),
              fanoutExpanded: expandedFanoutResults.has(msg.id),
              pendingPlanChoiceKey,
              pendingAgentQuestionsKey,
              auxiliaryKey: auxiliaryKeyWithPendingPlan,
              revealKey,
              callbackRefs: [
                onMessageSelectionCandidate,
                onOpenSubThread,
                onOpenSubThreadInSidePanel,
                onInspectRun,
                onOpenSideChatFromRun,
                onCopyMessage,
                onTogglePinMessage,
                onMessageFeedback,
                onDeleteMessage,
                onOpenSideChatFromMessage,
                onPromoteCollaboratorComment,
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
                }${isPinnedMessageTarget ? ' is-pinned-message-target' : ''}`}
                data-vrow-id={rowKey}
                data-message-id={msg.id}
                onMouseEnter={() => onMessageSelectionCandidate?.(msg)}
                onFocus={() => onMessageSelectionCandidate?.(msg)}
                ref={virtualizeEnabled ? virtualBlockRef : undefined}
              >
                {boundaryRun && (
                  <RunCard
                    run={boundaryRun}
                    fallbackProvider={getChatProvider(currentChat)}
                    onInspect={onInspectRun}
                    onOpenSideChat={onOpenSideChatFromRun}
                  />
                )}
                {isRoundHeader ? (
                  <EnsembleRoundCardHeader
                    key={msg.id}
                    message={msg}
                    onSetExpanded={setRoundExpanded}
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
                        onTogglePinMessage={onTogglePinMessage}
                        onDeleteMessage={onDeleteMessage}
                        onOpenSideChatFromMessage={onOpenSideChatFromMessage}
                        pinned={isPinned}
                        copied={copiedId === msg.id}
                        resultExpanded={expandedSubThreadResults.has(msg.id)}
                        onResultExpandedChange={(expanded) =>
                          setSubThreadResultExpanded(msg.id, expanded)
                        }
                      />
                    )}
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
                      expanded={expandedFanoutResults.has(msg.id)}
                      onExpandedChange={(expanded) => setFanoutResultExpanded(msg.id, expanded)}
                      compactDensity={compactDensity}
                      expandedActivityIds={activityExpansionIds ?? EMPTY_ACTIVITY_EXPANSION}
                      onExpandedActivityIdsChange={(next) =>
                        setActivityExpansionForRow(msg.id, next)
                      }
                      onOpenFileChangeInWorkbench={onOpenFileChangeInWorkbench}
                      onPreviewImage={onPreviewImage}
                      onDetachToPane={onDetachToPane}
                    />
                  </div>
                ) : isToolActivityStack ? (
                  <ActivityStack
                    key={msg.id}
                    activities={msg.toolActivities || []}
                    workspacePath={currentWorkspacePath}
                    provider={getChatProvider(currentChat)}
                    chatId={currentChat?.appChatId}
                    runId={msg.runId || boundaryRun?.runId}
                    chat={currentChat || undefined}
                    compactDensity={compactDensity}
                    liveActivityViewport={liveActivityViewport}
                    expandedActivityIds={activityExpansionIds ?? EMPTY_ACTIVITY_EXPANSION}
                    onExpandedActivityIdsChange={(next) => setActivityExpansionForRow(msg.id, next)}
                    onOpenFileChangeInWorkbench={onOpenFileChangeInWorkbench}
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
                ) : isContextCompaction ? (
                  /*
                    Provider context compaction (auto or manual). Structured
                    card with pre→post occupancy; `msg.content` carries the
                    plain-text summary as the fallback for older transcripts,
                    exports, and the iOS system-row projection.
                  */
                  <ContextCompactionCard key={msg.id} message={msg} />
                ) : isProviderRunFailure ? (
                  <ProviderRunFailureCard
                    key={msg.id}
                    message={msg}
                    onCopy={onCopyMessage}
                    onContextMenu={(event, copyText) =>
                      openMessageContextMenu(event, msg, copyText, 'provider failure', {
                        copyOnly: true,
                        copySource: 'static'
                      })
                    }
                    copied={copiedId === msg.id}
                  />
                ) : (
                  <div
                    key={msg.id}
                    className={`message-group ${
                      isReturnCard ? 'subthread-return-message' : ''
                    } ${isDelegationCard ? 'subthread-delegation-message' : ''}${
                      isGuestReply ? ' guest-participant-reply-message' : ''
                    }${isCollaboratorComment ? ' human-collaborator-comment-message' : ''}`}
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
                              isEnsembleChat: currentChat?.chatKind === 'ensemble'
                            }
                          )
                        // Solo General (global, non-ensemble) chats read as one
                        // friendly "Assistant" voice: drop the provider tint +
                        // model badge. Ensemble — AND a solo guest reply — keep
                        // their per-speaker tint/badge so the reader can still
                        // tell host from guest in a legitimate multi-voice chat.
                        const soloGlobal =
                          isGlobal === true &&
                          currentChat?.chatKind !== 'ensemble' &&
                          !isGuestReply &&
                          !pooledAgentIdentity
                        // 1.0.7 — participant-rename continuity. The
                        // header keeps the FROZEN role label; this quiet
                        // badge tells the reader the seat has since been
                        // renamed (e.g. "Planner" here is the seat now
                        // called "Architect") so they can follow one
                        // participant across a mid-session rename. Ledger-
                        // preferred, with a frozen-vs-current fallback —
                        // see deriveParticipantRenameContinuity.
                        const renameContinuity = deriveParticipantRenameContinuity(
                          msg,
                          currentChat?.ensemble?.participants,
                          currentChat?.ensemble?.sessionActivityLedger
                        )
                        return (
                          <div
                            className={`message-meta${
                              !soloGlobal && (providerClass || provider)
                                ? ` provider-${providerClass || provider}`
                                : ''
                            }`}
                          >
                            <span className="message-meta-label">
                              {!soloGlobal && pooledAgentIdentity && (
                                <PooledAgentIcon
                                  identity={pooledAgentIdentity}
                                  size={14}
                                  className="message-meta-agent-icon"
                                />
                              )}
                              {soloGlobal ? 'Assistant' : label}
                            </span>
                            {!soloGlobal && modelBadge && (
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
                        const label = statusMeta.role
                          ? `${getProviderLabel(statusMeta.provider)} / ${statusMeta.role}`
                          : getProviderLabel(statusMeta.provider)
                        const statusModelBadge = statusMeta.model
                          ? shortModelName(statusMeta.provider, '', statusMeta.model)
                          : ''
                        return (
                          <div className={`message-meta provider-${statusMeta.provider}`}>
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
                              isCollaboratorComment
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
                                      `${isGuestReply ? 'guest participant' : msg.role} message`
                                    )
                                : undefined
                            }
                          >
                            {msg.role === 'assistant' || msg.role === 'system' || isGuestReply ? (
                              isLiveRevealRow ? (
                                <RevealingMarkdownMessage
                                  content={msg.content}
                                  chat={currentChat || undefined}
                                  isLive
                                  mediaRefs={mediaRefs}
                                  workspacePath={currentChat?.workspacePath}
                                  onPreviewImage={onPreviewImage}
                                  streamRunId={messageStreamRunId}
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
                  </div>
                )}
                <TranscriptMessageFooter
                  message={msg}
                  label={footerLabel}
                  copyContent={footerCopyContent}
                  align={msg.role === 'user' ? 'end' : 'start'}
                  onCopyMessage={onCopyMessage}
                  onTogglePinMessage={onTogglePinMessage}
                  onMessageFeedback={onMessageFeedback}
                  onDeleteMessage={onDeleteMessage}
                  onOpenSideChatFromMessage={onOpenSideChatFromMessage}
                  pinned={isPinned}
                  copied={copiedId === msg.id}
                />
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
          {isThinking && (
            <div
              key="thinking-indicator"
              className="message-group"
              role="status"
              aria-live="polite"
              aria-atomic="true"
            >
              <span className="sr-only">
                {workingRoleLabel
                  ? `${workingRoleLabel} (${workingProviderLabel || 'Agent'}) working`
                  : `${workingProviderLabel || 'Agent'} working`}
              </span>
              <div
                className={`message-meta${
                  workingProviderClass || workingProvider
                    ? ` provider-${workingProviderClass || workingProvider}`
                    : ''
                }`}
              >
                <span className="message-meta-label">
                  {workingProviderLabel || currentProviderLabel}
                </span>
                {workingRoleLabel && (
                  <span
                    className="message-meta-model-badge message-meta-role-badge"
                    title={`Role: ${workingRoleLabel}`}
                    aria-label={`Role ${workingRoleLabel}`}
                  >
                    {workingRoleLabel}
                  </span>
                )}
                {workingModelBadge && (
                  <span
                    className="message-meta-model-badge"
                    title={`Model: ${workingModelBadge}`}
                    aria-label={`Model ${workingModelBadge}`}
                  >
                    {workingModelBadge}
                  </span>
                )}
              </div>
              <ThinkingIndicator />
            </div>
          )}
          {showRunCompleteSummary !== false && shouldShowRunCompleteNotice && runCompleteNotice && (
            <div
              className={`run-complete-card${isGlobal ? ' is-global-stripped' : ''}`}
              role="status"
              aria-live="assertive"
              aria-atomic="true"
            >
              <span className="sr-only">
                {isGlobal
                  ? runCompleteNotice.exitCode === 0
                    ? 'Done'
                    : runCompleteNotice.exitCode === 130
                      ? 'Stopped'
                      : "Couldn't finish"
                  : runCompleteNotice.exitCode === 0
                    ? 'Task complete'
                    : runCompleteNotice.exitCode === 130
                      ? 'Run cancelled'
                      : `Task ended with code ${runCompleteNotice.exitCode}`}
              </span>
              <div className="run-complete-main">
                <div className="run-complete-metadata">
                  <strong>
                    {isGlobal
                      ? runCompleteNotice.exitCode === 0
                        ? 'Done'
                        : runCompleteNotice.exitCode === 130
                          ? 'Stopped'
                          : "Couldn't finish"
                      : runCompleteNotice.exitCode === 0
                        ? 'Task complete'
                        : runCompleteNotice.exitCode === 130
                          ? 'Run cancelled'
                          : `Task ended (code ${runCompleteNotice.exitCode})`}
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
                  {!isGlobal && runCompleteNotice.exitCode === 0 && (
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
                      <button
                        className={`btn btn-sm btn-ghost run-copy-btn${isCopied ? ' is-copied' : ''}`}
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
                      </button>
                    )
                  })()}
                  {isGlobal && currentRun?.runId && onInspectRun && (
                    <button
                      className="btn btn-sm btn-ghost"
                      type="button"
                      onClick={() => onInspectRun(currentRun.runId)}
                      title="Inspect this run"
                      aria-label="Inspect this run"
                    >
                      Inspect
                    </button>
                  )}
                  {!isGlobal && currentRun?.runId && onOpenSideChatFromRun && (
                    <button
                      className="btn btn-sm btn-ghost"
                      type="button"
                      onClick={() => onOpenSideChatFromRun(currentRun.runId)}
                      title="Open side chat seeded from this run result"
                      aria-label="Open side chat from run result"
                    >
                      Side chat
                    </button>
                  )}
                </div>
              </div>
              {!isGlobal && runCompleteSummaryRows.length > 0 && (
                <div className="run-complete-summary-card">
                  <div className="run-complete-summary-header">
                    <strong>Run details</strong>
                  </div>
                  <div className="run-complete-summary-grid">
                    {runCompleteSummaryRows.map((row) => (
                      <div key={row.label} className="run-complete-summary-item">
                        <span>{row.label}</span>
                        <strong title={row.value}>{row.value}</strong>
                      </div>
                    ))}
                  </div>
                </div>
              )}
              {!isGlobal && escalationChips.length > 0 && (
                <div
                  className="ensemble-escalation-advisory"
                  role="status"
                  aria-label="Round advisories"
                >
                  {escalationChips.map((chip) => (
                    <div key={chip.id} className={`ensemble-escalation-chip tone-${chip.tone}`}>
                      <span className="ensemble-escalation-chip-label">{chip.label}</span>
                      {chip.action && (
                        <span className="ensemble-escalation-chip-action">{chip.action}</span>
                      )}
                    </div>
                  ))}
                </div>
              )}
              {(!isGlobal || displayFileChangeSummaries.length > 0) && (
              <div className="file-change-summary-card">
                <div className="file-change-summary-header">
                  <strong>File changes</strong>
                  <div className="file-change-summary-meta">
                    <span>{fileChangeSummaryText}</span>
                    {fileChangeShouldShowStats && (
                      <span className="file-change-summary-stats">
                        <span className="file-change-stat file-change-stat-add">
                          +{fileChangeDisplayAdds}
                        </span>
                        <span className="file-change-stat-divider">|</span>
                        <span className="file-change-stat file-change-stat-delete">
                          -{fileChangeDisplayDels}
                        </span>
                      </span>
                    )}
                  </div>
                </div>
                <div className="file-change-summary-list">
                  {displayFileChangeSummaries.length > 0 ? (
                    <>
                      {fileChangeSummaryWindow.items.map((item) => {
                        const rowContent = (
                          <>
                            <span className={`file-change-summary-status status-${item.status}`}>
                              {item.status === 'modified' ? 'edited' : item.status}
                            </span>
                            <FileTypeIcon
                              path={item.path}
                              size={14}
                              className="file-change-summary-type-icon"
                              workspacePath={currentWorkspacePath}
                            />
                            <span className="file-change-summary-path" title={item.path}>
                              {item.path}
                            </span>
                            {(item.additions !== undefined || item.deletions !== undefined) && (
                              <span className="file-change-summary-item-stats">
                                <span className="file-change-stat file-change-stat-add">
                                  +{item.additions || 0}
                                </span>
                                <span className="file-change-stat-divider">|</span>
                                <span className="file-change-stat file-change-stat-delete">
                                  -{item.deletions || 0}
                                </span>
                              </span>
                            )}
                          </>
                        )
                        if (!item.diffText && !onOpenFileChangeInWorkbench) {
                          return (
                            <div
                              key={`${item.path}-${item.status}`}
                              className="file-change-summary-item"
                            >
                              {rowContent}
                            </div>
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
                          <div
                            key={`${item.path}-${item.status}`}
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
                                  openFileChangeDiffPreview(event, item)
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
  (previous, next) =>
    previous.scrollRef === next.scrollRef &&
    previous.contentRef === next.contentRef &&
    previous.endRef === next.endRef &&
    previous.messages === next.messages &&
    previous.isWelcomeChat === next.isWelcomeChat &&
    previous.isThinking === next.isThinking &&
    previous.pendingPlanChoice === next.pendingPlanChoice &&
    previous.pendingProposedPlan === next.pendingProposedPlan &&
    previous.pendingAgentQuestions === next.pendingAgentQuestions &&
    previous.onAgentQuestionSubmit === next.onAgentQuestionSubmit &&
    previous.onAgentQuestionDismiss === next.onAgentQuestionDismiss &&
    previous.runCompleteNotice === next.runCompleteNotice &&
    previous.runCompleteDurationText === next.runCompleteDurationText &&
    previous.currentRun === next.currentRun &&
    previous.currentChat === next.currentChat &&
    previous.currentWorkspacePath === next.currentWorkspacePath &&
    previous.currentProviderLabel === next.currentProviderLabel &&
    previous.currentProvider === next.currentProvider &&
    previous.thinkingProviderLabel === next.thinkingProviderLabel &&
    previous.thinkingProvider === next.thinkingProvider &&
    previous.thinkingProviderClass === next.thinkingProviderClass &&
    previous.thinkingModelBadge === next.thinkingModelBadge &&
    previous.displayFileChangeSummaries === next.displayFileChangeSummaries &&
    previous.fileChangeSummaryText === next.fileChangeSummaryText &&
    previous.fileChangeShouldShowStats === next.fileChangeShouldShowStats &&
    previous.fileChangeDisplayAdds === next.fileChangeDisplayAdds &&
    previous.fileChangeDisplayDels === next.fileChangeDisplayDels &&
    previous.chats === next.chats &&
    previous.runningChatIds === next.runningChatIds &&
    previous.onOpenFileChangeInWorkbench === next.onOpenFileChangeInWorkbench &&
    previous.pendingQueuedAppRunIds === next.pendingQueuedAppRunIds &&
    previous.queuedRunStatusByAppRunId === next.queuedRunStatusByAppRunId &&
    previous.onCopyMessage === next.onCopyMessage &&
    previous.onDeleteMessage === next.onDeleteMessage &&
    previous.onMessageSelectionCandidate === next.onMessageSelectionCandidate &&
    previous.onOpenSideChatFromMessage === next.onOpenSideChatFromMessage &&
    previous.sideChatSeedMessageId === next.sideChatSeedMessageId &&
    previous.jumpToMessageRequest?.messageId === next.jumpToMessageRequest?.messageId &&
    previous.jumpToMessageRequest?.rowKey === next.jumpToMessageRequest?.rowKey &&
    previous.jumpToMessageRequest?.requestId === next.jumpToMessageRequest?.requestId &&
    previous.onManualTranscriptJump === next.onManualTranscriptJump &&
    previous.onJumpToLatest === next.onJumpToLatest &&
    previous.onPreviewImage === next.onPreviewImage &&
    previous.onDetachToPane === next.onDetachToPane &&
    previous.copiedId === next.copiedId &&
    previous.copy === next.copy &&
    previous.virtualize === next.virtualize &&
    previous.autoFollowRef === next.autoFollowRef &&
    previous.onProgrammaticScrollWrite === next.onProgrammaticScrollWrite &&
    previous.collapseOlderRounds === next.collapseOlderRounds &&
    previous.userMessageGutterEnabled === next.userMessageGutterEnabled
)
