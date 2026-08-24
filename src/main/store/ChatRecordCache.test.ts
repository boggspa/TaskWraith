import { beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'fs'
import { join } from 'path'
import { AppStore } from '../store'
import type { ChatRecord } from './types'

const userDataPath = vi.hoisted(() => `/tmp/taskwraith-chat-cache-test-${process.pid}`)

// T3a-1: Disable the coalescer for cache-behavior tests — these tests verify
// cache semantics, not coalesce timing. The coalescer has its own test suite.
vi.hoisted(() => {
  process.env.TASKWRAITH_SAVE_COALESCE_MS = '-1'
})

vi.mock('electron', () => ({
  app: {
    getPath: () => userDataPath
  }
}))

const chatsDir = join(userDataPath, 'chats')
const chatListIndexPath = join(userDataPath, 'chat-list-index.jsonl')

function diskPath(chatId: string): string {
  return join(chatsDir, `${chatId}.json`)
}

function readChatListIndex(): Record<string, ChatRecord & { searchPreview?: string }> {
  const index: Record<string, ChatRecord & { searchPreview?: string }> = {}
  const raw = fs.readFileSync(chatListIndexPath, 'utf-8')
  for (const line of raw.split('\n')) {
    const trimmed = line.trim()
    if (trimmed.length === 0) continue
    try {
      const rec = JSON.parse(trimmed)
      if (rec.entry && rec.chatId) {
        // Re-merge summaries for the test helper.
        const summaryPath = join(userDataPath, 'chat-list-summaries', `${rec.chatId}.json`)
        let summaries: Record<string, unknown> = {}
        try {
          summaries = JSON.parse(fs.readFileSync(summaryPath, 'utf-8'))
        } catch {
          /* ok */
        }
        index[rec.chatId] = { ...rec.entry, ...summaries } as ChatRecord & {
          searchPreview?: string
        }
      }
    } catch {
      /* skip corrupt lines */
    }
  }
  return index
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

  it('keeps main-owned worktree and PR-watch fields through a stale renderer save', async () => {
    const staleRendererChat = AppStore.createChat('ws-1', '/repo')
    const binding = {
      schemaVersion: 1 as const,
      baseWorkspacePath: '/repo',
      effectiveWorkspacePath: '/repo/.taskwraith/worktrees/thread-1',
      branch: 'taskwraith/thread-thread-1'
    }
    const watchedPr = {
      chatId: staleRendererChat.appChatId,
      workspacePath: '/repo',
      owner: 'taskwraith',
      repo: 'app',
      prNumber: 42
    }

    await AppStore.persistThreadWorktreeBinding(staleRendererChat.appChatId, binding)
    const durable = JSON.parse(fs.readFileSync(diskPath(staleRendererChat.appChatId), 'utf-8'))
    fs.writeFileSync(
      diskPath(staleRendererChat.appChatId),
      JSON.stringify({ ...durable, watchedPr })
    )

    AppStore.saveChat({ ...staleRendererChat, title: 'Renderer title update' } as ChatRecord)

    const saved = AppStore.getChat(staleRendererChat.appChatId)
    expect(saved).toMatchObject({
      title: 'Renderer title update',
      threadWorktreeBinding: binding,
      watchedPr
    })
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

      // 2026-08-18: counters/previews are volatile — a message landing inside
      // the window rides the cadence instead of appending a line per save
      // (the old stable-messageCount loophole was the append storm). The list
      // itself never lags: getChatList rebuilds a stale row before serving.
      vi.setSystemTime(new Date('2026-01-01T00:00:01.000Z'))
      AppStore.saveChat({ ...chat, messages: [message('first preview')] } as ChatRecord)
      const firstIndex = readChatListIndex()
      expect(firstIndex[chat.appChatId].searchPreview).toBeUndefined()

      // The volatile window elapses → the refresh lands on disk.
      vi.setSystemTime(new Date('2026-01-01T00:00:15.100Z'))
      AppStore.saveChat({ ...chat, messages: [message('first preview')] } as ChatRecord)
      const refreshedIndex = readChatListIndex()
      expect(refreshedIndex[chat.appChatId].searchPreview).toBe('first preview')

      // Inside the next window: throttled again.
      vi.setSystemTime(new Date('2026-01-01T00:00:16.000Z'))
      AppStore.saveChat({ ...chat, messages: [message('second preview')] } as ChatRecord)
      const throttledIndex = readChatListIndex()
      expect(throttledIndex[chat.appChatId].searchPreview).toBe('first preview')

      // And lands once the cadence allows.
      vi.setSystemTime(new Date('2026-01-01T00:00:30.200Z'))
      AppStore.saveChat({ ...chat, messages: [message('second preview')] } as ChatRecord)
      const secondRefreshIndex = readChatListIndex()
      expect(secondRefreshIndex[chat.appChatId].searchPreview).toBe('second preview')
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
    // Write in JSONL format — one line per entry.
    const lines = Object.entries(rawIndex).map(
      ([id, entry]) =>
        JSON.stringify({
          chatId: id,
          entry: { ...entry, runsSummary: undefined, lastRun: undefined }
        }) + '\n'
    )
    fs.writeFileSync(chatListIndexPath, lines.join(''))
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

describe('chat-list index freshness after save (cold-launch re-parse guard)', () => {
  /**
   * MEASURED on a live install 2026-08-05: every cold launch stalled 1-2 min
   * with main pegged at ~100% CPU and RSS sawtoothing 1.2-2.8 GB. Cause:
   * `getChatList()` only serves an index entry without re-reading the chat when
   * `sourceChatMtimeMs`/`sourceChatSize` match the file. `saveChat` wrote its
   * index entry via `toChatListItem(chat)` with NO stat argument, so those two
   * fields were absent entirely and the entry could never match — every chat
   * touched in a session was fully re-parsed on the next launch.
   *
   * Measured impact on that install: 49 of 204 chats permanently stale = 136 MB
   * of chat JSON re-parsed on every cold launch, dominated by the big ensemble
   * chats (61.8 MB, 20.6 MB, 19.4 MB). The rebuild never stuck: re-measuring
   * right after a launch that had just rebuilt showed the same 49 stale.
   */
  beforeEach(() => {
    AppStore.resetTransientDeletionGuardsForTests()
    fs.rmSync(userDataPath, { recursive: true, force: true })
    fs.mkdirSync(chatsDir, { recursive: true })
  })

  it('records the on-disk mtime+size so the next launch serves from the index', () => {
    const chat = AppStore.createChat('ws-1', '/repo')
    AppStore.saveChat({
      ...chat,
      title: 'Saved once',
      messages: [message('hello')]
    } as ChatRecord)

    const stat = fs.statSync(diskPath(chat.appChatId))
    const entry = readChatListIndex()[chat.appChatId] as unknown as {
      sourceChatMtimeMs?: number
      sourceChatSize?: number
    }
    expect(entry, 'no index entry written for the saved chat').toBeTruthy()
    expect(
      entry.sourceChatMtimeMs,
      'index entry has no source mtime — getChatList will fully re-parse this chat on every launch'
    ).toBe(stat.mtimeMs)
    expect(entry.sourceChatSize, 'index entry has no source size').toBe(stat.size)
  })

  it('stays fresh across repeated saves', () => {
    const chat = AppStore.createChat('ws-1', '/repo')
    let current = chat
    for (let i = 0; i < 3; i += 1) {
      current = AppStore.saveChat({ ...current, title: `Save ${i}` } as ChatRecord)
    }
    const stat = fs.statSync(diskPath(chat.appChatId))
    const entry = readChatListIndex()[chat.appChatId] as unknown as {
      sourceChatMtimeMs?: number
      sourceChatSize?: number
    }
    expect(entry.sourceChatMtimeMs).toBe(stat.mtimeMs)
    expect(entry.sourceChatSize).toBe(stat.size)
  })
})
