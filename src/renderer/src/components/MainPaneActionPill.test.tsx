import { createRef } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'

import {
  FX_MENU_ITEMS,
  INFO_MENU_ITEMS,
  MAIN_PANE_PRIMARY_ACTION_IDS,
  MainPaneActionPill
} from './MainPaneActionPill'

const noop = (): void => undefined

function renderPill(popoutMenuOpen = false): string {
  return renderToStaticMarkup(
    <MainPaneActionPill
      fxEnabled
      skyEnabled={false}
      ghostEnabled={false}
      onToggleSky={noop}
      onToggleGhost={noop}
      changelogOpen={false}
      firstLaunchOpen={false}
      bugReportOpen={false}
      onToggleChangelog={noop}
      onToggleFirstLaunch={noop}
      onToggleBugReport={noop}
      popoutMenuOpen={popoutMenuOpen}
      setPopoutMenuOpen={vi.fn()}
      popoutMenuRef={createRef<HTMLDivElement>()}
      canOpenWorkspacePopout
      hasCurrentChat
      onOpenWorkbench={noop}
      onOpenDiffStudio={noop}
      onOpenFileEditor={noop}
      onOpenChatPopout={noop}
      runOpen={false}
      onToggleRun={noop}
      homeOpen={false}
      onToggleHome={noop}
    />
  )
}

describe('MainPaneActionPill', () => {
  it('renders exactly five primary actions in the requested order', () => {
    const html = renderPill()
    const actionIds = Array.from(
      html.matchAll(/data-main-pane-action="([^"]+)"/g),
      (match) => match[1]
    )

    expect(actionIds).toEqual([...MAIN_PANE_PRIMARY_ACTION_IDS])
    expect(html.match(/<button/g)).toHaveLength(5)
    expect(html).toContain('aria-label="Choose visual effects"')
    expect(html).toContain('aria-label="Choose product information"')
    expect(html).toContain('aria-label="Open popout tools"')
    expect(html).toContain('aria-label="Toggle Run rail"')
    expect(html).toContain('aria-label="Toggle sidebar home"')
  })

  it('defines the exact FX and Info picker contents', () => {
    expect(FX_MENU_ITEMS.map((item) => item.label)).toEqual(['Weather/Sky', 'Ghost'])
    expect(INFO_MENU_ITEMS.map((item) => item.label)).toEqual([
      'Changelog',
      'First Launch',
      'Bug Report'
    ])
  })

  it('preserves all existing Pop Out destinations', () => {
    const html = renderPill(true)

    expect(html).toContain('aria-label="Popout tools"')
    expect(html).toContain('>Workbench<')
    expect(html).toContain('>Diff Studio<')
    expect(html).toContain('>File Editor<')
    expect(html).toContain('>Pop-Out Chat<')
    expect(html.match(/role="menuitem"/g)).toHaveLength(4)
  })
})
