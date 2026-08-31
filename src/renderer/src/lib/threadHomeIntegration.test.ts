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
    const layoutSelectStart = appSource.indexOf('const handleSelectMultiviewLayout = useCallback')
    const layoutSelectEnd = appSource.indexOf(
      'const workspaceSidebarToggleButton',
      layoutSelectStart
    )
    expect(appSource.slice(layoutSelectStart, layoutSelectEnd)).toContain(
      'setThreadHomeOpen(false)'
    )
    expect(layoutSource).toContain('threadHomeOpen && !isMultiviewSplit ? (')
    expect(layoutSource).toContain('<ThreadHomeWorkspace')
    expect(layoutSource).toContain('variant="main"')
    expect(layoutSource).toContain('variant="pane"')
    expect(layoutSource).toContain('runningChatIds={runningChatIdsArray}')
    expect(layoutSource).toContain('mediaRefs={currentChatMediaRefs}')
    expect(layoutSource).toContain('multiviewLayout={multiview.layout}')
    expect(layoutSource).toContain(
      'onSelectMultiviewLayout={composerCtx?.handleSelectMultiviewLayout}'
    )
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

  it('routes the primary glass-pill dismiss to Thread Home without collapsing MultiView', () => {
    const dismissStart = layoutSource.indexOf('const dismissPrimaryMultiviewPane =')
    const dismissEnd = layoutSource.indexOf(
      'const requestMainPaneWorkspaceStats',
      dismissStart
    )
    const dismiss = layoutSource.slice(dismissStart, dismissEnd)
    expect(dismiss).toContain('multiview.setPaneChat(primaryPaneIndex, null)')
    expect(dismiss).not.toContain('multiview.closePane')

    const pillStart = layoutSource.indexOf('<MainPaneActionPill\n')
    const pillEnd = layoutSource.indexOf('/>', pillStart)
    const pill = layoutSource.slice(pillStart, pillEnd)
    expect(pill).toContain('onCloseThread={')
    expect(pill).toContain('? dismissPrimaryMultiviewPane')
    expect(pill).toContain('mainThreadHomeWorkspaceRef.current?.closeCurrentPane()')
    expect(pill).toContain(': openThreadHome')
    expect(pill).not.toContain('closeThreadDisabled=')
    expect(pill).toContain("? 'Dismiss pane to Thread Home'")

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
