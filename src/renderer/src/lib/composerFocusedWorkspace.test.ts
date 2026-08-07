import { describe, expect, it } from 'vitest'
import {
  resolveComposerFocusedWorkspace,
  resolveComposerGitActionBasePath
} from './composerFocusedWorkspace'

const agBench = { id: 'ws-agbench', path: '/Users/chris/Documents/AGBench', displayName: 'AGBench' }
const test1 = { id: 'ws-test1', path: '/Users/chris/Documents/Test 1', displayName: 'Test 1' }

describe('resolveComposerFocusedWorkspace', () => {
  it('prefers the chat-resolved workspace in single-pane mode (no stale app-global leak)', () => {
    // Regression: ComposerWorkspaceSwitcher previously took App currentWorkspace
    // when !isMultiviewSplit, so switching threads left the footer primary/secondary
    // selector on AGBench while the above-bar git row already followed Test 1.
    expect(
      resolveComposerFocusedWorkspace({
        isMultiviewSplit: false,
        currentChatWorkspace: test1,
        currentWorkspace: agBench
      })
    ).toBe(test1)
  })

  it('prefers the chat-resolved workspace in multiview mode too', () => {
    expect(
      resolveComposerFocusedWorkspace({
        isMultiviewSplit: true,
        currentChatWorkspace: test1,
        currentWorkspace: agBench
      })
    ).toBe(test1)
  })

  it('falls back to app-global currentWorkspace when no chat workspace is resolved', () => {
    expect(
      resolveComposerFocusedWorkspace({
        isMultiviewSplit: false,
        currentChatWorkspace: null,
        currentWorkspace: agBench
      })
    ).toBe(agBench)
  })

  it('returns null when neither binding is available', () => {
    expect(
      resolveComposerFocusedWorkspace({
        isMultiviewSplit: false,
        currentChatWorkspace: null,
        currentWorkspace: null
      })
    ).toBeNull()
  })
})

describe('resolveComposerGitActionBasePath', () => {
  it('prefers chat-resolved currentWorkspacePath over a stale currentWorkspace.path', () => {
    // Regression: Branch & worktree / Commit / Create PR used currentWorkspace.path,
    // so a stale primary record could checkout/commit in AGBench while the thread
    // was bound to Test 1.
    expect(
      resolveComposerGitActionBasePath({
        currentWorkspacePath: test1.path,
        currentWorkspace: agBench
      })
    ).toBe(test1.path)
  })

  it('falls back to currentWorkspace.path when no chat path is available', () => {
    expect(
      resolveComposerGitActionBasePath({
        currentWorkspacePath: null,
        currentWorkspace: agBench
      })
    ).toBe(agBench.path)
  })

  it('returns undefined when neither path is available', () => {
    expect(
      resolveComposerGitActionBasePath({
        currentWorkspacePath: null,
        currentWorkspace: null
      })
    ).toBeUndefined()
  })
})
