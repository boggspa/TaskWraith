import { describe, expect, it, vi } from 'vitest'
import { assertPinnedWorkspaceTarget } from './WorkspaceTargetAuthority'

function authorityInput(
  overrides: Partial<Parameters<typeof assertPinnedWorkspaceTarget>[0]> = {}
): Parameters<typeof assertPinnedWorkspaceTarget>[0] {
  return {
    workspace: {
      id: 'workspace-1',
      path: '/lexical/repo',
      realPath: '/real/repo'
    },
    task: {
      workspaceId: 'workspace-1',
      workspacePath: '/lexical/repo'
    },
    chat: {
      workspaceId: 'workspace-1',
      workspacePath: '/lexical/repo'
    },
    workflow: {
      workspaceId: 'workspace-1',
      workspacePath: '/lexical/repo'
    },
    canonicalPath: (value) => value.replace(/\/$/, ''),
    resolveRealDirectory: () => '/real/repo',
    ...overrides
  }
}

describe('assertPinnedWorkspaceTarget', () => {
  it('returns the pinned real execution target while preserving lexical bindings', () => {
    expect(assertPinnedWorkspaceTarget(authorityInput())).toBe('/real/repo')
  })

  it('supports standalone tasks without a workflow binding', () => {
    expect(assertPinnedWorkspaceTarget(authorityInput({ workflow: null }))).toBe('/real/repo')
  })

  it.each([
    ['task', { task: { workspaceId: 'other', workspacePath: '/lexical/repo' } }],
    ['chat', { chat: { workspaceId: 'other', workspacePath: '/lexical/repo' } }],
    ['workflow', { workflow: { workspaceId: 'other', workspacePath: '/lexical/repo' } }]
  ])('rejects a mismatched %s workspace id before filesystem resolution', (_label, patch) => {
    const resolveRealDirectory = vi.fn(() => '/real/repo')
    expect(() =>
      assertPinnedWorkspaceTarget(authorityInput({ ...patch, resolveRealDirectory }))
    ).toThrow(/workspace id does not match/i)
    expect(resolveRealDirectory).not.toHaveBeenCalled()
  })

  it.each([
    ['task', { task: { workspaceId: 'workspace-1', workspacePath: '/other' } }],
    ['chat', { chat: { workspaceId: 'workspace-1', workspacePath: '/other' } }],
    ['workflow', { workflow: { workspaceId: 'workspace-1', workspacePath: '/other' } }]
  ])('rejects a mismatched %s lexical workspace path', (_label, patch) => {
    expect(() => assertPinnedWorkspaceTarget(authorityInput(patch))).toThrow(
      /workspace path does not match/i
    )
  })

  it('fails closed when the workspace has no real-path pin', () => {
    expect(() =>
      assertPinnedWorkspaceTarget(
        authorityInput({ workspace: { id: 'workspace-1', path: '/lexical/repo' } })
      )
    ).toThrow(/real-path pin/i)
  })

  it.each(['/real/repo/', 'relative/repo', '/'])(
    'rejects an unsafe real-path pin: %s',
    (realPath) => {
      expect(() =>
        assertPinnedWorkspaceTarget(
          authorityInput({
            workspace: { id: 'workspace-1', path: '/lexical/repo', realPath }
          })
        )
      ).toThrow(/canonical non-root absolute path/i)
    }
  )

  it('rejects a retargeted lexical path', () => {
    expect(() =>
      assertPinnedWorkspaceTarget(
        authorityInput({ resolveRealDirectory: () => '/real/replacement' })
      )
    ).toThrow(/no longer matches/i)
  })

  it('fails closed when the current target is missing, unreadable, or not a directory', () => {
    expect(() =>
      assertPinnedWorkspaceTarget(
        authorityInput({
          resolveRealDirectory: () => {
            throw new Error('not a directory')
          }
        })
      )
    ).toThrow(/unavailable or is not a directory/i)
  })
})
