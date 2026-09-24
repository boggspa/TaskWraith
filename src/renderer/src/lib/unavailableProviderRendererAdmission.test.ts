import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const appSource = readFileSync(new URL('../App.tsx', import.meta.url), 'utf8')

function sourceBetween(start: string, end: string): string {
  const startIndex = appSource.indexOf(start)
  const endIndex = appSource.indexOf(end, startIndex + start.length)
  expect(startIndex).toBeGreaterThanOrEqual(0)
  expect(endIndex).toBeGreaterThan(startIndex)
  return appSource.slice(startIndex, endIndex)
}

function expectBefore(source: string, first: string, second: string): void {
  const firstIndex = source.indexOf(first)
  const secondIndex = source.indexOf(second)
  expect(firstIndex).toBeGreaterThanOrEqual(0)
  expect(secondIndex).toBeGreaterThan(firstIndex)
}

describe('unavailable provider renderer admission', () => {
  it('does not turn missing scheduled-seal evidence into a Kimi availability gate', () => {
    const scheduleControls = sourceBetween(
      'const scheduleDisabledReason =',
      'const scheduleControls ='
    )

    expect(scheduleControls).not.toContain("currentProvider === 'kimi'")
    expect(appSource).not.toContain('Scheduled Kimi runs are unavailable')
  })

  // The run-lane duplicate and handoff-dispatch admission checks that used to
  // live here went with the Run rail: `handleDuplicateRunLane` and
  // `handleDispatchHandoff` were the only callers that created a chat from a
  // lane, and both were removed with the dock surface. Every surviving
  // chat-creating path is still asserted below.
  it('blocks direct-copy side chats before creation IPC', () => {
    const sideChat = sourceBetween(
      'const createSideChatFromCurrentChat =',
      'const openLinkedChatInSidePanel ='
    )
    expectBefore(
      sideChat,
      'if (!isRunnableProvider(sideProvider))',
      'await window.api.createSideChat({'
    )
  })

  it('blocks linked-chat runs and new grants before mutation or IPC', () => {
    const sideRun = sourceBetween('const handleSideRun =', 'const cancelRunningScheduledTaskForChat =')
    expectBefore(
      sideRun,
      'if (!isRunnableProvider(sideComposerProvider))',
      'const sideRunAttachments ='
    )
    expect(sideRun).toContain('Choose a currently offered provider for this linked chat.')

    const sideRunEligibility = sourceBetween(
      'const sideComposerProvider =',
      'const sideComposerModelOptionsRaw ='
    )
    expect(sideRunEligibility).toContain('isRunnableProvider(sideComposerProvider)')

    const sideGrant = sourceBetween(
      'const handleSetSideAgenticWorkspaceGrant =',
      'const sideComposerRunTimecodeStartedAt ='
    )
    expectBefore(
      sideGrant,
      'if (enabled && !isRunnableProvider(sideComposerProvider))',
      'await window.api.upsertAgenticWorkspaceGrant('
    )
  })

  it('blocks main-composer new grants for unavailable providers before upsert IPC', () => {
    const mainGrant = sourceBetween(
      'const handleSetAgenticWorkspaceGrant = async (',
      'const handleRemoveAgenticWorkspaceGrant ='
    )
    expectBefore(
      mainGrant,
      'if (enabled && !isRunnableProvider(targetProvider))',
      'await window.api.upsertAgenticWorkspaceGrant('
    )
  })

  it('blocks multiview runs and new grants before renderer mutation or IPC', () => {
    const paneRun = sourceBetween(
      'const handleRunMultiviewPane =',
      'const handleCancelMultiviewPane ='
    )
    expectBefore(
      paneRun,
      'if (!isRunnableProvider(request.provider))',
      'multiview.paneRefs[paneIndex]?.relockToLatest()'
    )
    expectBefore(
      paneRun,
      'if (!isRunnableProvider(request.provider))',
      'queueRunRequestRef.current('
    )
    expect(paneRun).toContain('Choose a currently offered provider for this pane.')

    const paneGrant = sourceBetween(
      'const handleMultiviewPaneToggleGrant =',
      'const handleMultiviewPaneAddWorkspaceFolder ='
    )
    expectBefore(
      paneGrant,
      'if (enabled && !isRunnableProvider(paneProvider))',
      'await window.api.upsertAgenticWorkspaceGrant('
    )
  })
})
