import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  branchCheckoutDisabledReason,
  checkoutGitBranch,
  createGitBranch,
  createGitWorktree,
  formatBranchLabel,
  isWorktreeDirty,
  listGitBranches,
  listGitWorktrees,
  removeGitWorktree,
  selectGitWorktree,
  worktreeActionDisabledReason
} from './gitBranchWorktreeUi'

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('gitBranchWorktreeUi', () => {
  it('detects dirty worktrees from snapshot counts', () => {
    expect(
      isWorktreeDirty({
        requestedPath: '/repo',
        branch: 'main',
        detached: false,
        repoRoot: '/repo',
        ahead: 0,
        behind: 0,
        clean: false,
        mergeState: null,
        conflicts: 0,
        counts: { changed: 2, staged: 0, unstaged: 2, untracked: 0 },
        lineStats: { additions: 1, deletions: 0 },
        files: []
      })
    ).toBe(true)
  })

  it('formats detached and branch labels', () => {
    expect(formatBranchLabel({ detached: true, branch: 'main' } as any)).toBe('detached HEAD')
    expect(formatBranchLabel({ detached: false, branch: 'feature/x' } as any)).toBe('feature/x')
    expect(formatBranchLabel(null, 'main')).toBe('main')
  })

  it('blocks dirty branch checkout without blocking worktree actions', () => {
    expect(
      branchCheckoutDisabledReason({
        workspacePath: '/repo',
        apiAvailable: true,
        dirty: true
      })
    ).toBe('Commit or stash changes before switching branch')
    expect(
      worktreeActionDisabledReason({
        workspacePath: '/repo',
        apiAvailable: true
      })
    ).toBe('')
  })

  it('blocks both branch and worktree actions when workspace git controls are unavailable', () => {
    expect(
      branchCheckoutDisabledReason({
        workspacePath: '',
        apiAvailable: true,
        dirty: false
      })
    ).toBe('No workspace')
    expect(
      worktreeActionDisabledReason({
        workspacePath: '/repo',
        apiAvailable: false
      })
    ).toBe('Worktree controls unavailable until backend IPC lands')
  })

  it('forwards the owning chat through every external-repository branch and worktree action', async () => {
    const api = {
      'git:list-branches': vi.fn(async () => ({ ok: true, branches: [] })),
      'git:checkout-branch': vi.fn(async () => ({ ok: true })),
      'git:create-branch': vi.fn(async () => ({ ok: true })),
      'git:list-worktrees': vi.fn(async () => ({ ok: true, worktrees: [] })),
      'git:create-worktree': vi.fn(async () => ({ ok: true })),
      'git:remove-worktree': vi.fn(async () => ({ ok: true })),
      'git:select-worktree': vi.fn(async () => ({ ok: true }))
    }
    vi.stubGlobal('window', { api })

    await listGitBranches('/external/repo', 'chat-1')
    await checkoutGitBranch('/external/repo', 'feature/existing', 'chat-1')
    await createGitBranch('/external/repo', 'feature/new', 'main', 'chat-1')
    await listGitWorktrees('/external/repo', 'chat-1')
    await createGitWorktree(
      '/external/repo',
      { name: 'task-worktree', branch: 'feature/new' },
      'chat-1'
    )
    await removeGitWorktree('/external/repo', '/external/worktree', true, 'chat-1')
    await selectGitWorktree('/external/repo', '/external/worktree', 'chat-1')

    expect(api['git:list-branches']).toHaveBeenCalledWith({
      workspacePath: '/external/repo',
      chatId: 'chat-1'
    })
    expect(api['git:checkout-branch']).toHaveBeenCalledWith({
      workspacePath: '/external/repo',
      chatId: 'chat-1',
      branch: 'feature/existing'
    })
    expect(api['git:create-branch']).toHaveBeenCalledWith({
      workspacePath: '/external/repo',
      chatId: 'chat-1',
      branch: 'feature/new',
      from: 'main'
    })
    expect(api['git:list-worktrees']).toHaveBeenCalledWith({
      workspacePath: '/external/repo',
      chatId: 'chat-1'
    })
    expect(api['git:create-worktree']).toHaveBeenCalledWith({
      workspacePath: '/external/repo',
      chatId: 'chat-1',
      name: 'task-worktree',
      branch: 'feature/new'
    })
    expect(api['git:remove-worktree']).toHaveBeenCalledWith({
      workspacePath: '/external/repo',
      chatId: 'chat-1',
      path: '/external/worktree',
      force: true
    })
    expect(api['git:select-worktree']).toHaveBeenCalledWith({
      workspacePath: '/external/repo',
      chatId: 'chat-1',
      path: '/external/worktree'
    })
  })

  it('preserves the registered-workspace payload when no chat is provided', async () => {
    const listBranches = vi.fn(async () => ({ ok: true, branches: [] }))
    vi.stubGlobal('window', { api: { 'git:list-branches': listBranches } })

    await listGitBranches('/registered/workspace')

    expect(listBranches).toHaveBeenCalledWith({ workspacePath: '/registered/workspace' })
  })
})
