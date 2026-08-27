import { readFileSync } from 'node:fs'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import type { ChatRecord } from '../../../main/store/types'
import {
  THREAD_HOME_RECENT_LIMIT,
  THREAD_HOME_SURFACES,
  ThreadHome,
  buildThreadHomeRecentThreadOptions,
  buildThreadHomeThreadOptions,
  settleThreadHomeCanvasOpen,
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

  it('shows the five newest non-active recents using sidebar recency rules', () => {
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

    expect(THREAD_HOME_RECENT_LIMIT).toBe(5)
    expect(options.map((option) => option.chatId)).toEqual([
      'recent-6',
      'recent-5',
      'recent-4',
      'recent-3',
      'recent-2'
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
        authorityChatId="a"
        mediaCount={4}
        onNewChat={vi.fn()}
        onSelectThread={vi.fn()}
        onSelectSurface={vi.fn()}
        onClosePane={vi.fn()}
        onActivate={vi.fn()}
      />
    )

    expect(html).toContain('aria-label="Thread Home"')
    expect(html.indexOf('New Chat')).toBeLessThan(html.indexOf('Alpha'))
    expect(html.indexOf('Alpha')).toBeLessThan(html.indexOf('Recents'))
    expect(html.indexOf('Recents')).toBeLessThan(html.indexOf('Beta'))
    expect(html).toContain('Alpha')
    expect(html).toContain('class="thread-home-list-heading" role="heading" aria-level="3"')
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
  })

  it('keeps presets visible but disabled without thread authority', () => {
    const html = renderToStaticMarkup(
      <ThreadHome
        variant="main"
        threads={[]}
        recentThreads={[]}
        onNewChat={vi.fn()}
        onSelectThread={vi.fn()}
        onSelectSurface={vi.fn()}
      />
    )
    expect(html).toContain('aria-label="New Chat"')
    expect(html).toContain('No active threads right now.')
    expect(html).toContain('No recent threads yet.')
    expect((html.match(/disabled=""/g) || []).length).toBe(THREAD_HOME_SURFACES.length)
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
      '.thread-home-surface-card:hover:not(:disabled),\n.thread-home-thread-row:hover {'
    )
    expect(css).toContain("[data-reduce-motion='true'] .thread-home-thread-row:hover")
    expect(css).not.toContain('color-mix(in srgb, var(--accent) 9%, var(--surface-2))')
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
})
