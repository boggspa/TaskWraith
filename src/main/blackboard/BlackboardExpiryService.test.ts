import { describe, expect, it, vi } from 'vitest'
import type { BlackboardEntry, ChatRecord } from '../store/types'
import { BLACKBOARD_EXPIRY_RETRY_MS, BlackboardExpiryService } from './BlackboardExpiryService'

const START_MS = Date.parse('2026-08-03T18:00:00.000Z')

function entry(id: string, expiresAt?: string): BlackboardEntry {
  return {
    id,
    chatId: 'chat-1',
    roundId: 'round-1',
    participantId: 'user',
    key: id,
    value: id,
    category: 'note',
    scope: 'session',
    createdAt: '2026-08-03T17:00:00.000Z',
    ...(expiresAt ? { expiresAt } : {})
  }
}

function chat(entries: BlackboardEntry[], id = 'chat-1'): ChatRecord {
  return {
    appChatId: id,
    provider: 'codex',
    chatKind: 'ensemble',
    scope: 'global',
    title: id,
    createdAt: START_MS,
    updatedAt: START_MS,
    archived: false,
    messages: [],
    runs: [],
    ensemble: {
      participants: [],
      blackboard: entries,
      updatedAt: '2026-08-03T17:00:00.000Z'
    }
  } as unknown as ChatRecord
}

describe('BlackboardExpiryService', () => {
  it('recovers due entries after startup and removes future entries at their deadline', () => {
    vi.useFakeTimers()
    try {
      let nowMs = START_MS
      const records = new Map<string, ChatRecord>([
        [
          'chat-1',
          chat([
            entry('durable'),
            entry('expired', '2026-08-03T18:00:00.000Z'),
            entry('future', '2026-08-03T18:01:00.000Z')
          ])
        ]
      ])
      const saveChat = vi.fn((next: ChatRecord) => {
        records.set(next.appChatId, next)
        return next
      })
      const service = new BlackboardExpiryService({
        listChats: () => [...records.values()],
        getChat: (chatId) => records.get(chatId) || null,
        saveChat,
        now: () => nowMs
      })

      service.start()
      expect(saveChat).not.toHaveBeenCalled()
      vi.advanceTimersByTime(0)
      expect(records.get('chat-1')?.ensemble?.blackboard?.map((item) => item.id)).toEqual([
        'durable',
        'future'
      ])

      nowMs += 60_000
      vi.advanceTimersByTime(60_000)
      expect(records.get('chat-1')?.ensemble?.blackboard?.map((item) => item.id)).toEqual([
        'durable'
      ])
      expect(saveChat).toHaveBeenCalledTimes(2)
      service.stop()
    } finally {
      vi.useRealTimers()
    }
  })

  it('re-arms when an ordinary chat save introduces an earlier expiry', () => {
    vi.useFakeTimers()
    try {
      let nowMs = START_MS
      const records = new Map<string, ChatRecord>([['chat-1', chat([])]])
      const saveChat = vi.fn((next: ChatRecord) => {
        records.set(next.appChatId, next)
        return next
      })
      const service = new BlackboardExpiryService({
        listChats: () => [...records.values()],
        getChat: (chatId) => records.get(chatId) || null,
        saveChat,
        now: () => nowMs
      })
      service.start()

      const updated = chat([entry('temporary', '2026-08-03T18:00:30.000Z')])
      records.set(updated.appChatId, updated)
      service.observeChat(updated)
      nowMs += 30_000
      vi.advanceTimersByTime(30_000)

      expect(records.get('chat-1')?.ensemble?.blackboard).toEqual([])
      expect(saveChat).toHaveBeenCalledTimes(1)
      service.stop()
    } finally {
      vi.useRealTimers()
    }
  })

  it('keeps failed deletions durable and retries with bounded backoff', () => {
    vi.useFakeTimers()
    try {
      let nowMs = START_MS
      const current = chat([entry('temporary', '2026-08-03T18:00:00.000Z')])
      const saveChat = vi.fn(() => {
        throw new Error('disk unavailable')
      })
      const onError = vi.fn()
      const service = new BlackboardExpiryService({
        listChats: () => [current],
        getChat: () => current,
        saveChat,
        now: () => nowMs,
        onError
      })
      service.start()
      vi.advanceTimersByTime(0)

      expect(saveChat).toHaveBeenCalledTimes(1)
      expect(onError).toHaveBeenCalledWith(expect.any(Error), 'chat-1')
      vi.advanceTimersByTime(BLACKBOARD_EXPIRY_RETRY_MS - 1)
      expect(saveChat).toHaveBeenCalledTimes(1)
      nowMs += BLACKBOARD_EXPIRY_RETRY_MS
      vi.advanceTimersByTime(1)
      expect(saveChat).toHaveBeenCalledTimes(2)
      service.stop()
    } finally {
      vi.useRealTimers()
    }
  })
})
