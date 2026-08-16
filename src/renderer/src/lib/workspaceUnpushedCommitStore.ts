import { useCallback, useSyncExternalStore } from 'react'
import {
  DEFAULT_GIT_UNPUSHED_COMMIT_PAGE_SIZE,
  type GitUnpushedCommitPageRequest,
  type GitUnpushedCommitStack
} from '../../../main/services/GitCommitStack'
import type { GitResult } from '../../../main/services/GitService'
import { normalizeWorkspacePath } from './composerWorktreeSelection'

export interface WorkspaceUnpushedCommitTarget {
  workspacePath: string
  chatId?: string
}

export interface WorkspaceUnpushedCommitState {
  stack: GitUnpushedCommitStack | null
  loading: boolean
  loadingMore: boolean
  complete: boolean
  error: string | null
}

type WorkspaceUnpushedCommitListener = () => void
type WorkspaceUnpushedCommitReader = (
  target: WorkspaceUnpushedCommitTarget,
  page: GitUnpushedCommitPageRequest
) => Promise<GitResult<GitUnpushedCommitStack>>
type IdleScheduler = (callback: () => void) => () => void

interface WorkspaceUnpushedCommitEntry {
  target: WorkspaceUnpushedCommitTarget
  state: WorkspaceUnpushedCommitState
  listeners: Set<WorkspaceUnpushedCommitListener>
  generation: number
  cancelIdle?: () => void
}

const EMPTY_WORKSPACE_UNPUSHED_COMMIT_STATE: WorkspaceUnpushedCommitState = Object.freeze({
  stack: null,
  loading: false,
  loadingMore: false,
  complete: false,
  error: null
})

function defaultReadPage(
  target: WorkspaceUnpushedCommitTarget,
  page: GitUnpushedCommitPageRequest
): Promise<GitResult<GitUnpushedCommitStack>> {
  return window.api.gitUnpushedCommits({
    workspacePath: target.workspacePath,
    chatId: target.chatId,
    page
  })
}

function defaultIdleScheduler(callback: () => void): () => void {
  if (typeof window === 'undefined') {
    callback()
    return () => undefined
  }
  const idleWindow = window as typeof window & {
    requestIdleCallback?: (callback: IdleRequestCallback, options?: IdleRequestOptions) => number
    cancelIdleCallback?: (handle: number) => void
  }
  if (typeof idleWindow.requestIdleCallback === 'function') {
    const handle = idleWindow.requestIdleCallback(callback, { timeout: 750 })
    return () => idleWindow.cancelIdleCallback?.(handle)
  }
  const handle = window.setTimeout(callback, 32)
  return () => window.clearTimeout(handle)
}

export function sameUnpushedCommitStackGeneration(
  left: GitUnpushedCommitStack,
  right: GitUnpushedCommitStack
): boolean {
  return (
    left.repoRoot === right.repoRoot &&
    left.branch === right.branch &&
    left.head === right.head &&
    left.upstream === right.upstream &&
    left.comparison === right.comparison
  )
}

export function mergeUnpushedCommitPages(
  current: GitUnpushedCommitStack,
  next: GitUnpushedCommitStack
): GitUnpushedCommitStack | null {
  if (!sameUnpushedCommitStackGeneration(current, next)) return null
  const commits = [...current.commits]
  const seen = new Set(commits.map((commit) => commit.hash))
  for (const commit of next.commits) {
    if (seen.has(commit.hash)) continue
    seen.add(commit.hash)
    commits.push(commit)
  }
  return {
    ...current,
    observedAt: next.observedAt,
    commits,
    page: next.page
  }
}

/**
 * One path-partitioned catalogue shared by the commits dock and transcript
 * commit references. Git runs in bounded pages; older pages begin only during
 * renderer idle time so the first 50 recent commits can paint immediately.
 */
export class WorkspaceUnpushedCommitStore {
  private readonly entries = new Map<string, WorkspaceUnpushedCommitEntry>()

  constructor(
    private readonly readPage: WorkspaceUnpushedCommitReader = defaultReadPage,
    private readonly scheduleIdle: IdleScheduler = defaultIdleScheduler
  ) {}

  get(path: string | null | undefined): WorkspaceUnpushedCommitState {
    const key = normalizeWorkspacePath(path || '')
    return key
      ? (this.entries.get(key)?.state ?? EMPTY_WORKSPACE_UNPUSHED_COMMIT_STATE)
      : EMPTY_WORKSPACE_UNPUSHED_COMMIT_STATE
  }

  subscribe(
    path: string | null | undefined,
    listener: WorkspaceUnpushedCommitListener
  ): () => void {
    const key = normalizeWorkspacePath(path || '')
    if (!key) return () => undefined
    const entry = this.entryFor({ workspacePath: key })
    entry.listeners.add(listener)
    return () => entry.listeners.delete(listener)
  }

  ensure(target: WorkspaceUnpushedCommitTarget): Promise<void> {
    const entry = this.entryFor(target)
    entry.target = target
    if (entry.state.stack || entry.state.loading) return Promise.resolve()
    return this.refresh(target)
  }

  refresh(target: WorkspaceUnpushedCommitTarget): Promise<void> {
    const entry = this.entryFor(target)
    entry.target = target
    entry.cancelIdle?.()
    entry.cancelIdle = undefined
    const generation = entry.generation + 1
    entry.generation = generation
    this.setState(entry, {
      ...entry.state,
      loading: true,
      loadingMore: false,
      complete: false,
      error: null
    })
    return this.loadPage(entry, generation, 0)
  }

  private entryFor(target: WorkspaceUnpushedCommitTarget): WorkspaceUnpushedCommitEntry {
    const key = normalizeWorkspacePath(target.workspacePath)
    const existing = this.entries.get(key)
    if (existing) return existing
    const entry: WorkspaceUnpushedCommitEntry = {
      target: { ...target, workspacePath: key },
      state: EMPTY_WORKSPACE_UNPUSHED_COMMIT_STATE,
      listeners: new Set(),
      generation: 0
    }
    this.entries.set(key, entry)
    return entry
  }

  private async loadPage(
    entry: WorkspaceUnpushedCommitEntry,
    generation: number,
    offset: number
  ): Promise<void> {
    let result: GitResult<GitUnpushedCommitStack>
    try {
      result = await this.readPage(entry.target, {
        offset,
        limit: DEFAULT_GIT_UNPUSHED_COMMIT_PAGE_SIZE
      })
    } catch (cause) {
      result = {
        ok: false,
        error: cause instanceof Error ? cause.message : 'Could not read unpushed commits.'
      }
    }
    if (entry.generation !== generation) return
    if (!result.ok) {
      this.setState(entry, {
        ...entry.state,
        loading: false,
        loadingMore: false,
        complete: false,
        error: result.error
      })
      return
    }

    const nextStack = result.data
    const stack = offset === 0 ? nextStack : this.mergeOrRestart(entry, nextStack)
    if (!stack) return
    const hasMore = Boolean(nextStack.page?.hasMore && nextStack.page.nextOffset !== undefined)
    this.setState(entry, {
      stack,
      loading: false,
      loadingMore: hasMore,
      complete: !hasMore,
      error: null
    })
    if (!hasMore) return

    const nextOffset = nextStack.page?.nextOffset
    if (nextOffset === undefined) return
    entry.cancelIdle = this.scheduleIdle(() => {
      entry.cancelIdle = undefined
      void this.loadPage(entry, generation, nextOffset)
    })
  }

  private mergeOrRestart(
    entry: WorkspaceUnpushedCommitEntry,
    nextStack: GitUnpushedCommitStack
  ): GitUnpushedCommitStack | null {
    const current = entry.state.stack
    if (!current) return nextStack
    const merged = mergeUnpushedCommitPages(current, nextStack)
    if (merged) return merged
    void this.refresh(entry.target)
    return null
  }

  private setState(entry: WorkspaceUnpushedCommitEntry, state: WorkspaceUnpushedCommitState): void {
    entry.state = state
    for (const listener of Array.from(entry.listeners)) listener()
  }
}

export const workspaceUnpushedCommitStore = new WorkspaceUnpushedCommitStore()

export function useWorkspaceUnpushedCommitState(
  path: string | null | undefined
): WorkspaceUnpushedCommitState {
  const normalizedPath = normalizeWorkspacePath(path || '')
  const subscribe = useCallback(
    (listener: WorkspaceUnpushedCommitListener) =>
      workspaceUnpushedCommitStore.subscribe(normalizedPath, listener),
    [normalizedPath]
  )
  const getSnapshot = useCallback(
    () => workspaceUnpushedCommitStore.get(normalizedPath),
    [normalizedPath]
  )
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
}
