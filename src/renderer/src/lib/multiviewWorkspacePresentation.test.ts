import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { updatePathKeyedWorkspaceSnapshot } from './multiviewWorkspacePresentation'

const source = readFileSync(new URL('../App.tsx', import.meta.url), 'utf8')

function slice(start: string, end: string): string {
  const startIndex = source.indexOf(start)
  const endIndex = source.indexOf(end, startIndex + start.length)
  expect(startIndex, `missing source marker: ${start}`).toBeGreaterThanOrEqual(0)
  expect(endIndex, `missing source marker: ${end}`).toBeGreaterThan(startIndex)
  return source.slice(startIndex, endIndex)
}

describe('Multiview focused workspace presentation', () => {
  it('keeps a late snapshot response owned by its requested workspace path', () => {
    const test3Snapshot = { requestedPath: '/Test 3', branch: 'three' }
    const previous = { '/Test 3': test3Snapshot }
    const lateTest2Snapshot = { requestedPath: '/Test 2', branch: 'two' }

    const updated = updatePathKeyedWorkspaceSnapshot(
      previous,
      '/Test 3',
      lateTest2Snapshot
    )

    expect(updated['/Test 2']).toBe(lateTest2Snapshot)
    expect(updated['/Test 3']).toBe(test3Snapshot)
    expect(updatePathKeyedWorkspaceSnapshot(updated, '/Test 3', null)).toBe(updated)
  })

  it('derives the focused path from the chat and keys visible snapshot subscriptions by path', () => {
    expect(source).toContain('resolvePaneWorkspacePath({')
    expect(source).toContain('const multiviewPaneWorkspacePathsKey = (() => {')
  })

  it('uses the path-keyed pane snapshot for focused split presentation', () => {
    const focusedSnapshot = slice(
      'const focusedPrimaryGitSnapshot =',
      'const currentExternalWorkspaceState ='
    )
    expect(focusedSnapshot).toContain('gitSnapshotByWorkspace[currentGitPresentationPath] ?? null')
    expect(focusedSnapshot).toContain('const focusedPrimaryPr = isMultiviewSplit ? null : primaryPr')
    expect(focusedSnapshot).toContain('const focusedPrimaryCi = isMultiviewSplit ? null : primaryCi')

    const diffStats = slice('const workspaceDiffStats =', 'const liveGitInvalidationKey =')
    expect(diffStats).toContain('if (focusedPrimaryGitSnapshot)')
    expect(diffStats).not.toContain('if (primaryGitSnapshot)')

    const composer = slice('const composerCtx: ComposerProps =', 'const activeWorkspaceBoard =')
    expect(composer).toContain('currentWorkspace: focusedCurrentWorkspace')
    expect(composer).toContain('primaryGitSnapshot: focusedPrimaryGitSnapshot')
    expect(composer).toContain('setPrimaryGitSnapshot: setFocusedPrimaryGitSnapshot')
    expect(composer).toContain('primaryPr: focusedPrimaryPr')
    expect(composer).toContain('primaryCi: focusedPrimaryCi')

    const paneSetter = slice(
      'const handleMultiviewPanePrimaryGitSnapshot =',
      'const handleMultiviewPaneComposerWorktreeChange ='
    )
    expect(paneSetter).toContain('updatePathKeyedWorkspaceSnapshot(prev, path, snapshot)')
  })

  it('updates focused workspace and chat inside one transition', () => {
    const focus = slice('const handleFocusMultiviewPane =', 'const handleOpenInMultiview =')
    const transitionIndex = focus.indexOf('startTransition(() => {')
    const focusIndex = focus.indexOf('multiview.focusPane(paneIndex, outgoingChatId)', transitionIndex)
    const nullableWorkspaceGuard = focus.indexOf(
      '(currentWorkspace?.id || null) !== (paneWorkspace?.id || null)'
    )
    const workspaceIndex = focus.indexOf('setCurrentWorkspace(paneWorkspace)', transitionIndex)
    const chatIndex = focus.indexOf('setCurrentChat(viewerChat)', transitionIndex)
    expect(transitionIndex).toBeGreaterThanOrEqual(0)
    expect(nullableWorkspaceGuard).toBeGreaterThanOrEqual(0)
    expect(focusIndex).toBeGreaterThan(transitionIndex)
    expect(workspaceIndex).toBeGreaterThan(focusIndex)
    expect(chatIndex).toBeGreaterThan(workspaceIndex)
  })
})
