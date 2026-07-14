import { beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'fs'
import { join } from 'path'
import { AppStore } from './index'
import type { ChatRecord } from './types'

const userDataPath = vi.hoisted(() => `/tmp/taskwraith-chat-cache-test-${process.pid}`)

vi.mock('electron', () => ({
  app: {
    getPath: () => userDataPath
  }
}))

const chatsDir = join(userDataPath, 'chats')
const chatListIndexPath = join(userDataPath, 'chat-list-index.json')

function diskPath(chatId: string): string {
  return join(chatsDir, `${chatId}.json`)
}

function readChatListIndex(): Record<string, ChatRecord & { searchPreview?: string }> {
  return JSON.parse(fs.readFileSync(chatListIndexPath, 'utf-8'))
}

function message(content: string): ChatRecord['messages'][number] {
  return {
    id: 'message-1',
    role: 'assistant',
    content,
    timestamp: '2026-01-01T00:00:00.000Z'
  }
}

describe('AppStore chat record cache', () => {
  beforeEach(() => {
    AppStore.resetTransientDeletionGuardsForTests()
    fs.rmSync(userDataPath, { recursive: true, force: true })
    fs.mkdirSync(chatsDir, { recursive: true })
  })

  it('repeat reads return the cached instance instead of re-parsing', () => {
    const chat = AppStore.createChat('ws-1', '/repo')
    const first = AppStore.getChat(chat.appChatId)
    const second = AppStore.getChat(chat.appChatId)
    expect(first).not.toBeNull()
    expect(second).toBe(first)

    // The sweep shares the same cache — same instance, not a re-parse.
    const swept = AppStore.getChats().find((c) => c.appChatId === chat.appChatId)
    expect(swept).toBe(first)
  })

  it('saveChat writes through: the next read is the saved record, no stale data', () => {
    const chat = AppStore.createChat('ws-1', '/repo')
    const before = AppStore.getChat(chat.appChatId)
    AppStore.saveChat({ ...chat, title: 'Renamed' } as ChatRecord)
    const after = AppStore.getChat(chat.appChatId)
    expect(after?.title).toBe('Renamed')
    expect(after).not.toBe(before)
    // Disk agrees (write-through, not cache-only).
    const onDisk = JSON.parse(fs.readFileSync(diskPath(chat.appChatId), 'utf-8'))
    expect(onDisk.title).toBe('Renamed')
  })

  it('increments and propagates the canonical whole-record persistence revision', () => {
    const chat = AppStore.createChat('ws-1', '/repo')
    expect(chat.persistenceRevision).toBe(1)

    const firstInput = { ...chat, title: 'First save' } as ChatRecord
    const first = AppStore.saveChat(firstInput)
    expect(first.persistenceRevision).toBe(2)
    expect(firstInput.persistenceRevision).toBe(2)

    const secondInput = { ...first, title: 'Second save' } as ChatRecord
    const second = AppStore.saveChat(secondInput)
    expect(second.persistenceRevision).toBe(3)
    expect(secondInput.persistenceRevision).toBe(3)
    expect(AppStore.getChat(chat.appChatId)?.persistenceRevision).toBe(3)

    const onDisk = JSON.parse(fs.readFileSync(diskPath(chat.appChatId), 'utf-8'))
    expect(onDisk.persistenceRevision).toBe(3)
  })

  it('an out-of-band file change invalidates via mtime/size and re-parses', () => {
    const chat = AppStore.createChat('ws-1', '/repo')
    const cached = AppStore.getChat(chat.appChatId)
    expect(cached?.title).toBe('New Chat')

    const raw = JSON.parse(fs.readFileSync(diskPath(chat.appChatId), 'utf-8'))
    raw.title = 'Edited outside the store'
    fs.writeFileSync(diskPath(chat.appChatId), JSON.stringify(raw))

    const reread = AppStore.getChat(chat.appChatId)
    expect(reread?.title).toBe('Edited outside the store')
    expect(reread).not.toBe(cached)
  })

  it('deleteChat drops the cache entry with the file', () => {
    const chat = AppStore.createChat('ws-1', '/repo')
    expect(AppStore.getChat(chat.appChatId)).not.toBeNull()
    AppStore.deleteChat(chat.appChatId)
    expect(AppStore.getChat(chat.appChatId)).toBeNull()
    expect(AppStore.getChats().some((c) => c.appChatId === chat.appChatId)).toBe(false)
  })

  it('a chat deleted out-of-band disappears from reads', () => {
    const chat = AppStore.createChat('ws-1', '/repo')
    expect(AppStore.getChat(chat.appChatId)).not.toBeNull()
    fs.unlinkSync(diskPath(chat.appChatId))
    expect(AppStore.getChat(chat.appChatId)).toBeNull()
    expect(AppStore.getChats().some((c) => c.appChatId === chat.appChatId)).toBe(false)
  })

  it('workspace filtering still applies on the cached sweep', () => {
    const a = AppStore.createChat('ws-a', '/repo-a')
    const b = AppStore.createChat('ws-b', '/repo-b')
    const wsA = AppStore.getChats('ws-a')
    expect(wsA.map((c) => c.appChatId)).toContain(a.appChatId)
    expect(wsA.map((c) => c.appChatId)).not.toContain(b.appChatId)
  })

  it('throttles chat-list index rewrites when only volatile summary fields change', () => {
    vi.useFakeTimers()
    try {
      vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'))
      const chat = AppStore.createChat('ws-1', '/repo')

      vi.setSystemTime(new Date('2026-01-01T00:00:01.000Z'))
      AppStore.saveChat({ ...chat, messages: [message('first preview')] } as ChatRecord)
      const firstIndex = readChatListIndex()
      expect(firstIndex[chat.appChatId].searchPreview).toBe('first preview')

      vi.setSystemTime(new Date('2026-01-01T00:00:02.000Z'))
      AppStore.saveChat({ ...chat, messages: [message('second preview')] } as ChatRecord)
      const throttledIndex = readChatListIndex()
      expect(throttledIndex[chat.appChatId].searchPreview).toBe('first preview')

      vi.setSystemTime(new Date('2026-01-01T00:00:03.100Z'))
      AppStore.saveChat({ ...chat, messages: [message('second preview')] } as ChatRecord)
      const refreshedIndex = readChatListIndex()
      expect(refreshedIndex[chat.appChatId].searchPreview).toBe('second preview')
    } finally {
      vi.useRealTimers()
    }
  })

  it('updates the chat-list index immediately for structural summary changes', () => {
    vi.useFakeTimers()
    try {
      vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'))
      const chat = AppStore.createChat('ws-1', '/repo')

      vi.setSystemTime(new Date('2026-01-01T00:00:01.000Z'))
      AppStore.saveChat({ ...chat, messages: [message('first preview')] } as ChatRecord)

      vi.setSystemTime(new Date('2026-01-01T00:00:01.500Z'))
      AppStore.saveChat({
        ...chat,
        title: 'Renamed immediately',
        messages: [message('second preview')]
      } as ChatRecord)

      const index = readChatListIndex()
      expect(index[chat.appChatId].title).toBe('Renamed immediately')
      expect(index[chat.appChatId].searchPreview).toBe('second preview')
    } finally {
      vi.useRealTimers()
    }
  })

  it('invalidates the chat-list index cache when the index changes out of band', () => {
    const chat = AppStore.createChat('ws-1', '/repo')
    expect(AppStore.getChatList().find((item) => item.appChatId === chat.appChatId)?.title).toBe(
      'New Chat'
    )

    const rawIndex = readChatListIndex()
    rawIndex[chat.appChatId].title = 'Edited index outside the store'
    fs.writeFileSync(chatListIndexPath, JSON.stringify(rawIndex, null, 2))
    const future = new Date(Date.now() + 5000)
    fs.utimesSync(chatListIndexPath, future, future)

    expect(AppStore.getChatList().find((item) => item.appChatId === chat.appChatId)?.title).toBe(
      'Edited index outside the store'
    )
  })

  it('self-heals stale chat-list rows when the backing chat file is newer', () => {
    const chat = AppStore.createChat('ws-1', '/repo')
    expect(AppStore.getChatList().find((item) => item.appChatId === chat.appChatId)?.title).toBe(
      'New Chat'
    )

    const rawChat = JSON.parse(fs.readFileSync(diskPath(chat.appChatId), 'utf-8'))
    rawChat.title = 'Edited chat outside the index'
    fs.writeFileSync(diskPath(chat.appChatId), JSON.stringify(rawChat))
    const future = new Date(Date.now() + 5000)
    fs.utimesSync(diskPath(chat.appChatId), future, future)

    expect(AppStore.getChatList().find((item) => item.appChatId === chat.appChatId)?.title).toBe(
      'Edited chat outside the index'
    )
    expect(readChatListIndex()[chat.appChatId].title).toBe('Edited chat outside the index')
  })
})
