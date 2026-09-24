import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import type { ChatListItem, ChatRecord, ChatMessage } from '../../../main/store/types'
import { getChatContentMatchSnippet, SidebarChatTitleEditable } from './SidebarChatTitleEditable'

function makeChat(overrides: Partial<ChatRecord> = {}): ChatRecord {
  return {
    appChatId: 'chat-1',
    title: 'Design notes',
    createdAt: 1,
    updatedAt: 1,
    archived: false,
    messages: [],
    ...overrides
  } as ChatRecord
}

function makeMessage(overrides: Partial<ChatMessage> & { content: string }): ChatMessage {
  const { content, ...rest } = overrides
  return {
    id: 'm-1',
    role: 'user',
    content,
    createdAt: 1,
    ...rest
  } as ChatMessage
}

const noop = {
  onStartEdit: vi.fn(),
  onSubmit: vi.fn(),
  onCancel: vi.fn()
}

describe('SidebarChatTitleEditable view mode', () => {
  it('renders the title in the provided class without an input', () => {
    const html = renderToStaticMarkup(
      <SidebarChatTitleEditable
        chat={makeChat({ title: 'Design notes' })}
        className="sidebar-chat-title"
        query=""
        isEditing={false}
        {...noop}
      />
    )

    expect(html).toContain('class="sidebar-chat-title"')
    expect(html).toContain('Design notes')
    expect(html).not.toContain('<input')
    expect(html).not.toContain('sidebar-chat-title-input')
  })

  it('highlights a title match without showing a conversation snippet', () => {
    const html = renderToStaticMarkup(
      <SidebarChatTitleEditable
        chat={makeChat({
          title: 'Design notes',
          messages: [makeMessage({ content: 'Design notes live in the thread' })]
        })}
        className="sidebar-recents-label"
        query="design"
        isEditing={false}
        {...noop}
      />
    )

    expect(html).toContain('<mark class="sidebar-search-highlight">Design</mark>')
    expect(html).toContain(' notes')
    expect(html).not.toContain('sidebar-search-content-match')
    expect(html).not.toContain('<input')
  })
})

describe('SidebarChatTitleEditable edit mode', () => {
  it('renders a pre-filled rename input instead of the title highlight', () => {
    const html = renderToStaticMarkup(
      <SidebarChatTitleEditable
        chat={makeChat({ title: 'Design notes' })}
        className="sidebar-pinned-label"
        query="design"
        isEditing={true}
        {...noop}
      />
    )

    expect(html).toContain('class="sidebar-pinned-label"')
    expect(html).toContain('class="sidebar-chat-title-input"')
    expect(html).toContain('aria-label="Rename chat"')
    expect(html).toContain('value="Design notes"')
    expect(html).not.toContain('<mark')
    expect(html).not.toContain('sidebar-search-content-match')
  })
})

describe('SidebarChatTitleEditable snippet highlight', () => {
  it('shows a highlighted conversation snippet when only the body matches', () => {
    const html = renderToStaticMarkup(
      <SidebarChatTitleEditable
        chat={makeChat({
          title: 'Design notes',
          messages: [makeMessage({ content: 'the widget factory is broken' })]
        })}
        className="sidebar-chat-title"
        query="widget"
        isEditing={false}
        {...noop}
      />
    )

    expect(html).toContain('class="sidebar-chat-subline sidebar-search-content-match"')
    expect(html).toContain('title="Match in conversation: the widget factory is broken"')
    expect(html).toContain('<mark class="sidebar-search-highlight">widget</mark>')
    expect(html).toContain('Design notes')
    expect(html).not.toContain('<input')
  })
})

describe('getChatContentMatchSnippet', () => {
  it('returns null when there is no query or the title already matches', () => {
    const chat = makeChat({
      title: 'Design notes',
      messages: [makeMessage({ content: 'the widget factory is broken' })]
    })
    expect(getChatContentMatchSnippet(chat, '')).toBeNull()
    expect(getChatContentMatchSnippet(chat, 'design')).toBeNull()
  })

  it('prefers searchPreview and skips channel-inbound messages', () => {
    const withPreview = {
      ...makeChat({ title: 'Design notes' }),
      searchPreview: 'found the widget here'
    } as ChatRecord & Pick<ChatListItem, 'searchPreview'>
    expect(getChatContentMatchSnippet(withPreview, 'widget')).toBe('found the widget here')

    const inboundThenUser = makeChat({
      title: 'Design notes',
      messages: [
        makeMessage({
          id: 'm-in',
          content: 'inbound widget noise',
          metadata: { kind: 'channelInbound' }
        }),
        makeMessage({ id: 'm-user', content: 'user mentioned widget later' })
      ]
    })
    expect(getChatContentMatchSnippet(inboundThenUser, 'widget')).toBe(
      'user mentioned widget later'
    )
  })

  it('centers a long body match with ellipses', () => {
    const prefix = 'AAAAAAAAAAAAAAAABBBBBBBBBBBBBB'
    const suffix = 'CCCCCCCCCCCCCCCCDDDDDDDDDDDDDD'
    const chat = makeChat({
      title: 'Design notes',
      messages: [makeMessage({ content: `${prefix}widget${suffix}` })]
    })
    const snippet = getChatContentMatchSnippet(chat, 'widget')
    expect(snippet).toBe(`…${prefix.slice(-24)}widget${suffix.slice(0, 24)}…`)
  })
})
