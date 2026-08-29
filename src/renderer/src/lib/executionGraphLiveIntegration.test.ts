import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const appSource = readFileSync(new URL('../App.tsx', import.meta.url), 'utf8')
const composerSource = readFileSync(new URL('../components/Composer.tsx', import.meta.url), 'utf8')
const layoutSource = readFileSync(
  new URL('../app/views/MainAppLayout.tsx', import.meta.url),
  'utf8'
)
const executionMapSource = readFileSync(
  new URL('../components/ExecutionMapView.tsx', import.meta.url),
  'utf8'
)

function slice(source: string, start: string, end: string): string {
  const startIndex = source.indexOf(start)
  const endIndex = source.indexOf(end, startIndex + start.length)
  expect(startIndex).toBeGreaterThanOrEqual(0)
  expect(endIndex).toBeGreaterThan(startIndex)
  return source.slice(startIndex, endIndex)
}

describe('live execution graph integration', () => {
  it('guards stale preload surfaces while hydrating every visible chat and applying push notices', () => {
    const hydration = slice(
      appSource,
      'const generation = ++executionRunQueryGenerationRef.current',
      'typeof window.api.onExecutionGraphChanged'
    )
    expect(hydration).toContain("typeof window.api.listExecutionRuns !== 'function'")
    expect(hydration).toContain('for (const paneChatId of multiview.paneChatIds)')
    expect(hydration).toContain(
      '.listExecutionRuns({ workspaceId, rootChatId: chatId, includeTerminal: true })'
    )
    expect(hydration).toContain('executionRunQueryGenerationRef.current !== generation')
    expect(hydration).toContain('mergeExecutionRunProjection(current[run.executionId], run)')

    const subscription = slice(
      appSource,
      'typeof window.api.onExecutionGraphChanged',
      'if (!openExecutionMap) return'
    )
    expect(subscription).toContain("typeof window.api.onExecutionGraphChanged !== 'function'")
    expect(subscription).toContain("typeof window.api.getExecutionRun !== 'function'")
    expect(subscription).toContain('window.api.onExecutionGraphChanged((notice) => {')
    expect(subscription).toContain('.getExecutionRun(notice.executionId)')
  })

  it('surfaces repository and recovery diagnostics through a stale-safe root notice', () => {
    const diagnostics = slice(
      appSource,
      'const refreshExecutionGraphDiagnostics =',
      'const generation = ++executionRunQueryGenerationRef.current'
    )
    expect(diagnostics).toContain(
      "typeof window.api.getExecutionGraphDiagnostics !== 'function'"
    )
    expect(diagnostics).toContain('.getExecutionGraphDiagnostics()')
    expect(appSource).toContain('executionGraphDiagnostics.repositoryDiagnostics.map(')
    expect(appSource).toContain('executionGraphDiagnostics.recoveryDiagnostics.map(')
    expect(appSource).toContain('className="execution-graph-diagnostics-notice"')
    expect(appSource).toContain('Stack history needs attention')
  })

  it('routes busy composer sends to classic queue; Stack append is gated off', () => {
    const handleRun = slice(appSource, 'const handleRun =', 'const createSideChatFromCurrentChat =')
    const busyBranch = slice(
      handleRun,
      'shouldQueueRunBeforeDispatch({',
      'void executeRun(request)'
    )
    // Call site may still consult the stack helper, but the product gate is
    // always false so the durable classic queue is what actually receives the
    // follow-up (see shouldAppendBusySendToExecutionStack).
    expect(busyBranch).toContain('queueRunRequest(request)')
    expect(busyBranch).toContain('appendBusyRunToExecutionStack(')

    const append = slice(appSource, 'const appendBusyRunToExecutionStack =', 'const handleRun =')
    expect(append).toContain('shouldAppendBusySendToExecutionStack({')
    expect(append).toContain('const requestSnapshot = createRunQueueRequestSnapshot(request)')
    expect(append).toContain('rootChatId: targetChatId')
    expect(append).toContain(
      "title: normalizeThreadTitle(`${targetChat.title || 'Task'} Stack`, 'Task Stack')"
    )

    const contextClear = slice(
      appSource,
      'const clearSubmittedExecutionStackContext =',
      'const settleProjectReferenceContextForRequest ='
    )
    expect(contextClear).toContain('submittedAttachmentIds.has(attachment.id)')
    expect(contextClear).toContain('deepEqual(current[chatId], request.discordContextSelection)')
  })

  it('keeps special submissions on their existing dispatch and durable queue paths', () => {
    const append = slice(appSource, 'const appendBusyRunToExecutionStack =', 'const handleRun =')
    expect(append).toContain('existingPrompt: Boolean(request.existingPrompt)')
    expect(append).toContain(
      'scheduled: Boolean(request.scheduledRunAt || request.scheduledTaskId)'
    )
    expect(append).toContain('directedParticipant: Boolean(request.dmTargetParticipantId)')
    expect(append).toContain('request.verbatimPrompt')
    expect(append).toContain('request.codexNativeReview')
    expect(append).toContain('request.handoffSourceRunId')
    expect(append).toContain('request.preserveComposer')
    expect(append).toContain('request.discordContextSelection')
    expect(append).toContain('request.effectiveWorkspacePath')
    expect(append).toContain(
      "request.externalPathGrants?.some((grant) => grant.duration === 'thisRun')"
    )
  })

  it('gives resting Multiview panes the same target-scoped classic queue path', () => {
    const paneRun = slice(
      appSource,
      'const handleRunMultiviewPane =',
      'const handleCancelMultiviewPane ='
    )
    expect(paneRun).toContain('chat: paneChat')
    expect(paneRun).toContain('prompt: panePrompt')
    expect(paneRun).toContain('imageAttachments: paneAttachments')
    expect(paneRun).toContain('discordContextSelectionByChatIdRef.current[chatId]')
    expect(paneRun).toContain('queueRunRequestRef.current(')
    // Stack projection wiring may still flow for Execution Map focus, but the
    // composer above-row no longer mounts Stack UI (see Composer.tsx).
    expect(appSource).toContain(
      'projectMultiviewPaneToHost(viewerPaneIndex, viewerChatId)\n          handleOpenExecutionMap(runId, stepId)'
    )
  })

  it('keeps classic queued rows in Composer and leaves Stack/Map off the above-row', () => {
    expect(composerSource).toContain('<QueuedMessagesAboveRow')
    expect(composerSource).not.toContain('<ExecutionStackAboveRow')
    expect(composerSource).not.toContain('Execution history ·')
    expect(composerSource).not.toContain('Write next step')
    expect(composerSource).not.toContain('Save graph')
    expect(composerSource).not.toContain('Open map')
    // Graph-owned jobs stay out of the ordinary queue strip / badge.
    expect(appSource).toContain('.filter((job) => !job.executionGraph)')
    expect(appSource).toContain('runQueueJobs,\n        chatId,')
  })

  it('keeps graph-owned queue rows out of ordinary queued-count badges', () => {
    const queueCounts = slice(
      appSource,
      'const queuedRunQueueCount =',
      'const currentExecutionRuns ='
    )
    expect(queueCounts.match(/!job\.executionGraph/g)).toHaveLength(2)
  })

  // The invariant is that EVERY Stack/execution error surface strips the
  // framing; the count is how that is enforced. A fourth surface was added with
  // the whole-execution killswitch (2026-08-29), which is why the count moved.
  it('strips Electron invoke framing from all four Stack error surfaces', () => {
    expect(appSource.match(/stripElectronInvokeErrorFraming\(error\)/g)).toHaveLength(5)
    expect(appSource).toContain('Could not add this message to the Stack:')
    expect(appSource).toContain('Could not save graph:')
    expect(appSource).toContain('Could not cancel the remaining Stack:')
    expect(appSource).toContain('Could not cancel the execution:')
  })

  it('uses Execution Map as the focused primary-pane alternative to the transcript', () => {
    const focusedPane = slice(layoutSource, 'renderFocusedCell={() =>', '<TranscriptPanel')
    expect(focusedPane).toContain('if (executionMapProjection) {')
    expect(focusedPane).toContain('<ExecutionMapView')
    expect(focusedPane).toContain('onBack={handleBackFromExecutionMap}')
    expect(focusedPane.indexOf('<ExecutionMapView')).toBeLessThan(
      focusedPane.indexOf('<div\n              ref={appTranscriptRef}')
    )
    expect(appSource).toContain('run.rootChatId !== currentComposerChatId')
    expect(executionMapSource).toContain('mapRef.current?.focus()')
    const back = slice(
      appSource,
      'const handleBackFromExecutionMap =',
      'const handleCancelExecutionStackStep ='
    )
    expect(back).toContain('setOpenExecutionMap(null)')
    expect(back).toContain("querySelector<HTMLTextAreaElement>('textarea')?.focus()")
  })
})
