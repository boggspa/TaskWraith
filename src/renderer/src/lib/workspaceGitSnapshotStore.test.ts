import { describe, expect, it, vi } from 'vitest'
import type { GitRepositorySnapshot } from '../../../main/services/GitService'
import { WorkspaceGitSnapshotStore, workspaceGitSnapshotsEqual } from './workspaceGitSnapshotStore'

function snapshot(requestedPath: string, branch: string, additions = 0): GitRepositorySnapshot {
  return {
    requestedPath,
    repoRoot: requestedPath,
    branch,
    commit: 'abc123',
    detached: false,
    upstream: 'origin/main',
    remoteName: 'origin',
    remoteUrl: 'https://example.test/repo.git',
    ahead: 0,
    behind: 0,
    files: [],
    counts: { changed: 0, staged: 0, unstaged: 0, untracked: 0 },
    clean: true,
    mergeState: null,
    conflicts: 0,
    lineStats: { additions, deletions: 0 }
  }
}

describe('WorkspaceGitSnapshotStore', () => {
  it('notifies only subscribers that own the updated path', () => {
    const store = new WorkspaceGitSnapshotStore()
    const first = vi.fn()
    const second = vi.fn()
    store.subscribe('/one', first)
    store.subscribe('/two', second)

    expect(store.set('/one', snapshot('/one', 'main'))).toBe(true)
    expect(first).toHaveBeenCalledOnce()
    expect(second).not.toHaveBeenCalled()
  })

  it('uses the response owner path and normalizes path aliases', () => {
    const store = new WorkspaceGitSnapshotStore()
    const testTwo = snapshot('/Test 2/', 'two')

    store.set('/Test 3', testTwo)

    expect(store.getSnapshot('/Test 2')).toBe(testTwo)
    expect(store.getSnapshot('/Test 3')).toBeNull()
  })

  it('does not notify for a semantically identical refresh', () => {
    const store = new WorkspaceGitSnapshotStore()
    const listener = vi.fn()
    store.subscribe('/repo', listener)
    store.set('/repo', snapshot('/repo', 'main'))
    listener.mockClear()

    expect(store.set('/repo', snapshot('/repo', 'main'))).toBe(false)
    expect(listener).not.toHaveBeenCalled()
    expect(store.set('/repo', snapshot('/repo', 'main', 1))).toBe(true)
    expect(listener).toHaveBeenCalledOnce()
  })

  it('retains only snapshots still owned by visible panes', () => {
    const store = new WorkspaceGitSnapshotStore()
    const removed = vi.fn()
    store.set('/one', snapshot('/one', 'one'))
    store.set('/two', snapshot('/two', 'two'))
    store.subscribe('/one', removed)

    expect(store.retain(['/two/'])).toBe(true)
    expect(store.getSnapshot('/one')).toBeNull()
    expect(store.getSnapshot('/two')).not.toBeNull()
    expect(removed).toHaveBeenCalledOnce()
  })

  it('retains last-good state for ownerless null responses', () => {
    const store = new WorkspaceGitSnapshotStore()
    const initial = snapshot('/repo', 'main')
    store.set('/repo', initial)

    expect(store.set('/repo', null)).toBe(false)
    expect(store.getSnapshot('/repo')).toBe(initial)
  })
})

describe('workspaceGitSnapshotsEqual', () => {
  it('ignores requested-path presentation differences', () => {
    expect(
      workspaceGitSnapshotsEqual(snapshot('/alias-a', 'main'), snapshot('/alias-b', 'main'))
    ).toBe(false)
    const left = snapshot('/alias-a', 'main')
    const right = { ...left, requestedPath: '/alias-b' }
    expect(workspaceGitSnapshotsEqual(left, right)).toBe(true)
  })
})
