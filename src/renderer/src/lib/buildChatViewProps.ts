import type { TranscriptPanelProps } from '../components/TranscriptPanel'

/**
 * Build the TranscriptPanel prop bundle for a Multiview pane-scoped transcript.
 * The focused pane keeps App.tsx's existing inline render (there is only ever
 * one focused pane, and it already re-renders on every token), so we
 * deliberately do NOT route it through a resolver; this builder exists only for
 * the extra panes.
 *
 * The pane policy still keeps workspace-global diff/fallback rows out of extra
 * panes, but it no longer forces the transcript into read-only mode. Per-chat
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
  runCompleteNotice: TranscriptPanelProps['runCompleteNotice']
  pendingAgentQuestions: TranscriptPanelProps['pendingAgentQuestions']
  onAgentQuestionSubmit?: TranscriptPanelProps['onAgentQuestionSubmit']
  onAgentQuestionDismiss?: TranscriptPanelProps['onAgentQuestionDismiss']
  chats: TranscriptPanelProps['chats']
  runningChatIds: TranscriptPanelProps['runningChatIds']
  compactDensity: boolean
  copiedId: TranscriptPanelProps['copiedId']
  copy: TranscriptPanelProps['copy']
  onOpenSubThread: TranscriptPanelProps['onOpenSubThread']
  onOpenSubThreadInSidePanel?: TranscriptPanelProps['onOpenSubThreadInSidePanel']
  onRunFallback?: TranscriptPanelProps['onRunFallback']
  onPlanChoiceSubmit?: TranscriptPanelProps['onPlanChoiceSubmit']
  onCopyMessage: TranscriptPanelProps['onCopyMessage']
  onDeleteMessage?: TranscriptPanelProps['onDeleteMessage']
  onTogglePinMessage?: TranscriptPanelProps['onTogglePinMessage']
  onOpenSideChatFromMessage?: TranscriptPanelProps['onOpenSideChatFromMessage']
  onMessageSelectionCandidate?: TranscriptPanelProps['onMessageSelectionCandidate']
  onPreviewImage: TranscriptPanelProps['onPreviewImage']
  // Optional pass-throughs — supplied when available, omitted otherwise.
  currentRun?: TranscriptPanelProps['currentRun']
  currentWorkspacePath?: string
  thinkingProviderLabel?: TranscriptPanelProps['thinkingProviderLabel']
  thinkingProvider?: TranscriptPanelProps['thinkingProvider']
  thinkingProviderClass?: TranscriptPanelProps['thinkingProviderClass']
  thinkingModelBadge?: TranscriptPanelProps['thinkingModelBadge']
  liveActivityViewport?: boolean
  pendingQueuedAppRunIds?: TranscriptPanelProps['pendingQueuedAppRunIds']
  onInspectRun?: TranscriptPanelProps['onInspectRun']
  currency?: TranscriptPanelProps['currency']
  currencyOverestimatePercent?: number
  providerRates?: TranscriptPanelProps['providerRates']
}

/** Stable singletons so the viewer policy never changes prop identity. */
const NOOP = (): void => {}
const NOOP_RUN_FALLBACK = (_model: string): void => {}
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
    // Pane policy: no workspace-global fallback UX, but agent questions and
    // plan cards are writable when the host passes the target-chat handlers.
    showFallbackUX: false,
    pendingPlanChoice: input.pendingPlanChoice ?? null,
    pendingAgentQuestions: input.pendingAgentQuestions,
    onAgentQuestionSubmit: input.onAgentQuestionSubmit ?? NOOP_AGENT_QUESTION,
    onAgentQuestionDismiss: input.onAgentQuestionDismiss ?? NOOP,
    runCompleteNotice: input.runCompleteNotice,
    runCompleteDurationText: null,
    currentChat: input.chat,
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
    onRunFallback: input.onRunFallback ?? NOOP_RUN_FALLBACK,
    onOpenSubThread: input.onOpenSubThread,
    onOpenSubThreadInSidePanel: input.onOpenSubThreadInSidePanel,
    onInspectRun: input.onInspectRun,
    compactDensity: input.compactDensity,
    liveActivityViewport: input.liveActivityViewport,
    pendingQueuedAppRunIds: input.pendingQueuedAppRunIds,
    onCopyMessage: input.onCopyMessage,
    onDeleteMessage: input.onDeleteMessage ?? NOOP,
    onTogglePinMessage: input.onTogglePinMessage,
    onOpenSideChatFromMessage: input.onOpenSideChatFromMessage,
    onMessageSelectionCandidate: input.onMessageSelectionCandidate,
    onPreviewImage: input.onPreviewImage,
    copiedId: input.copiedId,
    copy: input.copy,
    currency: input.currency,
    currencyOverestimatePercent: input.currencyOverestimatePercent,
    providerRates: input.providerRates
  }
}
