import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  DEFAULT_HEAVY_MIN_INTERVAL_MS,
  GitSnapshotPublisher,
  gitRepositorySnapshotPresentationEqual,
  gitSnapshotFilesystemRefreshInterval,
  gitRepositorySnapshotsEqual
} from './GitSnapshotPublisher'
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

  it('compares repository state without treating subscriber paths as mutations', () => {
    const left = makeSnapshot('/repo/left', {
      files: [
        {
          path: 'src/App.tsx',
          index: ' ',
          workingTree: 'M',
          kind: 'modified',
          staged: false,
          unstaged: true
        }
      ],
      counts: { changed: 1, staged: 0, unstaged: 1, untracked: 0 },
      clean: false
    })
    const right = { ...left, requestedPath: '/repo/right' }

    expect(gitRepositorySnapshotsEqual(left, right)).toBe(true)
    expect(
      gitRepositorySnapshotsEqual(left, {
        ...right,
        lineStats: { additions: 1, deletions: 0 }
      })
    ).toBe(false)
    expect(
      gitRepositorySnapshotPresentationEqual(left, {
        ...right,
        files: [],
        lineStats: { additions: 1, deletions: 0 }
      })
    ).toBe(true)
  })

  it('uses a slower filesystem cadence for heavy dirty trees and local-only histories', () => {
    expect(
      gitSnapshotFilesystemRefreshInterval(
        makeSnapshot('/repo', {
          clean: false,
          counts: { changed: 128, staged: 0, unstaged: 128, untracked: 0 }
        }),
        1200
      )
    ).toBe(DEFAULT_HEAVY_MIN_INTERVAL_MS)
    expect(
      gitSnapshotFilesystemRefreshInterval(
        makeSnapshot('/repo', { upstream: 'origin/main', ahead: 64 }),
        1200
      )
    ).toBe(DEFAULT_HEAVY_MIN_INTERVAL_MS)
    expect(gitSnapshotFilesystemRefreshInterval(makeSnapshot('/repo'), 1200)).toBe(1200)
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

  it('does not broadcast an unchanged filesystem refresh', async () => {
    const gitService = {
      snapshot: vi.fn<Pick<GitService, 'snapshot'>['snapshot']>(async (path) => ({
        ok: true,
        data: makeSnapshot(path)
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
    await publisher.subscribe({ subscriptionId: 'sub-1', requestedPath: '/repo', send })

    watchers[0]('src/App.tsx')
    await vi.advanceTimersByTimeAsync(25)

    expect(gitService.snapshot).toHaveBeenCalledTimes(2)
    expect(send).not.toHaveBeenCalled()
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
    onChanges[0]('.git/objects/aa/bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb')
    await vi.advanceTimersByTimeAsync(100)
    expect(gitService.snapshot).toHaveBeenCalledTimes(1)

    publisher.unsubscribe('sub-1')
    expect(close).toHaveBeenCalledTimes(1)
  })

  it('refreshes for git metadata changes that can happen without worktree writes', async () => {
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
      minIntervalMs: 0,
      watcherFactory: (_repoRoot, onChange) => {
        watchers.push((filename) => onChange(filename))
        return { on: vi.fn(), close: vi.fn() } as any
      }
    })
    await publisher.subscribe({ subscriptionId: 'sub-1', requestedPath: '/repo', send: vi.fn() })

    watchers[0]('.git/HEAD')
    watchers[0]('.git/index')
    watchers[0]('.git/refs/heads/main')
    watchers[0]('.git/FETCH_HEAD')
    watchers[0]('.git/config')
    await vi.advanceTimersByTimeAsync(25)

    expect(gitService.snapshot).toHaveBeenCalledTimes(2)
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

  it('uses the heavy cadence after a large filesystem snapshot', async () => {
    const heavy = makeSnapshot('/repo', {
      clean: false,
      counts: { changed: 256, staged: 0, unstaged: 256, untracked: 0 }
    })
    const gitService = {
      snapshot: vi.fn<Pick<GitService, 'snapshot'>['snapshot']>(async () => ({
        ok: true,
        data: heavy
      }))
    }
    const watchers: Array<(filename: string) => void> = []
    const publisher = new GitSnapshotPublisher({
      gitService,
      debounceMs: 25,
      minIntervalMs: 1200,
      heavyMinIntervalMs: 5000,
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
    await vi.advanceTimersByTimeAsync(4999)
    expect(gitService.snapshot).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(1)
    expect(gitService.snapshot).toHaveBeenCalledTimes(3)
  })

  it('holds filesystem-only file detail until a terminal or manual refresh', async () => {
    const initial = makeSnapshot('/repo', {
      clean: false,
      files: [
        {
          path: 'src/App.tsx',
          index: ' ',
          workingTree: 'M',
          kind: 'modified',
          staged: false,
          unstaged: true
        }
      ],
      counts: { changed: 1, staged: 0, unstaged: 1, untracked: 0 },
      lineStats: { additions: 1, deletions: 0 }
    })
    const detailOnly = {
      ...initial,
      files: [{ ...initial.files[0], workingTree: 'M' }],
      lineStats: { additions: 400, deletions: 120 }
    }
    const snapshots = [initial, detailOnly, detailOnly, detailOnly]
    const gitService = {
      snapshot: vi.fn<Pick<GitService, 'snapshot'>['snapshot']>(async () => ({
        ok: true,
        data: snapshots.shift() || detailOnly
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
    await publisher.subscribe({ subscriptionId: 'sub-1', requestedPath: '/repo', send })

    watchers[0]('src/App.tsx')
    await vi.advanceTimersByTimeAsync(25)
    expect(send).not.toHaveBeenCalled()

    // The second subscriber receives its snapshot directly. That must not
    // overwrite the first subscriber's last-delivered baseline and make its
    // later terminal detail refresh disappear.
    await publisher.subscribe({ subscriptionId: 'sub-2', requestedPath: '/repo', send: vi.fn() })

    publisher.invalidatePath('/repo', 'run-diff')
    await vi.advanceTimersByTimeAsync(25)
    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({ reason: 'run-diff', snapshot: detailOnly })
    )
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

  it('does not publish a refresh that resolves to a different repository root', async () => {
    let snapshotCall = 0
    const gitService = {
      snapshot: vi.fn<Pick<GitService, 'snapshot'>['snapshot']>(async (path) => {
        snapshotCall += 1
        return {
          ok: true,
          data:
            snapshotCall === 1
              ? makeSnapshot(path)
              : makeSnapshot(path, { repoRoot: '/replacement-repo' })
        }
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

  it('isolates and removes a throwing subscriber without blocking later deliveries', async () => {
    const gitService = {
      snapshot: vi.fn<Pick<GitService, 'snapshot'>['snapshot']>(async (path) => ({
        ok: true,
        data: makeSnapshot(path)
      }))
    }
    const throwingSend = vi.fn(() => {
      throw new Error('renderer unavailable')
    })
    const healthySend = vi.fn()
    const publisher = new GitSnapshotPublisher({
      gitService,
      debounceMs: 25,
      minIntervalMs: 0,
      watcherFactory: () => ({ on: vi.fn(), close: vi.fn() }) as any
    })
    await publisher.subscribe({
      subscriptionId: 'throwing',
      requestedPath: '/repo',
      send: throwingSend
    })
    await publisher.subscribe({
      subscriptionId: 'healthy',
      requestedPath: '/repo',
      send: healthySend
    })

    const snapshot = makeSnapshot('/repo', {
      clean: false,
      counts: { changed: 1, staged: 0, unstaged: 1, untracked: 0 }
    })
    expect(() => publisher.publishSnapshot(snapshot, 'git-action')).not.toThrow()
    expect(throwingSend).toHaveBeenCalledTimes(1)
    expect(healthySend).toHaveBeenCalledTimes(1)

    publisher.publishSnapshot(snapshot, 'manual')
    expect(throwingSend).toHaveBeenCalledTimes(1)
    expect(healthySend).toHaveBeenCalledTimes(2)
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
