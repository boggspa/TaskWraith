import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createRef } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'

import {
  FX_MENU_ITEMS,
  INFO_MENU_ITEMS,
  MAIN_PANE_GLASS_POPOVER_CLASS,
  MAIN_PANE_PRIMARY_ACTION_IDS,
  MainPaneActionPill
} from './MainPaneActionPill'

const noop = (): void => undefined

function renderPill(
  popoutMenuOpen = false,
  idScope?: string,
  workspace = true,
  includeClose = true
): string {
  return renderToStaticMarkup(
    <MainPaneActionPill
      idScope={idScope}
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
      workspaceStats={
        workspace
          ? {
              chatId: 'chat-1',
              baseWorkspacePath: '/repo',
              workspacePath: '/repo',
              label: 'repo',
              snapshot: null
            }
          : undefined
      }
      popoutMenuOpen={popoutMenuOpen}
      setPopoutMenuOpen={vi.fn()}
      popoutMenuRef={createRef<HTMLDivElement>()}
      canOpenWorkspacePopout
      hasCurrentChat
      onOpenWorkbench={noop}
      onOpenDiffStudio={noop}
      onOpenFileEditor={noop}
      onOpenChatPopout={noop}
      onOpenCompactCompanion={noop}
      runTitle="Start local server"
      runMenuOpen={false}
      runHasMenu={false}
      runDisabled={false}
      onRun={noop}
      homeOpen={false}
      onToggleHome={noop}
      onCloseThread={includeClose ? noop : undefined}
    />
  )
}

describe('MainPaneActionPill', () => {
  it('renders exactly seven primary actions for a workspace pane in the requested order', () => {
    const html = renderPill()
    const actionIds = Array.from(
      html.matchAll(/data-main-pane-action="([^"]+)"/g),
      (match) => match[1]
    )

    expect(actionIds).toEqual([...MAIN_PANE_PRIMARY_ACTION_IDS])
    expect(html.match(/<button/g)).toHaveLength(7)
    expect(html).toContain('aria-label="Choose visual effects"')
    expect(html).toContain('aria-label="Choose product information"')
    expect(html).toContain('aria-label="Open Workspace Stats"')
    expect(html).toContain('aria-label="Open popout tools"')
    expect(html).toContain('aria-label="Run build or preview"')
    expect(html).toContain('aria-label="Toggle sidebar home"')
    expect(html).toContain('aria-label="Close thread view"')
  })

  it('omits Workspace Stats from global or otherwise unbound panes', () => {
    const html = renderPill(false, undefined, false)
    const actionIds = Array.from(
      html.matchAll(/data-main-pane-action="([^"]+)"/g),
      (match) => match[1]
    )

    expect(actionIds).toEqual(['fx', 'info', 'popout', 'run', 'home', 'close'])
    expect(html).not.toContain('aria-label="Open Workspace Stats"')
  })

  it('omits the close segment when the owning surface has no close action', () => {
    const html = renderPill(false, undefined, true, false)
    expect(html).not.toContain('data-main-pane-action="close"')
    expect(html).not.toContain('aria-label="Close thread view"')
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
    expect(html).toContain(`class="${MAIN_PANE_GLASS_POPOVER_CLASS} chat-popout-menu"`)
    expect(html).toContain('>Workbench<')
    expect(html).toContain('>Diff Studio<')
    expect(html).toContain('>File Editor<')
    expect(html).toContain('>Pop-Out Chat<')
    expect(html).toContain('>Compact Companion<')
    expect(html.match(/role="menuitem"/g)).toHaveLength(5)
  })

  it('uses the app-wide glass popover chrome for every top-right picker', () => {
    expect(MAIN_PANE_GLASS_POPOVER_CLASS.split(' ')).toEqual([
      'side-chat-layout-menu',
      'composer-combined-picker-popover'
    ])
  })

  it('portals Workspace Stats beyond the pill backdrop root without replacing its material', () => {
    const componentRoot = join(process.cwd(), 'src/renderer/src/components')
    const component = readFileSync(join(componentRoot, 'MainPaneActionPill.tsx'), 'utf8')
    const popover = readFileSync(join(componentRoot, 'WorkspaceStatsPopover.tsx'), 'utf8')
    const css = readFileSync(
      join(process.cwd(), 'src/renderer/src/assets/css/31-workspace-stats.css'),
      'utf8'
    )

    expect(component).toContain('createPortal(workspaceStatsPopover, document.body)')
    expect(popover).toContain(
      'side-chat-layout-menu composer-combined-picker-popover workspace-stats-popover'
    )
    expect(css).toMatch(/\.workspace-stats-popover-host\s*\{[^}]*position: fixed;/s)
    expect(css).not.toContain('.chat-corner-controls > .workspace-stats-popover-host')
  })

  it('scopes trigger and menu ids when several pane pills are mounted', () => {
    const html = renderPill(false, 'multiview-pane-2')

    expect(html).toContain('id="multiview-pane-2-fx-trigger"')
    expect(html).toContain('aria-controls="multiview-pane-2-fx-menu"')
    expect(html).toContain('id="multiview-pane-2-info-trigger"')
    expect(html).toContain('aria-controls="multiview-pane-2-info-menu"')
    expect(html).toContain('id="multiview-pane-2-workspace-stats-trigger"')
    expect(html).toContain('aria-controls="multiview-pane-2-workspace-stats-popover"')
    expect(html).not.toContain('id="chat-corner-fx-trigger"')
  })
})
