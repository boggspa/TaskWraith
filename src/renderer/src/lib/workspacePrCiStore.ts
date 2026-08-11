import { useCallback, useSyncExternalStore } from 'react'
import type {
  GitCiStatusSummary,
  GitPrSummary,
  GitRepositorySnapshot
} from '../../../main/services/GitService'
import { normalizeWorkspacePath } from './composerWorktreeSelection'

type WorkspacePrCiListener = () => void

export interface WorkspacePrCiState {
  pr: GitPrSummary | null
  ci: GitCiStatusSummary | null
}

/**
 * PR-status refresh key derived from a git snapshot: while the key is
 * unchanged the previous fetch result is still authoritative and the fetch
 * may be skipped. No remote URL means no PR surface at all.
 */
export function gitPrStatusRefreshKey(
  snapshot: GitRepositorySnapshot | null | undefined
): string | null {
  if (!snapshot?.remoteUrl) return null
  return [
    snapshot.repoRoot,
    snapshot.remoteUrl,
    snapshot.branch || '',
    snapshot.upstream || '',
    snapshot.commit || ''
  ].join('\u0000')
}

/**
 * Path-partitioned GitHub PR/CI rollup cache — the path-keyed counterpart to
 * the scalar `primaryPr`/`primaryCi` singletons, so every visible Multiview
 * pane can report its OWN workspace's pull request and checks. Same wake model
 * as WorkspaceGitSnapshotStore: publishing a value wakes only consumers of
 * that repository path instead of rebuilding the App-level composer graph.
 */
export class WorkspacePrCiStore {
  private readonly states = new Map<string, WorkspacePrCiState>()
  private readonly listeners = new Map<string, Set<WorkspacePrCiListener>>()

  get(path: string | null | undefined): WorkspacePrCiState | null {
    const key = normalizeWorkspacePath(path || '')
    return key ? (this.states.get(key) ?? null) : null
  }

  subscribe(path: string | null | undefined, listener: WorkspacePrCiListener): () => void {
    const key = normalizeWorkspacePath(path || '')
    if (!key) return () => undefined
    const pathListeners = this.listeners.get(key) ?? new Set<WorkspacePrCiListener>()
    pathListeners.add(listener)
    this.listeners.set(key, pathListeners)
    return () => {
      pathListeners.delete(listener)
      if (pathListeners.size === 0) this.listeners.delete(key)
    }
  }

  /**
   * A changed PR invalidates any cached CI unless it is the same PR number —
   * the checks belong to the PR, and chips must never mix two pull requests.
   */
  setPr(path: string | null | undefined, pr: GitPrSummary | null): boolean {
    const key = normalizeWorkspacePath(path || '')
    if (!key) return false
    const previous = this.states.get(key) ?? null
    if (!previous && !pr) return false
    if (previous && previous.pr === pr) return false
    const keepCi = previous?.pr != null && pr != null && previous.pr.number === pr.number
    this.states.set(key, { pr, ci: keepCi ? (previous?.ci ?? null) : null })
    this.emit(key)
    return true
  }

  /** CI never renders without a PR; writes for a PR-less path are dropped. */
  setCi(path: string | null | undefined, ci: GitCiStatusSummary | null): boolean {
    const key = normalizeWorkspacePath(path || '')
    if (!key) return false
    const previous = this.states.get(key) ?? null
    if (!previous?.pr || previous.ci === ci) return false
    this.states.set(key, { pr: previous.pr, ci })
    this.emit(key)
    return true
  }

  /** Drop rollups for paths no longer owned by a visible pane. */
  retain(paths: Iterable<string>): boolean {
    const retained = new Set(
      Array.from(paths, (path) => normalizeWorkspacePath(path)).filter(Boolean)
    )
    let changed = false
    for (const path of Array.from(this.states.keys())) {
      if (retained.has(path)) continue
      this.states.delete(path)
      this.emit(path)
      changed = true
    }
    return changed
  }

  private emit(path: string): void {
    for (const listener of Array.from(this.listeners.get(path) ?? [])) listener()
  }
}

export interface WorkspacePrCiApi {
  githubPrStatus?: (args: {
    workspacePath: string
  }) => Promise<{ ok?: boolean; data?: GitPrSummary | null } | null | undefined>
  githubCiStatus?: (args: {
    workspacePath: string
  }) => Promise<{ ok?: boolean; data?: GitCiStatusSummary | null } | null | undefined>
}

/**
 * Per-path PR/CI refresh engine for the visible-pane set. Mirrors the focused
 * scalar machinery's contracts: the PR fetch is deduped by the snapshot-derived
 * refresh key (and NOT retried until that key changes), the CI summary chains
 * off a present PR number, and late responses are discarded once the request
 * key or generation has moved on. There is deliberately no standing CI poll —
 * pane freshness rides snapshot changes, run completion, and window focus, so
 * four panes never multiply a polling loop against the GitHub CLI.
 */
export class WorkspacePrCiRefresher {
  private readonly prRequestKeyByPath = new Map<string, string>()
  private readonly ciGenerationByPath = new Map<string, number>()
  private readonly ciInFlight = new Set<string>()

  constructor(
    private readonly store: WorkspacePrCiStore,
    private readonly readSnapshot: (path: string) => GitRepositorySnapshot | null,
    private readonly getApi: () => WorkspacePrCiApi | undefined
  ) {}

  /** Forget bookkeeping and cached rollups for paths no longer visible. */
  retain(paths: Iterable<string>): void {
    const retained = new Set(
      Array.from(paths, (path) => normalizeWorkspacePath(path)).filter(Boolean)
    )
    for (const key of Array.from(this.prRequestKeyByPath.keys())) {
      if (!retained.has(key)) this.prRequestKeyByPath.delete(key)
    }
    for (const key of Array.from(this.ciGenerationByPath.keys())) {
      if (!retained.has(key)) {
        this.ciGenerationByPath.delete(key)
        this.ciInFlight.delete(key)
      }
    }
    this.store.retain(retained)
  }

  /**
   * Refresh one path's PR rollup (deduped by refresh key), chaining the CI
   * summary while a PR is present. `forceCi` refetches CI even when the PR
   * key is unchanged — checks move without the snapshot changing.
   */
  refresh(path: string, options?: { forceCi?: boolean }): void {
    const key = normalizeWorkspacePath(path || '')
    if (!key) return
    const api = this.getApi()
    const snapshot = this.readSnapshot(path)
    const prKey = gitPrStatusRefreshKey(snapshot)
    if (typeof api?.githubPrStatus !== 'function' || !prKey) {
      this.prRequestKeyByPath.delete(key)
      this.store.setPr(path, null)
      return
    }
    const requestKey = `${key}\u0000${prKey}`
    if (this.prRequestKeyByPath.get(key) === requestKey) {
      if (options?.forceCi) this.refreshCi(path)
      return
    }
    this.prRequestKeyByPath.set(key, requestKey)
    void api.githubPrStatus({ workspacePath: path }).then(
      (result) => {
        if (this.prRequestKeyByPath.get(key) !== requestKey) return
        const pr = result?.ok ? (result.data ?? null) : null
        this.store.setPr(path, pr)
        if (pr?.number != null) this.refreshCi(path)
      },
      () => {
        if (this.prRequestKeyByPath.get(key) !== requestKey) return
        this.store.setPr(path, null)
      }
    )
  }

  private refreshCi(path: string): void {
    const key = normalizeWorkspacePath(path || '')
    if (!key) return
    const api = this.getApi()
    const pr = this.store.get(key)?.pr
    if (typeof api?.githubCiStatus !== 'function' || pr?.number == null) {
      this.store.setCi(path, null)
      return
    }
    if (this.ciInFlight.has(key)) return
    const generation = (this.ciGenerationByPath.get(key) ?? 0) + 1
    this.ciGenerationByPath.set(key, generation)
    this.ciInFlight.add(key)
    void api.githubCiStatus({ workspacePath: path }).then(
      (result) => {
        if (this.ciGenerationByPath.get(key) !== generation) return
        this.ciInFlight.delete(key)
        this.store.setCi(path, result?.ok ? (result.data ?? null) : null)
      },
      () => {
        if (this.ciGenerationByPath.get(key) !== generation) return
        this.ciInFlight.delete(key)
        this.store.setCi(path, null)
      }
    )
  }
}

export function useWorkspacePrCi(
  store: WorkspacePrCiStore | null | undefined,
  path: string | null | undefined
): WorkspacePrCiState | null {
  const normalizedPath = normalizeWorkspacePath(path || '')
  const subscribe = useCallback(
    (listener: WorkspacePrCiListener) =>
      store ? store.subscribe(normalizedPath, listener) : () => undefined,
    [normalizedPath, store]
  )
  const get = useCallback(() => store?.get(normalizedPath) ?? null, [normalizedPath, store])
  return useSyncExternalStore(subscribe, get, get)
}
