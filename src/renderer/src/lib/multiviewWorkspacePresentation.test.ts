import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { updatePathKeyedWorkspaceSnapshot } from './multiviewWorkspacePresentation'

const source = readFileSync(new URL('../App.tsx', import.meta.url), 'utf8')
const layoutSource = readFileSync(new URL('../app/views/MainAppLayout.tsx', import.meta.url), 'utf8')

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
    expect(source).toContain('new WorkspaceGitSnapshotStore()')
    expect(source).not.toContain('setGitSnapshotByWorkspace')
  })

  it('uses the path-keyed pane snapshot for focused split presentation', () => {
    const focusedSnapshot = slice(
      'const focusedPrimaryGitSnapshot =',
      'const currentExternalWorkspaceState ='
    )
    expect(focusedSnapshot).toContain('focusedMultiviewGitSnapshot')
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
    expect(paneSetter).toContain('multiviewGitSnapshotStore.set(path, snapshot)')
    expect(source).toContain('gitSnapshotStore={multiviewGitSnapshotStore}')
    expect(source).toContain('gitSnapshotPath={viewerGitPresentationPath}')
  })

  it('keeps ordinary focus local and reserves legacy projection for host-only actions', () => {
    const localFocus = slice('const handleFocusMultiviewPane =', 'const handleOpenInMultiview =')
    expect(localFocus).toContain('multiview.setFocusedPane(paneIndex)')
    expect(localFocus).not.toContain('setCurrentChat(')
    expect(localFocus).not.toContain('setCurrentWorkspace(')
    expect(localFocus).not.toContain('startTransition(')

    const projection = slice(
      'const projectMultiviewPaneToHost =',
      '// Ordinary pane activation is presentation-only.'
    )
    const focusIndex = projection.indexOf('multiview.setFocusedPane(paneIndex)')
    const navigationIndex = projection.indexOf(
      'setCurrentChatIdForNavigation(viewerChat.appChatId, { assignMultiviewPane: false })'
    )
    const workspaceIndex = projection.indexOf('setCurrentWorkspace(paneWorkspace)')
    const chatIndex = projection.indexOf('setCurrentChat(viewerChat)')
    const composerIndex = projection.indexOf(
      'applyChatComposerSelectionRef.current(viewerChat, viewerProvider)'
    )
    const transitionIndex = projection.indexOf('startTransition(() => {')
    expect(transitionIndex).toBeGreaterThanOrEqual(0)
    expect(projection).toContain('paneIndex === multiview.focusedPaneIndex')
    expect(projection).toContain('setSessionTrust(false)')
    expect(projection).toContain('clearWorkspaceTrust()')
    expect(projection).toContain('currentWorkspaceIdRef.current !== paneWorkspaceId')
    expect(projection).toContain(
      'outgoingMainScrollState || captureChatScrollState(outgoingPaneRefs?.scrollRef.current)'
    )
    expect(focusIndex).toBeGreaterThan(transitionIndex)
    expect(navigationIndex).toBeGreaterThan(focusIndex)
    expect(workspaceIndex).toBeGreaterThan(navigationIndex)
    expect(chatIndex).toBeGreaterThan(workspaceIndex)
    expect(composerIndex).toBeGreaterThan(chatIndex)
    expect(layoutSource).toContain('renderFocusedChatCell={')
    expect(layoutSource).toContain('const focusedHostOverlayRequired = Boolean(')
    // The host chrome still reaches only the host-projection pane — but via a
    // memoized element, because building it inline made a new node every
    // render and defeated every pane's memo (see lib/paneTopLeftChrome).
    expect(layoutSource).toMatch(
      /chatId === currentChatAppChatId \? focusedPaneTopLeftChrome : undefined/
    )
    expect(layoutSource).toMatch(
      /const focusedPaneTopLeftChrome = useMemo\(\s*\(\) => \(\s*<>\s*\{humanCollaborationControls\}/
    )
    expect(layoutSource).toContain('{!focusedHostOverlayRequired && channelMemberControl}')
    expect(layoutSource).toContain('showFocusedHostOverlay={focusedHostOverlayRequired}')
    expect(layoutSource).not.toContain('(!isChatPopoutWindow && !showWorkspaceSidebar)')
    expect(source).toContain(
      'viewerOwnsHostProjection ? composerCtx : resolveRestingPaneComposerCtx()'
    )
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

    const paneComposer = slice('const buildPaneComposerCtx =', 'const paneComposerCtxByKey =')
    expect(paneComposer).toContain('sessionTrust: false')
    expect(paneComposer).toContain('setSessionTrust: () => focusPaneForGoalControl()')
    expect(paneComposer).toContain('trustResult: null')
    expect(paneComposer).toContain('handleTrustWorkspaceClick: focusPaneForGoalControl')
    expect(paneComposer).toContain('handleBridgeCommand: async () => focusPaneForGoalControl()')
    expect(paneComposer).toContain('markPersistentSessionRestartNeeded: focusPaneForGoalControl')
    expect(paneComposer).not.toContain('sessionTrust: viewerOwnsFocusedTrust')
  })

  it('binds resting-pane review, mode, capture, and Discord actions to the pane chat', () => {
    const paneComposer = slice('const buildPaneComposerCtx =', 'const paneComposerCtxByKey =')
    expect(paneComposer).toContain(
      'currentDiscordContextSelection: discordContextSelectionByChatId[viewerChatId] || null'
    )
    expect(paneComposer).toContain('resumeAppWatchSnapshot: viewerResumeAppWatchSnapshot')
    expect(paneComposer).toContain(
      'paneCtxHelpers.handleReviewDiffForChat(\n            viewerChat,\n            viewerProvider,\n            viewerWorkspace'
    )
    expect(paneComposer).toContain(
      'paneCtxHelpers.handleToggleEnsembleForChat(viewerChat, enabled, viewerIsRunning)'
    )
    expect(paneComposer).toContain(
      'handleAttachWindow: () => paneCtxHelpers.handleAttachWindow(viewerChatId)'
    )
    expect(paneComposer).toContain(
      'handleDetachWindow: () => paneCtxHelpers.handleDetachWindow(viewerChatId)'
    )
    expect(paneComposer).toContain('paneCtxHelpers.clearDiscordContextForChat(viewerChatId)')
    expect(paneComposer).toContain(
      'paneCtxHelpers.openDiscordContextPickerForPane(viewerPaneIndex, viewerChatId)'
    )
    expect(paneComposer).toContain(
      'openWorkspaceDiffInInspector: (workspacePath?: string) => {'
    )
    expect(paneComposer).toContain(
      'projectMultiviewPaneToHost(viewerPaneIndex, viewerChatId)'
    )
    expect(paneComposer).toContain(
      'composerHandlers.openWorkspaceDiffInInspector(\n            workspacePath || viewerGitPresentationPath'
    )
    expect(paneComposer).toContain(
      'openWorkspaceCommitsInInspector: (workspacePath?: string) => {'
    )
    expect(paneComposer).toContain(
      'composerHandlers.openWorkspaceCommitsInInspector(\n            workspacePath || viewerGitPresentationPath'
    )

    const screenWatch = slice(
      'const handleMultiviewPaneToggleScreenWatch =',
      'const openDiscordContextPickerForPane ='
    )
    expect(screenWatch).toContain('attachedWindow?.chatId === chatId')
    expect(screenWatch).toContain('handleDetachWindow(chatId)')
    expect(screenWatch).toContain('handleAttachWindow(chatId)')
  })

  it('synchronously hides a prior chat attachment and gates Screen Watch on its own capability', () => {
    expect(source).toContain('const currentChatAttachedWindow =')
    expect(source).toContain('attachedWindow?.chatId === currentChat?.appChatId')
    expect(source).toContain('screenWatchUnavailableReason: nativeScreenWatchUnavailableReason')
    expect(source).not.toContain('appDriveUnavailableReason')

    const attachmentStatus = slice(
      'useEffect(() => {\n    const chatId = currentChat?.appChatId',
      '// triggerSendConfirmation moved INTO <Composer>'
    )
    expect(attachmentStatus).toContain('reconcileAttachedWindowStatus(chatId, status)')
    expect(attachmentStatus).toContain('currentChatIdRef.current !== chatId')

    const stickyProjection = slice('function stickyAppWatchStashInput(', 'function App()')
    expect(stickyProjection).toContain('title: attachment.windowMeta.title')
    expect(stickyProjection).toContain('bundleID: attachment.windowMeta.bundleID')
    expect(stickyProjection).toContain('applicationName: attachment.windowMeta.applicationName')
    for (const privateField of ['windowID', 'pid', 'handleID', 'scopeID', 'consentEpoch']) {
      expect(stickyProjection).not.toContain(privateField)
    }
    expect(source).toContain('liveAttachedWindowRef.current?.chatId === chatId')
    expect(source).toContain('.stickyAppWatchGet(chatId)')
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
