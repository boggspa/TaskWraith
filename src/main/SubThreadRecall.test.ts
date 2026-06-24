import { describe, expect, it } from 'vitest'
import { resolveSubThreadRecall, type SubThreadRecallChatLookup } from './SubThreadRecall'
import type { ChatRecord } from './store/types'

// Minimal ChatRecord factory — the resolver only reads a handful of
// fields, so the rest of the type can be filled in with safe defaults
// rather than mocked exhaustively per test.
function makeChat(overrides: Partial<ChatRecord>): ChatRecord {
  return {
    appChatId: 'chat-x',
    title: 'Sub-thread (test)',
    provider: 'kimi',
    workspaceId: 'ws-1',
    workspacePath: '/tmp/ws',
    scope: 'workspace',
    archived: false,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    messages: [],
    runs: [],
    ...overrides
  } as ChatRecord
}

function makeLookup(chats: ChatRecord[]): SubThreadRecallChatLookup {
  const byId = new Map(chats.map((c) => [c.appChatId, c]))
  return (id) => byId.get(id)
}

describe('resolveSubThreadRecall', () => {
  const parent = 'parent-A'

  it('returns spawn when subThreadId is not provided', () => {
    const lookup = makeLookup([])
    expect(
      resolveSubThreadRecall({ parentChatId: parent, targetProvider: 'kimi' }, lookup)
    ).toEqual({ mode: 'spawn' })
    expect(
      resolveSubThreadRecall(
        { subThreadId: '', parentChatId: parent, targetProvider: 'kimi' },
        lookup
      )
    ).toEqual({ mode: 'spawn' })
    expect(
      resolveSubThreadRecall(
        { subThreadId: '   ', parentChatId: parent, targetProvider: 'kimi' },
        lookup
      )
    ).toEqual({ mode: 'spawn' })
    expect(
      resolveSubThreadRecall(
        { subThreadId: null, parentChatId: parent, targetProvider: 'kimi' },
        lookup
      )
    ).toEqual({ mode: 'spawn' })
  })

  it('resolves recall when the sub-thread matches parent + provider', () => {
    const sub = makeChat({
      appChatId: 'sub-1',
      parentChatId: parent,
      provider: 'kimi',
      linkedProviderSessionId: 'kimi-session-99'
    })
    const result = resolveSubThreadRecall(
      { subThreadId: 'sub-1', parentChatId: parent, targetProvider: 'kimi' },
      makeLookup([sub])
    )
    expect(result).toEqual({ mode: 'recall', chat: sub, resumeSessionId: 'kimi-session-99' })
  })

  it('errors when the matched sub-thread has no linked provider session id yet', () => {
    const sub = makeChat({
      appChatId: 'sub-2',
      parentChatId: parent,
      provider: 'kimi'
    })
    const result = resolveSubThreadRecall(
      { subThreadId: 'sub-2', parentChatId: parent, targetProvider: 'kimi' },
      makeLookup([sub])
    )
    expect(result.mode).toBe('error')
    if (result.mode === 'error') {
      expect(result.message).toMatch(/does not have a resumable/i)
    }
  })

  it('uses linkedGeminiSessionId for Gemini sub-thread recall', () => {
    const sub = makeChat({
      appChatId: 'sub-gemini',
      parentChatId: parent,
      provider: 'gemini',
      linkedGeminiSessionId: 'gemini-session-1'
    })
    const result = resolveSubThreadRecall(
      { subThreadId: 'sub-gemini', parentChatId: parent, targetProvider: 'gemini' },
      makeLookup([sub])
    )
    expect(result.mode).toBe('recall')
    if (result.mode === 'recall') {
      expect(result.resumeSessionId).toBe('gemini-session-1')
    }
  })

  it('falls back to linkedProviderSessionId for Gemini API-backed sub-thread recall', () => {
    const sub = makeChat({
      appChatId: 'sub-gemini-api',
      parentChatId: parent,
      provider: 'gemini',
      linkedProviderSessionId: 'api://sub-gemini-api'
    })
    const result = resolveSubThreadRecall(
      { subThreadId: 'sub-gemini-api', parentChatId: parent, targetProvider: 'gemini' },
      makeLookup([sub])
    )
    expect(result.mode).toBe('recall')
    if (result.mode === 'recall') {
      expect(result.resumeSessionId).toBe('api://sub-gemini-api')
    }
  })

  it.each(['running', 'queued', 'starting', 'active', 'paused', 'cancelling', 'steer_promoting'])(
    'rejects recall while the sub-thread has a %s run',
    (status) => {
      const sub = makeChat({
        appChatId: `sub-${status}`,
        parentChatId: parent,
        provider: 'kimi',
        linkedProviderSessionId: 'kimi-session-99',
        runs: [{ runId: 'run-1', provider: 'kimi', startedAt: 't', status }]
      })
      const result = resolveSubThreadRecall(
        { subThreadId: `sub-${status}`, parentChatId: parent, targetProvider: 'kimi' },
        makeLookup([sub])
      )
      expect(result.mode).toBe('error')
      if (result.mode === 'error') {
        expect(result.message).toContain(`still ${status}`)
        expect(result.message).toMatch(/rejected in v1/i)
      }
    }
  )

  it('errors when subThreadId does not match any chat', () => {
    const result = resolveSubThreadRecall(
      { subThreadId: 'ghost', parentChatId: parent, targetProvider: 'kimi' },
      makeLookup([])
    )
    expect(result.mode).toBe('error')
    if (result.mode === 'error') {
      expect(result.message).toMatch(/does not match any TaskWraith chat record/i)
    }
  })

  it('errors when the sub-thread belongs to a different parent', () => {
    const sub = makeChat({
      appChatId: 'sub-3',
      parentChatId: 'someone-else',
      provider: 'kimi'
    })
    const result = resolveSubThreadRecall(
      { subThreadId: 'sub-3', parentChatId: parent, targetProvider: 'kimi' },
      makeLookup([sub])
    )
    expect(result.mode).toBe('error')
    if (result.mode === 'error') {
      expect(result.message).toMatch(/belongs to a different parent chat/i)
    }
  })

  it('errors when the sub-thread has no parent at all', () => {
    const sub = makeChat({
      appChatId: 'orphan',
      provider: 'kimi'
    })
    const result = resolveSubThreadRecall(
      { subThreadId: 'orphan', parentChatId: parent, targetProvider: 'kimi' },
      makeLookup([sub])
    )
    expect(result.mode).toBe('error')
    if (result.mode === 'error') {
      expect(result.message).toMatch(/no parent/i)
    }
  })

  it('errors when the sub-thread runs a different provider', () => {
    const sub = makeChat({
      appChatId: 'sub-4',
      parentChatId: parent,
      provider: 'codex'
    })
    const result = resolveSubThreadRecall(
      { subThreadId: 'sub-4', parentChatId: parent, targetProvider: 'kimi' },
      makeLookup([sub])
    )
    expect(result.mode).toBe('error')
    if (result.mode === 'error') {
      expect(result.message).toMatch(/runs codex/i)
      expect(result.message).toMatch(/requested provider="kimi"/i)
    }
  })

  it('errors when the matched sub-thread is archived', () => {
    const sub = makeChat({
      appChatId: 'sub-5',
      parentChatId: parent,
      provider: 'kimi',
      archived: true
    })
    const result = resolveSubThreadRecall(
      { subThreadId: 'sub-5', parentChatId: parent, targetProvider: 'kimi' },
      makeLookup([sub])
    )
    expect(result.mode).toBe('error')
    if (result.mode === 'error') {
      expect(result.message).toMatch(/archived/i)
    }
  })

  it('treats whitespace-padded subThreadId as the trimmed id', () => {
    const sub = makeChat({
      appChatId: 'sub-6',
      parentChatId: parent,
      provider: 'kimi',
      linkedProviderSessionId: 'session-x'
    })
    const result = resolveSubThreadRecall(
      { subThreadId: '  sub-6  ', parentChatId: parent, targetProvider: 'kimi' },
      makeLookup([sub])
    )
    expect(result.mode).toBe('recall')
    if (result.mode === 'recall') {
      expect(result.chat.appChatId).toBe('sub-6')
      expect(result.resumeSessionId).toBe('session-x')
    }
  })
})
