import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const appSource = readFileSync(new URL('../App.tsx', import.meta.url), 'utf8')
const layoutSource = readFileSync(
  new URL('../app/views/MainAppLayout.tsx', import.meta.url),
  'utf8'
)

describe('Thread Home integration', () => {
  it('opens non-destructively and closes whenever a thread is selected', () => {
    const stateStart = appSource.indexOf('const [threadHomeOpen, setThreadHomeOpen]')
    const stateEnd = appSource.indexOf('// Error handling', stateStart)
    const stateWiring = appSource.slice(stateStart, stateEnd)
    expect(stateWiring).toContain('threadHomeSourceChatIdRef.current = chatId')
    expect(stateWiring).toContain('setThreadHomeOpen(true)')
    expect(stateWiring).not.toContain('deleteChat')
    expect(stateWiring).not.toContain('archived')
    expect(stateWiring).not.toContain('setCurrentChat(null)')

    const selectStart = appSource.indexOf('const handleSelectChat = async')
    const selectEnd = appSource.indexOf('const handleSelectChatRef', selectStart)
    expect(appSource.slice(selectStart, selectEnd)).toContain('setThreadHomeOpen(false)')
  })

  it('replaces the single transcript/composer with Thread Home and keeps pane homes independent', () => {
    expect(layoutSource).toContain('threadHomeOpen && !isMultiviewSplit ? (')
    expect(layoutSource).toContain('<ThreadHomeWorkspace')
    expect(layoutSource).toContain('variant="main"')
    expect(layoutSource).toContain('variant="pane"')
    expect(layoutSource).toContain('runningChatIds={runningChatIdsArray}')
    expect(layoutSource).toContain('mediaRefs={currentChatMediaRefs}')
    expect(layoutSource).toContain('onNewChat={startNewThreadFromHome}')
    expect(layoutSource).toContain('handleNewDefaultGlobalChat?.()')
  })

  it('shares welcome activity slots with full Thread Home but keeps its dashboard welcome-only', () => {
    expect(appSource).toContain('isThreadHomeOpen: threadHomeOpen')
    expect(appSource).toContain('const isWelcomeOrThreadHome = isWelcomeChat || threadHomeOpen')
    expect(layoutSource).toContain('const threadHomeOverviewSections = threadHomeOpen')
    expect(layoutSource).not.toContain('dashboard: sharedUsageDashboard')
    expect(layoutSource).toContain(
      '<WelcomeHeatmaps slots={composerCtx.welcomeHeatmapSlots} layout="single" />'
    )
    expect(layoutSource).toContain(
      '{shouldShowWelcomeUsageDashboard && welcomeDashboardCardEnabled && ('
    )
    expect(layoutSource).toContain('overviewSections={threadHomeOverviewSections}')
  })

  it('routes close through the glass pill and retires the old floating pane close button', () => {
    const pillStart = layoutSource.indexOf('<MainPaneActionPill\n')
    const pillEnd = layoutSource.indexOf('/>', pillStart)
    const pill = layoutSource.slice(pillStart, pillEnd)
    expect(pill).toContain('onCloseThread={')
    expect(pill).toContain('? () => multiview.closePane(multiview.focusedPaneIndex)')
    expect(pill).toContain('mainThreadHomeWorkspaceRef.current?.closeCurrentPane()')
    expect(pill).toContain(': openThreadHome')
    expect(pill).not.toContain('closeThreadDisabled=')
    expect(pill).toContain(
      "isMultiviewSplit || threadHomeOpen ? 'Close pane' : 'Close thread view'"
    )

    const mainHomeStart = layoutSource.indexOf('<ThreadHomeWorkspace', pillEnd)
    const mainHomeEnd = layoutSource.indexOf('/>', mainHomeStart)
    expect(layoutSource.slice(mainHomeStart, mainHomeEnd)).toContain(
      'ref={mainThreadHomeWorkspaceRef}'
    )

    const gridStart = layoutSource.indexOf('<MultiviewPaneGrid')
    const gridTracks = layoutSource.indexOf('columnFractions=', gridStart)
    expect(layoutSource.slice(gridStart, gridTracks)).not.toContain('onClosePane=')
  })
})
