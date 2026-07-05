import { describe, expect, it } from 'vitest'
import { formatBranchLabel, isWorktreeDirty } from './gitBranchWorktreeUi'

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
})