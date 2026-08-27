import { readFileSync } from 'node:fs'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import type { ChatRecord } from '../../../main/store/types'
import { THREAD_HOME_SURFACES, ThreadHome, buildThreadHomeThreadOptions } from './ThreadHome'

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
  it('orders visible panes before additional running threads and deduplicates them', () => {
    const options = buildThreadHomeThreadOptions({
      chats: [chat('a', 'Alpha'), chat('b', 'Beta'), chat('c', 'Gamma')],
      paneChatIds: ['b', 'a', null],
      runningChatIds: ['a', 'c'],
      authorityChatId: 'b'
    })

    expect(options.map((option) => option.chatId)).toEqual(['b', 'a', 'c'])
    expect(options[0]).toMatchObject({ title: 'Beta', paneIndex: 0, running: false })
    expect(options[1]).toMatchObject({ title: 'Alpha', paneIndex: 1, running: true })
    expect(options[2]).toMatchObject({ title: 'Gamma', running: true })
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
            paneIndex: 1
          }
        ]}
        authorityChatId="a"
        authorityLabel="Alpha"
        mediaCount={4}
        onSelectThread={vi.fn()}
        onSelectSurface={vi.fn()}
        onClosePane={vi.fn()}
      />
    )

    expect(html).toContain('Thread Home')
    expect(html).toContain('Alpha')
    expect(html).toContain('Pane 2')
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
      <ThreadHome variant="main" threads={[]} onSelectThread={vi.fn()} onSelectSurface={vi.fn()} />
    )
    expect(html).toContain('Select a thread first')
    expect((html.match(/disabled=""/g) || []).length).toBe(THREAD_HOME_SURFACES.length)
  })

  it('does not route through or mutate the right dock', () => {
    const source = readFileSync(new URL('./ThreadHome.tsx', import.meta.url), 'utf8')
    expect(source).not.toContain('activateRightDock')
    expect(source).not.toContain('setRightDock')
    expect(source).not.toContain("presentation: 'dock'")
  })
})
