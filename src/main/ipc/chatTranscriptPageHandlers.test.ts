import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ipcMain } from 'electron'
import type { IpcMainInvokeEvent } from 'electron'
import type { ChatMessage, ChatRecord } from '../store/types'
import { registerChatTranscriptPageHandlers } from './chatTranscriptPageHandlers'
import type { SenderChatReadScope } from './chatHandlers'

vi.mock('electron', () => ({
  ipcMain: {
    handle: vi.fn()
  }
}))

const mockedHandle = vi.mocked(ipcMain.handle)

beforeEach(() => {
  mockedHandle.mockReset()
})

function message(id: string): ChatMessage {
  return {
    id,
    role: 'user',
    content: `content-${id}`,
    timestamp: '2026-09-01T00:00:00.000Z'
  } as ChatMessage
}

function chat(id: string, messageIds: string[]): ChatRecord {
  return {
    appChatId: id,
    provider: 'codex',
    title: id,
    scope: 'global',
    createdAt: 1,
    updatedAt: 7,
    archived: false,
    messages: messageIds.map(message),
    runs: []
  } as ChatRecord
}

function handlerFor(channel: string) {
  const entry = mockedHandle.mock.calls.find(([name]) => name === channel)
  if (!entry) throw new Error(`handler not registered: ${channel}`)
  return entry[1] as (event: IpcMainInvokeEvent, input: unknown) => unknown
}

function harness(
  options: {
    scope?: SenderChatReadScope
    chats?: Record<string, ChatRecord>
  } = {}
) {
  const chats = options.chats ?? {}
  const deps = {
    chatService: {
      getChat: vi.fn((chatId: string) => chats[chatId] ?? null)
    },
    resolveSenderChatReadScope: vi.fn(() => options.scope ?? ({ kind: 'all' } as const))
  }
  registerChatTranscriptPageHandlers(deps)
  return deps
}

const event = {} as IpcMainInvokeEvent

describe('registerChatTranscriptPageHandlers', () => {
  it('registers the page channel', () => {
    harness()
    expect(handlerFor('get-chat-transcript-page')).toBeTypeOf('function')
  })

  it('returns the tail page for a bare request', () => {
    harness({ chats: { 'chat-1': chat('chat-1', ['a', 'b', 'c']) } })
    const page = handlerFor('get-chat-transcript-page')(event, { chatId: 'chat-1' }) as any
    expect(page.messages.map((m: ChatMessage) => m.id)).toEqual(['a', 'b', 'c'])
    expect(page).toMatchObject({
      chatId: 'chat-1',
      totalMessageCount: 3,
      windowStart: 0,
      windowEnd: 3,
      hasOlder: false,
      hasNewer: false,
      oldestMessageId: 'a',
      newestMessageId: 'c',
      updatedAt: 7
    })
  })

  it('honours count limits and cursors', () => {
    harness({ chats: { 'chat-1': chat('chat-1', ['a', 'b', 'c', 'd', 'e']) } })
    const page = handlerFor('get-chat-transcript-page')(event, {
      chatId: 'chat-1',
      beforeMessageId: 'd',
      maxMessages: 2
    }) as any
    expect(page.messages.map((m: ChatMessage) => m.id)).toEqual(['b', 'c'])
    expect(page.hasOlder).toBe(true)
    expect(page.hasNewer).toBe(true)
  })

  it('returns null for a missing chat or a missing anchor', () => {
    harness({ chats: { 'chat-1': chat('chat-1', ['a']) } })
    expect(handlerFor('get-chat-transcript-page')(event, { chatId: 'gone' })).toBeNull()
    expect(
      handlerFor('get-chat-transcript-page')(event, { chatId: 'chat-1', aroundMessageId: 'gone' })
    ).toBeNull()
  })

  it('rejects a malformed request', () => {
    harness()
    expect(() => handlerFor('get-chat-transcript-page')(event, null)).toThrow(
      'Invalid transcript page request.'
    )
    expect(() => handlerFor('get-chat-transcript-page')(event, { chatId: '' })).toThrow(
      'Invalid transcript page request.'
    )
  })

  it('denies a chat-scoped renderer paging a chat it does not own', () => {
    harness({
      scope: { kind: 'chat', chatId: 'chat-1' },
      chats: { 'chat-2': chat('chat-2', ['a']) }
    })
    expect(() => handlerFor('get-chat-transcript-page')(event, { chatId: 'chat-2' })).toThrow(
      'Renderer does not own this chat read.'
    )
  })

  it('lets a chat-scoped renderer page its own chat', () => {
    harness({
      scope: { kind: 'chat', chatId: 'chat-1' },
      chats: { 'chat-1': chat('chat-1', ['a']) }
    })
    const page = handlerFor('get-chat-transcript-page')(event, { chatId: 'chat-1' }) as any
    expect(page.totalMessageCount).toBe(1)
  })
})
