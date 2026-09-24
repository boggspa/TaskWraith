import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  CHAT_POPOUT_HANDOFF_PREFIX,
  chatPopoutHandoffKey,
  getInitialChatPopoutChatId,
  getInitialChatPopoutPresentation,
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

    it('reads compact presentation only from chat popout URLs', () => {
      expect(
        getInitialChatPopoutPresentation('?popout=chat&chat=chat-1&presentation=compact')
      ).toBe('compact')
      expect(getInitialChatPopoutPresentation('?popout=chat&chat=chat-1')).toBe('full')
      expect(getInitialChatPopoutPresentation('?popout=file-editor&presentation=compact')).toBe(
        'full'
      )
    })

    it('falls back to window.location.search and tolerates SSR', () => {
      installWindow('?popout=chat&chat=from-window')
      expect(getInitialChatPopoutChatId()).toBe('from-window')
      expect(getInitialChatPopoutPresentation()).toBe('full')

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

    it('carries an explicit transcript-view override across the window boundary', () => {
      const raw = serializeChatPopoutHandoff({ transcriptView: 'minimal' }, 555)
      expect(JSON.parse(raw)).toEqual({ transcriptView: 'minimal', writtenAt: 555 })
      expect(parseChatPopoutHandoffPayload(raw)).toEqual({
        transcriptView: 'minimal',
        writtenAt: 555
      })
      expect(
        parseChatPopoutHandoffPayload(JSON.stringify({ transcriptView: 'tools', writtenAt: 556 }))
      ).toEqual({ transcriptView: 'tools', writtenAt: 556 })
    })

    it('carries a deliberate standard pin, distinctly from carrying no override', () => {
      // These two cases are the whole reason the four-item menu exists, and the
      // reason the carried value must not go through a total normaliser.
      const pinned = serializeChatPopoutHandoff({ transcriptView: 'standard' }, 601)
      expect(JSON.parse(pinned)).toEqual({ transcriptView: 'standard', writtenAt: 601 })
      expect(parseChatPopoutHandoffPayload(pinned)).toEqual({
        transcriptView: 'standard',
        writtenAt: 601
      })

      const unpinned = serializeChatPopoutHandoff({ draft: 'x' }, 602)
      expect(JSON.parse(unpinned)).toEqual({ draft: 'x', writtenAt: 602 })
      expect(parseChatPopoutHandoffPayload(unpinned)).toEqual({ draft: 'x', writtenAt: 602 })
      expect(parseChatPopoutHandoffPayload(unpinned)).not.toHaveProperty('transcriptView')
    })

    it('keeps an absent or unreadable transcript view out of the payload entirely', () => {
      expect(JSON.parse(serializeChatPopoutHandoff({ draft: 'a' }, 701))).toEqual({
        draft: 'a',
        writtenAt: 701
      })
      expect(
        JSON.parse(serializeChatPopoutHandoff({ draft: 'a', transcriptView: undefined }, 702))
      ).toEqual({ draft: 'a', writtenAt: 702 })
      expect(
        JSON.parse(serializeChatPopoutHandoff({ draft: 'a', transcriptView: 'huge' as never }, 703))
      ).toEqual({ draft: 'a', writtenAt: 703 })
      expect(
        parseChatPopoutHandoffPayload(
          JSON.stringify({ draft: 'a', transcriptView: 'huge', writtenAt: 704 })
        )
      ).toEqual({ draft: 'a', writtenAt: 704 })
      expect(
        parseChatPopoutHandoffPayload(
          JSON.stringify({ draft: 'a', transcriptView: null, writtenAt: 705 })
        )
      ).toEqual({ draft: 'a', writtenAt: 705 })
      // Positive control: the same two boundaries DO carry a real view, so the
      // four assertions above are about rejection, not about a dead field.
      expect(
        JSON.parse(serializeChatPopoutHandoff({ draft: 'a', transcriptView: 'tools' }, 706))
      ).toEqual({ draft: 'a', transcriptView: 'tools', writtenAt: 706 })
      expect(
        parseChatPopoutHandoffPayload(
          JSON.stringify({ draft: 'a', transcriptView: 'tools', writtenAt: 707 })
        )
      ).toEqual({ draft: 'a', transcriptView: 'tools', writtenAt: 707 })
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

    it('consumes the carried transcript view once, so a reloaded popout follows the default', () => {
      const storage = installWindow()
      vi.spyOn(Date, 'now').mockReturnValue(790)

      writeChatPopoutHandoff('chat-1', { transcriptView: 'minimal' })

      expect(storage.getItem(chatPopoutHandoffKey('chat-1'))).toBe(
        JSON.stringify({ transcriptView: 'minimal', writtenAt: 790 })
      )
      expect(readChatPopoutHandoff('chat-1')).toEqual({
        transcriptView: 'minimal',
        writtenAt: 790
      })
      // Deliberate: the read is destructive, exactly as it already is for the
      // draft, the scroll state and the disclosure map. A popout that reloads
      // finds nothing and falls back to the Appearance default, which shows
      // MORE rather than silently hiding a turn's work.
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
