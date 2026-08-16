import { describe, expect, it, vi } from 'vitest'
import type {
  GitUnpushedCommit,
  GitUnpushedCommitStack
} from '../../../shared/gitUnpushedCommits'
import type { GitSnapshotChangedPayload } from '../../../main/services/GitSnapshotPublisher'
import {
  WorkspaceUnpushedCommitStore,
  mergeUnpushedCommitPages,
  sameUnpushedCommitStackGeneration
} from './workspaceUnpushedCommitStore'

function commit(hash: string): GitUnpushedCommit {
  return {
    hash,
    parents: [],
    subject: hash,
    author: { name: 'TaskWraith' },
    filesChanged: 1,
    additions: 1,
    deletions: 0
  }
}

function stack(
  commits: GitUnpushedCommit[],
  options: { offset?: number; hasMore?: boolean; head?: string } = {}
): GitUnpushedCommitStack {
  const offset = options.offset ?? 0
  const hasMore = options.hasMore ?? false
  return {
    repoRoot: '/repo',
    branch: 'master',
    head: options.head ?? 'head-a',
    upstream: 'origin/master',
    comparison: 'upstream',
    observedAt: '2026-08-16T10:00:00.000Z',
    commits,
    page: {
      offset,
      limit: 50,
      hasMore,
      ...(hasMore ? { nextOffset: offset + 50 } : {})
    }
  }
}

describe('WorkspaceUnpushedCommitStore', () => {
  it('publishes the newest page before requesting older commits during idle time', async () => {
    const newest = commit('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa')
    const oldest = commit('bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb')
    const readPage = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, data: stack([newest], { hasMore: true }) })
      .mockResolvedValueOnce({ ok: true, data: stack([oldest], { offset: 50 }) })
    const idleCallbacks: Array<() => void> = []
    const store = new WorkspaceUnpushedCommitStore(readPage, (callback) => {
      idleCallbacks.push(callback)
      return () => undefined
    })
    const listener = vi.fn()
    store.subscribe('/repo', listener)

    await store.refresh({ workspacePath: '/repo', chatId: 'chat-1' })

    expect(store.get('/repo')).toMatchObject({
      stack: { commits: [newest] },
      loading: false,
      loadingMore: true,
      complete: false
    })
    expect(readPage).toHaveBeenCalledTimes(1)
    expect(idleCallbacks).toHaveLength(1)

    idleCallbacks.shift()?.()
    await vi.waitFor(() => expect(readPage).toHaveBeenCalledTimes(2))
    await vi.waitFor(() => expect(store.get('/repo').complete).toBe(true))
    expect(store.get('/repo').stack?.commits).toEqual([newest, oldest])
    expect(listener).toHaveBeenCalledTimes(3)
  })

  it('deduplicates concurrent ensure calls for the same workspace', async () => {
    let resolvePage: ((value: { ok: true; data: GitUnpushedCommitStack }) => void) | undefined
    const readPage = vi.fn(
      () =>
        new Promise<{ ok: true; data: GitUnpushedCommitStack }>((resolve) => {
          resolvePage = resolve
        })
    )
    const store = new WorkspaceUnpushedCommitStore(readPage)

    const first = store.ensure({ workspacePath: '/repo' })
    const second = store.ensure({ workspacePath: '/repo' })

    expect(readPage).toHaveBeenCalledOnce()
    resolvePage?.({ ok: true, data: stack([]) })
    await Promise.all([first, second])
    expect(store.get('/repo').complete).toBe(true)
  })

  it('keeps the last good page visible when an older-page read fails', async () => {
    const newest = commit('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa')
    const readPage = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, data: stack([newest], { hasMore: true }) })
      .mockResolvedValueOnce({ ok: false, error: 'Git timed out' })
    const idleCallbacks: Array<() => void> = []
    const store = new WorkspaceUnpushedCommitStore(readPage, (callback) => {
      idleCallbacks.push(callback)
      return () => undefined
    })

    await store.refresh({ workspacePath: '/repo' })
    idleCallbacks.shift()?.()
    await vi.waitFor(() => expect(store.get('/repo').error).toBe('Git timed out'))

    expect(store.get('/repo').stack?.commits).toEqual([newest])
    expect(store.get('/repo').loadingMore).toBe(false)
  })

  it('refreshes for commit-catalogue snapshot changes but ignores working-tree-only churn', async () => {
    const readPage = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, data: stack([]) })
      .mockResolvedValueOnce({ ok: true, data: stack([], { head: 'head-b' }) })
    let publishSnapshot: ((payload: GitSnapshotChangedPayload) => void) | undefined
    const store = new WorkspaceUnpushedCommitStore(
      readPage,
      (callback) => {
        callback()
        return () => undefined
      },
      (_target, callback) => {
        publishSnapshot = callback
        return () => undefined
      }
    )
    store.subscribe('/repo', vi.fn())
    await store.refresh({ workspacePath: '/repo' })

    const snapshot = {
      requestedPath: '/repo',
      repoRoot: '/repo',
      branch: 'master',
      commit: 'head-a',
      detached: false,
      upstream: 'origin/master',
      ahead: 0,
      behind: 0,
      remoteName: 'origin',
      remoteUrl: 'https://example.test/repo.git',
      files: [],
      counts: { changed: 0, staged: 0, unstaged: 0, untracked: 0 },
      clean: true,
      mergeState: null,
      conflicts: 0,
      lineStats: { additions: 0, deletions: 0 }
    }
    const payload = (nextSnapshot: typeof snapshot): GitSnapshotChangedPayload => ({
      subscriptionId: 'sub-1',
      requestedPath: '/repo',
      repoRoot: '/repo',
      snapshot: nextSnapshot,
      generation: 1,
      reason: 'filesystem'
    })
    publishSnapshot?.(payload(snapshot))
    publishSnapshot?.(payload({ ...snapshot, clean: false }))
    expect(readPage).toHaveBeenCalledOnce()

    publishSnapshot?.(payload({ ...snapshot, commit: 'head-b', ahead: 1 }))
    await vi.waitFor(() => expect(readPage).toHaveBeenCalledTimes(2))
  })
})

describe('unpushed commit page merging', () => {
  it('preserves newest-first order and drops duplicate boundary commits', () => {
    const newest = commit('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa')
    const older = commit('bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb')
    const merged = mergeUnpushedCommitPages(
      stack([newest], { hasMore: true }),
      stack([newest, older], { offset: 50 })
    )

    expect(merged?.commits).toEqual([newest, older])
    expect(merged?.page?.hasMore).toBe(false)
  })

  it('rejects pages from a changed HEAD', () => {
    expect(
      sameUnpushedCommitStackGeneration(
        stack([], { head: 'head-a' }),
        stack([], { head: 'head-b' })
      )
    ).toBe(false)
  })
})
