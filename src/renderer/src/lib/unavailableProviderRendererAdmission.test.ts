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
  it('blocks direct-copy side chats, run lanes, and handoffs before creation IPC', () => {
    const sideChat = sourceBetween(
      'const createSideChatFromCurrentChat =',
      'const openLinkedChatInSidePanel ='
    )
    expectBefore(
      sideChat,
      'if (!isLiveSelectableProvider(sideProvider))',
      'await window.api.createSideChat({'
    )

    const duplicate = sourceBetween(
      'const handleDuplicateRunLane =',
      'const handleCreateHandoffFromLane ='
    )
    expectBefore(
      duplicate,
      'if (!isLiveSelectableProvider(provider))',
      'await window.api.createGlobalChat()'
    )

    const handoff = sourceBetween(
      'const handleDispatchHandoff =',
      'const handleArchiveHandoff ='
    )
    expectBefore(
      handoff,
      'if (!isLiveSelectableProvider(provider))',
      'await window.api.createGlobalChat()'
    )
  })

  it('blocks linked-chat runs and new grants before mutation or IPC', () => {
    const sideRun = sourceBetween('const handleSideRun =', 'const cancelRunningScheduledTaskForChat =')
    expectBefore(
      sideRun,
      'if (!isLiveSelectableProvider(sideComposerProvider))',
      'const sideRunAttachments ='
    )
    expect(sideRun).toContain('Switch this linked chat to a live provider to continue.')

    const sideRunEligibility = sourceBetween(
      'const sideComposerProvider =',
      'const sideComposerModelOptionsRaw ='
    )
    expect(sideRunEligibility).toContain('isLiveSelectableProvider(sideComposerProvider)')

    const sideGrant = sourceBetween(
      'const handleSetSideAgenticWorkspaceGrant =',
      'const sideComposerRunTimecodeStartedAt ='
    )
    expectBefore(
      sideGrant,
      'if (enabled && !isLiveSelectableProvider(sideComposerProvider)) return',
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
      'if (!isLiveSelectableProvider(request.provider))',
      'multiview.paneRefs[paneIndex]?.relockToLatest()'
    )
    expectBefore(
      paneRun,
      'if (!isLiveSelectableProvider(request.provider))',
      'queueRunRequestRef.current('
    )
    expect(paneRun).toContain('Switch this pane to a live provider to continue.')

    const paneGrant = sourceBetween(
      'const handleMultiviewPaneToggleGrant =',
      'const handleMultiviewPaneAddWorkspaceFolder ='
    )
    expectBefore(
      paneGrant,
      'if (enabled && !isLiveSelectableProvider(paneProvider)) return',
      'await window.api.upsertAgenticWorkspaceGrant('
    )
  })
})
