import type {
  BridgeApprovalReplyAction,
  BridgeCancelRunAction,
  BridgeComposerPromptAction,
  BridgeComposerQueuePromptAction,
  BridgeComposerQueueItemAction,
  BridgeCreateThreadAction,
  BridgeThreadRowExpandAction,
  BridgeThreadMediaFetchAction,
  BridgeThreadSnapshotRequestAction,
  BridgeWorkspaceFileListAction,
  BridgeWorkspaceFileReadAction,
  BridgeWorkspaceFileWriteAction,
  BridgeWorkspaceFileDeleteAction,
  BridgeWorkspaceDiffAction,
  BridgeGitSnapshotAction,
  BridgeGitStageAllAction,
  BridgeGitStagePathsAction,
  BridgeGitUnstagePathsAction,
  BridgeGitCommitAction,
  BridgeGitPushAction,
  BridgeGithubPrStatusAction,
  BridgeGithubPrReadinessAction,
  BridgeGithubCreatePrAction,
  BridgeEnsembleCancelRoundAction,
  BridgeEnsembleCancelWakeupAction,
  BridgeEnsembleQueuePromptAction,
  BridgeEnsembleSkipActiveParticipantAction,
  BridgeEnsembleSteerAction,
  BridgeEnsembleRosterUpdateAction,
  BridgeEnsembleQueueItemAction,
  BridgeSetGuestParticipantAction,
  BridgeRemoveGuestParticipantAction,
  BridgeCreateSideChatAction,
  BridgeSetThreadNotesAction,
  BridgeGoalUpdateAction,
  BridgeToggleMessagePinAction,
  BridgeProposedPlanDecisionAction,
  BridgeCanvasActionAction,
  BridgeEnsembleWakeNowAction,
  BridgeQuestionRejectAction,
  BridgeQuestionReplyAction,
  BridgeRegisterApnsTokenAction,
  BridgeEnsemblePresetMutateAction,
  BridgeDiscoverTailnetHostsAction,
  BridgeSetYoloModeAction,
  BridgeTogglePinChatAction,
  BridgeTogglePinWorkspaceAction
} from './BridgeActionPayload'
import type { AgentApprovalAction } from './store/types'

/**
 * BridgeActionExecutor — Phase C-late execution surface.
 *
 * BridgeActionRouter answers the **policy** question: "should we let this
 * iOS action through?" (allowlist + payload validity). The executor
 * answers the **dispatch** question: "given that we are letting it
 * through, what does the desktop actually DO?"
 *
 * Splitting policy from execution keeps:
 *   - The router thin and easy to test (no service mocking needed).
 *   - Service integrations independently swappable. Each `execute*`
 *     method can be wired (or rewired) without touching policy code.
 *   - A clear contract for what's "done" vs "scaffolded": each method
 *     returns `executed: boolean` so the router can tell iOS the
 *     difference between "policy-denied" and "policy-allowed but the
 *     wiring isn't done yet".
 *
 * Today's slice wires `executeCancelRun` for real (cleanest dispatch
 * surface — single line through `providerAdapters.cancel`). The other
 * four variants return `executed: false, message: 'not yet implemented'`.
 * Each becomes its own focused slice as the underlying main-process
 * service surface stabilizes (the approval-response handler is 182
 * lines deep and needs its own extraction before bridge wiring).
 */

export interface BridgeActionExecutionResult {
  /** Whether the action's real effect was applied (run canceled,
   * approval resolved, prompt sent, etc.). When false, the action was
   * authorized by policy but the dispatch path isn't yet wired. */
  executed: boolean
  /** Human-readable message that surfaces in the iOS ack. */
  message: string
  /** Optional machine-readable execution detail for clients that need to
   * distinguish accepted-but-not-executed outcomes. */
  reasonCode?: BridgeActionExecutionReasonCode
  /** Optional structured data the iOS UI can use to navigate (e.g. the
   * new runId after a composerPrompt is dispatched). */
  data?: Record<string, unknown>
}

export type BridgeActionExecutionReasonCode =
  | 'approvalAlreadyResolved'
  | 'approvalDispatchFailed'

export interface BridgeActionExecutor {
  executeApprovalReply(action: BridgeApprovalReplyAction): Promise<BridgeActionExecutionResult>
  executeQuestionReply(action: BridgeQuestionReplyAction): Promise<BridgeActionExecutionResult>
  executeQuestionReject(action: BridgeQuestionRejectAction): Promise<BridgeActionExecutionResult>
  executeComposerPrompt(action: BridgeComposerPromptAction): Promise<BridgeActionExecutionResult>
  executeComposerQueuePrompt(
    action: BridgeComposerQueuePromptAction
  ): Promise<BridgeActionExecutionResult>
  executeComposerQueueItem(
    action: BridgeComposerQueueItemAction
  ): Promise<BridgeActionExecutionResult>
  executeCreateThread(action: BridgeCreateThreadAction): Promise<BridgeActionExecutionResult>
  executeThreadRowExpand(
    action: BridgeThreadRowExpandAction
  ): Promise<BridgeActionExecutionResult>
  executeThreadMediaFetch(
    action: BridgeThreadMediaFetchAction
  ): Promise<BridgeActionExecutionResult>
  executeThreadSnapshotRequest(
    action: BridgeThreadSnapshotRequestAction
  ): Promise<BridgeActionExecutionResult>
  executeWorkspaceFileList(
    action: BridgeWorkspaceFileListAction
  ): Promise<BridgeActionExecutionResult>
  executeWorkspaceFileRead(
    action: BridgeWorkspaceFileReadAction
  ): Promise<BridgeActionExecutionResult>
  executeWorkspaceFileWrite(
    action: BridgeWorkspaceFileWriteAction
  ): Promise<BridgeActionExecutionResult>
  executeWorkspaceFileDelete(
    action: BridgeWorkspaceFileDeleteAction
  ): Promise<BridgeActionExecutionResult>
  executeWorkspaceDiff(action: BridgeWorkspaceDiffAction): Promise<BridgeActionExecutionResult>
  executeGitSnapshot(action: BridgeGitSnapshotAction): Promise<BridgeActionExecutionResult>
  executeGitStageAll(action: BridgeGitStageAllAction): Promise<BridgeActionExecutionResult>
  executeGitStagePaths(action: BridgeGitStagePathsAction): Promise<BridgeActionExecutionResult>
  executeGitUnstagePaths(
    action: BridgeGitUnstagePathsAction
  ): Promise<BridgeActionExecutionResult>
  executeGitCommit(action: BridgeGitCommitAction): Promise<BridgeActionExecutionResult>
  executeGitPush(action: BridgeGitPushAction): Promise<BridgeActionExecutionResult>
  executeGithubPrStatus(action: BridgeGithubPrStatusAction): Promise<BridgeActionExecutionResult>
  executeGithubPrReadiness(
    action: BridgeGithubPrReadinessAction
  ): Promise<BridgeActionExecutionResult>
  executeGithubCreatePr(action: BridgeGithubCreatePrAction): Promise<BridgeActionExecutionResult>
  executeCancelRun(action: BridgeCancelRunAction): Promise<BridgeActionExecutionResult>
  executeEnsembleCancelRound(
    action: BridgeEnsembleCancelRoundAction
  ): Promise<BridgeActionExecutionResult>
  executeEnsembleSkipActiveParticipant(
    action: BridgeEnsembleSkipActiveParticipantAction
  ): Promise<BridgeActionExecutionResult>
  executeEnsembleWakeNow(action: BridgeEnsembleWakeNowAction): Promise<BridgeActionExecutionResult>
  executeEnsembleCancelWakeup(
    action: BridgeEnsembleCancelWakeupAction
  ): Promise<BridgeActionExecutionResult>
  executeEnsembleQueuePrompt(
    action: BridgeEnsembleQueuePromptAction
  ): Promise<BridgeActionExecutionResult>
  executeEnsembleSteer(action: BridgeEnsembleSteerAction): Promise<BridgeActionExecutionResult>
  executeEnsembleRosterUpdate(
    action: BridgeEnsembleRosterUpdateAction
  ): Promise<BridgeActionExecutionResult>
  executeEnsembleQueueItem(
    action: BridgeEnsembleQueueItemAction
  ): Promise<BridgeActionExecutionResult>
  executeSetGuestParticipant(
    action: BridgeSetGuestParticipantAction
  ): Promise<BridgeActionExecutionResult>
  executeRemoveGuestParticipant(
    action: BridgeRemoveGuestParticipantAction
  ): Promise<BridgeActionExecutionResult>
  executeCreateSideChat(
    action: BridgeCreateSideChatAction
  ): Promise<BridgeActionExecutionResult>
  executeSetThreadNotes(action: BridgeSetThreadNotesAction): Promise<BridgeActionExecutionResult>
  executeGoalUpdate(action: BridgeGoalUpdateAction): Promise<BridgeActionExecutionResult>
  executeToggleMessagePin(
    action: BridgeToggleMessagePinAction
  ): Promise<BridgeActionExecutionResult>
  executeProposedPlanDecision(
    action: BridgeProposedPlanDecisionAction
  ): Promise<BridgeActionExecutionResult>
  executeCanvasAction(action: BridgeCanvasActionAction): Promise<BridgeActionExecutionResult>
  executeRegisterApnsToken(
    action: BridgeRegisterApnsTokenAction
  ): Promise<BridgeActionExecutionResult>
  executeEnsemblePresetMutate(
    action: BridgeEnsemblePresetMutateAction
  ): Promise<BridgeActionExecutionResult>
  executeDiscoverTailnetHosts(
    action: BridgeDiscoverTailnetHostsAction
  ): Promise<BridgeActionExecutionResult>
  executeSetYoloMode(action: BridgeSetYoloModeAction): Promise<BridgeActionExecutionResult>
  executeTogglePinChat(action: BridgeTogglePinChatAction): Promise<BridgeActionExecutionResult>
  executeTogglePinWorkspace(
    action: BridgeTogglePinWorkspaceAction
  ): Promise<BridgeActionExecutionResult>
}

/**
 * NoopActionExecutor — every method returns `executed: false`. Used by
 * the router when no real executor is configured (tests, or main-process
 * states where service dispatch isn't yet available). The router
 * propagates the message back to iOS verbatim so the user sees
 * "scaffolded, not wired" instead of a generic deny.
 */
export class NoopActionExecutor implements BridgeActionExecutor {
  async executeApprovalReply(
    action: BridgeApprovalReplyAction
  ): Promise<BridgeActionExecutionResult> {
    return notWired('approvalReply', action.toolCallId)
  }
  async executeQuestionReply(
    action: BridgeQuestionReplyAction
  ): Promise<BridgeActionExecutionResult> {
    return notWired('questionReply', action.promptId)
  }
  async executeQuestionReject(
    action: BridgeQuestionRejectAction
  ): Promise<BridgeActionExecutionResult> {
    return notWired('questionReject', action.promptId)
  }
  async executeComposerPrompt(
    action: BridgeComposerPromptAction
  ): Promise<BridgeActionExecutionResult> {
    return notWired('composerPrompt', action.threadId)
  }
  async executeComposerQueuePrompt(
    action: BridgeComposerQueuePromptAction
  ): Promise<BridgeActionExecutionResult> {
    return notWired('composerQueuePrompt', action.threadId)
  }
  async executeComposerQueueItem(
    action: BridgeComposerQueueItemAction
  ): Promise<BridgeActionExecutionResult> {
    return notWired('composerQueueItem', action.queueId)
  }
  async executeCreateThread(
    action: BridgeCreateThreadAction
  ): Promise<BridgeActionExecutionResult> {
    return notWired('createThread', action.threadId ?? action.workspaceId)
  }
  async executeThreadRowExpand(
    action: BridgeThreadRowExpandAction
  ): Promise<BridgeActionExecutionResult> {
    return notWired('threadRowExpand', action.rowId)
  }
  async executeThreadMediaFetch(
    action: BridgeThreadMediaFetchAction
  ): Promise<BridgeActionExecutionResult> {
    return notWired('threadMediaFetch', action.mediaId)
  }
  async executeThreadSnapshotRequest(
    action: BridgeThreadSnapshotRequestAction
  ): Promise<BridgeActionExecutionResult> {
    return notWired('threadSnapshotRequest', action.threadId)
  }
  async executeWorkspaceFileList(
    action: BridgeWorkspaceFileListAction
  ): Promise<BridgeActionExecutionResult> {
    return notWired('workspaceFileList', action.workspaceId)
  }
  async executeWorkspaceFileRead(
    action: BridgeWorkspaceFileReadAction
  ): Promise<BridgeActionExecutionResult> {
    return notWired('workspaceFileRead', action.path)
  }
  async executeWorkspaceFileWrite(
    action: BridgeWorkspaceFileWriteAction
  ): Promise<BridgeActionExecutionResult> {
    return notWired('workspaceFileWrite', action.path)
  }
  async executeWorkspaceFileDelete(
    action: BridgeWorkspaceFileDeleteAction
  ): Promise<BridgeActionExecutionResult> {
    return notWired('workspaceFileDelete', action.path)
  }
  async executeWorkspaceDiff(
    action: BridgeWorkspaceDiffAction
  ): Promise<BridgeActionExecutionResult> {
    return notWired('workspaceDiff', action.workspaceId)
  }
  async executeGitSnapshot(action: BridgeGitSnapshotAction): Promise<BridgeActionExecutionResult> {
    return notWired('gitSnapshot', action.workspaceId)
  }
  async executeGitStageAll(action: BridgeGitStageAllAction): Promise<BridgeActionExecutionResult> {
    return notWired('gitStageAll', action.workspaceId)
  }
  async executeGitStagePaths(
    action: BridgeGitStagePathsAction
  ): Promise<BridgeActionExecutionResult> {
    return notWired('gitStagePaths', action.workspaceId)
  }
  async executeGitUnstagePaths(
    action: BridgeGitUnstagePathsAction
  ): Promise<BridgeActionExecutionResult> {
    return notWired('gitUnstagePaths', action.workspaceId)
  }
  async executeGitCommit(action: BridgeGitCommitAction): Promise<BridgeActionExecutionResult> {
    return notWired('gitCommit', action.workspaceId)
  }
  async executeGitPush(action: BridgeGitPushAction): Promise<BridgeActionExecutionResult> {
    return notWired('gitPush', action.workspaceId)
  }
  async executeGithubPrStatus(
    action: BridgeGithubPrStatusAction
  ): Promise<BridgeActionExecutionResult> {
    return notWired('githubPrStatus', action.workspaceId)
  }
  async executeGithubPrReadiness(
    action: BridgeGithubPrReadinessAction
  ): Promise<BridgeActionExecutionResult> {
    return notWired('githubPrReadiness', action.workspaceId)
  }
  async executeGithubCreatePr(
    action: BridgeGithubCreatePrAction
  ): Promise<BridgeActionExecutionResult> {
    return notWired('githubCreatePr', action.workspaceId)
  }
  async executeCancelRun(action: BridgeCancelRunAction): Promise<BridgeActionExecutionResult> {
    return notWired('cancelRun', action.runId)
  }
  async executeEnsembleCancelRound(
    action: BridgeEnsembleCancelRoundAction
  ): Promise<BridgeActionExecutionResult> {
    return notWired('ensembleCancelRound', action.threadId)
  }
  async executeEnsembleSkipActiveParticipant(
    action: BridgeEnsembleSkipActiveParticipantAction
  ): Promise<BridgeActionExecutionResult> {
    return notWired('ensembleSkipActiveParticipant', action.threadId)
  }
  async executeEnsembleWakeNow(
    action: BridgeEnsembleWakeNowAction
  ): Promise<BridgeActionExecutionResult> {
    return notWired('ensembleWakeNow', action.wakeupId)
  }
  async executeEnsembleCancelWakeup(
    action: BridgeEnsembleCancelWakeupAction
  ): Promise<BridgeActionExecutionResult> {
    return notWired('ensembleCancelWakeup', action.wakeupId)
  }
  async executeEnsembleQueuePrompt(
    action: BridgeEnsembleQueuePromptAction
  ): Promise<BridgeActionExecutionResult> {
    return notWired('ensembleQueuePrompt', action.threadId)
  }
  async executeEnsembleSteer(
    action: BridgeEnsembleSteerAction
  ): Promise<BridgeActionExecutionResult> {
    return notWired('ensembleSteer', action.threadId)
  }
  async executeEnsembleRosterUpdate(
    action: BridgeEnsembleRosterUpdateAction
  ): Promise<BridgeActionExecutionResult> {
    return notWired('ensembleRosterUpdate', action.threadId)
  }
  async executeEnsembleQueueItem(
    action: BridgeEnsembleQueueItemAction
  ): Promise<BridgeActionExecutionResult> {
    return notWired('ensembleQueueItem', action.threadId)
  }
  async executeSetGuestParticipant(
    action: BridgeSetGuestParticipantAction
  ): Promise<BridgeActionExecutionResult> {
    return notWired('setGuestParticipant', action.threadId)
  }
  async executeRemoveGuestParticipant(
    action: BridgeRemoveGuestParticipantAction
  ): Promise<BridgeActionExecutionResult> {
    return notWired('removeGuestParticipant', action.threadId)
  }
  async executeCreateSideChat(
    action: BridgeCreateSideChatAction
  ): Promise<BridgeActionExecutionResult> {
    return notWired('createSideChat', action.threadId)
  }
  async executeSetThreadNotes(
    action: BridgeSetThreadNotesAction
  ): Promise<BridgeActionExecutionResult> {
    return notWired('setThreadNotes', action.threadId)
  }
  async executeGoalUpdate(action: BridgeGoalUpdateAction): Promise<BridgeActionExecutionResult> {
    return notWired('goalUpdate', action.threadId)
  }
  async executeToggleMessagePin(
    action: BridgeToggleMessagePinAction
  ): Promise<BridgeActionExecutionResult> {
    return notWired('toggleMessagePin', action.threadId)
  }
  async executeProposedPlanDecision(
    action: BridgeProposedPlanDecisionAction
  ): Promise<BridgeActionExecutionResult> {
    return notWired('proposedPlanDecision', action.threadId)
  }
  async executeCanvasAction(
    action: BridgeCanvasActionAction
  ): Promise<BridgeActionExecutionResult> {
    return notWired('canvasAction', action.canvasId)
  }
  async executeRegisterApnsToken(
    action: BridgeRegisterApnsTokenAction
  ): Promise<BridgeActionExecutionResult> {
    return notWired('registerApnsToken', action.pairID)
  }
  async executeEnsemblePresetMutate(
    action: BridgeEnsemblePresetMutateAction
  ): Promise<BridgeActionExecutionResult> {
    return notWired('ensemblePresetMutate', action.op)
  }
  async executeDiscoverTailnetHosts(
    _action: BridgeDiscoverTailnetHostsAction
  ): Promise<BridgeActionExecutionResult> {
    return notWired('discoverTailnetHosts', 'oracle')
  }
  async executeSetYoloMode(action: BridgeSetYoloModeAction): Promise<BridgeActionExecutionResult> {
    return notWired('setYoloMode', String(action.enabled))
  }
  async executeTogglePinChat(
    action: BridgeTogglePinChatAction
  ): Promise<BridgeActionExecutionResult> {
    return notWired('togglePinChat', action.appChatId)
  }
  async executeTogglePinWorkspace(
    action: BridgeTogglePinWorkspaceAction
  ): Promise<BridgeActionExecutionResult> {
    return notWired('togglePinWorkspace', action.workspaceId)
  }
}

function notWired(kind: string, id: string): BridgeActionExecutionResult {
  return {
    executed: false,
    message: `Action "${kind}" (id=${id}) authorized but execution not yet wired`
  }
}

/**
 * MainProcessActionExecutor — the production implementation that
 * dispatches into Electron's main-process services.
 *
 * Wired today:
 *   - `executeCancelRun` → `cancelRunFn(provider, runId)` which delegates
 *     to the provider adapter's `cancel` method (same dispatch path the
 *     `cancel-agent-run` IPC handler uses).
 *
 * Scaffolded (return `executed: false`):
 *   - `executeApprovalReply` — wires after the `respond-agent-approval`
 *     IPC handler body is extracted into a callable. Owns ~5 provider-
 *     specific pending-approval registries; that extraction is its own
 *     slice.
 *   - `executeQuestionReply` / `executeQuestionReject` — tool-driven
 *     prompt-reply paths; provider-specific (Kimi/Gemini/Codex each have
 *     their own ask-question shapes).
 *   - `executeComposerPrompt` — needs the prompt-composition + run-start
 *     surface from main (currently distributed across IPC handlers
 *     `run-agent` etc.).
 */
export interface MainProcessActionExecutorDependencies {
  /** Callback the executor uses to cancel a run. Same dispatch surface
   * the `cancel-agent-run` IPC handler uses. */
  cancelRunFn: (provider: string, runId: string) => Promise<unknown>
  /** Callback the executor uses to resolve a pending approval or question.
   * Wraps the extracted `processAgentApprovalResponse` so iOS-initiated
   * decisions walk the same registries as renderer-initiated ones.
   * Returns `true` when the entry was found and processed, `false` when
   * no pending request matched (already resolved / expired / never
   * existed). The `options.userInput` field lets question-reply paths
   * pass typed answers through to Codex's `tool/requestUserInput` /
   * `mcp/elicitation/request` methods. */
  respondApprovalFn?: (
    requestId: string,
    action: AgentApprovalAction,
    options?: { userInput?: string }
  ) => Promise<boolean>
  respondQuestionFn?: (
    action: BridgeQuestionReplyAction | BridgeQuestionRejectAction,
    response: { kind: 'answer'; answer: string } | { kind: 'reject'; reason?: string }
  ) => Promise<boolean>
  /** Callback the executor uses to dispatch an iOS-initiated agent run.
   * The caller in main/index.ts looks up the workspace path by id,
   * builds an `AgentRunPayload`, and calls `dispatchAgentRun` with
   * `mainWindow.webContents` as the sender (so streaming events show
   * up in the desktop renderer's transcript view). Returns the appRunId
   * the run was dispatched as, or null when the run could not be
   * dispatched (workspace not found, main window missing, etc.). */
  composerPromptFn?: (action: BridgeComposerPromptAction) => Promise<{
    dispatched: boolean
    appRunId: string | null
    reason?: string
  }>
  composerQueuePromptFn?: (action: BridgeComposerQueuePromptAction) => Promise<{
    ok: boolean
    queueId?: string
    reason?: string
  }>
  composerQueueItemFn?: (action: BridgeComposerQueueItemAction) => Promise<{
    ok: boolean
    reason?: string
  }>
  createThreadFn?: (action: BridgeCreateThreadAction) => Promise<{
    ok: boolean
    threadId?: string
    chatKind?: string
    reason?: string
  }>
  threadRowExpandFn?: (action: BridgeThreadRowExpandAction) => Promise<{
    ok: boolean
    row?: Record<string, unknown>
    reason?: string
  }>
  threadMediaFetchFn?: (action: BridgeThreadMediaFetchAction) => Promise<{
    ok: boolean
    media?: Record<string, unknown>
    reason?: string
  }>
  /** Callback the executor uses to register an iOS device's APNs token.
   * The caller in main/index.ts forwards to `BridgeApnsTokenStore.upsert`.
   * Returns true on success, false (with a reason) on validation failure. */
  /** Callback that projects a bounded transcript window for one thread.
   * The snapshot is returned in the ack and may also be pushed on the
   * broadcast channel for older clients. */
  threadSnapshotRequestFn?: (action: BridgeThreadSnapshotRequestAction) => Promise<{
    ok: boolean
    thread?: Record<string, unknown>
    reason?: string
  }>
  workspaceFileListFn?: (action: BridgeWorkspaceFileListAction) => Promise<{
    ok: boolean
    entries?: Record<string, unknown>[]
    truncated?: boolean
    reason?: string
  }>
  workspaceFileReadFn?: (action: BridgeWorkspaceFileReadAction) => Promise<{
    ok: boolean
    file?: Record<string, unknown>
    reason?: string
  }>
  workspaceFileWriteFn?: (action: BridgeWorkspaceFileWriteAction) => Promise<{
    ok: boolean
    file?: Record<string, unknown>
    changeSet?: Record<string, unknown>
    reason?: string
  }>
  workspaceFileDeleteFn?: (action: BridgeWorkspaceFileDeleteAction) => Promise<{
    ok: boolean
    path?: string
    changeSet?: Record<string, unknown>
    reason?: string
  }>
  /** Callback the executor uses to compute the bounded workspace diff
   * for the iOS Diff Studio. The caller in main/index.ts resolves the
   * workspace path by id, runs the SAME git diff the desktop Diff Studio
   * renders, and projects it through `buildBoundedWorkspaceDiff` so the
   * ack stays inside the relay frame budget. Read-only. */
  workspaceDiffFn?: (action: BridgeWorkspaceDiffAction) => Promise<{
    ok: boolean
    diff?: Record<string, unknown>
    reason?: string
  }>
  /** Git workflow callbacks. The caller in main/index.ts resolves the
   * workspace path by id (allowlist-gated upstream by the router) and
   * forwards to GitService. Each returns a COMPACT, Codable-friendly
   * `git` snapshot (capped file list) so acks stay inside the relay
   * frame budget; failures carry GitService's already-legible reason
   * strings ("not a git repository", "nothing to commit", …). */
  gitSnapshotFn?: (action: BridgeGitSnapshotAction) => Promise<{
    ok: boolean
    git?: Record<string, unknown>
    reason?: string
  }>
  gitStageAllFn?: (action: BridgeGitStageAllAction) => Promise<{
    ok: boolean
    git?: Record<string, unknown>
    reason?: string
  }>
  gitStagePathsFn?: (action: BridgeGitStagePathsAction) => Promise<{
    ok: boolean
    git?: Record<string, unknown>
    reason?: string
  }>
  gitUnstagePathsFn?: (action: BridgeGitUnstagePathsAction) => Promise<{
    ok: boolean
    git?: Record<string, unknown>
    reason?: string
  }>
  gitCommitFn?: (action: BridgeGitCommitAction) => Promise<{
    ok: boolean
    git?: Record<string, unknown>
    reason?: string
  }>
  gitPushFn?: (action: BridgeGitPushAction) => Promise<{
    ok: boolean
    git?: Record<string, unknown>
    reason?: string
  }>
  githubPrStatusFn?: (action: BridgeGithubPrStatusAction) => Promise<{
    ok: boolean
    pr?: Record<string, unknown>
    reason?: string
  }>
  githubPrReadinessFn?: (action: BridgeGithubPrReadinessAction) => Promise<{
    ok: boolean
    readiness?: Record<string, unknown>
    reason?: string
  }>
  githubCreatePrFn?: (action: BridgeGithubCreatePrAction) => Promise<{
    ok: boolean
    pr?: Record<string, unknown>
    reason?: string
  }>
  registerApnsTokenFn?: (action: BridgeRegisterApnsTokenAction) => Promise<{
    registered: boolean
    reason?: string
    /** base64 raw X25519 push-agreement public key of the Mac, returned so the
     * device can derive the static shared secret to decrypt rich pushes. */
    macAgreePub?: string
  }>
  ensemblePresetMutateFn?: (action: BridgeEnsemblePresetMutateAction) => Promise<{
    ok: boolean
    reason?: string
  }>
  /** QR-optional discovery (Slice 5e): enumerate the tailnet with the host's
   * stored OAuth credential, probe each device's /v1/hostinfo, and return the
   * TaskWraith hosts (self + already-paired dropped). Read-only — the result
   * rides back UNICAST in the action ack, never a broadcast. Each host is a
   * compact {macIdentityPubKey, macDisplayName?, relayUrls, hostPlatform?}; the
   * fn caps the count so the ack stays inside the relay frame budget. */
  discoverTailnetHostsFn?: () => Promise<{
    ok: boolean
    hosts?: Array<Record<string, unknown>>
    reason?: string
  }>
  setYoloModeFn?: (enabled: boolean) => Promise<{ enabled: boolean }>
  togglePinChatFn?: (action: BridgeTogglePinChatAction) => Promise<{
    pinned: boolean
    reason?: string
  }>
  togglePinWorkspaceFn?: (action: BridgeTogglePinWorkspaceAction) => Promise<{
    pinned: boolean
    reason?: string
  }>
  ensembleCancelRoundFn?: (action: BridgeEnsembleCancelRoundAction) => Promise<unknown>
  ensembleSkipActiveParticipantFn?: (
    action: BridgeEnsembleSkipActiveParticipantAction
  ) => Promise<unknown>
  ensembleWakeNowFn?: (action: BridgeEnsembleWakeNowAction) => Promise<unknown>
  ensembleCancelWakeupFn?: (action: BridgeEnsembleCancelWakeupAction) => Promise<unknown>
  ensembleQueuePromptFn?: (action: BridgeEnsembleQueuePromptAction) => Promise<unknown>
  ensembleSteerFn?: (action: BridgeEnsembleSteerAction) => Promise<unknown>
  ensembleRosterUpdateFn?: (action: BridgeEnsembleRosterUpdateAction) => Promise<unknown>
  ensembleQueueItemFn?: (action: BridgeEnsembleQueueItemAction) => Promise<unknown>
  setGuestParticipantFn?: (action: BridgeSetGuestParticipantAction) => Promise<unknown>
  removeGuestParticipantFn?: (action: BridgeRemoveGuestParticipantAction) => Promise<unknown>
  createSideChatFn?: (action: BridgeCreateSideChatAction) => Promise<unknown>
  setThreadNotesFn?: (action: BridgeSetThreadNotesAction) => Promise<unknown>
  goalUpdateFn?: (action: BridgeGoalUpdateAction) => Promise<{
    ok: boolean
    goal?: unknown
    reason?: string
  }>
  toggleMessagePinFn?: (action: BridgeToggleMessagePinAction) => Promise<unknown>
  proposedPlanDecisionFn?: (action: BridgeProposedPlanDecisionAction) => Promise<unknown>
  canvasActionFn?: (action: BridgeCanvasActionAction) => Promise<unknown>
  log?: (line: string) => void
}

export class MainProcessActionExecutor implements BridgeActionExecutor {
  private readonly deps: MainProcessActionExecutorDependencies
  private readonly log: (line: string) => void

  constructor(deps: MainProcessActionExecutorDependencies) {
    this.deps = deps
    this.log = deps.log ?? (() => {})
  }

  async executeApprovalReply(
    action: BridgeApprovalReplyAction
  ): Promise<BridgeActionExecutionResult> {
    if (!this.deps.respondApprovalFn) {
      this.log(
        `[BridgeActionExecutor] approvalReply has no respondApprovalFn — toolCallId=${action.toolCallId}`
      )
      return notWired('approvalReply', action.toolCallId)
    }
    this.log(
      `[BridgeActionExecutor] approvalReply toolCallId=${action.toolCallId} decision=${action.decision}`
    )
    try {
      const resolved = await this.deps.respondApprovalFn(action.toolCallId, action.decision)
      if (resolved) {
        return {
          executed: true,
          message: `Approval "${action.toolCallId}" resolved as "${action.decision}"`,
          data: { toolCallId: action.toolCallId, decision: action.decision }
        }
      }
      return {
        executed: false,
        reasonCode: 'approvalAlreadyResolved',
        message: `No pending approval found for toolCallId="${action.toolCallId}" (already resolved, expired, or never registered)`
      }
    } catch (err) {
      const errMessage = err instanceof Error ? err.message : String(err)
      this.log(`[BridgeActionExecutor] approvalReply failed: ${errMessage}`)
      return {
        executed: false,
        reasonCode: 'approvalDispatchFailed',
        message: `Approval dispatch failed: ${errMessage}`
      }
    }
  }

  async executeQuestionReply(
    action: BridgeQuestionReplyAction
  ): Promise<BridgeActionExecutionResult> {
    if (!this.deps.respondQuestionFn && !this.deps.respondApprovalFn) {
      this.log(
        `[BridgeActionExecutor] questionReply has no responder — promptId=${action.promptId}`
      )
      return notWired('questionReply', action.promptId)
    }
    this.log(
      `[BridgeActionExecutor] questionReply promptId=${action.promptId} answerLen=${action.answer.length}`
    )
    try {
      const resolved = this.deps.respondQuestionFn
        ? await this.deps.respondQuestionFn(action, { kind: 'answer', answer: action.answer })
        : await this.deps.respondApprovalFn!(action.promptId, 'accept', {
            userInput: action.answer
          })
      if (resolved) {
        return {
          executed: true,
          message: `Question "${action.promptId}" answered`,
          data: { promptId: action.promptId, answerLength: action.answer.length }
        }
      }
      return {
        executed: false,
        message: `No pending question found for promptId="${action.promptId}" (already resolved, expired, or never registered)`
      }
    } catch (err) {
      const errMessage = err instanceof Error ? err.message : String(err)
      this.log(`[BridgeActionExecutor] questionReply failed: ${errMessage}`)
      return {
        executed: false,
        message: `Question reply dispatch failed: ${errMessage}`
      }
    }
  }

  async executeQuestionReject(
    action: BridgeQuestionRejectAction
  ): Promise<BridgeActionExecutionResult> {
    if (!this.deps.respondQuestionFn && !this.deps.respondApprovalFn) {
      this.log(
        `[BridgeActionExecutor] questionReject has no responder — promptId=${action.promptId}`
      )
      return notWired('questionReject', action.promptId)
    }
    this.log(`[BridgeActionExecutor] questionReject promptId=${action.promptId}`)
    try {
      const resolved = this.deps.respondQuestionFn
        ? await this.deps.respondQuestionFn(action, {
            kind: 'reject',
            reason: action.message || 'user-dismissed'
          })
        : await this.deps.respondApprovalFn!(action.promptId, 'decline')
      if (resolved) {
        return {
          executed: true,
          message: `Question "${action.promptId}" rejected`,
          data: { promptId: action.promptId }
        }
      }
      return {
        executed: false,
        message: `No pending question found for promptId="${action.promptId}" (already resolved, expired, or never registered)`
      }
    } catch (err) {
      const errMessage = err instanceof Error ? err.message : String(err)
      this.log(`[BridgeActionExecutor] questionReject failed: ${errMessage}`)
      return {
        executed: false,
        message: `Question reject dispatch failed: ${errMessage}`
      }
    }
  }

  async executeThreadSnapshotRequest(
    action: BridgeThreadSnapshotRequestAction
  ): Promise<BridgeActionExecutionResult> {
    if (!this.deps.threadSnapshotRequestFn) {
      return notWired('threadSnapshotRequest', action.threadId)
    }
    try {
      const result = await this.deps.threadSnapshotRequestFn(action)
      return result.ok
        ? {
            executed: true,
            message: `Thread snapshot loaded for ${action.threadId}`,
            data: result.thread ? { thread: result.thread, threadId: action.threadId } : undefined
          }
        : {
            executed: false,
            message: `Thread snapshot unavailable${result.reason ? `: ${result.reason}` : ''}`
          }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      this.log(`[BridgeActionExecutor] threadSnapshotRequest failed: ${message}`)
      return { executed: false, message: `Thread snapshot failed: ${message}` }
    }
  }

  async executeThreadRowExpand(
    action: BridgeThreadRowExpandAction
  ): Promise<BridgeActionExecutionResult> {
    if (!this.deps.threadRowExpandFn) {
      return notWired('threadRowExpand', action.rowId)
    }
    try {
      const result = await this.deps.threadRowExpandFn(action)
      if (result.ok && result.row) {
        return {
          executed: true,
          message: 'Expanded row.',
          data: { row: result.row, rowId: action.rowId, threadId: action.threadId }
        }
      }
      return {
        executed: false,
        message: result.reason ?? 'Could not expand row.'
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      return { executed: false, message: `Row expand failed: ${message}` }
    }
  }

  async executeThreadMediaFetch(
    action: BridgeThreadMediaFetchAction
  ): Promise<BridgeActionExecutionResult> {
    if (!this.deps.threadMediaFetchFn) {
      return notWired('threadMediaFetch', action.mediaId)
    }
    try {
      const result = await this.deps.threadMediaFetchFn(action)
      if (result.ok && result.media) {
        return {
          executed: true,
          message: 'Fetched transcript media.',
          data: { media: result.media, mediaId: action.mediaId, rowId: action.rowId, threadId: action.threadId }
        }
      }
      return {
        executed: false,
        message: result.reason ?? 'Could not fetch transcript media.'
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      return { executed: false, message: `Media fetch failed: ${message}` }
    }
  }

  async executeWorkspaceFileList(
    action: BridgeWorkspaceFileListAction
  ): Promise<BridgeActionExecutionResult> {
    if (!this.deps.workspaceFileListFn) {
      return notWired('workspaceFileList', action.workspaceId)
    }
    try {
      const result = await this.deps.workspaceFileListFn(action)
      if (result.ok && result.entries) {
        return {
          executed: true,
          message: `Loaded ${result.entries.length} workspace file entries.`,
          data: {
            entries: result.entries,
            truncated: Boolean(result.truncated)
          }
        }
      }
      return {
        executed: false,
        message: result.reason ?? 'Could not list workspace files.'
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      this.log(`[BridgeActionExecutor] workspaceFileList failed: ${message}`)
      return { executed: false, message: `Workspace file list failed: ${message}` }
    }
  }

  async executeWorkspaceFileRead(
    action: BridgeWorkspaceFileReadAction
  ): Promise<BridgeActionExecutionResult> {
    if (!this.deps.workspaceFileReadFn) {
      return notWired('workspaceFileRead', action.path)
    }
    try {
      const result = await this.deps.workspaceFileReadFn(action)
      if (result.ok && result.file) {
        return {
          executed: true,
          message: `Opened ${action.path}.`,
          data: { file: result.file }
        }
      }
      return {
        executed: false,
        message: result.reason ?? 'Could not open workspace file.'
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      this.log(`[BridgeActionExecutor] workspaceFileRead failed: ${message}`)
      return { executed: false, message: `Workspace file read failed: ${message}` }
    }
  }

  async executeWorkspaceFileWrite(
    action: BridgeWorkspaceFileWriteAction
  ): Promise<BridgeActionExecutionResult> {
    if (!this.deps.workspaceFileWriteFn) {
      return notWired('workspaceFileWrite', action.path)
    }
    try {
      const result = await this.deps.workspaceFileWriteFn(action)
      if (result.ok && result.file) {
        return {
          executed: true,
          message: `Saved ${action.path}.`,
          data: {
            file: result.file,
            ...(result.changeSet ? { changeSet: result.changeSet } : {})
          }
        }
      }
      return {
        executed: false,
        message: result.reason ?? 'Could not save workspace file.'
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      this.log(`[BridgeActionExecutor] workspaceFileWrite failed: ${message}`)
      return { executed: false, message: `Workspace file write failed: ${message}` }
    }
  }

  async executeWorkspaceFileDelete(
    action: BridgeWorkspaceFileDeleteAction
  ): Promise<BridgeActionExecutionResult> {
    if (!this.deps.workspaceFileDeleteFn) {
      return notWired('workspaceFileDelete', action.path)
    }
    try {
      const result = await this.deps.workspaceFileDeleteFn(action)
      if (result.ok) {
        return {
          executed: true,
          message: `Deleted ${result.path ?? action.path}.`,
          data: {
            path: result.path ?? action.path,
            ...(result.changeSet ? { changeSet: result.changeSet } : {})
          }
        }
      }
      return {
        executed: false,
        message: result.reason ?? 'Could not delete workspace file.'
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      this.log(`[BridgeActionExecutor] workspaceFileDelete failed: ${message}`)
      return { executed: false, message: `Workspace file delete failed: ${message}` }
    }
  }

  async executeWorkspaceDiff(
    action: BridgeWorkspaceDiffAction
  ): Promise<BridgeActionExecutionResult> {
    if (!this.deps.workspaceDiffFn) {
      return notWired('workspaceDiff', action.workspaceId)
    }
    try {
      const result = await this.deps.workspaceDiffFn(action)
      if (result.ok && result.diff) {
        return {
          executed: true,
          message: 'Workspace diff computed.',
          data: { diff: result.diff }
        }
      }
      return {
        executed: false,
        message: result.reason ?? 'Could not compute the workspace diff.'
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      this.log(`[BridgeActionExecutor] workspaceDiff failed: ${message}`)
      return { executed: false, message: `Workspace diff failed: ${message}` }
    }
  }

  async executeGitSnapshot(action: BridgeGitSnapshotAction): Promise<BridgeActionExecutionResult> {
    if (!this.deps.gitSnapshotFn) {
      return notWired('gitSnapshot', action.workspaceId)
    }
    try {
      const result = await this.deps.gitSnapshotFn(action)
      if (result.ok && result.git) {
        return { executed: true, message: 'Git status read.', data: { git: result.git } }
      }
      return { executed: false, message: result.reason ?? 'Could not read git status.' }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      this.log(`[BridgeActionExecutor] gitSnapshot failed: ${message}`)
      return { executed: false, message: `Git status failed: ${message}` }
    }
  }

  async executeGitStageAll(action: BridgeGitStageAllAction): Promise<BridgeActionExecutionResult> {
    if (!this.deps.gitStageAllFn) {
      return notWired('gitStageAll', action.workspaceId)
    }
    this.log(`[BridgeActionExecutor] gitStageAll ws=${action.workspaceId}`)
    try {
      const result = await this.deps.gitStageAllFn(action)
      if (result.ok && result.git) {
        return { executed: true, message: 'All changes staged.', data: { git: result.git } }
      }
      return { executed: false, message: result.reason ?? 'Could not stage changes.' }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      this.log(`[BridgeActionExecutor] gitStageAll failed: ${message}`)
      return { executed: false, message: `Stage failed: ${message}` }
    }
  }

  async executeGitStagePaths(
    action: BridgeGitStagePathsAction
  ): Promise<BridgeActionExecutionResult> {
    if (!this.deps.gitStagePathsFn) {
      return notWired('gitStagePaths', action.workspaceId)
    }
    this.log(`[BridgeActionExecutor] gitStagePaths ws=${action.workspaceId} count=${action.paths.length}`)
    try {
      const result = await this.deps.gitStagePathsFn(action)
      if (result.ok && result.git) {
        return { executed: true, message: 'Selected files staged.', data: { git: result.git } }
      }
      return { executed: false, message: result.reason ?? 'Could not stage selected files.' }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      this.log(`[BridgeActionExecutor] gitStagePaths failed: ${message}`)
      return { executed: false, message: `Stage selected files failed: ${message}` }
    }
  }

  async executeGitUnstagePaths(
    action: BridgeGitUnstagePathsAction
  ): Promise<BridgeActionExecutionResult> {
    if (!this.deps.gitUnstagePathsFn) {
      return notWired('gitUnstagePaths', action.workspaceId)
    }
    this.log(`[BridgeActionExecutor] gitUnstagePaths ws=${action.workspaceId} count=${action.paths.length}`)
    try {
      const result = await this.deps.gitUnstagePathsFn(action)
      if (result.ok && result.git) {
        return { executed: true, message: 'Selected files unstaged.', data: { git: result.git } }
      }
      return { executed: false, message: result.reason ?? 'Could not unstage selected files.' }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      this.log(`[BridgeActionExecutor] gitUnstagePaths failed: ${message}`)
      return { executed: false, message: `Unstage selected files failed: ${message}` }
    }
  }

  async executeGitCommit(action: BridgeGitCommitAction): Promise<BridgeActionExecutionResult> {
    if (!this.deps.gitCommitFn) {
      return notWired('gitCommit', action.workspaceId)
    }
    this.log(
      `[BridgeActionExecutor] gitCommit ws=${action.workspaceId} stageAll=${action.stageAll === true} msgLen=${action.message.length}`
    )
    try {
      const result = await this.deps.gitCommitFn(action)
      if (result.ok && result.git) {
        return { executed: true, message: 'Committed.', data: { git: result.git } }
      }
      return { executed: false, message: result.reason ?? 'Could not commit.' }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      this.log(`[BridgeActionExecutor] gitCommit failed: ${message}`)
      return { executed: false, message: `Commit failed: ${message}` }
    }
  }

  async executeGitPush(action: BridgeGitPushAction): Promise<BridgeActionExecutionResult> {
    if (!this.deps.gitPushFn) {
      return notWired('gitPush', action.workspaceId)
    }
    this.log(
      `[BridgeActionExecutor] gitPush ws=${action.workspaceId} setUpstream=${action.setUpstream === true}`
    )
    try {
      const result = await this.deps.gitPushFn(action)
      if (result.ok && result.git) {
        return { executed: true, message: 'Pushed.', data: { git: result.git } }
      }
      return { executed: false, message: result.reason ?? 'Could not push.' }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      this.log(`[BridgeActionExecutor] gitPush failed: ${message}`)
      return { executed: false, message: `Push failed: ${message}` }
    }
  }

  async executeGithubPrStatus(
    action: BridgeGithubPrStatusAction
  ): Promise<BridgeActionExecutionResult> {
    if (!this.deps.githubPrStatusFn) {
      return notWired('githubPrStatus', action.workspaceId)
    }
    try {
      const result = await this.deps.githubPrStatusFn(action)
      if (result.ok) {
        // `pr` may legitimately be absent — "no PR for this branch" is a
        // successful read, and the phone renders it as such.
        return {
          executed: true,
          message: result.pr ? 'Pull request found.' : 'No pull request for this branch.',
          data: result.pr ? { pr: result.pr } : {}
        }
      }
      return { executed: false, message: result.reason ?? 'Could not read pull request status.' }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      this.log(`[BridgeActionExecutor] githubPrStatus failed: ${message}`)
      return { executed: false, message: `Pull request status failed: ${message}` }
    }
  }

  async executeGithubPrReadiness(
    action: BridgeGithubPrReadinessAction
  ): Promise<BridgeActionExecutionResult> {
    if (!this.deps.githubPrReadinessFn) {
      return notWired('githubPrReadiness', action.workspaceId)
    }
    try {
      const result = await this.deps.githubPrReadinessFn(action)
      if (result.ok && result.readiness) {
        return {
          executed: true,
          message: 'Pull request readiness computed.',
          data: { readiness: result.readiness }
        }
      }
      return {
        executed: false,
        message: result.reason ?? 'Could not compute pull request readiness.'
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      this.log(`[BridgeActionExecutor] githubPrReadiness failed: ${message}`)
      return { executed: false, message: `Pull request readiness failed: ${message}` }
    }
  }

  async executeGithubCreatePr(
    action: BridgeGithubCreatePrAction
  ): Promise<BridgeActionExecutionResult> {
    if (!this.deps.githubCreatePrFn) {
      return notWired('githubCreatePr', action.workspaceId)
    }
    this.log(`[BridgeActionExecutor] githubCreatePr ws=${action.workspaceId}`)
    try {
      const result = await this.deps.githubCreatePrFn(action)
      if (result.ok && result.pr) {
        return { executed: true, message: 'Pull request created.', data: { pr: result.pr } }
      }
      return { executed: false, message: result.reason ?? 'Could not create the pull request.' }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      this.log(`[BridgeActionExecutor] githubCreatePr failed: ${message}`)
      return { executed: false, message: `Create pull request failed: ${message}` }
    }
  }

  async executeCreateThread(
    action: BridgeCreateThreadAction
  ): Promise<BridgeActionExecutionResult> {
    if (!this.deps.createThreadFn) {
      return notWired('createThread', action.threadId ?? action.workspaceId)
    }
    this.log(
      `[BridgeActionExecutor] createThread variant=${action.variant} ws=${action.workspaceId}`
    )
    try {
      const result = await this.deps.createThreadFn(action)
      if (result.ok && result.threadId) {
        return {
          executed: true,
          message: 'Chat created on your Mac.',
          data: {
            threadId: result.threadId,
            workspaceId: action.workspaceId,
            chatKind: result.chatKind
          }
        }
      }
      return {
        executed: false,
        message: result.reason ?? 'Could not create chat on your Mac.'
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      this.log(`[BridgeActionExecutor] createThread failed: ${message}`)
      return { executed: false, message: `Create thread failed: ${message}` }
    }
  }

  async executeComposerPrompt(
    action: BridgeComposerPromptAction
  ): Promise<BridgeActionExecutionResult> {
    if (!this.deps.composerPromptFn) {
      this.log(
        `[BridgeActionExecutor] composerPrompt has no composerPromptFn — threadId=${action.threadId}`
      )
      return notWired('composerPrompt', action.threadId)
    }
    this.log(
      `[BridgeActionExecutor] composerPrompt provider=${action.provider} ws=${action.workspaceId} thread=${action.threadId}`
    )
    try {
      const result = await this.deps.composerPromptFn(action)
      if (result.dispatched) {
        // `appRunId` may be null: the dispatcher acks at ACCEPTANCE and
        // runs preflight/dispatch async so the phone's ack window isn't
        // held hostage to provider startup. The run id reaches the phone
        // via the projection snapshot that follows dispatch.
        return {
          executed: true,
          message: 'Dispatching on your Mac.',
          data: {
            ...(result.appRunId ? { appRunId: result.appRunId } : {}),
            workspaceId: action.workspaceId,
            threadId: action.threadId,
            provider: action.provider
          }
        }
      }
      return {
        executed: false,
        message: `Composer prompt could not be dispatched${result.reason ? `: ${result.reason}` : ''}`
      }
    } catch (err) {
      const errMessage = err instanceof Error ? err.message : String(err)
      this.log(`[BridgeActionExecutor] composerPrompt failed: ${errMessage}`)
      return {
        executed: false,
        message: `Composer prompt dispatch failed: ${errMessage}`
      }
    }
  }

  async executeComposerQueuePrompt(
    action: BridgeComposerQueuePromptAction
  ): Promise<BridgeActionExecutionResult> {
    if (!this.deps.composerQueuePromptFn) {
      return notWired('composerQueuePrompt', action.threadId)
    }
    this.log(
      `[BridgeActionExecutor] composerQueuePrompt provider=${action.provider} ws=${action.workspaceId} thread=${action.threadId}`
    )
    try {
      const result = await this.deps.composerQueuePromptFn(action)
      if (result.ok) {
        return {
          executed: true,
          message: 'Queued on your Mac.',
          data: {
            ...(result.queueId ? { queueId: result.queueId } : {}),
            workspaceId: action.workspaceId,
            threadId: action.threadId,
            provider: action.provider
          }
        }
      }
      return {
        executed: false,
        message: result.reason ?? 'Composer prompt could not be queued.'
      }
    } catch (err) {
      const errMessage = err instanceof Error ? err.message : String(err)
      this.log(`[BridgeActionExecutor] composerQueuePrompt failed: ${errMessage}`)
      return {
        executed: false,
        message: `Composer prompt queue failed: ${errMessage}`
      }
    }
  }

  async executeComposerQueueItem(
    action: BridgeComposerQueueItemAction
  ): Promise<BridgeActionExecutionResult> {
    if (!this.deps.composerQueueItemFn) {
      return notWired('composerQueueItem', action.queueId)
    }
    this.log(
      `[BridgeActionExecutor] composerQueueItem op=${action.op} queueId=${action.queueId}`
    )
    try {
      const result = await this.deps.composerQueueItemFn(action)
      return {
        executed: Boolean(result.ok),
        message: result.ok ? 'Queued prompt updated.' : result.reason ?? 'Queued prompt update failed.',
        data: {
          queueId: action.queueId,
          workspaceId: action.workspaceId,
          threadId: action.threadId,
          op: action.op
        }
      }
    } catch (err) {
      const errMessage = err instanceof Error ? err.message : String(err)
      this.log(`[BridgeActionExecutor] composerQueueItem failed: ${errMessage}`)
      return {
        executed: false,
        message: `Queued prompt update failed: ${errMessage}`
      }
    }
  }

  async executeCancelRun(action: BridgeCancelRunAction): Promise<BridgeActionExecutionResult> {
    this.log(`[BridgeActionExecutor] cancelRun provider=${action.provider} runId=${action.runId}`)
    try {
      const result = await this.deps.cancelRunFn(action.provider, action.runId)
      return {
        executed: true,
        message: `Run "${action.runId}" cancellation dispatched to provider "${action.provider}"`,
        data: {
          cancelResult: serializableOrNull(result),
          runId: action.runId,
          provider: action.provider
        }
      }
    } catch (err) {
      const errMessage = err instanceof Error ? err.message : String(err)
      this.log(`[BridgeActionExecutor] cancelRun failed: ${errMessage}`)
      return {
        executed: false,
        message: `Cancel dispatch failed: ${errMessage}`
      }
    }
  }

  async executeEnsembleCancelRound(
    action: BridgeEnsembleCancelRoundAction
  ): Promise<BridgeActionExecutionResult> {
    return this.executeEnsembleAction(
      'ensembleCancelRound',
      action.threadId,
      this.deps.ensembleCancelRoundFn,
      action
    )
  }

  async executeEnsembleSkipActiveParticipant(
    action: BridgeEnsembleSkipActiveParticipantAction
  ): Promise<BridgeActionExecutionResult> {
    return this.executeEnsembleAction(
      'ensembleSkipActiveParticipant',
      action.threadId,
      this.deps.ensembleSkipActiveParticipantFn,
      action
    )
  }

  async executeEnsembleWakeNow(
    action: BridgeEnsembleWakeNowAction
  ): Promise<BridgeActionExecutionResult> {
    return this.executeEnsembleAction(
      'ensembleWakeNow',
      action.wakeupId,
      this.deps.ensembleWakeNowFn,
      action
    )
  }

  async executeEnsembleCancelWakeup(
    action: BridgeEnsembleCancelWakeupAction
  ): Promise<BridgeActionExecutionResult> {
    return this.executeEnsembleAction(
      'ensembleCancelWakeup',
      action.wakeupId,
      this.deps.ensembleCancelWakeupFn,
      action
    )
  }

  async executeEnsembleQueuePrompt(
    action: BridgeEnsembleQueuePromptAction
  ): Promise<BridgeActionExecutionResult> {
    return this.executeEnsembleAction(
      'ensembleQueuePrompt',
      action.threadId,
      this.deps.ensembleQueuePromptFn,
      action
    )
  }

  async executeEnsembleSteer(
    action: BridgeEnsembleSteerAction
  ): Promise<BridgeActionExecutionResult> {
    return this.executeEnsembleAction(
      'ensembleSteer',
      action.threadId,
      this.deps.ensembleSteerFn,
      action
    )
  }

  async executeEnsembleRosterUpdate(
    action: BridgeEnsembleRosterUpdateAction
  ): Promise<BridgeActionExecutionResult> {
    return this.executeEnsembleAction(
      'ensembleRosterUpdate',
      action.threadId,
      this.deps.ensembleRosterUpdateFn,
      action
    )
  }

  async executeEnsembleQueueItem(
    action: BridgeEnsembleQueueItemAction
  ): Promise<BridgeActionExecutionResult> {
    return this.executeEnsembleAction(
      'ensembleQueueItem',
      action.threadId,
      this.deps.ensembleQueueItemFn,
      action
    )
  }

  async executeSetGuestParticipant(
    action: BridgeSetGuestParticipantAction
  ): Promise<BridgeActionExecutionResult> {
    return this.executeEnsembleAction(
      'setGuestParticipant',
      action.threadId,
      this.deps.setGuestParticipantFn,
      action
    )
  }

  async executeRemoveGuestParticipant(
    action: BridgeRemoveGuestParticipantAction
  ): Promise<BridgeActionExecutionResult> {
    return this.executeEnsembleAction(
      'removeGuestParticipant',
      action.threadId,
      this.deps.removeGuestParticipantFn,
      action
    )
  }

  async executeCreateSideChat(
    action: BridgeCreateSideChatAction
  ): Promise<BridgeActionExecutionResult> {
    return this.executeEnsembleAction(
      'createSideChat',
      action.threadId,
      this.deps.createSideChatFn,
      action
    )
  }

  async executeSetThreadNotes(
    action: BridgeSetThreadNotesAction
  ): Promise<BridgeActionExecutionResult> {
    return this.executeEnsembleAction(
      'setThreadNotes',
      action.threadId,
      this.deps.setThreadNotesFn,
      action
    )
  }

  async executeGoalUpdate(action: BridgeGoalUpdateAction): Promise<BridgeActionExecutionResult> {
    if (!this.deps.goalUpdateFn) {
      this.log(
        `[BridgeActionExecutor] goalUpdate has no goalUpdateFn — threadId=${action.threadId}`
      )
      return notWired('goalUpdate', action.threadId)
    }
    try {
      const result = await this.deps.goalUpdateFn(action)
      if (!result.ok) {
        return { executed: false, message: result.reason || 'Goal update was declined' }
      }
      return {
        executed: true,
        message: 'Goal updated.',
        data: { threadId: action.threadId, goal: result.goal ?? null }
      }
    } catch (err) {
      const errMessage = err instanceof Error ? err.message : String(err)
      this.log(`[BridgeActionExecutor] goalUpdate failed: ${errMessage}`)
      return { executed: false, message: `Goal update failed: ${errMessage}` }
    }
  }

  async executeToggleMessagePin(
    action: BridgeToggleMessagePinAction
  ): Promise<BridgeActionExecutionResult> {
    return this.executeEnsembleAction(
      'toggleMessagePin',
      action.threadId,
      this.deps.toggleMessagePinFn,
      action
    )
  }

  async executeProposedPlanDecision(
    action: BridgeProposedPlanDecisionAction
  ): Promise<BridgeActionExecutionResult> {
    return this.executeEnsembleAction(
      'proposedPlanDecision',
      action.threadId,
      this.deps.proposedPlanDecisionFn,
      action
    )
  }
  async executeCanvasAction(
    action: BridgeCanvasActionAction
  ): Promise<BridgeActionExecutionResult> {
    return this.executeEnsembleAction(
      'canvasAction',
      action.canvasId,
      this.deps.canvasActionFn,
      action
    )
  }

  async executeRegisterApnsToken(
    action: BridgeRegisterApnsTokenAction
  ): Promise<BridgeActionExecutionResult> {
    if (!this.deps.registerApnsTokenFn) {
      this.log(
        `[BridgeActionExecutor] registerApnsToken has no registerApnsTokenFn — pairID=${action.pairID}`
      )
      return notWired('registerApnsToken', action.pairID)
    }
    this.log(`[BridgeActionExecutor] registerApnsToken pairID=${action.pairID} env=${action.env}`)
    try {
      const result = await this.deps.registerApnsTokenFn(action)
      if (result.registered) {
        return {
          executed: true,
          message: `APNs token registered for pairID="${action.pairID}" (env=${action.env})`,
          data: { pairID: action.pairID, env: action.env }
        }
      }
      return {
        executed: false,
        message: `APNs token registration declined${result.reason ? `: ${result.reason}` : ''}`
      }
    } catch (err) {
      const errMessage = err instanceof Error ? err.message : String(err)
      this.log(`[BridgeActionExecutor] registerApnsToken failed: ${errMessage}`)
      return {
        executed: false,
        message: `APNs token registration failed: ${errMessage}`
      }
    }
  }

  async executeEnsemblePresetMutate(
    action: BridgeEnsemblePresetMutateAction
  ): Promise<BridgeActionExecutionResult> {
    if (!this.deps.ensemblePresetMutateFn) {
      return notWired('ensemblePresetMutate', action.op)
    }
    try {
      const result = await this.deps.ensemblePresetMutateFn(action)
      return result.ok
        ? { executed: true, message: `Roster preset ${action.op} applied.` }
        : {
            executed: false,
            message: `Roster preset ${action.op} declined${result.reason ? `: ${result.reason}` : ''}`
          }
    } catch (err) {
      const errMessage = err instanceof Error ? err.message : String(err)
      return { executed: false, message: `Roster preset ${action.op} failed: ${errMessage}` }
    }
  }

  async executeDiscoverTailnetHosts(
    _action: BridgeDiscoverTailnetHostsAction
  ): Promise<BridgeActionExecutionResult> {
    if (!this.deps.discoverTailnetHostsFn) {
      return notWired('discoverTailnetHosts', 'oracle')
    }
    try {
      const result = await this.deps.discoverTailnetHostsFn()
      if (result.ok) {
        // Read-only enumeration: an empty tailnet is still a SUCCESS (mirror
        // executeGitSnapshot — a read that finds nothing still executed). The
        // hosts ride back unicast in the ack; the phone dedupes vs its own
        // paired list defensively.
        const hosts = result.hosts ?? []
        return {
          executed: true,
          message:
            hosts.length === 1
              ? 'Found 1 other TaskWraith host on your tailnet.'
              : `Found ${hosts.length} other TaskWraith hosts on your tailnet.`,
          data: { hosts }
        }
      }
      return { executed: false, message: result.reason ?? 'Could not enumerate the tailnet.' }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      this.log(`[BridgeActionExecutor] discoverTailnetHosts failed: ${message}`)
      return { executed: false, message: `Discovery failed: ${message}` }
    }
  }

  async executeSetYoloMode(action: BridgeSetYoloModeAction): Promise<BridgeActionExecutionResult> {
    if (!this.deps.setYoloModeFn) {
      this.log('[BridgeActionExecutor] setYoloMode has no setYoloModeFn')
      return notWired('setYoloMode', String(action.enabled))
    }
    try {
      const result = await this.deps.setYoloModeFn(action.enabled)
      return {
        executed: true,
        message: `YOLO mode ${result.enabled ? 'enabled' : 'disabled'}`,
        data: { enabled: result.enabled }
      }
    } catch (err) {
      const errMessage = err instanceof Error ? err.message : String(err)
      this.log(`[BridgeActionExecutor] setYoloMode failed: ${errMessage}`)
      return { executed: false, message: `YOLO mode update failed: ${errMessage}` }
    }
  }

  async executeTogglePinChat(
    action: BridgeTogglePinChatAction
  ): Promise<BridgeActionExecutionResult> {
    if (!this.deps.togglePinChatFn) {
      this.log(
        `[BridgeActionExecutor] togglePinChat has no togglePinChatFn — appChatId=${action.appChatId}`
      )
      return notWired('togglePinChat', action.appChatId)
    }
    try {
      const result = await this.deps.togglePinChatFn(action)
      if (result.reason) {
        return { executed: false, message: result.reason }
      }
      return {
        executed: true,
        message: `Chat "${action.appChatId}" ${result.pinned ? 'pinned' : 'unpinned'}`,
        data: { appChatId: action.appChatId, pinned: result.pinned }
      }
    } catch (err) {
      const errMessage = err instanceof Error ? err.message : String(err)
      this.log(`[BridgeActionExecutor] togglePinChat failed: ${errMessage}`)
      return { executed: false, message: `Pin chat update failed: ${errMessage}` }
    }
  }

  async executeTogglePinWorkspace(
    action: BridgeTogglePinWorkspaceAction
  ): Promise<BridgeActionExecutionResult> {
    if (!this.deps.togglePinWorkspaceFn) {
      this.log(
        `[BridgeActionExecutor] togglePinWorkspace has no togglePinWorkspaceFn — workspaceId=${action.workspaceId}`
      )
      return notWired('togglePinWorkspace', action.workspaceId)
    }
    try {
      const result = await this.deps.togglePinWorkspaceFn(action)
      if (result.reason) {
        return { executed: false, message: result.reason }
      }
      return {
        executed: true,
        message: `Workspace "${action.workspaceId}" ${result.pinned ? 'pinned' : 'unpinned'}`,
        data: { workspaceId: action.workspaceId, pinned: result.pinned }
      }
    } catch (err) {
      const errMessage = err instanceof Error ? err.message : String(err)
      this.log(`[BridgeActionExecutor] togglePinWorkspace failed: ${errMessage}`)
      return { executed: false, message: `Pin workspace update failed: ${errMessage}` }
    }
  }

  private async executeEnsembleAction<TAction>(
    kind: string,
    id: string,
    handler: ((action: TAction) => Promise<unknown>) | undefined,
    action: TAction
  ): Promise<BridgeActionExecutionResult> {
    if (!handler) {
      this.log(`[BridgeActionExecutor] ${kind} has no handler — id=${id}`)
      return notWired(kind, id)
    }
    try {
      const result = await handler(action)
      const resultRecord = isRecord(result) ? result : null
      const okValue = typeof resultRecord?.ok === 'boolean' ? resultRecord.ok : undefined
      const appliedValue =
        typeof resultRecord?.applied === 'boolean' ? resultRecord.applied : undefined
      const executed = okValue ?? appliedValue ?? Boolean(result)
      const reason =
        typeof resultRecord?.error === 'string'
          ? resultRecord.error
          : typeof resultRecord?.reason === 'string'
            ? resultRecord.reason
            : typeof resultRecord?.message === 'string'
              ? resultRecord.message
              : undefined
      return {
        executed,
        message: executed
          ? `Ensemble action "${kind}" applied`
          : `Ensemble action "${kind}" was not applied${reason ? `: ${reason}` : ''}`,
        data: {
          actionKind: kind,
          result: serializableOrNull(result)
        }
      }
    } catch (err) {
      const errMessage = err instanceof Error ? err.message : String(err)
      this.log(`[BridgeActionExecutor] ${kind} failed: ${errMessage}`)
      return {
        executed: false,
        message: `Ensemble action "${kind}" failed: ${errMessage}`
      }
    }
  }
}

/** Best-effort coercion of a service-returned value into something
 * JSON-safe for the executor result. Strings/numbers/booleans/objects
 * pass through; functions / undefined become null. */
function serializableOrNull(value: unknown): unknown {
  if (value === undefined || typeof value === 'function') return null
  try {
    // Round-trip through JSON to strip non-serializable bits.
    return JSON.parse(JSON.stringify(value))
  } catch {
    return null
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}
