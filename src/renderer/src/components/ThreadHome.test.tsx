import { readFileSync } from 'node:fs'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import type { ChatRecord, WorkspaceRecord } from '../../../main/store/types'
import {
  THREAD_HOME_RECENT_LIMIT,
  THREAD_HOME_SURFACES,
  ThreadHome,
  ThreadHomeTerminalWorkspacePicker,
  buildThreadHomeRecentThreadOptions,
  buildThreadHomeThreadOptions,
  settleThreadHomeCanvasOpen,
  settleThreadHomeTerminalOpen,
  type ThreadHomeCanvasOpenResult
} from './ThreadHome'

const chat = (id: string, title: string, provider: ChatRecord['provider'] = 'codex'): ChatRecord =>
  ({
    appChatId: id,
    title,
    provider,
    scope: 'workspace',
    workspacePath: `/work/${id}`,
    createdAt: 1,
    updatedAt: 1,
    messages: []
  }) as unknown as ChatRecord

const missionControl = {
  phase: 'Live' as const,
  summary: '3 active · 12 participants · 2 channels'
}

const workspace = (id: string, displayName: string, path: string): WorkspaceRecord => ({
  id,
  displayName,
  path,
  lastOpenedAt: 1,
  createdAt: 1,
  pinned: false
})

describe('buildThreadHomeThreadOptions', () => {
  it('shows only running threads in live order and uses panes only as annotations', () => {
    const options = buildThreadHomeThreadOptions({
      chats: [chat('a', 'Alpha'), chat('b', 'Beta'), chat('c', 'Gamma')],
      paneChatIds: ['b', 'a', null],
      runningChatIds: ['a', 'c']
    })

    expect(options.map((option) => option.chatId)).toEqual(['a', 'c'])
    expect(options[0]).toMatchObject({ title: 'Alpha', paneIndex: 1, running: true })
    expect(options[1]).toMatchObject({ title: 'Gamma', running: true })
  })

  it('drops archived and missing records', () => {
    const archived = { ...chat('a', 'Archived'), archived: true }
    expect(
      buildThreadHomeThreadOptions({
        chats: [archived],
        paneChatIds: ['a', 'missing'],
        runningChatIds: ['a', 'missing']
      })
    ).toEqual([])
  })

  it('shows the six newest non-active recents using sidebar recency rules', () => {
    const chats = Array.from({ length: 9 }, (_, index) => ({
      ...chat(`recent-${index + 1}`, `Recent ${index + 1}`),
      createdAt: (index + 1) * 100
    }))
    chats[7] = { ...chats[7], pinned: true }
    chats[6] = { ...chats[6], archived: true }

    const options = buildThreadHomeRecentThreadOptions({
      chats,
      runningChatIds: ['recent-9'],
      paneChatIds: ['recent-6']
    })

    expect(THREAD_HOME_RECENT_LIMIT).toBe(6)
    expect(options.map((option) => option.chatId)).toEqual([
      'recent-6',
      'recent-5',
      'recent-4',
      'recent-3',
      'recent-2',
      'recent-1'
    ])
    expect(options[0]).toMatchObject({ running: false, paneIndex: 0 })
  })
})

describe('ThreadHome', () => {
  it('renders active-thread rows and all six requested surface presets', () => {
    const html = renderToStaticMarkup(
      <ThreadHome
        variant="pane"
        threads={[
          {
            chatId: 'a',
            title: 'Alpha',
            provider: 'codex',
            workspaceLabel: 'repo',
            running: true,
            stats: {
              filesChanged: 2,
              additions: 12,
              deletions: 3,
              hasLineStats: true,
              commits: 1
            },
            paneIndex: 1
          }
        ]}
        recentThreads={[
          {
            chatId: 'b',
            title: 'Beta',
            provider: 'claude',
            workspaceLabel: 'other-repo',
            running: false
          }
        ]}
        missionControl={missionControl}
        authorityChatId="a"
        mediaCount={4}
        onNewChat={vi.fn()}
        onSelectThread={vi.fn()}
        onSelectSurface={vi.fn()}
        onOpenMissionControl={vi.fn()}
        onOpenTerminal={vi.fn()}
        onClosePane={vi.fn()}
        onActivate={vi.fn()}
      />
    )

    expect(html).toContain('aria-label="Thread Home"')
    expect(html.indexOf('New Chat')).toBeLessThan(html.indexOf('Open New Terminal'))
    expect(html.indexOf('Open New Terminal')).toBeLessThan(html.indexOf('Mission Control'))
    expect(html.indexOf('Mission Control')).toBeLessThan(html.indexOf('>Active</div>'))
    expect(html.indexOf('Mission Control')).toBeLessThan(html.indexOf('Alpha'))
    expect(html.indexOf('>Active</div>')).toBeLessThan(html.indexOf('Alpha'))
    expect(html.indexOf('Alpha')).toBeLessThan(html.indexOf('>Recents</div>'))
    expect(html.indexOf('Recents')).toBeLessThan(html.indexOf('Beta'))
    expect(html.indexOf('Beta')).toBeLessThan(html.indexOf('>Canvas</div>'))
    expect(html).toContain('Alpha')
    expect(html).toContain('class="thread-home-list-heading" role="heading" aria-level="3"')
    expect((html.match(/thread-home-list-heading/g) || []).length).toBe(3)
    expect(html).toContain('class="sidebar-chat-running"')
    expect(html).toContain('Pane 2')
    expect(html).toContain('class="thread-home-run-stats"')
    expect(html).toContain('2 changed files, 12 additions, 3 deletions, 1 commit')
    expect(html).toContain('composer-git-commit-trigger-icon')
    expect(html).toContain('aria-label="Close empty pane"')
    expect(THREAD_HOME_SURFACES.map((surface) => surface.id)).toEqual([
      'charts',
      'browser',
      'mesh',
      'sketch',
      'media',
      'simulator'
    ])
    for (const surface of THREAD_HOME_SURFACES) {
      expect(html).toContain(surface.label.replace('&', '&amp;'))
      expect(html).toContain(surface.description)
    }
    expect(html).toContain('aria-label="4 media items"')
    expect(html).toContain(
      'aria-label="Open Mission Control. 3 active · 12 participants · 2 channels. Live"'
    )
    expect(html).toContain('thread-home-mission-control-card')
    expect(html).toContain('aria-label="Open New Terminal. Choose a workspace."')
    expect(html).toContain('<strong>New Terminal</strong>')
  })

  it('asks which added workspace should become the terminal cwd', () => {
    const onSelect = vi.fn()
    const workspaces = [
      workspace('alpha', 'Alpha repo', '/work/alpha'),
      workspace('beta', 'Beta repo', '/work/beta')
    ]
    const html = renderToStaticMarkup(
      <ThreadHomeTerminalWorkspacePicker workspaces={workspaces} onSelect={onSelect} />
    )

    expect(html).toContain('aria-label="Choose a terminal workspace"')
    expect(html).toContain('The terminal starts with that workspace as its current directory.')
    expect(html).toContain('Alpha repo')
    expect(html).toContain('/work/alpha')
    expect(html).toContain('Beta repo')
    expect(html).toContain('/work/beta')
    expect(html).toContain('aria-label="Open terminal in Alpha repo, /work/alpha"')
    expect(html).toContain('Select a CLI to load in the workspace-isolated terminal.')

    const empty = renderToStaticMarkup(
      <ThreadHomeTerminalWorkspacePicker workspaces={[]} onSelect={onSelect} />
    )
    expect(empty).toContain('Add a workspace in the sidebar before opening a terminal.')
  })

  it('passes the selected CLI id to main instead of writing a renderer command', () => {
    const source = readFileSync('src/renderer/src/components/ThreadHome.tsx', 'utf8')

    expect(source).toContain('window.api.terminal.create(workspace.path, sessionId, cliId)')
    expect(source).not.toContain('getCommandForCli')
    expect(source).not.toContain('window.api.terminal.write(sessionId, command')
  })

  it('keeps presets visible but disabled without thread authority', () => {
    const html = renderToStaticMarkup(
      <ThreadHome
        variant="main"
        threads={[]}
        recentThreads={[]}
        missionControl={missionControl}
        onNewChat={vi.fn()}
        onSelectThread={vi.fn()}
        onSelectSurface={vi.fn()}
        onOpenMissionControl={vi.fn()}
        onOpenTerminal={vi.fn()}
      />
    )
    expect(html).toContain('aria-label="New Chat"')
    expect(html).toContain('>Active</div>')
    expect(html).not.toContain('No active threads right now.')
    expect(html).toContain('No recent threads yet.')
    expect(html).toContain('>Canvas</div>')
    expect((html.match(/disabled=""/g) || []).length).toBe(THREAD_HOME_SURFACES.length)
  })

  it('adds only the heatmap to the full home without crowding pane homes', () => {
    const render = (variant: 'main' | 'pane') =>
      renderToStaticMarkup(
        <ThreadHome
          variant={variant}
          threads={[]}
          recentThreads={[]}
          missionControl={missionControl}
          overviewSections={{
            heatmaps: <div>Heatmap content</div>
          }}
          onNewChat={vi.fn()}
          onSelectThread={vi.fn()}
          onSelectSurface={vi.fn()}
          onOpenMissionControl={vi.fn()}
          onOpenTerminal={vi.fn()}
        />
      )

    const main = render('main')
    expect(main).toContain('thread-home-scroll--with-overview')
    expect(main).not.toContain('thread-home-dashboard-region')
    expect(main).toContain('aria-label="Activity heatmaps"')
    expect(main.indexOf('New Chat')).toBeLessThan(main.indexOf('Heatmap content'))

    const pane = render('pane')
    expect(pane).not.toContain('Heatmap content')
  })

  it('centres the launcher and heatmap as a scroll-safe lightweight group', () => {
    const css = readFileSync(new URL('../assets/css/43-thread-home.css', import.meta.url), 'utf8')
    expect(css).toContain('.thread-home-scroll--with-overview > .thread-home-section:first-child {')
    expect(css).toContain('margin-top: auto')
    expect(css).toContain('margin: clamp(36px, 5vh, 64px) auto auto')
    expect(css).not.toContain('thread-home-dashboard-region')
    expect(css).not.toContain('thread-home-additions-region')
  })

  it('gives a secondary Thread Home cell an opaque pane surface', () => {
    const css = readFileSync(
      new URL('../assets/css/44-thread-home-multiview.css', import.meta.url),
      'utf8'
    )
    const paneStart = css.indexOf(
      '.thread-home.thread-home--pane,\n.thread-home-surface.thread-home-surface--pane {'
    )
    const paneEnd = css.indexOf('}', paneStart)
    const paneRule = css.slice(paneStart, paneEnd)

    expect(paneRule).toContain(
      'background-color: var(--main-pane-opacity-override-bg, var(--content-bg, #161616))'
    )
    expect(paneRule).toContain('background-image: none')
    expect(paneRule).toContain('backdrop-filter: none')
  })

  it('does not route through or mutate the right dock', () => {
    const source = readFileSync(new URL('./ThreadHome.tsx', import.meta.url), 'utf8')
    expect(source).not.toContain('activateRightDock')
    expect(source).not.toContain('setRightDock')
    expect(source).not.toContain("presentation: 'dock'")
  })

  it('shares one close path between full-pane surface chrome and the glass pill', () => {
    const source = readFileSync(new URL('./ThreadHome.tsx', import.meta.url), 'utf8')
    const css = readFileSync(new URL('../assets/css/43-thread-home.css', import.meta.url), 'utf8')
    const canvasCss = readFileSync(
      new URL('../assets/css/26-canvas-dock.css', import.meta.url),
      'utf8'
    )

    expect(source).toContain('closeCurrentPane: () =>')
    expect(source).toContain('if (surface) {')
    expect(source).toContain('closeSurface()')
    expect(css).toContain('.thread-home-surface--main {')
    expect(css).toContain('padding-top: 70px')
    expect(canvasCss).toContain('.canvas-pane-close {')
    expect(canvasCss).not.toContain('.canvas-dock-panel .canvas-pane-close')
  })

  it('renders every thread row as transparent satellite content with the shared shimmer', () => {
    const css = readFileSync(new URL('../assets/css/43-thread-home.css', import.meta.url), 'utf8')
    const rowStart = css.indexOf('.thread-home-thread-row {')
    const rowEnd = css.indexOf('}', rowStart)
    const rowRule = css.slice(rowStart, rowEnd)

    expect(rowRule).toContain('border: 1px solid transparent')
    expect(rowRule).toContain('background: transparent')
    expect(rowRule).toContain('box-shadow: none')
    expect(rowRule).toContain('backdrop-filter: none')
    expect(css).toContain(
      '.thread-home-surface-card:hover:not(:disabled),\n.thread-home-mission-control-card:hover,\n.thread-home-thread-row:hover {'
    )
    const missionStart = css.indexOf('.thread-home-mission-control-card {')
    const missionEnd = css.indexOf('}', missionStart)
    const missionRule = css.slice(missionStart, missionEnd)
    expect(missionRule).toContain('border: 1px solid transparent')
    expect(missionRule).toContain('background: transparent')
    const missionCardStart = css.indexOf('.thread-home-mission-control-card {', missionEnd)
    const missionCardEnd = css.indexOf('}', missionCardStart)
    const missionCardRule = css.slice(missionCardStart, missionCardEnd)
    expect(missionCardRule).toContain('min-height: 74px')
    expect(missionCardRule).not.toContain('min-height: 148px')
    const metricStart = css.indexOf('.host-mission-control-overview-metrics > div {')
    const metricEnd = css.indexOf('}', metricStart)
    const metricRule = css.slice(metricStart, metricEnd)
    expect(metricRule).toContain('border: 0')
    expect(metricRule).toContain('background: transparent')
    expect(css).toContain("[data-reduce-motion='true'] .thread-home-thread-row:hover")
    expect(css).not.toContain('color-mix(in srgb, var(--accent) 9%, var(--surface-2))')
    const headingStart = css.indexOf('.thread-home-list-heading {')
    const headingEnd = css.indexOf('}', headingStart)
    const headingRule = css.slice(headingStart, headingEnd)
    expect(headingRule).toContain("'Avenir Next'")
    expect(headingRule).toContain('letter-spacing: -0.01em')
    expect(headingRule).toContain('text-transform: none')
    expect(css).toContain('.thread-home-thread-row .sidebar-chat-running {')
  })

  it('closes a successful embedded Canvas that resolves after its host unmounts', async () => {
    let resolveRequest: (result: ThreadHomeCanvasOpenResult) => void = () => undefined
    const request = new Promise<ThreadHomeCanvasOpenResult>((resolve) => {
      resolveRequest = resolve
    })
    let current = true
    const onAccepted = vi.fn()
    const onRejected = vi.fn()
    const onDiscarded = vi.fn()
    const settling = settleThreadHomeCanvasOpen({
      request,
      isCurrent: () => current,
      fallbackError: 'Could not open Canvas.',
      onAccepted,
      onRejected,
      onDiscarded
    })

    current = false
    resolveRequest({
      ok: true,
      canvasId: 'late-canvas',
      url: 'https://example.com',
      title: 'Late Canvas'
    })
    await settling

    expect(onDiscarded).toHaveBeenCalledWith('late-canvas')
    expect(onAccepted).not.toHaveBeenCalled()
    expect(onRejected).not.toHaveBeenCalled()
  })

  it('kills a terminal session that finishes opening after Thread Home moved on', async () => {
    let resolveRequest: () => void = () => undefined
    const request = new Promise<void>((resolve) => {
      resolveRequest = resolve
    })
    let current = true
    const onAccepted = vi.fn()
    const onRejected = vi.fn()
    const onDiscarded = vi.fn()
    const settling = settleThreadHomeTerminalOpen({
      request,
      sessionId: 'late-terminal',
      isCurrent: () => current,
      onAccepted,
      onRejected,
      onDiscarded
    })

    current = false
    resolveRequest()
    await settling

    expect(onDiscarded).toHaveBeenCalledWith('late-terminal')
    expect(onAccepted).not.toHaveBeenCalled()
    expect(onRejected).not.toHaveBeenCalled()
  })
})
