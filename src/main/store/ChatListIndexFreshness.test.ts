import { beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'fs'
import { join } from 'path'
import { AppStore } from '../store'
import type { ChatRecord } from './types'

const userDataPath = vi.hoisted(() => `/tmp/taskwraith-index-freshness-${process.pid}`)

// Coalescing ENABLED (production shape): the chat-file write is deferred, so
// the chat-list index entry is built BEFORE the bytes land on disk. This file
// exists because ChatRecordCache.test.ts pins the coalescer OFF, which makes
// the deferred path untestable there — a freshness test written in that file
// passes without ever exercising the deferral it claims to cover.
vi.hoisted(() => {
  process.env.TASKWRAITH_SAVE_COALESCE_MS = '50'
})

vi.mock('electron', () => ({ app: { getPath: () => userDataPath } }))

const chatsDir = join(userDataPath, 'chats')

function indexEntry(
  chatId: string
): { sourceChatMtimeMs?: number; sourceChatSize?: number } | null {
  const raw = fs.readFileSync(join(userDataPath, 'chat-list-index.jsonl'), 'utf-8')
  let found: Record<string, unknown> | null = null
  for (const line of raw.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue
    try {
      const rec = JSON.parse(trimmed)
      if (rec.chatId === chatId && rec.entry) found = rec.entry
    } catch {
      /* skip corrupt */
    }
  }
  return found as { sourceChatMtimeMs?: number; sourceChatSize?: number } | null
}

describe('chat-list index freshness across the save coalescer', () => {
  /**
   * MEASURED on a live install 2026-08-05: cold launch stalled 1-2 minutes with
   * main at ~100% CPU and RSS sawtoothing 1.2-2.8 GB, re-parsing 136 MB of chat
   * JSON. `getChatList()` only skips re-reading a chat when the index entry's
   * sourceChatMtimeMs/Size match the file; `saveChat` built its entry with no
   * stat at all, so 49 of 204 chats were permanently stale — and re-measuring
   * straight after a rebuild launch showed the same 49, proving it never stuck.
   */
  beforeEach(() => {
    AppStore.resetTransientDeletionGuardsForTests()
    fs.rmSync(userDataPath, { recursive: true, force: true })
    fs.mkdirSync(chatsDir, { recursive: true })
  })

  it('entry matches the bytes on disk after the deferred write flushes', () => {
    const chat = AppStore.createChat('ws-1', '/repo')
    AppStore.saveChat({ ...chat, title: 'Deferred save' } as ChatRecord)
    AppStore.flushAllChatSaves()

    const stat = fs.statSync(join(chatsDir, `${chat.appChatId}.json`))
    const entry = indexEntry(chat.appChatId)
    expect(entry, 'no index entry written').toBeTruthy()
    expect(
      entry?.sourceChatMtimeMs,
      'entry stat does not match disk — getChatList re-parses this chat every launch'
    ).toBe(stat.mtimeMs)
    expect(entry?.sourceChatSize).toBe(stat.size)
  })

  it('stays matched after several coalesced saves', () => {
    const chat = AppStore.createChat('ws-1', '/repo')
    let current = chat
    for (let i = 0; i < 4; i += 1) {
      current = AppStore.saveChat({ ...current, title: `Save ${i}` } as ChatRecord)
    }
    AppStore.flushAllChatSaves()

    const stat = fs.statSync(join(chatsDir, `${chat.appChatId}.json`))
    const entry = indexEntry(chat.appChatId)
    expect(entry?.sourceChatMtimeMs).toBe(stat.mtimeMs)
    expect(entry?.sourceChatSize).toBe(stat.size)
  })
})
