import type { TranscriptPanelProps } from '../components/TranscriptPanel'

/**
 * Build the TranscriptPanel prop bundle for a NON-FOCUSED Multiview pane — a
 * live, read-only VIEWER. The focused pane keeps App.tsx's existing inline
 * render (there is only ever one focused pane, and it already re-renders on
 * every token), so we deliberately do NOT route it through a resolver; this
 * builder exists only for the extra panes.
 *
 * The "viewer policy" — interactivity hard-disabled, no diff, no fallback UX —
 * mirrors the proven side-chat TranscriptPanel call site (App.tsx ~21313) and
 * lives here in ONE place so every viewer pane behaves identically and it can
 * be unit-tested without rendering. Per-chat values (messages, provider,
 * running state, run-complete notice) are passed in by the caller, which has
 * the App-scope helpers to derive them; the constant policy props are stable
 * module-level singletons so they never perturb the pane's memo.
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
  runCompleteNotice: TranscriptPanelProps['runCompleteNotice']
  pendingAgentQuestions: TranscriptPanelProps['pendingAgentQuestions']
  chats: TranscriptPanelProps['chats']
  runningChatIds: TranscriptPanelProps['runningChatIds']
  compactDensity: boolean
  copiedId: TranscriptPanelProps['copiedId']
  copy: TranscriptPanelProps['copy']
  onOpenSubThread: TranscriptPanelProps['onOpenSubThread']
  onCopyMessage: TranscriptPanelProps['onCopyMessage']
  onPreviewImage: TranscriptPanelProps['onPreviewImage']
  // Optional pass-throughs — supplied when available, omitted otherwise.
  currentRun?: TranscriptPanelProps['currentRun']
  currentWorkspacePath?: string
  liveActivityViewport?: boolean
  pendingQueuedAppRunIds?: TranscriptPanelProps['pendingQueuedAppRunIds']
  onInspectRun?: TranscriptPanelProps['onInspectRun']
  currency?: TranscriptPanelProps['currency']
  currencyOverestimatePercent?: number
  providerRates?: TranscriptPanelProps['providerRates']
}

/** Stable singletons so the viewer policy never changes prop identity. */
const NOOP = (): void => {}
const EMPTY_FILE_SUMMARIES: TranscriptPanelProps['displayFileChangeSummaries'] = []

export function buildChatViewProps(input: BuildChatViewPropsInput): TranscriptPanelProps {
  return {
    scrollRef: input.refs.scrollRef,
    contentRef: input.refs.contentRef,
    endRef: input.refs.endRef,
    messages: input.messages,
    isWelcomeChat: input.isWelcomeChat,
    isThinking: input.isThinking,
    // Viewer policy: no interactive run/plan/agent affordances.
    showFallbackUX: false,
    pendingPlanChoice: null,
    pendingAgentQuestions: input.pendingAgentQuestions,
    onAgentQuestionSubmit: NOOP,
    onAgentQuestionDismiss: NOOP,
    runCompleteNotice: input.runCompleteNotice,
    runCompleteDurationText: null,
    currentChat: input.chat,
    currentRun: input.currentRun ?? null,
    currentWorkspacePath: input.currentWorkspacePath,
    currentProviderLabel: input.providerLabel,
    currentProvider: input.provider,
    thinkingProviderLabel: input.providerLabel,
    thinkingProvider: input.provider,
    // Viewer policy: the focused pane owns the diff surface, not viewers.
    displayFileChangeSummaries: EMPTY_FILE_SUMMARIES,
    fileChangeSummaryText: '',
    fileChangeShouldShowStats: false,
    fileChangeDisplayAdds: 0,
    fileChangeDisplayDels: 0,
    chats: input.chats,
    runningChatIds: input.runningChatIds,
    onPlanChoiceSubmit: NOOP,
    onRunFallback: NOOP,
    onOpenSubThread: input.onOpenSubThread,
    onInspectRun: input.onInspectRun,
    compactDensity: input.compactDensity,
    liveActivityViewport: input.liveActivityViewport,
    pendingQueuedAppRunIds: input.pendingQueuedAppRunIds,
    onCopyMessage: input.onCopyMessage,
    // Viewer policy: read-only — no destructive message mutation.
    onDeleteMessage: NOOP,
    onPreviewImage: input.onPreviewImage,
    copiedId: input.copiedId,
    copy: input.copy,
    currency: input.currency,
    currencyOverestimatePercent: input.currencyOverestimatePercent,
    providerRates: input.providerRates
  }
}
