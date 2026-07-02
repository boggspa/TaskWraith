import { watch, type FSWatcher } from 'fs'
import { basename } from 'path'
import type { GitRepositorySnapshot, GitResult, GitService } from './GitService'

export type GitSnapshotInvalidationReason =
  | 'subscribe'
  | 'filesystem'
  | 'manual'
  | 'git-action'
  | 'run-diff'

export interface GitSnapshotChangedPayload {
  subscriptionId: string
  requestedPath: string
  repoRoot: string
  snapshot: GitRepositorySnapshot
  generation: number
  reason: GitSnapshotInvalidationReason
}

export interface GitSnapshotSubscription {
  subscriptionId: string
  requestedPath: string
  send: (payload: GitSnapshotChangedPayload) => void
  webContentsId?: number
}

export type GitSnapshotSubscribeResult = GitResult<{
  subscriptionId: string
  requestedPath: string
  repoRoot: string
  snapshot: GitRepositorySnapshot
  generation: number
}>

type WatcherFactory = (
  repoRoot: string,
  onChange: (filename: string | Buffer | null) => void
) => FSWatcher

interface RepoSubscriptionState {
  repoRoot: string
  subscriptions: Set<string>
  watcher: FSWatcher | null
  timer: NodeJS.Timeout | null
  inFlight: boolean
  pendingReason: GitSnapshotInvalidationReason | null
  lastStartedAt: number
  generation: number
  lastGood: GitRepositorySnapshot | null
}

export interface GitSnapshotPublisherOptions {
  gitService: Pick<GitService, 'snapshot'>
  debounceMs?: number
  minIntervalMs?: number
  watcherFactory?: WatcherFactory
}

const DEFAULT_DEBOUNCE_MS = 250
const DEFAULT_MIN_INTERVAL_MS = 1200

const IGNORED_PATH_SEGMENTS = new Set([
  '.git',
  'node_modules',
  '.next',
  'dist',
  'build',
  'out',
  'coverage',
  'DerivedData',
  '.taskwraith'
])

export class GitSnapshotPublisher {
  private readonly gitService: Pick<GitService, 'snapshot'>
  private readonly debounceMs: number
  private readonly minIntervalMs: number
  private readonly watcherFactory: WatcherFactory
  private readonly subscriptions = new Map<string, GitSnapshotSubscription>()
  private readonly repoBySubscription = new Map<string, string>()
  private readonly repos = new Map<string, RepoSubscriptionState>()

  constructor(options: GitSnapshotPublisherOptions) {
    this.gitService = options.gitService
    this.debounceMs = options.debounceMs ?? DEFAULT_DEBOUNCE_MS
    this.minIntervalMs = options.minIntervalMs ?? DEFAULT_MIN_INTERVAL_MS
    this.watcherFactory =
      options.watcherFactory ??
      ((repoRoot, onChange) =>
        watch(repoRoot, { recursive: true }, (_eventType, filename) => onChange(filename)))
  }

  async subscribe(subscription: GitSnapshotSubscription): Promise<GitSnapshotSubscribeResult> {
    const snapshotResult = await this.gitService.snapshot(subscription.requestedPath)
    if (!snapshotResult.ok) return snapshotResult
    const snapshot = snapshotResult.data
    const repoRoot = snapshot.repoRoot
    const state = this.ensureRepoState(repoRoot, snapshot)
    this.subscriptions.set(subscription.subscriptionId, subscription)
    this.repoBySubscription.set(subscription.subscriptionId, repoRoot)
    state.subscriptions.add(subscription.subscriptionId)
    state.lastGood = snapshot
    return {
      ok: true,
      data: {
        subscriptionId: subscription.subscriptionId,
        requestedPath: subscription.requestedPath,
        repoRoot,
        snapshot,
        generation: state.generation
      }
    }
  }

  unsubscribe(subscriptionId: string): void {
    const repoRoot = this.repoBySubscription.get(subscriptionId)
    this.repoBySubscription.delete(subscriptionId)
    this.subscriptions.delete(subscriptionId)
    if (!repoRoot) return
    const state = this.repos.get(repoRoot)
    if (!state) return
    state.subscriptions.delete(subscriptionId)
    if (state.subscriptions.size > 0) return
    this.disposeRepoState(repoRoot, state)
  }

  unsubscribeWebContents(webContentsId: number): void {
    const stale = Array.from(this.subscriptions.values())
      .filter((subscription) => subscription.webContentsId === webContentsId)
      .map((subscription) => subscription.subscriptionId)
    stale.forEach((subscriptionId) => this.unsubscribe(subscriptionId))
  }

  invalidatePath(path: string, reason: GitSnapshotInvalidationReason = 'manual'): void {
    const direct = this.repos.get(path)
    if (direct) {
      this.schedule(path, reason)
      return
    }
    for (const [repoRoot] of this.repos) {
      if (path === repoRoot || path.startsWith(`${repoRoot}/`) || path.startsWith(`${repoRoot}\\`)) {
        this.schedule(repoRoot, reason)
      }
    }
  }

  publishSnapshot(snapshot: GitRepositorySnapshot, reason: GitSnapshotInvalidationReason): void {
    const state = this.repos.get(snapshot.repoRoot)
    if (!state || state.subscriptions.size === 0) return
    state.lastGood = snapshot
    state.generation += 1
    this.broadcast(state, snapshot, reason)
  }

  dispose(): void {
    for (const [repoRoot, state] of this.repos) {
      this.disposeRepoState(repoRoot, state)
    }
    this.subscriptions.clear()
    this.repoBySubscription.clear()
  }

  private ensureRepoState(
    repoRoot: string,
    initialSnapshot: GitRepositorySnapshot
  ): RepoSubscriptionState {
    const existing = this.repos.get(repoRoot)
    if (existing) return existing
    const state: RepoSubscriptionState = {
      repoRoot,
      subscriptions: new Set(),
      watcher: null,
      timer: null,
      inFlight: false,
      pendingReason: null,
      lastStartedAt: 0,
      generation: 1,
      lastGood: initialSnapshot
    }
    try {
      state.watcher = this.watcherFactory(repoRoot, (filename) => {
        if (this.shouldIgnoreFileEvent(filename)) return
        this.schedule(repoRoot, 'filesystem')
      })
      state.watcher.on('error', () => {
        state.watcher = null
      })
    } catch {
      state.watcher = null
    }
    this.repos.set(repoRoot, state)
    return state
  }

  private schedule(repoRoot: string, reason: GitSnapshotInvalidationReason): void {
    const state = this.repos.get(repoRoot)
    if (!state || state.subscriptions.size === 0) return
    if (state.timer) clearTimeout(state.timer)
    const elapsed = Date.now() - state.lastStartedAt
    const minIntervalDelay = Math.max(0, this.minIntervalMs - elapsed)
    const delay = Math.max(this.debounceMs, minIntervalDelay)
    state.timer = setTimeout(() => {
      state.timer = null
      void this.refresh(repoRoot, reason)
    }, delay)
  }

  private async refresh(repoRoot: string, reason: GitSnapshotInvalidationReason): Promise<void> {
    const state = this.repos.get(repoRoot)
    if (!state || state.subscriptions.size === 0) return
    if (state.inFlight) {
      state.pendingReason = reason
      return
    }
    state.inFlight = true
    state.lastStartedAt = Date.now()
    const startedGeneration = state.generation
    try {
      const result = await this.gitService.snapshot(repoRoot)
      if (result.ok && state.generation === startedGeneration) {
        state.lastGood = result.data
        state.generation += 1
        this.broadcast(state, result.data, reason)
      }
    } finally {
      state.inFlight = false
      const pendingReason = state.pendingReason
      state.pendingReason = null
      if (pendingReason && state.subscriptions.size > 0) {
        this.schedule(repoRoot, pendingReason)
      }
    }
  }

  private broadcast(
    state: RepoSubscriptionState,
    snapshot: GitRepositorySnapshot,
    reason: GitSnapshotInvalidationReason
  ): void {
    for (const subscriptionId of Array.from(state.subscriptions)) {
      const subscription = this.subscriptions.get(subscriptionId)
      if (!subscription) {
        state.subscriptions.delete(subscriptionId)
        continue
      }
      const subscriberSnapshot =
        snapshot.requestedPath === subscription.requestedPath
          ? snapshot
          : { ...snapshot, requestedPath: subscription.requestedPath }
      subscription.send({
        subscriptionId,
        requestedPath: subscription.requestedPath,
        repoRoot: state.repoRoot,
        snapshot: subscriberSnapshot,
        generation: state.generation,
        reason
      })
    }
  }

  private disposeRepoState(repoRoot: string, state: RepoSubscriptionState): void {
    if (state.timer) clearTimeout(state.timer)
    state.timer = null
    try {
      state.watcher?.close()
    } catch {
      // already closed
    }
    this.repos.delete(repoRoot)
  }

  private shouldIgnoreFileEvent(filename: string | Buffer | null): boolean {
    if (!filename) return false
    const raw = filename.toString()
    if (!raw) return false
    const segments = raw.split(/[\\/]+/).filter(Boolean)
    if (segments.some((segment) => IGNORED_PATH_SEGMENTS.has(segment))) return true
    const leaf = basename(raw)
    return leaf.endsWith('.tmp') || leaf.endsWith('.swp') || leaf === '.DS_Store'
  }
}
