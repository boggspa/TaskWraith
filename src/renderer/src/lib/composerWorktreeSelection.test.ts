import { describe, expect, it } from 'vitest'
import {
  buildComposerRuntimeWorktreeIntent,
  isLinkedWorktreePath,
  resolveWorktreeSelectionFromSnapshot,
  worktreeSelectionRequiredWarning
} from './composerWorktreeSelection'

describe('composerWorktreeSelection', () => {
  it('detects linked worktree paths', () => {
    expect(isLinkedWorktreePath('/repo', '/repo/.worktrees/task')).toBe(true)
    expect(isLinkedWorktreePath('/repo', '/repo')).toBe(false)
  })

  it('resolves composer selection from a linked snapshot', () => {
    const selection = resolveWorktreeSelectionFromSnapshot('/repo', {
      requestedPath: '/repo/.worktrees/task',
      repoRoot: '/repo',
      branch: 'task-branch',
      detached: false,
      ahead: 0,
      behind: 0,
      clean: true,
      mergeState: null,
      conflicts: 0,
      counts: { changed: 0, staged: 0, unstaged: 0, untracked: 0 },
      lineStats: { additions: 0, deletions: 0 },
      files: []
    })
    expect(selection).toMatchObject({
      baseWorkspacePath: '/repo',
      effectiveWorkspacePath: '/repo/.worktrees/task',
      branch: 'task-branch',
      label: 'task-branch'
    })
  })

  it('builds selected runtime worktree intent from composer selection', () => {
    const intent = buildComposerRuntimeWorktreeIntent({
      baseWorkspacePath: '/repo',
      selection: {
        baseWorkspacePath: '/repo',
        effectiveWorkspacePath: '/repo/.worktrees/task',
        label: 'task-branch',
        source: 'composer'
      },
      runtimeProfile: {
        id: 'codex-worktree',
        name: 'Codex worktree',
        provider: 'codex',
        scope: 'workspace',
        workspaceMode: 'worktree'
      } as import('../../../main/store/types').RuntimeProfile
    })
    expect(intent).toMatchObject({
      requested: true,
      source: 'composer',
      status: 'selected',
      effectiveWorkspacePath: '/repo/.worktrees/task',
      profileId: 'codex-worktree'
    })
  })

  it('requires selection when runtime profile uses worktree mode', () => {
    const intent = buildComposerRuntimeWorktreeIntent({
      baseWorkspacePath: '/repo',
      selection: null,
      runtimeProfile: {
        id: 'codex-worktree',
        name: 'Codex worktree',
        provider: 'codex',
        scope: 'workspace',
        workspaceMode: 'worktree'
      } as import('../../../main/store/types').RuntimeProfile
    })
    expect(intent?.status).toBe('selection-required')
    expect(worktreeSelectionRequiredWarning(intent)).toContain('requires an isolated worktree')
  })
})