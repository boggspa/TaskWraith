import { describe, expect, it } from 'vitest'

import {
  hasConversationContent,
  isReusableWelcomeChat,
  shouldRenderWelcome,
  type ReusableChatLike,
  type WelcomeChatLike,
  type WelcomeMessageLike
} from './welcomeState'

const chat: WelcomeChatLike = { appChatId: 'chat-1' }

describe('hasConversationContent', () => {
  it('returns false for an empty message list', () => {
    expect(hasConversationContent([])).toBe(false)
  })

  it('returns true when an assistant message exists', () => {
    expect(hasConversationContent([{ role: 'assistant' }])).toBe(true)
  })

  it('returns true when a user message exists', () => {
    expect(hasConversationContent([{ role: 'user' }])).toBe(true)
  })

  it('returns true when a tool message exists', () => {
    expect(hasConversationContent([{ role: 'tool' }])).toBe(true)
  })

  it('returns true when an error message exists', () => {
    expect(hasConversationContent([{ role: 'error' }])).toBe(true)
  })

  it('returns false for system-only messages', () => {
    expect(hasConversationContent([{ role: 'system' }, { role: 'system' }])).toBe(false)
  })

  it('detects content in the last position of a long list', () => {
    const messages: WelcomeMessageLike[] = [
      { role: 'system' },
      { role: 'system' },
      { role: 'system' },
      { role: 'assistant' }
    ]
    expect(hasConversationContent(messages)).toBe(true)
  })
})

describe('shouldRenderWelcome', () => {
  it('returns false when no chat is selected', () => {
    expect(
      shouldRenderWelcome({
        currentChat: null,
        messages: [],
        isCurrentChatRunning: false
      })
    ).toBe(false)
  })

  it('returns true when the chat exists, has no conversation content, and is idle', () => {
    expect(
      shouldRenderWelcome({
        currentChat: chat,
        messages: [],
        isCurrentChatRunning: false
      })
    ).toBe(true)
  })

  it('treats a chat with only a system message as a welcome candidate', () => {
    expect(
      shouldRenderWelcome({
        currentChat: chat,
        messages: [{ role: 'system' }],
        isCurrentChatRunning: false
      })
    ).toBe(true)
  })

  it('hides the welcome surface for a summary-only chat with persisted messages', () => {
    expect(
      shouldRenderWelcome({
        currentChat: { appChatId: 'chat-2', summaryOnly: true, messageCount: 3, runCount: 1 },
        messages: [],
        isCurrentChatRunning: false
      })
    ).toBe(false)
  })

  it('hides the welcome surface for a summary-only linked child while it hydrates', () => {
    expect(
      shouldRenderWelcome({
        currentChat: {
          appChatId: 'subthread-1',
          parentChatId: 'parent-1',
          summaryOnly: true,
          messageCount: 0,
          runCount: 0
        },
        messages: [],
        isCurrentChatRunning: false
      })
    ).toBe(false)
  })

  it('hides the welcome surface for a linked child even after hydration', () => {
    expect(
      shouldRenderWelcome({
        currentChat: { appChatId: 'subthread-2', parentChatId: 'parent-1' },
        messages: [],
        isCurrentChatRunning: false
      })
    ).toBe(false)
  })

  it('hides the welcome surface when the chat has assistant content', () => {
    expect(
      shouldRenderWelcome({
        currentChat: chat,
        messages: [{ role: 'assistant' }],
        isCurrentChatRunning: false
      })
    ).toBe(false)
  })

  it('hides the welcome surface when the chat has only a tool activity row', () => {
    // Tool-only chats (e.g. a Kimi chat whose first turn was a shell
    // command before any assistant prose streamed in) must not render
    // welcome over the running transcript.
    expect(
      shouldRenderWelcome({
        currentChat: chat,
        messages: [{ role: 'tool' }],
        isCurrentChatRunning: false
      })
    ).toBe(false)
  })

  it('hides the welcome surface when the chat is currently running', () => {
    expect(
      shouldRenderWelcome({
        currentChat: chat,
        messages: [],
        isCurrentChatRunning: true
      })
    ).toBe(false)
  })

  it('still hides welcome when the chat has both content and is running', () => {
    expect(
      shouldRenderWelcome({
        currentChat: chat,
        messages: [{ role: 'user' }],
        isCurrentChatRunning: true
      })
    ).toBe(false)
  })
})

describe('isReusableWelcomeChat', () => {
  it('reuses a pristine summary chat (no messages, no runs)', () => {
    const summary: ReusableChatLike = { summaryOnly: true, messageCount: 0, runCount: 0 }
    expect(isReusableWelcomeChat(summary)).toBe(true)
  })

  it('does NOT reuse a summary chat that has persisted messages', () => {
    const summary: ReusableChatLike = { summaryOnly: true, messageCount: 3, runCount: 1 }
    expect(isReusableWelcomeChat(summary)).toBe(false)
  })

  it('does NOT reuse a summary chat with runCount>0 but zero messages', () => {
    // The regression: a chat whose run started but never persisted a message
    // (aborted / failed / empty-result run) has messageCount 0 but runCount>0.
    // shouldRenderWelcome suppresses the hero for it, so reusing it on launch
    // would land a blank transcript. It must be excluded from reuse.
    const ranButEmpty: ReusableChatLike = { summaryOnly: true, messageCount: 0, runCount: 2 }
    expect(isReusableWelcomeChat(ranButEmpty)).toBe(false)
    // ...and shouldRenderWelcome agrees — the two must stay in lockstep.
    expect(
      shouldRenderWelcome({
        currentChat: { appChatId: 'ran-but-empty', summaryOnly: true, messageCount: 0, runCount: 2 },
        messages: [],
        isCurrentChatRunning: false
      })
    ).toBe(false)
  })

  it('does NOT reuse a sub-thread (parentChatId set) even when empty', () => {
    const child: ReusableChatLike = {
      parentChatId: 'parent-1',
      summaryOnly: true,
      messageCount: 0,
      runCount: 0
    }
    expect(isReusableWelcomeChat(child)).toBe(false)
  })

  it('treats missing runCount/messageCount on a summary chat as zero (reusable)', () => {
    expect(isReusableWelcomeChat({ summaryOnly: true })).toBe(true)
  })

  it('reuses a full record with no messages', () => {
    expect(isReusableWelcomeChat({ messages: [] })).toBe(true)
  })

  it('reuses a full record with only a system message', () => {
    expect(isReusableWelcomeChat({ messages: [{ role: 'system' }] })).toBe(true)
  })

  it('does NOT reuse a full record with conversation content', () => {
    expect(isReusableWelcomeChat({ messages: [{ role: 'assistant' }] })).toBe(false)
  })
})
