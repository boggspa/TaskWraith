import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  CHAT_POPOUT_HANDOFF_PREFIX,
  chatPopoutHandoffKey,
  getInitialChatPopoutChatId,
  listChatPopoutHandoffChatIds,
  parseChatPopoutHandoffPayload,
  readChatPopoutHandoff,
  serializeChatPopoutHandoff,
  writeChatPopoutHandoff
} from './chatPopoutHandoff'

class MemoryStorage implements Storage {
  private readonly map = new Map<string, string>()

  get length(): number {
    return this.map.size
  }

  clear(): void {
    this.map.clear()
  }

  getItem(key: string): string | null {
    return this.map.get(key) ?? null
  }

  key(index: number): string | null {
    return Array.from(this.map.keys())[index] ?? null
  }

  removeItem(key: string): void {
    this.map.delete(key)
  }

  setItem(key: string, value: string): void {
    this.map.set(key, value)
  }
}

function installWindow(search = ''): MemoryStorage {
  const localStorage = new MemoryStorage()
  vi.stubGlobal('window', {
    localStorage,
    location: { search }
  } as unknown as Window & typeof globalThis)
  return localStorage
}

describe('chatPopoutHandoff', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  describe('getInitialChatPopoutChatId', () => {
    it('reads the chat id only from chat popout URLs', () => {
      expect(getInitialChatPopoutChatId('?popout=chat&chat=chat-1')).toBe('chat-1')
      expect(getInitialChatPopoutChatId('?popout=file&chat=chat-1')).toBe('')
      expect(getInitialChatPopoutChatId('?popout=chat')).toBe('')
    })

    it('falls back to window.location.search and tolerates SSR', () => {
      installWindow('?popout=chat&chat=from-window')
      expect(getInitialChatPopoutChatId()).toBe('from-window')

      vi.unstubAllGlobals()
      expect(getInitialChatPopoutChatId()).toBe('')
    })
  })

  describe('payload parsing', () => {
    it('serializes and parses draft, anchored scroll, disclosure, and writtenAt', () => {
      const raw = serializeChatPopoutHandoff(
        {
          draft: 'resume this',
          scrollState: {
            scrollTop: 12,
            scrollHeight: 100,
            clientHeight: 20,
            scrollRatio: 0.5,
            atBottom: false,
            anchorMessageId: 'm1',
            anchorOffset: 8
          },
          roundExpansion: [
            { roundId: 'round-1', expanded: true },
            { roundId: 'round-2', expanded: false }
          ]
        },
        123
      )

      expect(parseChatPopoutHandoffPayload(raw)).toEqual({
        draft: 'resume this',
        scrollState: {
          scrollTop: 12,
          scrollHeight: 100,
          clientHeight: 20,
          scrollRatio: 0.5,
          atBottom: false,
          anchorMessageId: 'm1',
          anchorOffset: 8
        },
        roundExpansion: [
          { roundId: 'round-1', expanded: true },
          { roundId: 'round-2', expanded: false }
        ],
        writtenAt: 123
      })
    })

    it('preserves explicit empty disclosure so the destination can clear stale state', () => {
      const raw = serializeChatPopoutHandoff({ roundExpansion: [] }, 321)
      expect(parseChatPopoutHandoffPayload(raw)).toEqual({
        roundExpansion: [],
        writtenAt: 321
      })
    })

    it('filters malformed disclosure at both serialization boundaries', () => {
      const malformed = [
        { roundId: 'round-1', expanded: true },
        { roundId: '', expanded: false },
        { roundId: 'round-2', expanded: 'yes' }
      ]
      const raw = serializeChatPopoutHandoff({ roundExpansion: malformed as never }, 222)
      expect(JSON.parse(raw)).toEqual({
        roundExpansion: [{ roundId: 'round-1', expanded: true }],
        writtenAt: 222
      })
      expect(
        parseChatPopoutHandoffPayload(JSON.stringify({ roundExpansion: malformed, writtenAt: 223 }))
      ).toEqual({
        roundExpansion: [{ roundId: 'round-1', expanded: true }],
        writtenAt: 223
      })
    })

    it('uses the fallback timestamp when the payload omitted writtenAt', () => {
      expect(parseChatPopoutHandoffPayload(JSON.stringify({ draft: 'x' }), 456)).toEqual({
        draft: 'x',
        writtenAt: 456
      })
    })

    it('returns null for corrupt, null, or primitive payloads', () => {
      expect(parseChatPopoutHandoffPayload('{bad json')).toBeNull()
      expect(parseChatPopoutHandoffPayload('null')).toBeNull()
      expect(parseChatPopoutHandoffPayload('7')).toBeNull()
    })
  })

  describe('localStorage handoff', () => {
    it('writes and consumes the handoff payload', () => {
      const storage = installWindow()
      vi.spyOn(Date, 'now').mockReturnValue(789)

      writeChatPopoutHandoff('chat-1', { draft: 'hello' })

      expect(storage.getItem(chatPopoutHandoffKey('chat-1'))).toBe(
        JSON.stringify({ draft: 'hello', writtenAt: 789 })
      )
      expect(readChatPopoutHandoff('chat-1')).toEqual({
        draft: 'hello',
        writtenAt: 789
      })
      expect(storage.getItem(chatPopoutHandoffKey('chat-1'))).toBeNull()
      expect(readChatPopoutHandoff('chat-1')).toBeNull()
    })

    it('removes corrupt payloads on read', () => {
      const storage = installWindow()
      storage.setItem(chatPopoutHandoffKey('chat-1'), '{bad json')

      expect(readChatPopoutHandoff('chat-1')).toBeNull()
      expect(storage.getItem(chatPopoutHandoffKey('chat-1'))).toBeNull()
    })

    it('lists chat ids with pending handoff keys', () => {
      const storage = installWindow()
      storage.setItem(chatPopoutHandoffKey('chat-1'), '{}')
      storage.setItem(`${CHAT_POPOUT_HANDOFF_PREFIX}chat-2`, '{}')
      storage.setItem('taskwraith.other.chat-3', '{}')

      expect(listChatPopoutHandoffChatIds()).toEqual(['chat-1', 'chat-2'])
    })

    it('does nothing when storage is unavailable', () => {
      expect(readChatPopoutHandoff('chat-1')).toBeNull()
      expect(listChatPopoutHandoffChatIds()).toEqual([])
      expect(() => writeChatPopoutHandoff('chat-1', { draft: 'x' })).not.toThrow()
    })
  })
})
