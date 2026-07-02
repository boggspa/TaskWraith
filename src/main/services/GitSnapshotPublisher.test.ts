import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { GitSnapshotPublisher } from './GitSnapshotPublisher'
import type { GitRepositorySnapshot, GitService } from './GitService'

function makeSnapshot(
  requestedPath: string,
  overrides: Partial<GitRepositorySnapshot> = {}
): GitRepositorySnapshot {
  return {
    requestedPath,
    repoRoot: '/repo',
    branch: 'main',
    detached: false,
    ahead: 0,
    behind: 0,
    files: [],
    counts: { changed: 0, staged: 0, unstaged: 0, untracked: 0 },
    clean: true,
    mergeState: null,
    conflicts: 0,
    lineStats: { additions: 0, deletions: 0 },
    ...overrides
  }
}

describe('GitSnapshotPublisher', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-07-02T00:00:00.000Z'))
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('subscribes by repo root and emits debounced authoritative refreshes', async () => {
    const snapshots = [
      makeSnapshot('/repo/subdir'),
      makeSnapshot('/repo', {
        clean: false,
        counts: { changed: 2, staged: 0, unstaged: 2, untracked: 0 },
        lineStats: { additions: 12, deletions: 4 }
      })
    ]
    const gitService = {
      snapshot: vi.fn<Pick<GitService, 'snapshot'>['snapshot']>(async (path) => ({
        ok: true,
        data: snapshots.shift() || makeSnapshot(path)
      }))
    }
    const watchers: Array<(filename: string) => void> = []
    const send = vi.fn()
    const publisher = new GitSnapshotPublisher({
      gitService,
      debounceMs: 25,
      minIntervalMs: 0,
      watcherFactory: (_repoRoot, onChange) => {
        watchers.push((filename) => onChange(filename))
        return { on: vi.fn(), close: vi.fn() } as any
      }
    })

    const result = await publisher.subscribe({
      subscriptionId: 'sub-1',
      requestedPath: '/repo/subdir',
      send
    })

    expect(result).toEqual({
      ok: true,
      data: {
        subscriptionId: 'sub-1',
        requestedPath: '/repo/subdir',
        repoRoot: '/repo',
        snapshot: makeSnapshot('/repo/subdir'),
        generation: 1
      }
    })
    expect(watchers).toHaveLength(1)

    watchers[0]('src/App.tsx')
    watchers[0]('src/App.css')
    await vi.advanceTimersByTimeAsync(24)
    expect(send).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)

    expect(gitService.snapshot).toHaveBeenCalledTimes(2)
    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({
        subscriptionId: 'sub-1',
        requestedPath: '/repo/subdir',
        repoRoot: '/repo',
        generation: 2,
        reason: 'filesystem',
        snapshot: expect.objectContaining({
          requestedPath: '/repo/subdir',
          counts: { changed: 2, staged: 0, unstaged: 2, untracked: 0 },
          lineStats: { additions: 12, deletions: 4 }
        })
      })
    )
  })

  it('ignores noisy watcher paths and closes watchers when the last subscriber leaves', async () => {
    const gitService = {
      snapshot: vi.fn<Pick<GitService, 'snapshot'>['snapshot']>(async (path) => ({
        ok: true,
        data: makeSnapshot(path)
      }))
    }
    const onChanges: Array<(filename: string) => void> = []
    const close = vi.fn()
    const publisher = new GitSnapshotPublisher({
      gitService,
      debounceMs: 25,
      minIntervalMs: 0,
      watcherFactory: (_repoRoot, handler) => {
        onChanges.push((filename) => handler(filename))
        return { on: vi.fn(), close } as any
      }
    })

    await publisher.subscribe({ subscriptionId: 'sub-1', requestedPath: '/repo', send: vi.fn() })
    expect(onChanges).toHaveLength(1)
    onChanges[0]('node_modules/package/index.js')
    onChanges[0]('.git/index.lock')
    await vi.advanceTimersByTimeAsync(100)
    expect(gitService.snapshot).toHaveBeenCalledTimes(1)

    publisher.unsubscribe('sub-1')
    expect(close).toHaveBeenCalledTimes(1)
  })

  it('enforces the minimum refresh interval across invalidations', async () => {
    const gitService = {
      snapshot: vi.fn<Pick<GitService, 'snapshot'>['snapshot']>(async (path) => ({
        ok: true,
        data: makeSnapshot(path)
      }))
    }
    const watchers: Array<(filename: string) => void> = []
    const publisher = new GitSnapshotPublisher({
      gitService,
      debounceMs: 25,
      minIntervalMs: 1200,
      watcherFactory: (_repoRoot, onChange) => {
        watchers.push((filename) => onChange(filename))
        return { on: vi.fn(), close: vi.fn() } as any
      }
    })
    await publisher.subscribe({ subscriptionId: 'sub-1', requestedPath: '/repo', send: vi.fn() })

    watchers[0]('src/first.ts')
    await vi.advanceTimersByTimeAsync(25)
    expect(gitService.snapshot).toHaveBeenCalledTimes(2)

    watchers[0]('src/second.ts')
    await vi.advanceTimersByTimeAsync(1199)
    expect(gitService.snapshot).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(1)
    expect(gitService.snapshot).toHaveBeenCalledTimes(3)
  })

  it('preserves the last good snapshot when a refresh fails', async () => {
    const gitService = {
      snapshot: vi.fn<Pick<GitService, 'snapshot'>['snapshot']>(async (path) =>
        path === '/repo'
          ? { ok: false, error: 'index.lock' }
          : { ok: true, data: makeSnapshot(path) }
      )
    }
    const watchers: Array<(filename: string) => void> = []
    const send = vi.fn()
    const publisher = new GitSnapshotPublisher({
      gitService,
      debounceMs: 25,
      minIntervalMs: 0,
      watcherFactory: (_repoRoot, onChange) => {
        watchers.push((filename) => onChange(filename))
        return { on: vi.fn(), close: vi.fn() } as any
      }
    })
    await publisher.subscribe({ subscriptionId: 'sub-1', requestedPath: '/repo/subdir', send })

    watchers[0]('src/App.tsx')
    await vi.advanceTimersByTimeAsync(25)

    expect(gitService.snapshot).toHaveBeenCalledTimes(2)
    expect(send).not.toHaveBeenCalled()
  })

  it('publishes git-action snapshots immediately', async () => {
    const gitService = {
      snapshot: vi.fn<Pick<GitService, 'snapshot'>['snapshot']>(async (path) => ({
        ok: true,
        data: makeSnapshot(path)
      }))
    }
    const send = vi.fn()
    const publisher = new GitSnapshotPublisher({
      gitService,
      debounceMs: 25,
      minIntervalMs: 0,
      watcherFactory: () => ({ on: vi.fn(), close: vi.fn() }) as any
    })
    await publisher.subscribe({ subscriptionId: 'sub-1', requestedPath: '/repo', send })

    const snapshot = makeSnapshot('/repo', {
      clean: false,
      counts: { changed: 1, staged: 1, unstaged: 0, untracked: 0 }
    })
    publisher.publishSnapshot(snapshot, 'git-action')

    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({
        generation: 2,
        reason: 'git-action',
        snapshot
      })
    )
  })

  it('does not let an older in-flight refresh overwrite a newer git-action snapshot', async () => {
    let snapshotCall = 0
    const resolveRefreshes: Array<
      (result: Awaited<ReturnType<Pick<GitService, 'snapshot'>['snapshot']>>) => void
    > = []
    const gitService = {
      snapshot: vi.fn<Pick<GitService, 'snapshot'>['snapshot']>(async (path) => {
        snapshotCall += 1
        if (snapshotCall === 1) return { ok: true, data: makeSnapshot(path) }
        return new Promise((resolve) => {
          resolveRefreshes.push(resolve)
        })
      })
    }
    const watchers: Array<(filename: string) => void> = []
    const send = vi.fn()
    const publisher = new GitSnapshotPublisher({
      gitService,
      debounceMs: 25,
      minIntervalMs: 0,
      watcherFactory: (_repoRoot, onChange) => {
        watchers.push((filename) => onChange(filename))
        return { on: vi.fn(), close: vi.fn() } as any
      }
    })
    await publisher.subscribe({ subscriptionId: 'sub-1', requestedPath: '/repo', send })

    watchers[0]('src/App.tsx')
    await vi.advanceTimersByTimeAsync(25)
    expect(gitService.snapshot).toHaveBeenCalledTimes(2)

    const actionSnapshot = makeSnapshot('/repo', {
      clean: false,
      counts: { changed: 1, staged: 1, unstaged: 0, untracked: 0 }
    })
    publisher.publishSnapshot(actionSnapshot, 'git-action')
    expect(send).toHaveBeenCalledTimes(1)
    expect(send).toHaveBeenLastCalledWith(
      expect.objectContaining({ generation: 2, reason: 'git-action', snapshot: actionSnapshot })
    )

    expect(resolveRefreshes).toHaveLength(1)
    resolveRefreshes[0]({
      ok: true,
      data: makeSnapshot('/repo', {
        clean: false,
        counts: { changed: 5, staged: 0, unstaged: 5, untracked: 0 }
      })
    })
    await Promise.resolve()

    expect(send).toHaveBeenCalledTimes(1)
  })
})
