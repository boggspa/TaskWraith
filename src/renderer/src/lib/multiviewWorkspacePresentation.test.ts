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
    expect(focusedSnapshot).toContain('normalizeWorkspacePath(primaryPrOwnerPathRef.current')
    expect(focusedSnapshot).toContain('normalizeWorkspacePath(primaryCiOwnerPathRef.current')
    expect(focusedSnapshot).toContain('normalizeWorkspacePath(snapshot.requestedPath)')

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

  it('updates explicit pane focus once and hydrates its owned display state', () => {
    const focus = slice('const handleFocusMultiviewPane =', 'const handleOpenInMultiview =')
    const focusIndex = focus.indexOf('multiview.focusPane(paneIndex, outgoingChatId)')
    const navigationIndex = focus.indexOf(
      'setCurrentChatIdForNavigation(viewerChat.appChatId, { assignMultiviewPane: false })'
    )
    const workspaceIndex = focus.indexOf('setCurrentWorkspace(paneWorkspace)')
    const chatIndex = focus.indexOf('setCurrentChat(viewerChat)')
    const composerIndex = focus.indexOf(
      'applyChatComposerSelectionRef.current(viewerChat, viewerProvider)'
    )
    expect(focus).not.toContain('startTransition(() => {')
    expect(focus).not.toContain('assignToNextPane')
    expect(focus).toContain('setSessionTrust(false)')
    expect(focus).toContain('clearWorkspaceTrust()')
    expect(focus).toContain('currentWorkspaceIdRef.current !== paneWorkspaceId')
    expect(focusIndex).toBeGreaterThanOrEqual(0)
    expect(navigationIndex).toBeGreaterThan(focusIndex)
    expect(workspaceIndex).toBeGreaterThan(navigationIndex)
    expect(chatIndex).toBeGreaterThan(workspaceIndex)
    expect(composerIndex).toBeGreaterThan(chatIndex)
  })

  it('guards workspace trust refreshes against late ownership changes', () => {
    const trustRefresh = slice('const clearWorkspaceTrust =', 'const currentProvider =')
    expect(trustRefresh).toContain('workspaceTrustGenerationRef.current += 1')
    expect(trustRefresh).toContain('await window.api.checkTrust(workspace.path)')
    expect(trustRefresh).toContain('isCurrentWorkspaceTrustOwner(requestOwner, currentOwner)')
    expect(trustRefresh).toContain('currentWorkspaceIdRef.current')
    expect(trustRefresh).toContain('currentWorkspacePathRef.current')
    expect(trustRefresh).toContain('setTrustResult(null)')
    expect(source.match(/window\.api\.checkTrust\(/g)).toHaveLength(1)
    expect(source).not.toContain('.then(setTrustResult)')
  })

  it('keeps resting panes outside focused-session trust', () => {
    const paneRun = slice('const handleRunMultiviewPane =', 'const handleCancelMultiviewPane =')
    expect(paneRun).toContain('paneIndex === multiview.focusedPaneIndex')
    expect(paneRun).toContain('? sessionTrust')
    expect(paneRun).toContain(': false')

    const paneComposer = slice(
      'const paneComposerCtx: ComposerProps =',
      'const memoizedPaneComposerCtx ='
    )
    expect(paneComposer).toContain(
      'sessionTrust: viewerOwnsFocusedTrust ? sessionTrust : false'
    )
    expect(paneComposer).toContain('setSessionTrust: viewerOwnsFocusedTrust')
    expect(paneComposer).toContain('trustResult: viewerOwnsFocusedTrust ? trustResult : null')
    expect(paneComposer).toContain('handleTrustWorkspaceClick: viewerOwnsFocusedTrust')
    expect(paneComposer).toContain('handleBridgeCommand: viewerOwnsFocusedTrust')
    expect(paneComposer).toContain('markPersistentSessionRestartNeeded: viewerOwnsFocusedTrust')

    const restingPaneComposer = slice(
      'const buildPaneComposerCtx =',
      'const paneComposerCtxByKey ='
    )
    expect(restingPaneComposer).toContain(
      'handleBridgeCommand: async () => focusPaneForGoalControl()'
    )
    expect(restingPaneComposer).toContain(
      'markPersistentSessionRestartNeeded: focusPaneForGoalControl'
    )
  })

  it('binds resting-pane review, mode, capture, and Discord actions to the pane chat', () => {
    const paneComposer = slice(
      'const paneComposerCtx: ComposerProps =',
      'const memoizedPaneComposerCtx ='
    )
    expect(paneComposer).toContain(
      'currentDiscordContextSelection: discordContextSelectionByChatId[viewerChatId] || null'
    )
    expect(paneComposer).toContain('resumeAppWatchSnapshot: viewerResumeAppWatchSnapshot')
    expect(paneComposer).toContain(
      'await handleReviewDiffForChat(viewerChat, viewerProvider, viewerWorkspace)'
    )
    expect(paneComposer).toContain(
      'handleToggleEnsembleForChat(viewerChat, enabled, viewerIsRunning)'
    )
    expect(paneComposer).toContain('handleAttachWindow: () => handleAttachWindow(viewerChatId)')
    expect(paneComposer).toContain('handleDetachWindow: () => handleDetachWindow(viewerChatId)')
    expect(paneComposer).toContain(
      'handleClearDiscordContext: () => clearDiscordContextForChat(viewerChatId)'
    )
    expect(paneComposer).toContain(
      'openDiscordContextPickerForPane(viewerPaneIndex, viewerChatId)'
    )

    const screenWatch = slice(
      'const handleMultiviewPaneToggleScreenWatch =',
      'const openDiscordContextPickerForPane ='
    )
    expect(screenWatch).toContain('attachedWindowOwnerChatIdRef.current === chatId')
    expect(screenWatch).toContain('handleDetachWindow(chatId)')
    expect(screenWatch).toContain('handleAttachWindow(chatId)')
  })

  it('invalidates registered Git and CI responses when workspace ownership changes', () => {
    expect(source).toContain('primaryWorkspacePresentationGenerationRef.current += 1')
    expect(source).toContain('primaryCiRequestGenerationRef.current += 1')
    expect(source).toContain('setPrimaryGitSnapshot(null)')
    expect(source).toContain(
      '!isCurrentPrimaryWorkspaceRequest(requestedWorkspacePath, workspaceGeneration)'
    )
    expect(source).toContain(
      'primaryCiRequestGenerationRef.current !== requestGeneration'
    )
    expect(source).toContain(
      "normalizeWorkspacePath(primaryPrOwnerPathRef.current || '')"
    )
    expect(source).toContain(
      "normalizeWorkspacePath(primaryCiOwnerPathRef.current || '')"
    )
  })

  it('does not let the focused Diff Studio scalar replace the current chat run summary', () => {
    expect(source).toContain(
      'const exactFileChangeSummaries = getRunFileDiffSummaries(currentRunDiff || null)'
    )
    expect(source).toContain('selectRunEvidenceMessages(messages, {')
    expect(source).toContain('runIds: [liveToolFileSummaryRunId]')
    expect(source).not.toContain(
      'const exactFileChangeSummaries = getRunFileDiffSummaries(runDiff || currentRunDiff || null)'
    )
    const completionEvidence = slice(
      'const liveToolFileChangeSummaries =',
      'const displayFileChangeSummaries ='
    )
    expect(completionEvidence).toContain(': liveToolFileChangeSummaries')
    expect(completionEvidence).not.toContain('workspaceFileChangeSummaries')
    expect(completionEvidence).not.toContain('applyWorkspaceDiffOverlay')
    expect(source).toContain('mergeCompletionFileChangeSummaries(')
  })
})
