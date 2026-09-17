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
  onOpenExecutionMapForThread?: unknown
  hasLiveOwnedExecution?: boolean
  ownedExecutionViews?: readonly unknown[]
  onCancelOwnedExecution?: unknown
  onResumeOwnedExecution?: unknown
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
  /** Fleet wave elevation: pending maps keyed by child subThreadId. */
  pendingAgentApprovalByChatId?: Record<string, { id?: string } | null | undefined>
  pendingApprovalQueueByChatId?: Record<string, readonly { id?: string }[] | undefined>
  onRespondAgentApproval?: unknown
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
  /** In-chat search (Cmd+F) painting state; see `transcriptSearchHighlight`. */
  threadSearchQuery?: string
  threadSearchMatchRowKeys?: ReadonlySet<string>
  threadSearchActiveRowKey?: string | null
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
  /**
   * The two Settings → Appearance values the panel consumes INSIDE its render.
   *
   * An unlisted prop here is silent in both directions: the structural type
   * below is all `unknown`, so `TranscriptPanelProps` stays assignable, and the
   * transcript simply never re-renders when the value changes. There is no type
   * error and no render error — only a stale panel.
   *
   * `fanoutLaneLayout` was missing, and the reason it looked safe is worth
   * writing down: its EFFECT is mostly a `:root` attribute CSS reads outside
   * React, so it reads like pure styling. It is not. TranscriptPanel derives
   * `pairFanoutLanes` from it in JS (`resolveFanoutLaneLayout(fanoutLaneLayout)
   * === 'paired'`), and that one boolean feeds the projection estimate, the
   * slot map and the measurement pass. Left uncompared, switching Fan-out lanes
   * in Settings and returning to the app leaves the panel on the old layout —
   * the takeover hides `.app-transcript` with `display: none` rather than
   * unmounting it, precisely so state survives the round trip, so nothing
   * forces the re-render an unmount would have.
   */
  fanoutLaneLayout?: unknown
  defaultTranscriptView?: unknown
  /**
   * Transcript text size. The `fanoutLaneLayout` warning above applies with
   * full force: the panel resolves this to a NUMBER in its own render, and that
   * number is both the `--transcript-font-scale` it stamps and the
   * `TranscriptLayoutEpoch.fontScale` the estimator, the measure pass and every
   * height cache key are built from. Unlisted, changing the size in Settings
   * and returning leaves the panel on the old scale — and "the setting does
   * nothing" is exactly how that presents.
   *
   * Note the contrast with `transcriptFontFamily`, which is legitimately NOT
   * here: that one is only a CSS variable the panel never reads in JS. Copying
   * that precedent for a font SCALE is the mistake this comment exists to stop.
   */
  transcriptTextSize?: unknown
  isGlobal?: unknown
}

export function transcriptRunningChatIdsSignature(ids: readonly string[] | undefined): string {
  if (!ids || ids.length === 0) return ''
  return Array.from(new Set(ids)).sort().join('\u0000')
}

/** Head + queue approval ids by chat — fleet cards re-render when these change. */
export function transcriptPendingApprovalsSignature(
  byChatId?: Record<string, { id?: string } | null | undefined>,
  queueByChatId?: Record<string, readonly { id?: string }[] | undefined>
): string {
  const keys = new Set<string>()
  if (byChatId) {
    for (const key of Object.keys(byChatId)) keys.add(key)
  }
  if (queueByChatId) {
    for (const key of Object.keys(queueByChatId)) keys.add(key)
  }
  if (keys.size === 0) return ''
  return [...keys]
    .sort()
    .map((chatId) => {
      const ids: string[] = []
      const head = byChatId?.[chatId]
      if (head?.id) ids.push(head.id)
      const queue = queueByChatId?.[chatId]
      if (queue) {
        for (const row of queue) {
          if (row?.id) ids.push(row.id)
        }
      }
      return `${chatId}\u0001${ids.join('\u0002')}`
    })
    .join('\u0003')
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

export function transcriptOwnedExecutionViewsSignature(
  views: readonly unknown[] | undefined
): string {
  if (!views?.length) return ''
  return views
    .map((value) => {
      const view = (value || {}) as Record<string, any>
      const counts = (view.counts || {}) as Record<string, unknown>
      const cells = Array.isArray(view.cells) ? view.cells : []
      return [
        String(view.executionId || ''),
        String(view.title || ''),
        String(view.seatId || ''),
        String(view.state || ''),
        String(view.settled === true),
        ...[
          'total',
          'proposed',
          'queued',
          'running',
          'needsAction',
          'completed',
          'failed',
          'skipped',
          'settled'
        ].map((key) => String(counts[key] ?? '')),
        cells
          .map((cell: Record<string, unknown>) =>
            [cell.id, cell.status, cell.title, cell.kind]
              .map((part) => String(part ?? ''))
              .join('\u0004')
          )
          .join('\u0005')
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

/**
 * Matched-row identity for the in-chat search paint. Identity compare first,
 * because the layout memoises the set; the membership walk only runs when a
 * new set object arrives, and only while the search bar is open.
 */
export function transcriptSearchRowKeysEqual(
  previous: ReadonlySet<string> | undefined,
  next: ReadonlySet<string> | undefined
): boolean {
  if (previous === next) return true
  if (!previous || !next) return false
  if (previous.size !== next.size) return false
  for (const rowKey of previous) if (!next.has(rowKey)) return false
  return true
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
    previous.onOpenExecutionMapForThread === next.onOpenExecutionMapForThread &&
    previous.hasLiveOwnedExecution === next.hasLiveOwnedExecution &&
    transcriptOwnedExecutionViewsSignature(previous.ownedExecutionViews) ===
      transcriptOwnedExecutionViewsSignature(next.ownedExecutionViews) &&
    previous.onCancelOwnedExecution === next.onCancelOwnedExecution &&
    previous.onResumeOwnedExecution === next.onResumeOwnedExecution &&
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
    transcriptPendingApprovalsSignature(
      previous.pendingAgentApprovalByChatId,
      previous.pendingApprovalQueueByChatId
    ) ===
      transcriptPendingApprovalsSignature(
        next.pendingAgentApprovalByChatId,
        next.pendingApprovalQueueByChatId
      ) &&
    previous.onRespondAgentApproval === next.onRespondAgentApproval &&
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
    previous.threadSearchQuery === next.threadSearchQuery &&
    previous.threadSearchActiveRowKey === next.threadSearchActiveRowKey &&
    transcriptSearchRowKeysEqual(
      previous.threadSearchMatchRowKeys,
      next.threadSearchMatchRowKeys
    ) &&
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
    previous.fanoutLaneLayout === next.fanoutLaneLayout &&
    previous.defaultTranscriptView === next.defaultTranscriptView &&
    previous.transcriptTextSize === next.transcriptTextSize &&
    previous.isGlobal === next.isGlobal
  )
}
