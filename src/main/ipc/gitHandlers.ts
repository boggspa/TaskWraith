import { ipcMain, type IpcMainInvokeEvent } from 'electron'
import type { ChatRecord, ExternalPathGrant } from '../store/types'
import type {
  GitCommitInput,
  GitCreatePrInput,
  GitPushInput,
  GitResult,
  GitPrReadiness,
  GitPrSummary,
  GitRepositorySnapshot,
  GitService,
  GitStageInput,
  GitUnstageInput
} from '../services/GitService'
import type {
  GitSnapshotInvalidationReason,
  GitSnapshotPublisher
} from '../services/GitSnapshotPublisher'
import type {
  ExternalPublishReceipt,
  ExternalPublishReceiptCompletion,
  ExternalPublishReceiptInput,
  ExternalPublishReceiptWriter
} from '../ExternalPublishReceiptLedger'

type GitIpcPayload = { workspacePath?: string; repoPath?: string }
type GitSnapshotSubscribePayload = GitIpcPayload & { subscriptionId?: string }
type GitSnapshotInvalidatePayload = GitIpcPayload & { reason?: GitSnapshotInvalidationReason }
type GitIpcScope = 'registered-workspace' | 'registered-or-granted-read'

const GIT_SNAPSHOT_INVALIDATION_REASONS = new Set<GitSnapshotInvalidationReason>([
  'subscribe',
  'filesystem',
  'manual',
  'git-action',
  'run-diff'
])

export interface GitHandlersDeps {
  getChats: () => ChatRecord[]
  externalPathGrantMetadataLists: (chat: ChatRecord | null | undefined) => ExternalPathGrant[]
  normalizeExternalPathGrants: (grants?: ExternalPathGrant[]) => ExternalPathGrant[]
  canonicalExternalGrantPath: (value: string) => string | null
  canonicalPath: (value: string) => string
  findRegisteredWorkspace: (workspacePath: string) => unknown
  resolvePath: (value: string) => string
  pathSeparator: string
  gitService: Pick<
    GitService,
    | 'snapshot'
    | 'stage'
    | 'unstage'
    | 'commit'
    | 'push'
    | 'pullRequestStatus'
    | 'pullRequestReadiness'
    | 'createPullRequest'
  >
  gitSnapshotPublisher?: Pick<
    GitSnapshotPublisher,
    'subscribe' | 'unsubscribe' | 'unsubscribeWebContents' | 'invalidatePath' | 'publishSnapshot'
  >
  externalPublishReceipts?: Pick<ExternalPublishReceiptWriter, 'begin' | 'complete'>
  openExternal: (url: string) => Promise<unknown>
}

type ExternalPublishReceiptStart = Omit<
  ExternalPublishReceiptInput,
  'origin' | 'decision' | 'reason'
>

type ExternalPublishReceiptStartResult =
  | { ok: true; receiptId?: string }
  | { ok: false; error: string; receiptId?: string }

function allSignedExternalPathGrants(deps: GitHandlersDeps): ExternalPathGrant[] {
  return deps.normalizeExternalPathGrants(
    deps.getChats().flatMap((chat) => deps.externalPathGrantMetadataLists(chat))
  )
}

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
    const grantPath = (
      deps.canonicalExternalGrantPath(grant.path) || deps.resolvePath(grant.path)
    ).replace(/\/+$/, '')
    const coversPath =
      target === grantPath ||
      (grant.kind === 'directory' && target.startsWith(grantPath + deps.pathSeparator))
    if (!coversPath) return false
    return access === 'read' || grant.access === 'write'
  })
}

function gitPayloadPath(
  deps: GitHandlersDeps,
  payload: GitIpcPayload | undefined,
  scope: GitIpcScope
): { ok: true; path: string } | { ok: false; error: string } {
  const raw =
    typeof payload?.repoPath === 'string' && payload.repoPath.trim()
      ? payload.repoPath
      : payload?.workspacePath || ''
  const normalized = deps.canonicalExternalGrantPath(raw) || deps.canonicalPath(raw)
  if (!normalized.trim()) {
    return { ok: false, error: 'Repository path is required.' }
  }
  if (deps.findRegisteredWorkspace(normalized)) return { ok: true, path: normalized }
  if (
    scope === 'registered-or-granted-read' &&
    externalGrantCoversPath(deps, normalized, allSignedExternalPathGrants(deps), 'read')
  ) {
    return { ok: true, path: normalized }
  }
  return {
    ok: false,
    error:
      scope === 'registered-or-granted-read'
        ? 'Git inspection is limited to registered workspaces or signed external path grants.'
        : 'Git actions are limited to registered workspaces.'
  }
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

export function registerGitHandlers(deps: GitHandlersDeps): void {
  const subscriptionCleanups = new Map<string, () => void>()

  ipcMain.handle('git:snapshot', async (_event, payload?: GitIpcPayload) => {
    const repo = gitPayloadPath(deps, payload, 'registered-or-granted-read')
    return repo.ok ? deps.gitService.snapshot(repo.path) : repo
  })

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
      const repo = gitPayloadPath(deps, payload, 'registered-or-granted-read')
      if (!repo.ok) return repo
      const sender = event.sender
      subscriptionCleanups.get(subscriptionId)?.()
      const onDestroyed = (): void => {
        deps.gitSnapshotPublisher?.unsubscribe(subscriptionId)
        subscriptionCleanups.delete(subscriptionId)
      }
      const cleanup = (): void => {
        sender.removeListener('destroyed', onDestroyed)
        deps.gitSnapshotPublisher?.unsubscribe(subscriptionId)
        subscriptionCleanups.delete(subscriptionId)
      }
      sender.once('destroyed', onDestroyed)
      subscriptionCleanups.set(subscriptionId, cleanup)
      const result = await deps.gitSnapshotPublisher.subscribe({
        subscriptionId,
        requestedPath: repo.path,
        webContentsId: sender.id,
        send: (snapshotPayload) => {
          if (!sender.isDestroyed()) {
            sender.send('git:snapshot-changed', snapshotPayload)
          }
        }
      })
      if (!result.ok) {
        subscriptionCleanups.get(subscriptionId)?.()
      }
      return result
    }
  )

  ipcMain.handle('git:unsubscribe-snapshot', async (_event, payload?: { subscriptionId?: string }) => {
    const subscriptionId =
      typeof payload?.subscriptionId === 'string' ? payload.subscriptionId.trim() : ''
    if (subscriptionId) {
      const cleanup = subscriptionCleanups.get(subscriptionId)
      if (cleanup) cleanup()
      else deps.gitSnapshotPublisher?.unsubscribe(subscriptionId)
    }
    return { ok: true }
  })

  ipcMain.handle('git:invalidate-snapshot', async (_event, payload?: GitSnapshotInvalidatePayload) => {
    const repo = gitPayloadPath(deps, payload, 'registered-or-granted-read')
    if (!repo.ok) return repo
    deps.gitSnapshotPublisher?.invalidatePath(repo.path, gitSnapshotInvalidationReason(payload?.reason))
    return { ok: true }
  })

  ipcMain.handle(
    'git:stage',
    async (
      _event,
      payload?: GitIpcPayload & Pick<GitStageInput, 'paths' | 'all' | 'update' | 'patch'>
    ): Promise<GitResult<GitRepositorySnapshot> | { ok: false; error: string }> => {
      const repo = gitPayloadPath(deps, payload, 'registered-workspace')
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
      _event,
      payload?: GitIpcPayload & Pick<GitUnstageInput, 'paths'>
    ): Promise<GitResult<GitRepositorySnapshot> | { ok: false; error: string }> => {
      const repo = gitPayloadPath(deps, payload, 'registered-workspace')
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
      _event,
      payload?: GitIpcPayload & Pick<GitCommitInput, 'message'>
    ): Promise<GitResult<GitRepositorySnapshot> | { ok: false; error: string }> => {
      const repo = gitPayloadPath(deps, payload, 'registered-workspace')
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
      _event,
      payload?: GitIpcPayload & Pick<GitPushInput, 'setUpstream' | 'remote'>
    ): Promise<GitResult<GitRepositorySnapshot> | { ok: false; error: string }> => {
      const repo = gitPayloadPath(deps, payload, 'registered-workspace')
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
        remote: payload?.remote
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
    async (_event, payload?: GitIpcPayload): Promise<GitResult<GitPrSummary> | { ok: false; error: string }> => {
      const repo = gitPayloadPath(deps, payload, 'registered-workspace')
      return repo.ok ? deps.gitService.pullRequestStatus(repo.path) : repo
    }
  )

  ipcMain.handle(
    'github:pr-readiness',
    async (
      _event,
      payload?: GitIpcPayload
    ): Promise<GitResult<GitPrReadiness> | { ok: false; error: string }> => {
      const repo = gitPayloadPath(deps, payload, 'registered-workspace')
      return repo.ok ? deps.gitService.pullRequestReadiness(repo.path) : repo
    }
  )

  ipcMain.handle(
    'create-github-pr',
    async (
      _event,
      payload?: GitIpcPayload &
        Pick<GitCreatePrInput, 'title' | 'body' | 'draft'> & { openInBrowser?: boolean }
    ): Promise<GitResult<GitPrSummary> | ({ ok: true } & GitPrSummary) | { ok: false; error: string }> => {
      const repo = gitPayloadPath(deps, payload, 'registered-workspace')
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
          void deps.openExternal(url).catch(() => {})
        }
        return { ok: true, ...result.data }
      }
      return result
    }
  )
}
