import { ipcMain, type IpcMainInvokeEvent } from 'electron'
import type { ChatRecord, ExternalPathGrant } from '../store/types'
import type {
  GitCiStatusInput,
  GitCiStatusSummary,
  GitCommitInput,
  GitCreateBranchInput,
  GitCreatePrInput,
  GitCreateWorktreeInput,
  GitPushInput,
  GitRemoveWorktreeInput,
  GitResult,
  GitPrReadiness,
  GitPrSummary,
  GitRepositorySnapshot,
  GitSelectWorktreeInput,
  GitService,
  GitStageInput,
  GitUnstageInput,
  GitWorktreeList
} from '../services/GitService'
import type { GitWorkspaceStats } from '../services/GitWorkspaceStats'
import type {
  GitSnapshotInvalidationReason,
  GitSnapshotPublisher
} from '../services/GitSnapshotPublisher'
import type { WatchedPrDescriptor } from '../../shared/watchedPrNotify'
import type { SetWatchedPrPayload, WatchPrAckPayload } from '../services/WatchPrPoller'
import type {
  ExternalPublishReceiptCompletion,
  ExternalPublishReceiptInput,
  ExternalPublishReceiptWriter
} from '../ExternalPublishReceiptLedger'

type GitIpcPayload = { workspacePath?: string; repoPath?: string; chatId?: string }
type GitWorkspaceStatsPayload = GitIpcPayload & { worktreePath?: string }
type GitSnapshotSubscribePayload = GitIpcPayload & { subscriptionId?: string }
type GitSnapshotInvalidatePayload = GitIpcPayload & { reason?: GitSnapshotInvalidationReason }
type GitIpcScope = 'registered-workspace' | 'registered-or-granted-read' | 'registered-or-granted-write'
type GitAuthorizedPath = {
  ok: true
  path: string
  lexicalPath: string
  source: 'registered' | 'external'
  chatId: string
}

const GIT_SNAPSHOT_INVALIDATION_REASONS = new Set<GitSnapshotInvalidationReason>([
  'subscribe',
  'filesystem',
  'manual',
  'git-action',
  'run-diff'
])

const EXTERNAL_WORKTREE_SCOPE_ERROR =
  'Worktree actions are limited to registered workspace roots.'

export interface GitHandlersDeps {
  getChat: (chatId: string) => ChatRecord | null | undefined
  executableExternalPathGrantsForChat: (
    chat: ChatRecord | null | undefined
  ) => ExternalPathGrant[]
  canonicalExternalGrantPath: (value: string) => string | null
  canonicalPath: (value: string) => string
  findRegisteredWorkspace: (workspacePath: string) => unknown
  gitRepositoryRootForPath: (workspacePath: string) => string | null
  externalGitRepositoryRootIsSelfContained: (repositoryRoot: string) => boolean
  resolvePath: (value: string) => string
  pathSeparator: string
  gitService: Pick<
    GitService,
    | 'snapshot'
    | 'workspaceStats'
    | 'stage'
    | 'unstage'
    | 'commit'
    | 'push'
    | 'listBranches'
    | 'checkoutBranch'
    | 'createBranch'
    | 'listWorktrees'
    | 'createWorktree'
    | 'removeWorktree'
    | 'selectWorktree'
    | 'pullRequestStatus'
    | 'pullRequestReadiness'
    | 'createPullRequest'
    | 'ciStatus'
  >
  gitSnapshotPublisher?: Pick<
    GitSnapshotPublisher,
    'subscribe' | 'unsubscribe' | 'unsubscribeWebContents' | 'invalidatePath' | 'publishSnapshot'
  >
  externalPublishReceipts?: Pick<ExternalPublishReceiptWriter, 'begin' | 'complete'>
  openSafeShellTarget: (url: unknown) => Promise<{ ok: boolean; error?: string }>
  /**
   * Slice-6 "watch PR" (A1d) wiring, provided by main's poller composition.
   * Optional so existing handler tests constructed without a poller stay valid.
   */
  watchPr?: {
    setWatchedPr: (
      chatId: string,
      descriptor: WatchedPrDescriptor | null
    ) => Promise<{ ok: true } | { ok: false; error: string }>
    resolveAck: (chatId: string, signature: string, ok: boolean, error?: string) => void
    forgetWatch: (chatId: string) => void
  }
  assertSenderScope: (
    event: IpcMainInvokeEvent,
    input: { capability: 'git'; chatId?: string; workspacePath: string }
  ) => void
}

type ExternalPublishReceiptStart = Omit<
  ExternalPublishReceiptInput,
  'origin' | 'decision' | 'reason'
>

type ExternalPublishReceiptStartResult =
  | { ok: true; receiptId?: string }
  | { ok: false; error: string; receiptId?: string }

function externalGrantCoversPath(
  deps: GitHandlersDeps,
  targetPath: string,
  grants: ExternalPathGrant[],
  access: 'read' | 'write'
): boolean {
  const target = (deps.canonicalExternalGrantPath(targetPath) || deps.resolvePath(targetPath)).replace(
    /\/+$/,
    ''
  )
  return grants.some((grant) => {
    if (grant.kind !== 'directory') return false
    // `grant.path` is part of the signed capability and was canonicalized when
    // main issued it. Never re-realpath that authority string at use time: if
    // the original directory is replaced by a symlink, following it here would
    // silently retarget a still-valid signature to a different repository.
    const grantPath = deps.resolvePath(grant.path).replace(/\/+$/, '')
    const coversPath =
      target === grantPath ||
      (grant.kind === 'directory' && target.startsWith(grantPath + deps.pathSeparator))
    if (!coversPath) return false
    return access === 'read' || grant.access === 'write'
  })
}

function gitScopeError(scope: GitIpcScope): string {
  if (scope === 'registered-workspace') return 'Git actions are limited to registered workspaces.'
  if (scope === 'registered-or-granted-write') {
    return 'Git actions require registered workspaces or signed write grants.'
  }
  return 'Git inspection is limited to registered workspaces or signed external path grants.'
}

function gitPayloadPath(
  deps: GitHandlersDeps,
  event: IpcMainInvokeEvent,
  payload: GitIpcPayload | undefined,
  scope: GitIpcScope
):
  | GitAuthorizedPath
  | { ok: false; error: string } {
  const raw =
    typeof payload?.repoPath === 'string' && payload.repoPath.trim()
      ? payload.repoPath
      : payload?.workspacePath || ''
  const requestedPath = raw.trim()
  if (!requestedPath) {
    return { ok: false, error: 'Repository path is required.' }
  }
  const lexicalNormalized = deps.canonicalPath(requestedPath)
  const normalized = deps.canonicalExternalGrantPath(requestedPath) || lexicalNormalized
  const chatId = typeof payload?.chatId === 'string' ? payload.chatId.trim() : ''
  deps.assertSenderScope(event, {
    capability: 'git',
    ...(chatId ? { chatId } : {}),
    workspacePath: normalized
  })
  const repositoryRoot = deps.gitRepositoryRootForPath(normalized)
  if (
    deps.findRegisteredWorkspace(lexicalNormalized) ||
    deps.findRegisteredWorkspace(normalized)
  ) {
    // The configured workspace is the filesystem authority boundary. Git's
    // default repo-root behavior must not widen a registered monorepo package
    // to sibling packages outside that workspace.
    if (repositoryRoot !== normalized) {
      return { ok: false, error: gitScopeError(scope) }
    }
    return {
      ok: true,
      path: normalized,
      lexicalPath: lexicalNormalized,
      source: 'registered',
      chatId
    }
  }
  if (scope === 'registered-workspace') {
    return { ok: false, error: gitScopeError(scope) }
  }
  // External Git operations are repository-wide: even a snapshot resolves to
  // repoRoot and exposes sibling status, while stage/commit/branch/worktree
  // actions mutate that root. A grant for only a nested subdirectory must not
  // silently widen to the containing repository.
  if (!repositoryRoot || repositoryRoot !== normalized) {
    return { ok: false, error: gitScopeError(scope) }
  }
  if (!deps.externalGitRepositoryRootIsSelfContained(repositoryRoot)) {
    return { ok: false, error: gitScopeError(scope) }
  }
  const chat = chatId ? deps.getChat(chatId) : null
  if (
    chat &&
    externalGrantCoversPath(
      deps,
      normalized,
      deps.executableExternalPathGrantsForChat(chat),
      scope === 'registered-or-granted-write' ? 'write' : 'read'
    )
  ) {
    return {
      ok: true,
      path: normalized,
      lexicalPath: lexicalNormalized,
      source: 'external',
      chatId
    }
  }
  return {
    ok: false,
    error: gitScopeError(scope)
  }
}

function gitSnapshotSubscriptionStillAuthorized(
  deps: GitHandlersDeps,
  event: IpcMainInvokeEvent,
  bound: GitAuthorizedPath
): boolean {
  deps.assertSenderScope(event, {
    capability: 'git',
    ...(bound.chatId ? { chatId: bound.chatId } : {}),
    workspacePath: bound.path
  })
  if (bound.source === 'registered') {
    return Boolean(
      deps.findRegisteredWorkspace(bound.lexicalPath) ||
        deps.findRegisteredWorkspace(bound.path)
    )
  }
  // External repositories must retain both halves of their original
  // authority: a self-contained `.git` marker and the chat's live signed
  // grant. This deliberately avoids another `git rev-parse` during publish.
  if (!deps.externalGitRepositoryRootIsSelfContained(bound.path)) return false
  const chat = bound.chatId ? deps.getChat(bound.chatId) : null
  return Boolean(
    chat &&
      externalGrantCoversPath(
        deps,
        bound.path,
        deps.executableExternalPathGrantsForChat(chat),
        'read'
      )
  )
}

function gitSnapshotInvalidationReason(value: unknown): GitSnapshotInvalidationReason {
  return typeof value === 'string' &&
    GIT_SNAPSHOT_INVALIDATION_REASONS.has(value as GitSnapshotInvalidationReason)
    ? (value as GitSnapshotInvalidationReason)
    : 'manual'
}

async function beginDesktopExternalPublishReceipt(
  deps: GitHandlersDeps,
  input: ExternalPublishReceiptStart
): Promise<ExternalPublishReceiptStartResult> {
  if (!deps.externalPublishReceipts) return { ok: true }
  try {
    const receipt = await deps.externalPublishReceipts.begin({
      ...input,
      origin: 'desktop-ui',
      decision: 'allowed',
      reason: 'Desktop user initiated external publishing.'
    })
    if (receipt.decision === 'denied') {
      return {
        ok: false,
        error: receipt.reason || 'External publishing is blocked by policy.',
        receiptId: receipt.id
      }
    }
    return { ok: true, receiptId: receipt.id }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return {
      ok: false,
      error: `External publishing receipt could not be recorded: ${message}`
    }
  }
}

async function completeExternalPublishReceipt(
  deps: GitHandlersDeps,
  receiptId: string | undefined,
  input: Omit<ExternalPublishReceiptCompletion, 'id'>
): Promise<void> {
  if (!receiptId || !deps.externalPublishReceipts) return
  try {
    await deps.externalPublishReceipts.complete({ id: receiptId, ...input })
  } catch {
    // The publish operation already reached Git/GitHub; completion metadata is
    // best-effort so a disk-write failure here does not hide the real result.
  }
}

function worktreeListContainsPath(list: GitWorktreeList, targetPath: string): boolean {
  const target = targetPath.trim().replace(/\/+$/, '')
  if (!target) return false
  return list.worktrees.some((worktree) => worktree.path.replace(/\/+$/, '') === target)
}

export function registerGitHandlers(deps: GitHandlersDeps): void {
  type SubscriptionCleanup = {
    cleanup: () => void
    webContentsId: number
  }
  const subscriptionCleanups = new Map<string, SubscriptionCleanup>()

  ipcMain.handle('git:snapshot', async (event, payload?: GitIpcPayload) => {
    const repo = gitPayloadPath(deps, event, payload, 'registered-or-granted-read')
    return repo.ok ? deps.gitService.snapshot(repo.path) : repo
  })

  ipcMain.handle(
    'git:workspace-stats',
    async (
      event,
      payload?: GitWorkspaceStatsPayload
    ): Promise<GitResult<GitWorkspaceStats> | { ok: false; error: string }> => {
      const repo = gitPayloadPath(deps, event, payload, 'registered-or-granted-read')
      if (!repo.ok) return repo
      const targetPath = String(payload?.worktreePath || '').trim()
      if (!targetPath || targetPath.replace(/\/+$/, '') === repo.path.replace(/\/+$/, '')) {
        return deps.gitService.workspaceStats(repo.path)
      }
      if (repo.source === 'external') {
        return { ok: false, error: EXTERNAL_WORKTREE_SCOPE_ERROR }
      }
      const worktrees = await deps.gitService.listWorktrees(repo.path)
      if (!worktrees.ok) return worktrees
      if (!worktreeListContainsPath(worktrees.data, targetPath)) {
        return { ok: false, error: 'Selected path is not a linked worktree for this repository.' }
      }
      return deps.gitService.workspaceStats(targetPath)
    }
  )

  ipcMain.handle(
    'git:subscribe-snapshot',
    async (
      event: IpcMainInvokeEvent,
      payload?: GitSnapshotSubscribePayload
    ): Promise<
      | Awaited<ReturnType<NonNullable<GitHandlersDeps['gitSnapshotPublisher']>['subscribe']>>
      | { ok: false; error: string }
    > => {
      if (!deps.gitSnapshotPublisher) {
        return { ok: false, error: 'Live git snapshots are unavailable.' }
      }
      const subscriptionId =
        typeof payload?.subscriptionId === 'string' ? payload.subscriptionId.trim() : ''
      if (!subscriptionId) return { ok: false, error: 'Subscription id is required.' }
      const repo = gitPayloadPath(deps, event, payload, 'registered-or-granted-read')
      if (!repo.ok) return repo
      const sender = event.sender
      const existing = subscriptionCleanups.get(subscriptionId)
      if (existing && existing.webContentsId !== sender.id) {
        return {
          ok: false,
          error: 'Git snapshot subscription id belongs to another renderer.'
        }
      }
      existing?.cleanup()
      const forgetSubscription = (): void => {
        if (subscriptionCleanups.get(subscriptionId) === subscription) {
          subscriptionCleanups.delete(subscriptionId)
        }
      }
      const onDestroyed = (): void => {
        deps.gitSnapshotPublisher?.unsubscribe(subscriptionId)
        forgetSubscription()
      }
      const cleanup = (): void => {
        sender.removeListener('destroyed', onDestroyed)
        deps.gitSnapshotPublisher?.unsubscribe(subscriptionId)
        forgetSubscription()
      }
      const subscription: SubscriptionCleanup = { cleanup, webContentsId: sender.id }
      sender.once('destroyed', onDestroyed)
      subscriptionCleanups.set(subscriptionId, subscription)
      const boundRepoRoot = repo.path
      const result = await deps.gitSnapshotPublisher.subscribe({
        subscriptionId,
        requestedPath: repo.path,
        webContentsId: sender.id,
        send: (snapshotPayload) => {
          try {
            if (
              snapshotPayload.repoRoot !== boundRepoRoot ||
              snapshotPayload.snapshot.repoRoot !== boundRepoRoot
            ) {
              cleanup()
              return
            }
            if (!gitSnapshotSubscriptionStillAuthorized(deps, event, repo)) {
              cleanup()
              return
            }
            if (sender.isDestroyed()) {
              cleanup()
              return
            }
            sender.send('git:snapshot-changed', snapshotPayload)
          } catch {
            cleanup()
          }
        }
      })
      if (!result.ok) {
        if (subscriptionCleanups.get(subscriptionId) === subscription) cleanup()
        return result
      }
      if (subscriptionCleanups.get(subscriptionId) !== subscription) {
        return {
          ok: false,
          error: 'Git snapshot subscription changed while it was starting.'
        }
      }
      if (
        result.data.repoRoot !== boundRepoRoot ||
        result.data.snapshot.repoRoot !== boundRepoRoot
      ) {
        cleanup()
        return {
          ok: false,
          error: 'Git snapshot repository changed while the subscription was starting.'
        }
      }
      try {
        if (!gitSnapshotSubscriptionStillAuthorized(deps, event, repo)) {
          cleanup()
          return {
            ok: false,
            error: 'Git snapshot authorization changed while the subscription was starting.'
          }
        }
      } catch {
        cleanup()
        return {
          ok: false,
          error: 'Git snapshot authorization changed while the subscription was starting.'
        }
      }
      return result
    }
  )

  ipcMain.handle('git:unsubscribe-snapshot', async (event, payload?: { subscriptionId?: string }) => {
    const subscriptionId =
      typeof payload?.subscriptionId === 'string' ? payload.subscriptionId.trim() : ''
    if (subscriptionId) {
      const subscription = subscriptionCleanups.get(subscriptionId)
      if (subscription && subscription.webContentsId !== event.sender.id) {
        return {
          ok: false,
          error: 'Git snapshot subscription id belongs to another renderer.'
        }
      }
      subscription?.cleanup()
    }
    return { ok: true }
  })

  ipcMain.handle('git:invalidate-snapshot', async (event, payload?: GitSnapshotInvalidatePayload) => {
    const repo = gitPayloadPath(deps, event, payload, 'registered-or-granted-read')
    if (!repo.ok) return repo
    deps.gitSnapshotPublisher?.invalidatePath(repo.path, gitSnapshotInvalidationReason(payload?.reason))
    return { ok: true }
  })

  ipcMain.handle('git:list-branches', async (event, payload?: GitIpcPayload) => {
    const repo = gitPayloadPath(deps, event, payload, 'registered-or-granted-read')
    if (!repo.ok) return { ok: false, branches: [], error: repo.error }
    const result = await deps.gitService.listBranches(repo.path)
    return result.ok
      ? { ok: true, branches: result.data.branches, currentBranch: result.data.currentBranch }
      : { ok: false, branches: [], error: result.error }
  })

  ipcMain.handle(
    'git:checkout-branch',
    async (
      event,
      payload?: GitIpcPayload & Pick<GitCreateBranchInput, 'branch'>
    ): Promise<{ ok: boolean; snapshot?: GitRepositorySnapshot; error?: string }> => {
      const repo = gitPayloadPath(deps, event, payload, 'registered-or-granted-write')
      if (!repo.ok) return { ok: false, error: repo.error }
      const result = await deps.gitService.checkoutBranch({
        repoPath: repo.path,
        branch: payload?.branch || ''
      })
      if (result.ok) deps.gitSnapshotPublisher?.publishSnapshot(result.data, 'git-action')
      return result.ok ? { ok: true, snapshot: result.data } : { ok: false, error: result.error }
    }
  )

  ipcMain.handle(
    'git:create-branch',
    async (
      event,
      payload?: GitIpcPayload & Pick<GitCreateBranchInput, 'branch' | 'from'>
    ): Promise<{ ok: boolean; snapshot?: GitRepositorySnapshot; error?: string }> => {
      const repo = gitPayloadPath(deps, event, payload, 'registered-or-granted-write')
      if (!repo.ok) return { ok: false, error: repo.error }
      const result = await deps.gitService.createBranch({
        repoPath: repo.path,
        branch: payload?.branch || '',
        from: payload?.from
      })
      if (result.ok) deps.gitSnapshotPublisher?.publishSnapshot(result.data, 'git-action')
      return result.ok ? { ok: true, snapshot: result.data } : { ok: false, error: result.error }
    }
  )

  ipcMain.handle('git:list-worktrees', async (event, payload?: GitIpcPayload) => {
    const repo = gitPayloadPath(deps, event, payload, 'registered-or-granted-read')
    if (!repo.ok) return { ok: false, worktrees: [], error: repo.error }
    if (repo.source === 'external') {
      return { ok: false, worktrees: [], error: EXTERNAL_WORKTREE_SCOPE_ERROR }
    }
    const result = await deps.gitService.listWorktrees(repo.path)
    return result.ok
      ? { ok: true, worktrees: result.data.worktrees }
      : { ok: false, worktrees: [], error: result.error }
  })

  ipcMain.handle(
    'git:create-worktree',
    async (
      event,
      payload?: GitIpcPayload & Pick<GitCreateWorktreeInput, 'name' | 'branch' | 'path'>
    ): Promise<{ ok: boolean; snapshot?: GitRepositorySnapshot; error?: string }> => {
      const repo = gitPayloadPath(deps, event, payload, 'registered-or-granted-write')
      if (!repo.ok) return { ok: false, error: repo.error }
      if (repo.source === 'external') return { ok: false, error: EXTERNAL_WORKTREE_SCOPE_ERROR }
      const result = await deps.gitService.createWorktree({
        repoPath: repo.path,
        name: payload?.name,
        branch: payload?.branch,
        path: payload?.path
      })
      if (result.ok) deps.gitSnapshotPublisher?.publishSnapshot(result.data, 'git-action')
      return result.ok ? { ok: true, snapshot: result.data } : { ok: false, error: result.error }
    }
  )

  ipcMain.handle(
    'git:remove-worktree',
    async (
      event,
      payload?: GitIpcPayload & Pick<GitRemoveWorktreeInput, 'path' | 'force'>
    ): Promise<{ ok: boolean; snapshot?: GitRepositorySnapshot; error?: string }> => {
      const repo = gitPayloadPath(deps, event, payload, 'registered-or-granted-write')
      if (!repo.ok) return { ok: false, error: repo.error }
      if (repo.source === 'external') return { ok: false, error: EXTERNAL_WORKTREE_SCOPE_ERROR }
      const result = await deps.gitService.removeWorktree({
        repoPath: repo.path,
        path: payload?.path || '',
        force: payload?.force
      })
      if (result.ok) deps.gitSnapshotPublisher?.publishSnapshot(result.data, 'git-action')
      return result.ok ? { ok: true, snapshot: result.data } : { ok: false, error: result.error }
    }
  )

  ipcMain.handle(
    'git:select-worktree',
    async (
      event,
      payload?: GitIpcPayload & Pick<GitSelectWorktreeInput, 'path'>
    ): Promise<{ ok: boolean; snapshot?: GitRepositorySnapshot; error?: string }> => {
      const repo = gitPayloadPath(deps, event, payload, 'registered-or-granted-read')
      if (!repo.ok) return { ok: false, error: repo.error }
      if (repo.source === 'external') return { ok: false, error: EXTERNAL_WORKTREE_SCOPE_ERROR }
      const worktrees = await deps.gitService.listWorktrees(repo.path)
      if (!worktrees.ok) return { ok: false, error: worktrees.error }
      const target = String(payload?.path || '').trim()
      if (!worktreeListContainsPath(worktrees.data, target)) {
        return { ok: false, error: 'Selected path is not a linked worktree for this repository.' }
      }
      const result = await deps.gitService.selectWorktree({
        repoPath: repo.path,
        path: target
      })
      return result.ok ? { ok: true, snapshot: result.data } : { ok: false, error: result.error }
    }
  )

  ipcMain.handle(
    'git:stage',
    async (
      event,
      payload?: GitIpcPayload & Pick<GitStageInput, 'paths' | 'all' | 'update' | 'patch'>
    ): Promise<GitResult<GitRepositorySnapshot> | { ok: false; error: string }> => {
      const repo = gitPayloadPath(deps, event, payload, 'registered-or-granted-write')
      if (!repo.ok) return repo
      const result = await deps.gitService.stage({
        repoPath: repo.path,
        paths: payload?.paths,
        all: payload?.all,
        update: payload?.update,
        patch: payload?.patch
      })
      if (result.ok) deps.gitSnapshotPublisher?.publishSnapshot(result.data, 'git-action')
      return result
    }
  )

  ipcMain.handle(
    'git:unstage',
    async (
      event,
      payload?: GitIpcPayload & Pick<GitUnstageInput, 'paths'>
    ): Promise<GitResult<GitRepositorySnapshot> | { ok: false; error: string }> => {
      const repo = gitPayloadPath(deps, event, payload, 'registered-or-granted-write')
      if (!repo.ok) return repo
      const result = await deps.gitService.unstage({
        repoPath: repo.path,
        paths: payload?.paths
      })
      if (result.ok) deps.gitSnapshotPublisher?.publishSnapshot(result.data, 'git-action')
      return result
    }
  )

  ipcMain.handle(
    'git:commit',
    async (
      event,
      payload?: GitIpcPayload & Pick<GitCommitInput, 'message'>
    ): Promise<GitResult<GitRepositorySnapshot> | { ok: false; error: string }> => {
      const repo = gitPayloadPath(deps, event, payload, 'registered-or-granted-write')
      if (!repo.ok) return repo
      const result = await deps.gitService.commit({
        repoPath: repo.path,
        message: payload?.message || ''
      })
      if (result.ok) deps.gitSnapshotPublisher?.publishSnapshot(result.data, 'git-action')
      return result
    }
  )

  ipcMain.handle(
    'git:push',
    async (
      event,
      payload?: GitIpcPayload & Pick<GitPushInput, 'setUpstream' | 'remote'>
    ): Promise<GitResult<GitRepositorySnapshot> | { ok: false; error: string }> => {
      const repo = gitPayloadPath(deps, event, payload, 'registered-or-granted-write')
      if (!repo.ok) return repo
      const receipt = await beginDesktopExternalPublishReceipt(deps, {
        action: 'gitPush',
        workspacePath: repo.path,
        repoPath: repo.path,
        remote: payload?.remote,
        setUpstream: payload?.setUpstream
      })
      if (!receipt.ok) return { ok: false, error: receipt.error }
      const result = await deps.gitService.push({
        repoPath: repo.path,
        setUpstream: payload?.setUpstream,
        remote: payload?.remote,
        ...(repo.source === 'external' ? { externalRepository: true } : {})
      })
      await completeExternalPublishReceipt(deps, receipt.receiptId, {
        outcome: result.ok ? 'completed' : 'failed',
        ...(result.ok ? { commitSha: result.data.commit } : { error: result.error })
      })
      if (result.ok) deps.gitSnapshotPublisher?.publishSnapshot(result.data, 'git-action')
      return result
    }
  )

  ipcMain.handle(
    'github:pr-status',
    async (event, payload?: GitIpcPayload): Promise<GitResult<GitPrSummary> | { ok: false; error: string }> => {
      const repo = gitPayloadPath(deps, event, payload, 'registered-or-granted-read')
      return repo.ok ? deps.gitService.pullRequestStatus(repo.path) : repo
    }
  )

  ipcMain.handle(
    'github:pr-readiness',
    async (
      event,
      payload?: GitIpcPayload
    ): Promise<GitResult<GitPrReadiness> | { ok: false; error: string }> => {
      const repo = gitPayloadPath(deps, event, payload, 'registered-or-granted-read')
      return repo.ok ? deps.gitService.pullRequestReadiness(repo.path) : repo
    }
  )

  ipcMain.handle(
    'github:ci-status',
    async (
      event,
      payload?: GitIpcPayload &
        Pick<
          GitCiStatusInput,
          | 'pr'
          | 'branch'
          | 'commitSha'
          | 'includeFailedLogs'
          | 'maxRuns'
          | 'maxFailedLogs'
          | 'maxLogChars'
        >
    ): Promise<GitResult<GitCiStatusSummary> | { ok: false; error: string }> => {
      const repo = gitPayloadPath(deps, event, payload, 'registered-or-granted-read')
      if (!repo.ok) return repo
      return deps.gitService.ciStatus({
        repoPath: repo.path,
        pr: payload?.pr,
        branch: payload?.branch,
        commitSha: payload?.commitSha,
        includeFailedLogs: payload?.includeFailedLogs,
        maxRuns: payload?.maxRuns,
        maxFailedLogs: payload?.maxFailedLogs,
        maxLogChars: payload?.maxLogChars
      })
    }
  )

  // Slice-6 "watch PR" (A1d) — the visible per-chat toggle is the ENTIRE
  // authorization: setting Chat.watchedPr opts the chat into the host poller,
  // clearing it also drops the poller's dedupe cursor. The descriptor is
  // validated/normalized by the store's async race-safe persistWatchedPr; the
  // workspace stays scope-asserted like the rest of the github: family.
  ipcMain.handle(
    'github:set-watched-pr',
    async (
      event,
      payload?: SetWatchedPrPayload
    ): Promise<{ ok: true } | { ok: false; error: string }> => {
      if (!deps.watchPr) return { ok: false, error: 'PR watching is unavailable.' }
      const chatId = typeof payload?.chatId === 'string' ? payload.chatId.trim() : ''
      if (!chatId) return { ok: false, error: 'A chat is required to watch a pull request.' }
      const watched = payload?.watchedPr
      if (watched == null) {
        const cleared = await deps.watchPr.setWatchedPr(chatId, null)
        if (cleared.ok) deps.watchPr.forgetWatch(chatId)
        return cleared
      }
      const workspacePath =
        typeof watched.workspacePath === 'string' ? watched.workspacePath.trim() : ''
      if (!workspacePath) {
        return { ok: false, error: 'A workspace is required to watch a pull request.' }
      }
      deps.assertSenderScope(event, { capability: 'git', chatId, workspacePath })
      return deps.watchPr.setWatchedPr(chatId, {
        chatId,
        workspacePath,
        owner: typeof watched.owner === 'string' ? watched.owner.trim() : '',
        repo: typeof watched.repo === 'string' ? watched.repo.trim() : '',
        prNumber: Number(watched.prNumber)
      })
    }
  )

  // Renderer → poller outcome for a requested thread notification. The dedupe
  // cursor advances ONLY on an ok ack; the poller's pending-ack map enforces
  // chatId+signature pairing, so a stray ack is a no-op.
  ipcMain.handle(
    'github:watch-pr-notify-ack',
    (_event, payload?: WatchPrAckPayload): { ok: true } => {
      const chatId = typeof payload?.chatId === 'string' ? payload.chatId : ''
      const signature = typeof payload?.signature === 'string' ? payload.signature : ''
      if (deps.watchPr && chatId && signature) {
        deps.watchPr.resolveAck(
          chatId,
          signature,
          payload?.ok === true,
          typeof payload?.error === 'string' ? payload.error : undefined
        )
      }
      return { ok: true }
    }
  )

  ipcMain.handle(
    'create-github-pr',
    async (
      event,
      payload?: GitIpcPayload &
        Pick<GitCreatePrInput, 'title' | 'body' | 'draft'> & { openInBrowser?: boolean }
    ): Promise<GitResult<GitPrSummary> | ({ ok: true } & GitPrSummary) | { ok: false; error: string }> => {
      const repo = gitPayloadPath(deps, event, payload, 'registered-or-granted-write')
      if (!repo.ok) return repo
      const receipt = await beginDesktopExternalPublishReceipt(deps, {
        action: 'githubCreatePr',
        workspacePath: repo.path,
        repoPath: repo.path,
        title: payload?.title,
        draft: payload?.draft
      })
      if (!receipt.ok) return { ok: false, error: receipt.error }
      const result = await deps.gitService.createPullRequest({
        repoPath: repo.path,
        title: payload?.title,
        body: payload?.body,
        draft: payload?.draft
      })
      await completeExternalPublishReceipt(deps, receipt.receiptId, {
        outcome: result.ok ? 'completed' : 'failed',
        ...(result.ok ? { prUrl: result.data.url } : { error: result.error })
      })
      if (result.ok) {
        const url = result.data.url
        if (url && payload?.openInBrowser !== false) {
          void deps.openSafeShellTarget(url).catch(() => {})
        }
        return { ok: true, ...result.data }
      }
      return result
    }
  )
}
