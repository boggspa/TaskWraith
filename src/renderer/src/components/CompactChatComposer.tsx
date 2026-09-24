import { useLayoutEffect, useRef, type KeyboardEvent, type RefObject } from 'react'
import type { GitRepositorySnapshot } from '../../../main/services/GitService'
import type { ChatRecord, WorkspaceRecord } from '../../../main/store/types'
import { resolveWorkspaceDisplayName } from '../../../shared/workspaceDisplayName'
import { AGENTIC_SERVICE_LABELS } from '../../../shared/agenticServiceLabels'
import type { ComposerWorktreeSelection } from '../lib/composerWorktreeSelection'
import {
  exactCommandRuleOfferForApproval,
  type AgentApprovalAction,
  type AgentApprovalRequest
} from '../lib/agentApprovalTypes'
import { renderAgentApprovalPreview } from '../lib/agentApprovalPreview'
import { approvalActionPresentation } from '../lib/approvalActionPresentation'
import { useComposerDraft } from '../hooks/useComposerDraft'
import './CompactChatComposer.css'

export interface CompactWorkspaceStatus {
  workspaceName: string
  branchOrWorktree: string
  isWorktree: boolean
  ahead: number
  behind: number
  filesChanged: number
  additions: number
  deletions: number
}

export function compactWorkspaceStatus(input: {
  workspace: WorkspaceRecord | null | undefined
  snapshot: GitRepositorySnapshot | null | undefined
  worktreeSelection?: ComposerWorktreeSelection | null
  diffStats: { filesChanged: number; additions: number; deletions: number }
}): CompactWorkspaceStatus | null {
  const workspace = input.workspace
  if (!workspace) return null
  const snapshot = input.snapshot
  const worktree = input.worktreeSelection
  const branchOrWorktree =
    worktree?.label ||
    (snapshot?.detached ? snapshot.commit?.slice(0, 8) || 'detached' : snapshot?.branch) ||
    workspace.branch ||
    'no branch'

  return {
    workspaceName: resolveWorkspaceDisplayName({
      displayName: workspace.displayName,
      path: workspace.path,
      repoRoot: snapshot?.repoRoot,
      remoteUrl: snapshot?.remoteUrl
    }),
    branchOrWorktree,
    isWorktree: Boolean(worktree),
    ahead: snapshot?.ahead ?? 0,
    behind: snapshot?.behind ?? 0,
    filesChanged: Math.max(0, input.diffStats.filesChanged || 0),
    additions: Math.max(0, input.diffStats.additions || 0),
    deletions: Math.max(0, input.diffStats.deletions || 0)
  }
}

export function compactComposerSubmitMode(input: {
  running: boolean
  canSteer: boolean
  steerBusy: boolean
  midRunInputBehavior?: string
}): 'run' | 'steer' {
  return input.running &&
    input.canSteer &&
    !input.steerBusy &&
    input.midRunInputBehavior === 'steer'
    ? 'steer'
    : 'run'
}

function CompactApprovalCard({
  request,
  onAction
}: {
  request: AgentApprovalRequest
  onAction: (
    requestId: string,
    action: AgentApprovalAction,
    intentNote?: string,
    commandRuleOfferId?: string
  ) => void | Promise<void>
}): React.JSX.Element {
  const actions = request.actions || ['accept', 'decline', 'cancel']
  const exactCommandRuleOffer = exactCommandRuleOfferForApproval(request)
  const displayActions: Array<AgentApprovalAction | 'exactCommandRule'> = actions.flatMap(
    (action) =>
      action === 'acceptForSession' && exactCommandRuleOffer ? ['exactCommandRule'] : [action]
  )
  const externalPath = request.preview?.externalPathDetection?.path
  return (
    <section
      className={`compact-chat-approval provider-${request.provider}`}
      role="alertdialog"
      aria-modal="false"
      aria-labelledby="compact-chat-approval-title"
    >
      <header className="compact-chat-approval-header">
        <strong id="compact-chat-approval-title">{request.title || 'Permission needed'}</strong>
        <span>{request.provider}</span>
      </header>
      {request.body && <p>{request.body}</p>}
      {externalPath && (
        <div className="compact-chat-approval-path">
          <span>Path</span>
          <code>{externalPath}</code>
        </div>
      )}
      {renderAgentApprovalPreview(request.preview)}
      <div className="compact-chat-approval-actions">
        {displayActions.map((action) => {
          if (action === 'exactCommandRule') {
            if (!exactCommandRuleOffer) return null
            return (
              <button
                key={action}
                type="button"
                title={`Add only this literal ${exactCommandRuleOffer.executableName} invocation to a revocable workspace allowlist. Future matches run outside a workspace sandbox and without workspace locks.`}
                onClick={() =>
                  void onAction(request.id, 'accept', undefined, exactCommandRuleOffer.offerId)
                }
              >
                Add exact command to Allowlist
              </button>
            )
          }
          const presentation = approvalActionPresentation(action, {
            serviceLabel: request.service ? AGENTIC_SERVICE_LABELS[request.service] : undefined
          })
          return (
            <button
              key={action}
              type="button"
              className={
                action === 'decline' || action === 'cancel' || action === 'declineExternalPath'
                  ? 'is-danger'
                  : action === 'accept' ||
                      action === 'grantExternalPathRead' ||
                      action === 'grantExternalPathEdit'
                    ? 'is-primary'
                    : undefined
              }
              title={presentation.title}
              onClick={() => void onAction(request.id, action)}
            >
              {presentation.label}
            </button>
          )
        })}
      </div>
    </section>
  )
}

export interface CompactChatComposerProps {
  prompt: string
  currentComposerChatId: string | null
  currentChat: ChatRecord | null
  currentWorkspace: WorkspaceRecord | null
  isCurrentGlobalChat: boolean
  primaryGitSnapshot: GitRepositorySnapshot | null
  composerWorktreeSelection?: ComposerWorktreeSelection | null
  workspaceDiffStats: { filesChanged: number; additions: number; deletions: number }
  composerAreaRef: RefObject<HTMLDivElement | null>
  composerAriaLabel?: string
  composerPlaceholder?: string
  imageAttachments?: readonly unknown[]
  pendingAgentApproval?: AgentApprovalRequest | null
  setChatPromptDraft: (chatId: string | null, value: string) => void
  handlePickImages: () => void | Promise<void>
  handleRun: (...args: any[]) => void | Promise<void>
  handleCancel: () => void | Promise<void>
  handleSteer?: () => void | Promise<void>
  handleAgentApprovalAction: (
    requestId: string,
    action: AgentApprovalAction,
    intentNote?: string,
    commandRuleOfferId?: string
  ) => void | Promise<void>
  isCurrentChatRunning: boolean
  isCurrentChatBusyForSteer: boolean
  isSteerBusyForCurrentChat: boolean
  midRunInputBehavior?: string
}

export function CompactChatComposer({
  prompt: promptFromProps,
  currentComposerChatId,
  currentChat,
  currentWorkspace,
  isCurrentGlobalChat,
  primaryGitSnapshot,
  composerWorktreeSelection,
  workspaceDiffStats,
  composerAreaRef,
  composerAriaLabel = 'Message TaskWraith',
  composerPlaceholder = 'Message TaskWraith…',
  imageAttachments = [],
  pendingAgentApproval,
  setChatPromptDraft,
  handlePickImages,
  handleRun,
  handleCancel,
  handleSteer,
  handleAgentApprovalAction,
  isCurrentChatRunning,
  isCurrentChatBusyForSteer,
  isSteerBusyForCurrentChat,
  midRunInputBehavior
}: CompactChatComposerProps): React.JSX.Element {
  // Live draft, subscribed for this composer's chat. The prop is only a
  // first-render seed: App reads the store non-reactively and no longer
  // re-renders per keystroke, so without this subscription the controlled
  // textarea below would freeze at whatever text App last happened to render.
  const liveComposerDraft = useComposerDraft(currentComposerChatId)
  const prompt = currentComposerChatId ? liveComposerDraft : promptFromProps
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const workspaceStatus = compactWorkspaceStatus({
    workspace: currentWorkspace,
    snapshot: primaryGitSnapshot,
    worktreeSelection: composerWorktreeSelection,
    diffStats: workspaceDiffStats
  })
  const hasSendableContent = Boolean(prompt.trim() || imageAttachments.length > 0)
  const canCompose = Boolean(currentChat && (isCurrentGlobalChat || currentWorkspace))

  useLayoutEffect(() => {
    const textarea = textareaRef.current
    if (!textarea) return
    textarea.style.height = '0px'
    textarea.style.height = `${Math.min(144, Math.max(34, textarea.scrollHeight))}px`
  }, [prompt])

  const submitPrompt = (): void => {
    if (!canCompose || !hasSendableContent) return
    const mode = compactComposerSubmitMode({
      running: isCurrentChatRunning,
      canSteer: Boolean(handleSteer && isCurrentChatBusyForSteer),
      steerBusy: isSteerBusyForCurrentChat,
      midRunInputBehavior
    })
    if (mode === 'steer') {
      void handleSteer?.()
      return
    }
    void handleRun()
  }

  const handleTextareaKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>): void => {
    if (event.key !== 'Enter' || event.shiftKey || event.nativeEvent.isComposing) return
    event.preventDefault()
    submitPrompt()
  }

  return (
    <div className="compact-chat-composer-area" ref={composerAreaRef}>
      {pendingAgentApproval && (
        <CompactApprovalCard request={pendingAgentApproval} onAction={handleAgentApprovalAction} />
      )}
      {workspaceStatus && (
        <div
          className="compact-chat-workspace-row"
          role="status"
          aria-label={`${workspaceStatus.workspaceName}, ${workspaceStatus.branchOrWorktree}, ${workspaceStatus.ahead} commits ahead, ${workspaceStatus.behind} behind, ${workspaceStatus.filesChanged} files changed, ${workspaceStatus.additions} additions, ${workspaceStatus.deletions} deletions`}
        >
          <div className="compact-chat-workspace-context">
            <svg viewBox="0 0 18 18" aria-hidden="true">
              <path d="M5 3v8.5A2.5 2.5 0 0 0 7.5 14H13M5 6h5a3 3 0 0 1 3 3v6M3.5 3a1.5 1.5 0 1 0 3 0 1.5 1.5 0 0 0-3 0ZM11.5 15a1.5 1.5 0 1 0 3 0 1.5 1.5 0 0 0-3 0Z" />
            </svg>
            <strong>{workspaceStatus.workspaceName}</strong>
            <span className="compact-chat-workspace-separator">·</span>
            <span
              className={
                workspaceStatus.isWorktree
                  ? 'compact-chat-worktree-name'
                  : 'compact-chat-branch-name'
              }
              title={workspaceStatus.isWorktree ? 'Selected worktree' : 'Current branch'}
            >
              {workspaceStatus.branchOrWorktree}
            </span>
            <span className="compact-chat-ahead">↑{workspaceStatus.ahead}</span>
            <span className="compact-chat-behind">↓{workspaceStatus.behind}</span>
          </div>
          <div className="compact-chat-workspace-stats">
            <span className="compact-chat-files-changed">
              {workspaceStatus.filesChanged} files changed
            </span>
            <span className="compact-chat-diff-stat">
              <b>+{workspaceStatus.additions}</b>
              <em>-{workspaceStatus.deletions}</em>
            </span>
          </div>
        </div>
      )}
      <div className="compact-chat-composer-pill">
        <button
          className={`compact-chat-attach${imageAttachments.length > 0 ? ' is-active' : ''}`}
          type="button"
          onClick={() => void handlePickImages()}
          disabled={!canCompose}
          title={
            imageAttachments.length > 0
              ? `Attach context · ${imageAttachments.length} attached`
              : 'Attach context'
          }
          aria-label={
            imageAttachments.length > 0
              ? `Attach context, ${imageAttachments.length} attached`
              : 'Attach context'
          }
        >
          <svg viewBox="0 0 18 18" aria-hidden="true">
            <path d="M9 3v12M3 9h12" />
          </svg>
        </button>
        <textarea
          ref={textareaRef}
          rows={1}
          value={prompt}
          aria-label={composerAriaLabel}
          placeholder={composerPlaceholder}
          disabled={!canCompose}
          onChange={(event) => setChatPromptDraft(currentComposerChatId, event.target.value)}
          onKeyDown={handleTextareaKeyDown}
        />
        <button
          className={`compact-chat-send${isCurrentChatRunning ? ' is-stop' : ''}`}
          type="button"
          onClick={() => {
            if (isCurrentChatRunning) {
              void handleCancel()
              return
            }
            submitPrompt()
          }}
          disabled={
            isCurrentChatRunning ? isSteerBusyForCurrentChat : !canCompose || !hasSendableContent
          }
          title={isCurrentChatRunning ? 'Stop run' : 'Send message'}
          aria-label={isCurrentChatRunning ? 'Stop run' : 'Send message'}
        >
          {isCurrentChatRunning ? (
            <span className="compact-chat-stop-symbol" aria-hidden="true" />
          ) : (
            <svg viewBox="0 0 18 18" aria-hidden="true">
              <path d="m5 10 4-4 4 4M9 6v8" />
            </svg>
          )}
        </button>
      </div>
    </div>
  )
}
