import { describe, expect, it } from 'vitest'
import {
  buildComposerRuntimeWorktreeIntent,
  composerWorktreeSelectionForChat,
  composerWorktreeSelectionFromEffectivePath,
  isLinkedWorktreePath,
  resolveComposerEffectiveWorkspacePath,
  resolveWorktreeSelectionFromSnapshot,
  updateComposerWorktreeSelectionForChat,
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

  it('owns linked worktree selections by chat when two panes share one base workspace', () => {
    const chatASelection = {
      baseWorkspacePath: '/repo',
      effectiveWorkspacePath: '/repo-worktrees/chat-a',
      label: 'chat-a',
      source: 'composer' as const
    }
    const chatBSelection = {
      baseWorkspacePath: '/repo',
      effectiveWorkspacePath: '/repo-worktrees/chat-b',
      label: 'chat-b',
      source: 'composer' as const
    }

    const withChatA = updateComposerWorktreeSelectionForChat({}, 'chat-a', chatASelection)
    const withBothChats = updateComposerWorktreeSelectionForChat(
      withChatA,
      'chat-b',
      chatBSelection
    )
    const chatBChanged = updateComposerWorktreeSelectionForChat(withBothChats, 'chat-b', {
      ...chatBSelection,
      effectiveWorkspacePath: '/repo-worktrees/chat-b-next',
      label: 'chat-b-next'
    })

    expect(composerWorktreeSelectionForChat(chatBChanged, 'chat-a', '/repo')).toBe(
      chatASelection
    )
    expect(
      resolveComposerEffectiveWorkspacePath(
        '/repo',
        composerWorktreeSelectionForChat(chatBChanged, 'chat-a', '/repo')
      )
    ).toBe('/repo-worktrees/chat-a')
    expect(
      resolveComposerEffectiveWorkspacePath(
        '/repo',
        composerWorktreeSelectionForChat(chatBChanged, 'chat-b', '/repo')
      )
    ).toBe('/repo-worktrees/chat-b-next')
  })

  it('rejects a stale selection after its chat is rebound to another workspace', () => {
    const selections = updateComposerWorktreeSelectionForChat({}, 'chat-a', {
      baseWorkspacePath: '/repo-a',
      effectiveWorkspacePath: '/repo-a-worktrees/feature',
      label: 'feature',
      source: 'composer'
    })

    expect(composerWorktreeSelectionForChat(selections, 'chat-a', '/repo-b')).toBeNull()
    expect(
      resolveComposerEffectiveWorkspacePath(
        '/repo-b',
        composerWorktreeSelectionForChat(selections, 'chat-a', '/repo-b')
      )
    ).toBe('/repo-b')
  })

  it('rebuilds a queued run from its immutable worktree path after the picker changes', () => {
    const queuedPath = '/repo-worktrees/queued-a'
    let selections = updateComposerWorktreeSelectionForChat({}, 'chat-a', {
      baseWorkspacePath: '/repo',
      effectiveWorkspacePath: queuedPath,
      label: 'queued-a',
      source: 'composer'
    })
    const requestSnapshot = {
      effectiveWorkspacePath: resolveComposerEffectiveWorkspacePath(
        '/repo',
        composerWorktreeSelectionForChat(selections, 'chat-a', '/repo')
      )
    }

    selections = updateComposerWorktreeSelectionForChat(selections, 'chat-a', {
      baseWorkspacePath: '/repo',
      effectiveWorkspacePath: '/repo-worktrees/later-b',
      label: 'later-b',
      source: 'composer'
    })

    const restoredSelection = composerWorktreeSelectionFromEffectivePath(
      '/repo',
      requestSnapshot.effectiveWorkspacePath
    )
    expect(restoredSelection?.effectiveWorkspacePath).toBe(queuedPath)
    expect(
      resolveComposerEffectiveWorkspacePath('/repo', restoredSelection)
    ).toBe(queuedPath)
    expect(
      composerWorktreeSelectionForChat(selections, 'chat-a', '/repo')?.effectiveWorkspacePath
    ).toBe('/repo-worktrees/later-b')
  })
})
