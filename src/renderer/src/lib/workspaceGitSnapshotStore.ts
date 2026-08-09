import { useCallback, useSyncExternalStore } from 'react'
import type { GitRepositorySnapshot } from '../../../main/services/GitService'
import { normalizeWorkspacePath } from './composerWorktreeSelection'

type WorkspaceGitSnapshotListener = () => void

/**
 * A path-partitioned Git snapshot cache owned by one App instance. Publishing a
 * snapshot wakes only consumers of that repository path instead of rebuilding
 * the App-level composer graph for every visible Multiview pane.
 */
export class WorkspaceGitSnapshotStore {
  private readonly snapshots = new Map<string, GitRepositorySnapshot>()
  private readonly listeners = new Map<string, Set<WorkspaceGitSnapshotListener>>()

  getSnapshot(path: string | null | undefined): GitRepositorySnapshot | null {
    const key = normalizeWorkspacePath(path || '')
    return key ? (this.snapshots.get(key) ?? null) : null
  }

  subscribe(path: string | null | undefined, listener: WorkspaceGitSnapshotListener): () => void {
    const key = normalizeWorkspacePath(path || '')
    if (!key) return () => undefined
    const pathListeners = this.listeners.get(key) ?? new Set<WorkspaceGitSnapshotListener>()
    pathListeners.add(listener)
    this.listeners.set(key, pathListeners)
    return () => {
      pathListeners.delete(listener)
      if (pathListeners.size === 0) this.listeners.delete(key)
    }
  }

  /** Null responses carry no authoritative owner and retain the last good value. */
  set(path: string | null | undefined, snapshot: GitRepositorySnapshot | null): boolean {
    if (!snapshot) return false
    const key = normalizeWorkspacePath(snapshot.requestedPath || path || '')
    if (!key) return false
    const previous = this.snapshots.get(key) ?? null
    if (workspaceGitSnapshotsEqual(previous, snapshot)) return false
    this.snapshots.set(key, snapshot)
    this.emit(key)
    return true
  }

  /** Drop snapshots for paths no longer owned by a visible pane. */
  retain(paths: Iterable<string>): boolean {
    const retained = new Set(
      Array.from(paths, (path) => normalizeWorkspacePath(path)).filter(Boolean)
    )
    let changed = false
    for (const path of Array.from(this.snapshots.keys())) {
      if (retained.has(path)) continue
      this.snapshots.delete(path)
      this.emit(path)
      changed = true
    }
    return changed
  }

  private emit(path: string): void {
    for (const listener of Array.from(this.listeners.get(path) ?? [])) listener()
  }
}

/** Requested path is presentation metadata; every compared field is repo state. */
export function workspaceGitSnapshotsEqual(
  left: GitRepositorySnapshot | null,
  right: GitRepositorySnapshot | null
): boolean {
  if (left === right) return true
  if (!left || !right) return false
  if (
    left.repoRoot !== right.repoRoot ||
    left.branch !== right.branch ||
    left.commit !== right.commit ||
    left.detached !== right.detached ||
    left.upstream !== right.upstream ||
    left.remoteName !== right.remoteName ||
    left.remoteUrl !== right.remoteUrl ||
    left.ahead !== right.ahead ||
    left.behind !== right.behind ||
    left.clean !== right.clean ||
    left.mergeState !== right.mergeState ||
    left.conflicts !== right.conflicts ||
    left.counts.changed !== right.counts.changed ||
    left.counts.staged !== right.counts.staged ||
    left.counts.unstaged !== right.counts.unstaged ||
    left.counts.untracked !== right.counts.untracked ||
    left.lineStats.additions !== right.lineStats.additions ||
    left.lineStats.deletions !== right.lineStats.deletions ||
    left.files.length !== right.files.length
  ) {
    return false
  }
  return left.files.every((file, index) => {
    const other = right.files[index]
    return (
      other != null &&
      file.path === other.path &&
      file.originalPath === other.originalPath &&
      file.index === other.index &&
      file.workingTree === other.workingTree &&
      file.kind === other.kind &&
      file.staged === other.staged &&
      file.unstaged === other.unstaged
    )
  })
}

export function useWorkspaceGitSnapshot(
  store: WorkspaceGitSnapshotStore | null | undefined,
  path: string | null | undefined
): GitRepositorySnapshot | null {
  const normalizedPath = normalizeWorkspacePath(path || '')
  const subscribe = useCallback(
    (listener: WorkspaceGitSnapshotListener) =>
      store ? store.subscribe(normalizedPath, listener) : () => undefined,
    [normalizedPath, store]
  )
  const getSnapshot = useCallback(
    () => store?.getSnapshot(normalizedPath) ?? null,
    [normalizedPath, store]
  )
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
}
