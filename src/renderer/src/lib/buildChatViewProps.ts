import type { TranscriptPanelProps } from '../components/TranscriptPanel'
import { isGlobalChat } from './chatScope'

/**
 * Build the TranscriptPanel prop bundle for a Multiview pane-scoped transcript.
 * The focused pane keeps App.tsx's existing inline render (there is only ever
 * one focused pane, and it already re-renders on every token), so we
 * deliberately do NOT route it through a resolver; this builder exists only for
 * the extra panes.
 *
 * The pane policy still keeps workspace-global diff rows out of extra panes,
 * but it no longer forces the transcript into read-only mode. Per-chat
 * values (messages, provider, running state, run-complete notice) and handlers
 * are passed in by the caller, which has the App-scope helpers to derive them;
 * the constant fallback props are stable module-level singletons so they never
 * perturb the pane's memo.
 */

type Refs = Pick<TranscriptPanelProps, 'scrollRef' | 'contentRef' | 'endRef'>

export interface BuildChatViewPropsInput {
  refs: Refs
  chat: TranscriptPanelProps['currentChat']
  messages: TranscriptPanelProps['messages']
  provider: TranscriptPanelProps['currentProvider']
  providerLabel: string
  isWelcomeChat: boolean
  isThinking: boolean
  pendingPlanChoice?: TranscriptPanelProps['pendingPlanChoice']
  pendingProposedPlan?: TranscriptPanelProps['pendingProposedPlan']
  runCompleteNotice: TranscriptPanelProps['runCompleteNotice']
  pendingAgentQuestions: TranscriptPanelProps['pendingAgentQuestions']
  contextCompactionProgress?: TranscriptPanelProps['contextCompactionProgress']
  onAgentQuestionSubmit?: TranscriptPanelProps['onAgentQuestionSubmit']
  onAgentQuestionDismiss?: TranscriptPanelProps['onAgentQuestionDismiss']
  onEnsemblePollVote?: TranscriptPanelProps['onEnsemblePollVote']
  chats: TranscriptPanelProps['chats']
  runningChatIds: TranscriptPanelProps['runningChatIds']
  compactDensity: boolean
  copiedId: TranscriptPanelProps['copiedId']
  copy: TranscriptPanelProps['copy']
  onOpenSubThread: TranscriptPanelProps['onOpenSubThread']
  onOpenSubThreadInSidePanel?: TranscriptPanelProps['onOpenSubThreadInSidePanel']
  onPlanChoiceSubmit?: TranscriptPanelProps['onPlanChoiceSubmit']
  onProposedPlanApprove?: TranscriptPanelProps['onProposedPlanApprove']
  onProposedPlanDismiss?: TranscriptPanelProps['onProposedPlanDismiss']
  onProposedPlanCustom?: TranscriptPanelProps['onProposedPlanCustom']
  onCopyMessage: TranscriptPanelProps['onCopyMessage']
  onAddMessageToPrompt?: TranscriptPanelProps['onAddMessageToPrompt']
  onDeleteMessage?: TranscriptPanelProps['onDeleteMessage']
  onTogglePinMessage?: TranscriptPanelProps['onTogglePinMessage']
  onMessageFeedback?: TranscriptPanelProps['onMessageFeedback']
  onOpenSideChatFromMessage?: TranscriptPanelProps['onOpenSideChatFromMessage']
  onMessageSelectionCandidate?: TranscriptPanelProps['onMessageSelectionCandidate']
  onPreviewImage: TranscriptPanelProps['onPreviewImage']
  onDetachToPane?: TranscriptPanelProps['onDetachToPane']
  // Optional pass-throughs — supplied when available, omitted otherwise.
  currentRun?: TranscriptPanelProps['currentRun']
  currentWorkspacePath?: string
  thinkingProviderLabel?: TranscriptPanelProps['thinkingProviderLabel']
  thinkingProvider?: TranscriptPanelProps['thinkingProvider']
  thinkingProviderClass?: TranscriptPanelProps['thinkingProviderClass']
  thinkingModelBadge?: TranscriptPanelProps['thinkingModelBadge']
  liveActivityViewport?: boolean
  pendingQueuedAppRunIds?: TranscriptPanelProps['pendingQueuedAppRunIds']
  queuedRunStatusByAppRunId?: TranscriptPanelProps['queuedRunStatusByAppRunId']
  onInspectRun?: TranscriptPanelProps['onInspectRun']
  currency?: TranscriptPanelProps['currency']
  currencyOverestimatePercent?: number
  providerRates?: TranscriptPanelProps['providerRates']
}

/** Stable singletons so the viewer policy never changes prop identity. */
const NOOP = (): void => {}
const NOOP_PLAN_CHOICE = (_messageId: string, _option: string): void => {}
const NOOP_AGENT_QUESTION = (_questionId: string, _answer: string, _isCustom: boolean): void => {}
const EMPTY_FILE_SUMMARIES: TranscriptPanelProps['displayFileChangeSummaries'] = []

export function buildChatViewProps(input: BuildChatViewPropsInput): TranscriptPanelProps {
  return {
    scrollRef: input.refs.scrollRef,
    contentRef: input.refs.contentRef,
    endRef: input.refs.endRef,
    messages: input.messages,
    isWelcomeChat: input.isWelcomeChat,
    isThinking: input.isThinking,
    // Pane policy: agent questions and plan cards are writable when the host
    // passes the target-chat handlers.
    pendingPlanChoice: input.pendingPlanChoice ?? null,
    pendingProposedPlan: input.pendingProposedPlan ?? null,
    pendingAgentQuestions: input.pendingAgentQuestions,
    contextCompactionProgress: input.contextCompactionProgress ?? [],
    onAgentQuestionSubmit: input.onAgentQuestionSubmit ?? NOOP_AGENT_QUESTION,
    onAgentQuestionDismiss: input.onAgentQuestionDismiss ?? NOOP,
    onEnsemblePollVote: input.onEnsemblePollVote,
    runCompleteNotice: input.runCompleteNotice,
    runCompleteDurationText: null,
    currentChat: input.chat,
    isGlobal: isGlobalChat(input.chat),
    currentRun: input.currentRun ?? null,
    currentWorkspacePath: input.currentWorkspacePath,
    currentProviderLabel: input.providerLabel,
    currentProvider: input.provider,
    thinkingProviderLabel: input.providerLabel,
    thinkingProvider: input.provider,
    ...(input.thinkingProviderLabel ? { thinkingProviderLabel: input.thinkingProviderLabel } : {}),
    ...(input.thinkingProvider !== undefined ? { thinkingProvider: input.thinkingProvider } : {}),
    ...(input.thinkingProviderClass !== undefined
      ? { thinkingProviderClass: input.thinkingProviderClass }
      : {}),
    ...(input.thinkingModelBadge !== undefined
      ? { thinkingModelBadge: input.thinkingModelBadge }
      : {}),
    // Pane policy: the focused pane owns the diff surface.
    displayFileChangeSummaries: EMPTY_FILE_SUMMARIES,
    fileChangeSummaryText: '',
    fileChangeShouldShowStats: false,
    fileChangeDisplayAdds: 0,
    fileChangeDisplayDels: 0,
    chats: input.chats,
    runningChatIds: input.runningChatIds,
    onPlanChoiceSubmit: input.onPlanChoiceSubmit ?? NOOP_PLAN_CHOICE,
    onProposedPlanApprove: input.onProposedPlanApprove ?? (() => {}),
    onProposedPlanDismiss: input.onProposedPlanDismiss ?? (() => {}),
    onProposedPlanCustom: input.onProposedPlanCustom ?? (() => {}),
    onOpenSubThread: input.onOpenSubThread,
    onOpenSubThreadInSidePanel: input.onOpenSubThreadInSidePanel,
    onInspectRun: input.onInspectRun,
    compactDensity: input.compactDensity,
    liveActivityViewport: input.liveActivityViewport,
    pendingQueuedAppRunIds: input.pendingQueuedAppRunIds,
    queuedRunStatusByAppRunId: input.queuedRunStatusByAppRunId,
    onCopyMessage: input.onCopyMessage,
    onAddMessageToPrompt: input.onAddMessageToPrompt,
    onDeleteMessage: input.onDeleteMessage ?? NOOP,
    onTogglePinMessage: input.onTogglePinMessage,
    onMessageFeedback: input.onMessageFeedback,
    onOpenSideChatFromMessage: input.onOpenSideChatFromMessage,
    onMessageSelectionCandidate: input.onMessageSelectionCandidate,
    onPreviewImage: input.onPreviewImage,
    onDetachToPane: input.onDetachToPane,
    copiedId: input.copiedId,
    copy: input.copy,
    userMessageGutterEnabled: false,
    currency: input.currency,
    currencyOverestimatePercent: input.currencyOverestimatePercent,
    providerRates: input.providerRates
  }
}
