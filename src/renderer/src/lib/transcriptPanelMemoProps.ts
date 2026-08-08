import type { ChatRecord } from '../../../main/store/types'

/**
 * T7a — TranscriptPanel memo prop groups / equality.
 *
 * ADR §5.8: memo must not key solely on `currentChat ===`. App chrome can
 * replace the ChatRecord object identity on every sidebar tick; the transcript
 * derivation graph should only invalidate when transcript-relevant identity
 * changes (chat id, updatedAt, messages/runs refs, or run identity).
 *
 * Extracted from TranscriptPanel so the comparator is unit-testable without
 * mounting the panel, and so App can build stable prop groups later without
 * growing the monolith comparator.
 *
 * Uses a structural props shape (not a direct import of TranscriptPanelProps)
 * to avoid a runtime cycle with the panel module.
 */

export type TranscriptPanelMemoComparable = {
  scrollRef: unknown
  contentRef: unknown
  endRef: unknown
  messages: unknown
  isWelcomeChat: boolean
  isThinking: boolean
  pendingPlanChoice: unknown
  pendingProposedPlan: unknown
  pendingAgentQuestions: unknown
  onAgentQuestionSubmit: unknown
  onAgentQuestionDismiss: unknown
  onEnsemblePollVote?: unknown
  runCompleteNotice: unknown
  runCompleteDurationText: unknown
  currentRun?: unknown
  currentChat: ChatRecord | null
  currentWorkspacePath?: unknown
  currentProviderLabel: unknown
  currentProvider: unknown
  thinkingProviderLabel?: unknown
  thinkingProvider?: unknown
  thinkingProviderClass?: unknown
  thinkingModelBadge?: unknown
  displayFileChangeSummaries: unknown
  roundFileChangeSummaries?: unknown
  fileChangeSummaryText: unknown
  fileChangeShouldShowStats: unknown
  fileChangeDisplayAdds: unknown
  fileChangeDisplayDels: unknown
  chats: ChatRecord[]
  runningChatIds: string[]
  onOpenFileChangeInWorkbench?: unknown
  onCopyMessage: unknown
  onAddMessageToPrompt?: unknown
  onDeleteMessage: unknown
  onTogglePinMessage?: unknown
  onMessageFeedback?: unknown
  onMessageSelectionCandidate?: unknown
  onOpenSideChatFromMessage?: unknown
  sideChatSeedMessageId?: string | null
  jumpToMessageRequest?: { messageId: string; rowKey?: string; requestId: number } | null
  externalRestoreAnchorMessageId?: string | null
  onManualTranscriptJump?: unknown
  onJumpToLatest?: unknown
  onPreviewImage: unknown
  onDetachToPane?: unknown
  onOpenProjectReferenceCitation?: unknown
  resolveProjectReferenceExtract?: unknown
  copiedId: unknown
  copy: unknown
  virtualize?: unknown
  autoFollowRef?: unknown
  getUserScrollGestureLive?: unknown
  onProgrammaticScrollWrite?: unknown
  collapseOlderRounds?: unknown
  userMessageGutterEnabled?: unknown
  showRunCompleteSummary?: unknown
  compactDensity: unknown
  liveActivityViewport?: unknown
  isGlobal?: unknown
}

export function transcriptRunningChatIdsSignature(ids: readonly string[] | undefined): string {
  if (!ids || ids.length === 0) return ''
  return Array.from(new Set(ids)).sort().join('\u0000')
}

export function transcriptAuxiliaryChatsSignature(chats: readonly ChatRecord[]): string {
  if (chats.length === 0) return ''
  return chats
    .map((chat) => {
      const lastRun = chat.runs?.[chat.runs.length - 1]
      const dispatchError = chat.delegationContext?.dispatchError
      return [
        chat.appChatId,
        chat.title || '',
        chat.updatedAt || '',
        chat.delegationContext?.resultReturnedAt || '',
        typeof dispatchError?.message === 'string' ? dispatchError.message : '',
        lastRun?.runId || '',
        lastRun?.status || '',
        lastRun?.endedAt || ''
      ].join('\u0001')
    })
    .sort()
    .join('\u0002')
}

export function transcriptAuxiliaryChatsEqual(
  previous: readonly ChatRecord[],
  next: readonly ChatRecord[]
): boolean {
  return (
    previous === next ||
    transcriptAuxiliaryChatsSignature(previous) === transcriptAuxiliaryChatsSignature(next)
  )
}

/**
 * Transcript-relevant identity for `currentChat`. Intentionally ignores
 * object identity and non-transcript chrome fields that churn on App commits.
 */
export function transcriptChatIdentityEqual(
  previous: ChatRecord | null | undefined,
  next: ChatRecord | null | undefined
): boolean {
  if (previous === next) return true
  if (!previous || !next) return false
  return (
    previous.appChatId === next.appChatId &&
    previous.updatedAt === next.updatedAt &&
    previous.messages === next.messages &&
    previous.runs === next.runs &&
    previous.title === next.title &&
    previous.archived === next.archived &&
    previous.chatKind === next.chatKind &&
    (previous as { summaryOnly?: boolean }).summaryOnly ===
      (next as { summaryOnly?: boolean }).summaryOnly
  )
}

export function transcriptPanelPropsEqual(
  previous: TranscriptPanelMemoComparable,
  next: TranscriptPanelMemoComparable
): boolean {
  return (
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
    previous.onEnsemblePollVote === next.onEnsemblePollVote &&
    previous.runCompleteNotice === next.runCompleteNotice &&
    previous.runCompleteDurationText === next.runCompleteDurationText &&
    previous.currentRun === next.currentRun &&
    transcriptChatIdentityEqual(previous.currentChat, next.currentChat) &&
    previous.currentWorkspacePath === next.currentWorkspacePath &&
    previous.currentProviderLabel === next.currentProviderLabel &&
    previous.currentProvider === next.currentProvider &&
    previous.thinkingProviderLabel === next.thinkingProviderLabel &&
    previous.thinkingProvider === next.thinkingProvider &&
    previous.thinkingProviderClass === next.thinkingProviderClass &&
    previous.thinkingModelBadge === next.thinkingModelBadge &&
    previous.displayFileChangeSummaries === next.displayFileChangeSummaries &&
    previous.roundFileChangeSummaries === next.roundFileChangeSummaries &&
    previous.fileChangeSummaryText === next.fileChangeSummaryText &&
    previous.fileChangeShouldShowStats === next.fileChangeShouldShowStats &&
    previous.fileChangeDisplayAdds === next.fileChangeDisplayAdds &&
    previous.fileChangeDisplayDels === next.fileChangeDisplayDels &&
    transcriptAuxiliaryChatsEqual(previous.chats, next.chats) &&
    transcriptRunningChatIdsSignature(previous.runningChatIds) ===
      transcriptRunningChatIdsSignature(next.runningChatIds) &&
    previous.onOpenFileChangeInWorkbench === next.onOpenFileChangeInWorkbench &&
    previous.onCopyMessage === next.onCopyMessage &&
    previous.onAddMessageToPrompt === next.onAddMessageToPrompt &&
    previous.onDeleteMessage === next.onDeleteMessage &&
    previous.onTogglePinMessage === next.onTogglePinMessage &&
    previous.onMessageFeedback === next.onMessageFeedback &&
    previous.onMessageSelectionCandidate === next.onMessageSelectionCandidate &&
    previous.onOpenSideChatFromMessage === next.onOpenSideChatFromMessage &&
    previous.sideChatSeedMessageId === next.sideChatSeedMessageId &&
    previous.jumpToMessageRequest?.messageId === next.jumpToMessageRequest?.messageId &&
    previous.jumpToMessageRequest?.rowKey === next.jumpToMessageRequest?.rowKey &&
    previous.jumpToMessageRequest?.requestId === next.jumpToMessageRequest?.requestId &&
    previous.externalRestoreAnchorMessageId === next.externalRestoreAnchorMessageId &&
    previous.onManualTranscriptJump === next.onManualTranscriptJump &&
    previous.onJumpToLatest === next.onJumpToLatest &&
    previous.onPreviewImage === next.onPreviewImage &&
    previous.onDetachToPane === next.onDetachToPane &&
    previous.onOpenProjectReferenceCitation === next.onOpenProjectReferenceCitation &&
    previous.resolveProjectReferenceExtract === next.resolveProjectReferenceExtract &&
    previous.copiedId === next.copiedId &&
    previous.copy === next.copy &&
    previous.virtualize === next.virtualize &&
    previous.autoFollowRef === next.autoFollowRef &&
    previous.getUserScrollGestureLive === next.getUserScrollGestureLive &&
    previous.onProgrammaticScrollWrite === next.onProgrammaticScrollWrite &&
    previous.collapseOlderRounds === next.collapseOlderRounds &&
    previous.userMessageGutterEnabled === next.userMessageGutterEnabled &&
    previous.showRunCompleteSummary === next.showRunCompleteSummary &&
    previous.compactDensity === next.compactDensity &&
    previous.liveActivityViewport === next.liveActivityViewport &&
    previous.isGlobal === next.isGlobal
  )
}
