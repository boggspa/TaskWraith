import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const appSource = readFileSync(new URL('../App.tsx', import.meta.url), 'utf8')
const composerSource = readFileSync(new URL('../components/Composer.tsx', import.meta.url), 'utf8')
const mainSource = readFileSync(new URL('../../../main/index.ts', import.meta.url), 'utf8')
const preloadTypes = readFileSync(new URL('../../../preload/index.d.ts', import.meta.url), 'utf8')

function sourceBetween(source: string, start: string, end: string): string {
  const startIndex = source.indexOf(start)
  const endIndex = source.indexOf(end, startIndex)
  expect(startIndex).toBeGreaterThanOrEqual(0)
  expect(endIndex).toBeGreaterThan(startIndex)
  return source.slice(startIndex, endIndex)
}

describe('project reference context dispatch acceptance', () => {
  it('does not consume the one-send selection during generic composer cleanup', () => {
    const cleanup = sourceBetween(
      appSource,
      'const clearComposerAttachmentsForSubmittedRequest =',
      'const settleProjectReferenceContextForRequest ='
    )

    expect(cleanup).not.toContain('settleProjectReferenceContextClaim')
  })

  it('claims a selection atomically during request construction', () => {
    const requestBuilder = sourceBetween(
      appSource,
      'const buildRunRequest =',
      'const buildRunRequestRef ='
    )

    expect(requestBuilder).toContain('claimProjectReferenceContextSelection')
    expect(requestBuilder).toContain('{ projectReferenceContextClaim }')
    expect(requestBuilder).not.toContain(
      ': getProjectReferenceContextSelection(selectedChat?.appChatId)'
    )
  })

  it('claims the owning chat selection for side-panel and multiview sends', () => {
    const sideRun = sourceBetween(appSource, 'const handleSideRun =', 'const cancelRunningScheduledTaskForChat =')
    const paneRun = sourceBetween(
      appSource,
      'const handleRunMultiviewPane =',
      'const handleCancelMultiviewPane ='
    )

    expect(sideRun).toContain('claimProjectReferenceContext: true')
    expect(sideRun).toContain('runRequestHasContent(request)')
    expect(paneRun).toContain('claimProjectReferenceContext: true')
    expect(paneRun).toContain('runRequestHasContent(request)')
  })

  it('enables the Composer for an explicit reference-only solo send', () => {
    expect(composerSource).toContain('hasProjectReferenceContext = false')
    expect(composerSource).toContain(
      'hasAttachmentPromptContent(prompt, imageAttachments) || hasProjectReferenceContext'
    )
    expect(appSource).toContain(
      'currentProjectReferenceContextSelection?.referenceIds.length && !isCurrentEnsembleChat'
    )
  })

  it('settles a queued claim only after durable queue persistence succeeds', () => {
    const queue = sourceBetween(
      appSource,
      'const queueRunRequest =',
      'const queueRunRequestRef ='
    )
    const persistIndex = queue.indexOf('persistRunQueueJobForRequest')
    const acceptedIndex = queue.indexOf(
      "settleProjectReferenceContextForRequest(queuedRequest, 'accepted')"
    )
    const failureIndex = queue.indexOf('.catch((error) =>')

    expect(persistIndex).toBeGreaterThanOrEqual(0)
    expect(acceptedIndex).toBeGreaterThan(persistIndex)
    expect(failureIndex).toBeGreaterThan(acceptedIndex)
    expect(queue).toContain(
      'prev.filter((candidate) => candidate.appRunId !== queuedRequest.appRunId)'
    )

    const snapshotBuilder = sourceBetween(
      appSource,
      'const createRunQueueRequestSnapshot =',
      'const persistRunQueueJobForRequest ='
    )
    expect(snapshotBuilder).not.toContain('projectReferenceContextClaim')
  })

  it('consumes an immediate selection only from an affirmative main dispatch receipt', () => {
    const executeRun = sourceBetween(appSource, 'const executeRun =', 'const executeRunRef =')
    const receiptIndex = executeRun.indexOf(
      'const dispatchResult = await window.api.runAgent(dispatchPayload)'
    )
    const receiptBlock = executeRun.slice(receiptIndex, receiptIndex + 500)

    expect(receiptIndex).toBeGreaterThanOrEqual(0)
    expect(receiptBlock).toContain('dispatchAccepted = dispatchResult.dispatched')
    expect(receiptBlock).toContain('settleProjectReferenceContextForRequest(')
    expect(receiptBlock).toContain(
      "dispatchResult.dispatched ? 'accepted' : 'rejected'"
    )
  })

  it('returns the main dispatch receipt through the run-agent IPC contract', () => {
    const handler = sourceBetween(
      mainSource,
      "ipcMain.handle('run-agent'",
      "ipcMain.handle(\n      'run-ensemble-round'"
    )

    expect(handler).toContain('return dispatchWithAuthorizedAttachmentPaths(')
    expect(preloadTypes).toContain(
      'runAgent: (payload: AgentRunPayload) => Promise<DispatchResult>'
    )
  })

  it('does not let a stale external-grant operation erase or dispatch a newer prompt', () => {
    const persistence = sourceBetween(
      appSource,
      'const persistExternalPathGrantPromptForChat =',
      'const persistExternalPathGrantPrompt ='
    )

    expect(
      persistence.match(
        /externalPathGrantPromptByChatIdRef\.current\[chatId\] !== prompt/g
      )
    ).toHaveLength(2)
    expect(persistence).toContain('prev[chatId] === prompt')
    expect(persistence.indexOf('prev[chatId] === prompt')).toBeLessThan(
      persistence.indexOf('executeExternalPathGrantRunRef.current(resumeRun)')
    )
  })

  it('releases pending external-grant claims during chat teardown', () => {
    const deleteChat = sourceBetween(
      appSource,
      'const handleDeleteChat =',
      'const handleDeleteAllChatHistory ='
    )
    const deleteAll = sourceBetween(
      appSource,
      'const handleDeleteAllChatHistory =',
      'const handleTogglePinWorkspace ='
    )

    expect(deleteChat).toContain('clearExternalPathGrantPrompt(chatId)')
    expect(deleteChat).toContain('clearProjectReferenceContextSelection(chatId)')
    expect(deleteAll).toContain(
      'prompt?.pendingRun?.projectReferenceContextClaim'
    )
    expect(deleteAll).toContain('externalPathGrantPromptByChatIdRef.current = {}')
    expect(deleteAll).toContain('clearProjectReferenceContextSelection(chatId)')
  })
})
