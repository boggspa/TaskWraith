import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import type { ChatRecord } from '../../../main/store/types'
import { findClickableByClassName } from '../test/reactElementTree'
import { SubThreadStatusTicker } from './SubThreadStatusTicker'

const chat = (overrides: Partial<ChatRecord> = {}): ChatRecord =>
  ({
    appChatId: 'parent-1',
    provider: 'claude',
    title: 'Parent',
    messages: [],
    runs: [],
    ...overrides
  }) as ChatRecord

describe('SubThreadStatusTicker', () => {
  it('renders nothing when the active chat has no running sub-threads', () => {
    const parent = chat()
    const leaf = chat({
      appChatId: 'leaf-1',
      parentChatId: parent.appChatId,
      parentChatRelation: 'subThread',
      provider: 'codex',
      title: 'Idle child'
    })

    expect(
      renderToStaticMarkup(
        <SubThreadStatusTicker
          currentChat={parent}
          chats={[parent, leaf]}
          runningChatIds={[]}
          onOpenSubThread={() => {}}
        />
      )
    ).toBe('')

    expect(
      renderToStaticMarkup(
        <SubThreadStatusTicker
          currentChat={leaf}
          chats={[parent, leaf]}
          runningChatIds={[leaf.appChatId]}
          onOpenSubThread={() => {}}
        />
      )
    ).toBe('')
  })

  it('renders an active-child strip for a parent with a running sub-thread', () => {
    const parent = chat({ provider: 'claude', title: 'Parent orchestration' })
    const child = chat({
      appChatId: 'child-1',
      parentChatId: parent.appChatId,
      parentChatRelation: 'subThread',
      provider: 'codex',
      title: 'Build agent'
    })

    const html = renderToStaticMarkup(
      <SubThreadStatusTicker
        currentChat={parent}
        chats={[parent, child]}
        runningChatIds={[child.appChatId]}
        onOpenSubThread={() => {}}
      />
    )

    expect(html).toContain('subthread-status-ticker')
    expect(html).toContain('orchestrating')
    expect(html).toContain('sub-thread active')
    expect(html).toContain('Claude')
    expect(html).toContain('Codex')
    expect(html).toContain('title="Build agent"')
  })

  it('navigates to the sub-thread when the active strip is clicked', () => {
    const parent = chat()
    const child = chat({
      appChatId: 'child-nav',
      parentChatId: parent.appChatId,
      parentChatRelation: 'subThread',
      provider: 'grok',
      title: 'Nav child'
    })
    const onOpenSubThread = vi.fn()

    const tree = SubThreadStatusTicker({
      currentChat: parent,
      chats: [parent, child],
      runningChatIds: [child.appChatId],
      onOpenSubThread
    })

    findClickableByClassName(tree, 'subthread-status-ticker-item').props.onClick?.()

    expect(onOpenSubThread).toHaveBeenCalledWith('child-nav')
  })
})
