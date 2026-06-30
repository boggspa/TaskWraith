import { describe, expect, it } from 'vitest'
import type { ChatRecord, ProviderId } from '../../../main/store/types'
import { getChatDisplayProvider, getChatProvider } from './chatScope'

const baseChat = (patch: Partial<ChatRecord> = {}): ChatRecord =>
  ({
    appChatId: 'chat-1',
    provider: 'codex',
    messages: [],
    runs: [],
    ...patch
  }) as ChatRecord

describe('getChatDisplayProvider', () => {
  it('returns ensemble for an ensemble chat even when it carries a seed provider', () => {
    expect(getChatDisplayProvider(baseChat({ chatKind: 'ensemble', provider: 'grok' }))).toBe(
      'ensemble'
    )
  })

  it('returns ensemble for an ensemble chat with no seed provider', () => {
    expect(getChatDisplayProvider(baseChat({ chatKind: 'ensemble', provider: undefined }))).toBe(
      'ensemble'
    )
  })

  it('returns the underlying provider for a normal (single) chat', () => {
    expect(getChatDisplayProvider(baseChat({ chatKind: 'single', provider: 'claude' }))).toBe(
      'claude'
    )
    // chatKind is optional; absence must NOT be treated as ensemble.
    expect(getChatDisplayProvider(baseChat({ provider: 'kimi' }))).toBe('kimi')
  })

  it('falls back to gemini for a missing/null/empty chat', () => {
    expect(getChatDisplayProvider(null)).toBe('gemini')
    expect(getChatDisplayProvider(undefined)).toBe('gemini')
    expect(getChatDisplayProvider(baseChat({ provider: undefined }))).toBe('gemini')
  })
})

describe('getChatProvider (runtime identity is unchanged)', () => {
  it('still returns the seed ProviderId for an ensemble chat (no display remap)', () => {
    // Runtime routing must keep seeing the real provider, not 'ensemble'.
    const provider: ProviderId = getChatProvider(baseChat({ chatKind: 'ensemble', provider: 'grok' }))
    expect(provider).toBe('grok')
  })

  it('still falls back to gemini for a missing chat', () => {
    expect(getChatProvider(null)).toBe('gemini')
    expect(getChatProvider(undefined)).toBe('gemini')
  })
})
