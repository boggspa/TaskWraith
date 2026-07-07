import type { GitRepositorySnapshot } from './GitService'
import type { GitSnapshotPublisher } from './GitSnapshotPublisher'

export interface RemoteGitFeedWorkspace {
  workspaceId: string
  workspacePath: string
}

export interface RemoteGitSnapshotFeedOptions {
  publisher: Pick<GitSnapshotPublisher, 'subscribe' | 'unsubscribe'>
  /** Registered workspaces currently allowlisted for remote monitoring. */
  listWorkspaces: () => RemoteGitFeedWorkspace[]
  /** Fresh-snapshot landing spot — cache + broadcast to paired phones. */
  onSnapshot: (workspaceId: string, workspacePath: string, snapshot: GitRepositorySnapshot) => void
  log?: (line: string) => void
  now?: () => number
}

/** A failed subscribe (usually "not a git repo") is retried no sooner than
 * this — reconcile runs on every projection build, and each retry spawns a
 * git process. */
const FAILED_SUBSCRIBE_RETRY_MS = 60_000

/**
 * Keeps the remote (iOS) git snapshot cache as fresh as the desktop pill.
 *
 * The desktop pill rides GitSnapshotPublisher — fs-watcher plus run-event
 * invalidations, debounced with a min recompute interval — while the remote
 * cache historically refreshed only on phone pulls and run events, so git
 * changes with no run attached (terminal commits, other sessions, editor
 * saves) never reached a paired phone until some unrelated event fired.
 *
 * This feed holds headless publisher subscriptions for every allowlisted
 * workspace WHILE at least one phone is connected, landing each recompute in
 * the remote cache at the publisher's own cadence (250ms debounce, 1.2s min
 * interval per repo). Zero phones connected = zero subscriptions = zero extra
 * fs watchers or git work on an idle Mac.
 */
export class RemoteGitSnapshotFeed {
  private readonly opts: RemoteGitSnapshotFeedOptions
  private readonly now: () => number
  private readonly subscribed = new Map<string, { subscriptionId: string; workspacePath: string }>()
  private readonly failedSubscribeAt = new Map<string, number>()
  private connectedCount = 0
  private queue: Promise<void> = Promise.resolve()
  private sequence = 0
  private disposed = false

  constructor(opts: RemoteGitSnapshotFeedOptions) {
    this.opts = opts
    this.now = opts.now ?? Date.now
  }

  setConnectedDeviceCount(count: number): void {
    this.connectedCount = Math.max(0, count)
    this.reconcile()
  }

  /** Re-align subscriptions with the current workspace/allowlist set. Cheap
   * when nothing changed — safe to call from hot broadcast paths. */
  reconcile(): void {
    this.queue = this.queue
      .then(() => this.reconcileNow())
      .catch((error) => {
        this.opts.log?.(`[remote-git-feed] reconcile failed: ${String(error)}`)
      })
  }

  /** Resolves once every reconcile requested so far has completed. */
  settled(): Promise<void> {
    return this.queue
  }

  dispose(): void {
    this.disposed = true
    for (const entry of this.subscribed.values()) {
      this.opts.publisher.unsubscribe(entry.subscriptionId)
    }
    this.subscribed.clear()
  }

  private async reconcileNow(): Promise<void> {
    if (this.disposed) return
    const desired = new Map<string, string>()
    if (this.connectedCount > 0) {
      for (const workspace of this.opts.listWorkspaces()) {
        if (!workspace.workspaceId || !workspace.workspacePath) continue
        desired.set(workspace.workspaceId, workspace.workspacePath)
      }
    }
    for (const [workspaceId, entry] of Array.from(this.subscribed)) {
      if (desired.get(workspaceId) === entry.workspacePath) continue
      this.opts.publisher.unsubscribe(entry.subscriptionId)
      this.subscribed.delete(workspaceId)
    }
    for (const [workspaceId, workspacePath] of desired) {
      if (this.subscribed.has(workspaceId)) continue
      const failedAt = this.failedSubscribeAt.get(workspaceId)
      if (failedAt !== undefined && this.now() - failedAt < FAILED_SUBSCRIBE_RETRY_MS) continue
      this.sequence += 1
      const subscriptionId = `remote-git-feed:${workspaceId}:${this.sequence}`
      const result = await this.opts.publisher.subscribe({
        subscriptionId,
        requestedPath: workspacePath,
        send: (payload) => {
          if (this.disposed) return
          // Stale-closure guard: only the workspace's CURRENT subscription
          // may land snapshots (path changes resubscribe under a new id).
          if (this.subscribed.get(workspaceId)?.subscriptionId !== subscriptionId) return
          this.opts.onSnapshot(workspaceId, workspacePath, payload.snapshot)
        }
      })
      if (this.disposed) {
        if (result.ok) this.opts.publisher.unsubscribe(subscriptionId)
        return
      }
      if (!result.ok) {
        this.failedSubscribeAt.set(workspaceId, this.now())
        this.opts.log?.(
          `[remote-git-feed] subscribe failed for ${workspaceId} (${workspacePath}): ${result.error}`
        )
        continue
      }
      this.failedSubscribeAt.delete(workspaceId)
      this.subscribed.set(workspaceId, { subscriptionId, workspacePath })
      // Land the subscribe-time snapshot too — the phone's first paint after
      // (re)connecting starts fresh instead of waiting for the next change.
      this.opts.onSnapshot(workspaceId, workspacePath, result.data.snapshot)
    }
  }
}
