import type { TranscriptPanelProps } from '../components/TranscriptPanel'
import type { MultiviewPaneRefs } from '../hooks/useMultiviewState'
import { isGlobalChat } from './chatScope'
import { getLiveToolFileDiffSummaries } from './LiveFileDiffSummary'
import { formatWorkDuration } from './runCompleteSummary'
import {
  mergeCompletionFileChangeSummaries,
  selectCompletionRunIds,
  selectRunEvidenceMessages
} from './RunWorkspaceDiff'

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

type Refs = MultiviewPaneRefs

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
  autoFollowRef?: TranscriptPanelProps['autoFollowRef']
  getUserScrollGestureLive?: TranscriptPanelProps['getUserScrollGestureLive']
  externalRestoreAnchorMessageId?: TranscriptPanelProps['externalRestoreAnchorMessageId']
  onManualTranscriptJump?: TranscriptPanelProps['onManualTranscriptJump']
  onJumpToLatest?: TranscriptPanelProps['onJumpToLatest']
  onProgrammaticScrollWrite?: TranscriptPanelProps['onProgrammaticScrollWrite']
  // Optional pass-throughs — supplied when available, omitted otherwise.
  currentRun?: TranscriptPanelProps['currentRun']
  currentWorkspacePath?: string
  thinkingProviderLabel?: TranscriptPanelProps['thinkingProviderLabel']
  thinkingProvider?: TranscriptPanelProps['thinkingProvider']
  thinkingProviderClass?: TranscriptPanelProps['thinkingProviderClass']
  thinkingModelBadge?: TranscriptPanelProps['thinkingModelBadge']
  liveActivityViewport?: boolean
  fanoutLaneLayout?: TranscriptPanelProps['fanoutLaneLayout']
  onInspectRun?: TranscriptPanelProps['onInspectRun']
  currency?: TranscriptPanelProps['currency']
  currencyOverestimatePercent?: number
  providerRates?: TranscriptPanelProps['providerRates']
  /** Fleet wave elevation: pending approval head/queue keyed by child chat id. */
  pendingAgentApprovalByChatId?: TranscriptPanelProps['pendingAgentApprovalByChatId']
  pendingApprovalQueueByChatId?: TranscriptPanelProps['pendingApprovalQueueByChatId']
  onRespondAgentApproval?: TranscriptPanelProps['onRespondAgentApproval']
}

/** Stable singletons so the viewer policy never changes prop identity. */
const NOOP = (): void => {}
const NOOP_PLAN_CHOICE = (_messageId: string, _option: string): void => {}
const NOOP_AGENT_QUESTION = (_questionId: string, _answer: string, _isCustom: boolean): void => {}
const EMPTY_FILE_SUMMARIES: TranscriptPanelProps['displayFileChangeSummaries'] = []

function evidencePathKey(path: string, workspacePath?: string): string {
  const normalized = path.trim().replace(/\\/g, '/').replace(/^\.\//, '')
  const workspace = workspacePath?.trim().replace(/\\/g, '/').replace(/\/$/, '')
  if (!workspace) return normalized
  const prefix = `${workspace}/`
  return normalized.startsWith(prefix) ? normalized.slice(prefix.length) : normalized
}

interface PaneFileChangePresentation {
  summaries: TranscriptPanelProps['displayFileChangeSummaries']
  roundSummaries: NonNullable<TranscriptPanelProps['roundFileChangeSummaries']>
  text: string
  shouldShowStats: boolean
  additions: number
  deletions: number
}

/**
 * Memo for the pane file-change projection.
 *
 * `getLiveToolFileDiffSummaries` parses a run's streamed tool activities, and
 * this builder ran it raw inside the pane render — once per mounted pane, on
 * every App render, at ensemble flush rates. The focused transcript has had a
 * signature+cache in front of the same call since the 2026-08-18 renderer OOM
 * work; the pane path never got one, so its cost scaled with both pane count
 * and run length.
 *
 * The entry validates every value `paneFileChangePresentation` reads, by
 * identity, so a stale projection is not representable: any real change misses
 * and recomputes. `ensemble.activeRound` is only identity-stable across
 * no-change flushes because of the ensemble-identity work in 9aa368362 — this
 * memo would still be correct without it, just colder.
 *
 * Keyed per (chat, run, workspace) rather than a single entry so two panes on
 * the same chat cannot evict each other, and bounded so closed panes and
 * switched chats cannot accumulate.
 */
interface PaneFileChangeMemoEntry {
  messages: BuildChatViewPropsInput['messages']
  chatKind: unknown
  activeRound: unknown
  runs: unknown
  currentRun: unknown
  hasRunCompleteNotice: boolean
  value: PaneFileChangePresentation
}

const paneFileChangeMemo = new Map<string, PaneFileChangeMemoEntry>()
const PANE_FILE_CHANGE_MEMO_LIMIT = 24
// Workspace paths may contain spaces, so a space cannot separate the key parts
// unambiguously. Built via fromCharCode: writing the escape inline here landed
// a literal NUL byte in this file, which turns it binary to git while tsc and
// the tests both still pass. See the repo control-byte guard.
const PANE_FILE_CHANGE_KEY_SEPARATOR = String.fromCharCode(1)

function paneFileChangeMemoKey(input: BuildChatViewPropsInput): string {
  return [
    input.chat?.appChatId || '',
    input.currentRun?.runId || '',
    input.currentWorkspacePath || ''
  ].join(PANE_FILE_CHANGE_KEY_SEPARATOR)
}

function paneFileChangePresentation(input: BuildChatViewPropsInput): PaneFileChangePresentation {
  const key = paneFileChangeMemoKey(input)
  const chatKind = input.chat?.chatKind
  const activeRound = input.chat?.chatKind === 'ensemble' ? input.chat.ensemble?.activeRound : null
  const runs = input.chat?.runs
  const hasRunCompleteNotice = Boolean(input.runCompleteNotice)
  const cached = paneFileChangeMemo.get(key)
  if (
    cached &&
    cached.messages === input.messages &&
    cached.chatKind === chatKind &&
    cached.activeRound === activeRound &&
    cached.runs === runs &&
    cached.currentRun === input.currentRun &&
    cached.hasRunCompleteNotice === hasRunCompleteNotice
  ) {
    return cached.value
  }
  const value = computePaneFileChangePresentation(input)
  paneFileChangeMemo.delete(key)
  paneFileChangeMemo.set(key, {
    messages: input.messages,
    chatKind,
    activeRound,
    runs,
    currentRun: input.currentRun,
    hasRunCompleteNotice,
    value
  })
  if (paneFileChangeMemo.size > PANE_FILE_CHANGE_MEMO_LIMIT) {
    const oldestKey = paneFileChangeMemo.keys().next().value
    if (oldestKey !== undefined) paneFileChangeMemo.delete(oldestKey)
  }
  return value
}

function computePaneFileChangePresentation(
  input: BuildChatViewPropsInput
): PaneFileChangePresentation {
  const runDiff = input.currentRun?.runDiff
  const exactSummaries = runDiff
    ? [...runDiff.createdFiles, ...runDiff.modifiedFiles, ...runDiff.deletedFiles]
    : null
  const hasExactSummaries = exactSummaries !== null && exactSummaries.length > 0
  const currentRunId = input.currentRun?.runId
  const currentRunMessages = currentRunId
    ? selectRunEvidenceMessages(input.messages, {
        runIds: [currentRunId],
        runs: input.chat?.runs
      })
    : []
  const liveSummaries = getLiveToolFileDiffSummaries(
    currentRunMessages,
    input.currentWorkspacePath
  ).filter((summary) => !summary.isNoise)
  const ownersByPath = new Map<string, NonNullable<(typeof liveSummaries)[number]['owners']>>()
  for (const summary of liveSummaries) {
    if (summary.owners?.length) {
      ownersByPath.set(evidencePathKey(summary.path, input.currentWorkspacePath), summary.owners)
    }
  }
  const exactSummariesWithOwners = (exactSummaries || []).map((summary) => {
    const owners = ownersByPath.get(evidencePathKey(summary.path, input.currentWorkspacePath))
    return summary.owners?.length || !owners ? summary : { ...summary, owners }
  })
  const currentRunSummaries = (hasExactSummaries ? exactSummariesWithOwners : liveSummaries).filter(
    (summary) => !summary.isNoise
  )
  const roundRunIds = input.runCompleteNotice
    ? selectCompletionRunIds(input.chat, input.currentRun)
    : new Set<string>()
  const roundMessages = input.runCompleteNotice
    ? selectRunEvidenceMessages(input.messages, {
        runIds: roundRunIds,
        runs: input.chat?.runs
      })
    : []
  const roundSummaries =
    roundMessages.length > 0
      ? getLiveToolFileDiffSummaries(roundMessages, input.currentWorkspacePath).filter(
          (summary) => !summary.isNoise
        )
      : EMPTY_FILE_SUMMARIES
  const summaries = mergeCompletionFileChangeSummaries(
    currentRunSummaries,
    roundSummaries,
    input.currentWorkspacePath,
    { preferDisplayEvidence: roundRunIds.size <= 1 }
  )
  const completionRoundSummaries = roundSummaries.length > 0 ? summaries : EMPTY_FILE_SUMMARIES
  const summariesAreEstimated =
    !hasExactSummaries || (roundSummaries.length > 0 && roundRunIds.size > 1)
  if (summaries.length === 0) {
    return {
      summaries: EMPTY_FILE_SUMMARIES,
      roundSummaries: completionRoundSummaries,
      text: '',
      shouldShowStats: false,
      additions: 0,
      deletions: 0
    }
  }
  const created = summaries.filter((summary) => summary.status === 'created').length
  const modified = summaries.filter((summary) => summary.status === 'modified').length
  const deleted = summaries.filter((summary) => summary.status === 'deleted').length
  const hasLineStats = summaries.some(
    (summary) => summary.additions !== undefined || summary.deletions !== undefined
  )
  return {
    summaries,
    roundSummaries: completionRoundSummaries,
    text: `Created ${created} · Edited ${modified} · Deleted ${deleted}${summariesAreEstimated ? ' · live est.' : ''}`,
    shouldShowStats: true,
    additions: hasLineStats
      ? summaries.reduce((total, summary) => total + (summary.additions || 0), 0)
      : created + modified,
    deletions: hasLineStats
      ? summaries.reduce((total, summary) => total + (summary.deletions || 0), 0)
      : deleted
  }
}

export function buildChatViewProps(input: BuildChatViewPropsInput): TranscriptPanelProps {
  const fileChanges = paneFileChangePresentation(input)
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
    // Same derivation as the focused surface (App's runCompleteDurationText):
    // the pane's Task Complete card header reads "Worked for …" too.
    runCompleteDurationText: formatWorkDuration(
      input.runCompleteNotice?.startedAt,
      input.runCompleteNotice?.timestamp
    ),
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
    // The transcript completion card is pane-owned even though Diff Studio
    // remains focused-only. Project this chat's own run/tool evidence so a
    // resting pane never hides its writes or borrows another pane's files.
    displayFileChangeSummaries: fileChanges.summaries,
    roundFileChangeSummaries: fileChanges.roundSummaries,
    fileChangeSummaryText: fileChanges.text,
    fileChangeShouldShowStats: fileChanges.shouldShowStats,
    fileChangeDisplayAdds: fileChanges.additions,
    fileChangeDisplayDels: fileChanges.deletions,
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
    fanoutLaneLayout: input.fanoutLaneLayout,
    onCopyMessage: input.onCopyMessage,
    onAddMessageToPrompt: input.onAddMessageToPrompt,
    onDeleteMessage: input.onDeleteMessage ?? NOOP,
    onTogglePinMessage: input.onTogglePinMessage,
    onMessageFeedback: input.onMessageFeedback,
    onOpenSideChatFromMessage: input.onOpenSideChatFromMessage,
    onMessageSelectionCandidate: input.onMessageSelectionCandidate,
    onPreviewImage: input.onPreviewImage,
    onDetachToPane: input.onDetachToPane,
    autoFollowRef: input.autoFollowRef,
    getUserScrollGestureLive: input.getUserScrollGestureLive,
    externalRestoreAnchorMessageId: input.externalRestoreAnchorMessageId,
    onManualTranscriptJump: input.onManualTranscriptJump,
    onJumpToLatest: input.onJumpToLatest,
    onProgrammaticScrollWrite: input.onProgrammaticScrollWrite,
    copiedId: input.copiedId,
    copy: input.copy,
    userMessageGutterEnabled: false,
    currency: input.currency,
    currencyOverestimatePercent: input.currencyOverestimatePercent,
    providerRates: input.providerRates,
    pendingAgentApprovalByChatId: input.pendingAgentApprovalByChatId,
    pendingApprovalQueueByChatId: input.pendingApprovalQueueByChatId,
    onRespondAgentApproval: input.onRespondAgentApproval
  }
}
