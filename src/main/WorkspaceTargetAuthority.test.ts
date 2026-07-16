import { resolve, sep } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { assertPinnedWorkspaceTarget } from './WorkspaceTargetAuthority'

// resolve() keeps these fixtures lexically canonical on every platform
// (POSIX literals fail `resolve(p) === p` on Windows).
const LEXICAL_PATH = resolve('/lexical/repo')
const REAL_PATH = resolve('/real/repo')
const OTHER_PATH = resolve('/other')
const REPLACEMENT_REAL_PATH = resolve('/real/replacement')

function authorityInput(
  overrides: Partial<Parameters<typeof assertPinnedWorkspaceTarget>[0]> = {}
): Parameters<typeof assertPinnedWorkspaceTarget>[0] {
  return {
    workspace: {
      id: 'workspace-1',
      path: LEXICAL_PATH,
      realPath: REAL_PATH
    },
    task: {
      workspaceId: 'workspace-1',
      workspacePath: LEXICAL_PATH
    },
    chat: {
      workspaceId: 'workspace-1',
      workspacePath: LEXICAL_PATH
    },
    workflow: {
      workspaceId: 'workspace-1',
      workspacePath: LEXICAL_PATH
    },
    canonicalPath: (value) => value.replace(/[\\/]$/, ''),
    resolveRealDirectory: () => REAL_PATH,
    ...overrides
  }
}

describe('assertPinnedWorkspaceTarget', () => {
  it('returns the pinned real execution target while preserving lexical bindings', () => {
    expect(assertPinnedWorkspaceTarget(authorityInput())).toBe(REAL_PATH)
  })

  it('supports standalone tasks without a workflow binding', () => {
    expect(assertPinnedWorkspaceTarget(authorityInput({ workflow: null }))).toBe(REAL_PATH)
  })

  it.each([
    ['task', { task: { workspaceId: 'other', workspacePath: LEXICAL_PATH } }],
    ['chat', { chat: { workspaceId: 'other', workspacePath: LEXICAL_PATH } }],
    ['workflow', { workflow: { workspaceId: 'other', workspacePath: LEXICAL_PATH } }]
  ])('rejects a mismatched %s workspace id before filesystem resolution', (_label, patch) => {
    const resolveRealDirectory = vi.fn(() => REAL_PATH)
    expect(() =>
      assertPinnedWorkspaceTarget(authorityInput({ ...patch, resolveRealDirectory }))
    ).toThrow(/workspace id does not match/i)
    expect(resolveRealDirectory).not.toHaveBeenCalled()
  })

  it.each([
    ['task', { task: { workspaceId: 'workspace-1', workspacePath: OTHER_PATH } }],
    ['chat', { chat: { workspaceId: 'workspace-1', workspacePath: OTHER_PATH } }],
    ['workflow', { workflow: { workspaceId: 'workspace-1', workspacePath: OTHER_PATH } }]
  ])('rejects a mismatched %s lexical workspace path', (_label, patch) => {
    expect(() => assertPinnedWorkspaceTarget(authorityInput(patch))).toThrow(
      /workspace path does not match/i
    )
  })

  it('fails closed when the workspace has no real-path pin', () => {
    expect(() =>
      assertPinnedWorkspaceTarget(
        authorityInput({ workspace: { id: 'workspace-1', path: LEXICAL_PATH } })
      )
    ).toThrow(/real-path pin/i)
  })

  // Each pin is deliberately non-canonical on every platform: a trailing
  // separator, a relative path, and a bare filesystem root.
  it.each([`${REAL_PATH}${sep}`, 'relative/repo', resolve('/')])(
    'rejects an unsafe real-path pin: %s',
    (realPath) => {
      expect(() =>
        assertPinnedWorkspaceTarget(
          authorityInput({
            workspace: { id: 'workspace-1', path: LEXICAL_PATH, realPath }
          })
        )
      ).toThrow(/canonical non-root absolute path/i)
    }
  )

  it('rejects a retargeted lexical path', () => {
    expect(() =>
      assertPinnedWorkspaceTarget(
        authorityInput({ resolveRealDirectory: () => REPLACEMENT_REAL_PATH })
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
