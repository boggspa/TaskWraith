import { describe, expect, it } from 'vitest'
import {
  CHAT_UPDATE_INTEREST_PROTOCOL_VERSION,
  type ChatUpdateInterestEntry
} from '../shared/chatUpdateInterest'
import { ChatUpdateInterestRegistry } from './ChatUpdateInterestRegistry'

function snapshot(entries: ChatUpdateInterestEntry[]) {
  return { protocolVersion: CHAT_UPDATE_INTEREST_PROTOCOL_VERSION, entries }
}

describe('ChatUpdateInterestRegistry', () => {
  it('keeps legacy full delivery until the first valid renderer handshake', () => {
    const registry = new ChatUpdateInterestRegistry()
    expect(registry.modeFor(7, 'chat-a')).toBe('full')

    expect(registry.update(7, { entries: [] })).toBeNull()
    expect(registry.hasHandshake(7)).toBe(false)
    expect(registry.modeFor(7, 'chat-a')).toBe('full')

    expect(registry.update(7, snapshot([]))).toEqual(snapshot([]))
    expect(registry.hasHandshake(7)).toBe(true)
    expect(registry.modeFor(7, 'chat-a')).toBeUndefined()
  })

  it('replaces each WebContents snapshot independently and resolves full or paged mode', () => {
    const registry = new ChatUpdateInterestRegistry()
    registry.update(
      7,
      snapshot([
        { chatId: 'chat-a', mode: 'paged' },
        { chatId: 'chat-b', mode: 'full' }
      ])
    )
    registry.update(8, snapshot([{ chatId: 'chat-a', mode: 'full' }]))

    expect(registry.modeFor(7, 'chat-a')).toBe('paged')
    expect(registry.modeFor(7, 'chat-b')).toBe('full')
    expect(registry.modeFor(7, 'chat-c')).toBeUndefined()
    expect(registry.modeFor(8, 'chat-a')).toBe('full')

    registry.replaceTargetSnapshot(7, snapshot([{ chatId: 'chat-c', mode: 'paged' }]))
    expect(registry.modeFor(7, 'chat-a')).toBeUndefined()
    expect(registry.modeFor(7, 'chat-c')).toBe('paged')
  })

  it('bounds and deduplicates retained ids for every target', () => {
    const registry = new ChatUpdateInterestRegistry({ maxEntriesPerTarget: 2 })
    const entries: ChatUpdateInterestEntry[] = Array.from({ length: 2_000 }, (_, index) => ({
      chatId: `chat-${index}`,
      mode: 'paged'
    }))
    entries.splice(1, 0, { chatId: 'chat-0', mode: 'full' })
    const accepted = registry.update(7, snapshot(entries))

    expect(accepted?.entries).toEqual([
      { chatId: 'chat-0', mode: 'full' },
      { chatId: 'chat-1', mode: 'paged' }
    ])
    expect(registry.trackedChatCountForTarget(7)).toBe(2)
  })

  it('clears one target or one chat without affecting unrelated interests', () => {
    const registry = new ChatUpdateInterestRegistry()
    registry.update(7, snapshot([{ chatId: 'chat-a', mode: 'paged' }]))
    registry.update(
      8,
      snapshot([
        { chatId: 'chat-a', mode: 'full' },
        { chatId: 'chat-b', mode: 'paged' }
      ])
    )

    expect(registry.clearChat('chat-a')).toBe(2)
    expect(registry.modeFor(7, 'chat-a')).toBeUndefined()
    expect(registry.modeFor(8, 'chat-b')).toBe('paged')

    expect(registry.clearTarget(7)).toBe(true)
    expect(registry.trackedTargetCount()).toBe(1)
    // A destroyed target is removed entirely; if its numeric id were somehow
    // reused before a handshake, it receives the legacy compatibility default.
    expect(registry.modeFor(7, 'chat-a')).toBe('full')
  })

  it('rejects invalid target and chat ids without allocating state', () => {
    const registry = new ChatUpdateInterestRegistry()
    expect(registry.update(-1, snapshot([{ chatId: 'chat-a', mode: 'paged' }]))).toBeNull()
    expect(registry.modeFor(-1, 'chat-a')).toBeUndefined()
    expect(registry.modeFor(7, '\n')).toBeUndefined()
    expect(registry.trackedTargetCount()).toBe(0)
  })
})
