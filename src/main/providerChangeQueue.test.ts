import { describe, expect, it } from 'vitest'
import type { ChatRecord } from './store/types'
import {
  PENDING_PROVIDER_CHANGE_KEY,
  applyPendingProviderChangeOnFinalize,
  applyProviderChange,
  hasPendingProviderChange,
  queueProviderChange,
  readPendingProviderChange
} from './providerChangeQueue'

function chat(overrides: Partial<ChatRecord> = {}): ChatRecord {
  return {
    appChatId: 'chat-1',
    title: 'Chat',
    createdAt: 1,
    updatedAt: 1,
    archived: false,
    provider: 'claude',
    messages: [
      { id: 'm1', role: 'user', content: 'hi', timestamp: '2026-07-04T00:00:00.000Z' }
    ],
    runs: [{ runId: 'r1', provider: 'claude', startedAt: '2026-07-04T00:00:00.000Z', status: 'success' }],
    ...overrides
  } as ChatRecord
}

describe('readPendingProviderChange', () => {
  it('returns null when no pending change is stored', () => {
    expect(readPendingProviderChange(chat())).toBeNull()
    expect(readPendingProviderChange(chat({ providerMetadata: { selectedModelType: 'x' } }))).toBeNull()
  })

  it('returns null when the stored provider is not a real ProviderId', () => {
    const bad = chat({
      providerMetadata: { [PENDING_PROVIDER_CHANGE_KEY]: { provider: 'not-a-provider' } }
    })
    expect(readPendingProviderChange(bad)).toBeNull()
  })

  it('parses a valid pending change including metadata + queuedAt', () => {
    const c = chat({
      providerMetadata: {
        [PENDING_PROVIDER_CHANGE_KEY]: {
          provider: 'codex',
          providerMetadata: { selectedModelType: 'gpt-5.5', codexReasoningEffort: 'high' },
          queuedAt: '2026-07-04T01:00:00.000Z'
        }
      }
    })
    expect(readPendingProviderChange(c)).toEqual({
      provider: 'codex',
      providerMetadata: { selectedModelType: 'gpt-5.5', codexReasoningEffort: 'high' },
      queuedAt: '2026-07-04T01:00:00.000Z'
    })
    expect(hasPendingProviderChange(c)).toBe(true)
  })
})

describe('queueProviderChange (running path)', () => {
  it('records the switch WITHOUT changing provider or clearing sessions', () => {
    const before = chat({
      provider: 'claude',
      linkedProviderSessionId: 'sess-claude',
      providerMetadata: { selectedModelType: 'claude-sonnet' }
    })
    const after = queueProviderChange(before, {
      provider: 'codex',
      providerMetadata: { selectedModelType: 'gpt-5.5' }
    })

    // In-flight run keeps the old provider + session.
    expect(after.provider).toBe('claude')
    expect(after.linkedProviderSessionId).toBe('sess-claude')
    // Existing metadata preserved; pending recorded.
    expect(after.providerMetadata?.selectedModelType).toBe('claude-sonnet')
    expect(readPendingProviderChange(after)).toEqual({
      provider: 'codex',
      providerMetadata: { selectedModelType: 'gpt-5.5' }
    })
    // Input not mutated.
    expect(hasPendingProviderChange(before)).toBe(false)
  })
})

describe('applyProviderChange (idle path + turn-end apply)', () => {
  it('switches provider, merges metadata, clears both linked session ids, drops pending', () => {
    const before = chat({
      provider: 'claude',
      linkedProviderSessionId: 'sess-claude',
      linkedGeminiSessionId: 'sess-gemini',
      taskWraithMcpProfileReceipt: {
        schemaVersion: 1,
        profileId: 'taskwraith-core-v1',
        provider: 'claude',
        providerSessionId: 'sess-claude',
        pinnedAt: '2026-07-11T00:00:00.000Z'
      },
      providerMetadata: {
        selectedModelType: 'claude-sonnet',
        taskWraithRuntimePreambleVersion: 'v1', // unrelated key must survive
        [PENDING_PROVIDER_CHANGE_KEY]: { provider: 'codex' }
      }
    })
    const after = applyProviderChange(before, {
      provider: 'codex',
      providerMetadata: { selectedModelType: 'gpt-5.5', codexReasoningEffort: 'high' }
    })

    expect(after.provider).toBe('codex')
    // Session hygiene: both linked ids gone (a switched provider must not resume old session).
    expect('linkedProviderSessionId' in after).toBe(false)
    expect('linkedGeminiSessionId' in after).toBe(false)
    expect(after.taskWraithMcpProfileReceipt).toBeUndefined()
    // New provider metadata applied; unrelated key preserved; pending dropped.
    expect(after.providerMetadata?.selectedModelType).toBe('gpt-5.5')
    expect(after.providerMetadata?.codexReasoningEffort).toBe('high')
    expect(after.providerMetadata?.taskWraithRuntimePreambleVersion).toBe('v1')
    expect(after.providerMetadata?.[PENDING_PROVIDER_CHANGE_KEY]).toBeUndefined()
  })

  it('keeps the pinned MCP profile on the same native session across a model change', () => {
    const before = chat({
      provider: 'claude',
      linkedProviderSessionId: 'sess-claude',
      taskWraithMcpProfileReceipt: {
        schemaVersion: 1,
        profileId: 'taskwraith-core-v1',
        provider: 'claude',
        providerSessionId: 'sess-claude',
        pinnedAt: '2026-07-11T00:00:00.000Z'
      },
      providerMetadata: { selectedModelType: 'claude-sonnet' }
    })
    // Same provider, only model/reasoning changes (the mid-turn unlock case).
    const after = applyProviderChange(before, {
      provider: 'claude',
      providerMetadata: { selectedModelType: 'claude-opus', claudeReasoningEffort: 'high' }
    })

    // The MCP profile follows the actual native session identity. Changing the
    // model does not change that birth-pinned tool surface.
    expect(after.provider).toBe('claude')
    expect(after.linkedProviderSessionId).toBe('sess-claude')
    expect(after.taskWraithMcpProfileReceipt).toMatchObject({
      profileId: 'taskwraith-core-v1',
      providerSessionId: 'sess-claude'
    })
    // …but the model/reasoning metadata did update.
    expect(after.providerMetadata?.selectedModelType).toBe('claude-opus')
    expect(after.providerMetadata?.claudeReasoningEffort).toBe('high')
  })

  it('keeps legacy same-provider model changes on their existing session', () => {
    const before = chat({
      provider: 'claude',
      linkedProviderSessionId: 'legacy-claude-session',
      providerMetadata: { selectedModelType: 'claude-sonnet' }
    })

    const after = applyProviderChange(before, {
      provider: 'claude',
      providerMetadata: { selectedModelType: 'claude-opus' }
    })

    expect(after.linkedProviderSessionId).toBe('legacy-claude-session')
    expect(after.taskWraithMcpProfileReceipt).toBeUndefined()
  })

  it('keeps the MCP profile receipt for same-provider non-model metadata changes', () => {
    const receipt = {
      schemaVersion: 1 as const,
      profileId: 'taskwraith-core-v1' as const,
      provider: 'claude' as const,
      providerSessionId: 'sess-claude',
      pinnedAt: '2026-07-11T00:00:00.000Z'
    }
    const before = chat({
      provider: 'claude',
      linkedProviderSessionId: 'sess-claude',
      taskWraithMcpProfileReceipt: receipt,
      providerMetadata: { selectedModelType: 'claude-sonnet' }
    })

    const after = applyProviderChange(before, {
      provider: 'claude',
      providerMetadata: { claudeReasoningEffort: 'high' }
    })

    expect(after.taskWraithMcpProfileReceipt).toBe(receipt)
  })

  it('clears the gemini session on a genuine provider switch', () => {
    const before = chat({ provider: 'gemini', linkedGeminiSessionId: 'g-sess' })
    const after = applyProviderChange(before, { provider: 'claude' })
    expect(after.provider).toBe('claude')
    expect('linkedGeminiSessionId' in after).toBe(false)
  })

  it('never touches messages / runs / ensemble (historical transcript preserved)', () => {
    const before = chat({ ensemble: { participants: [] } as never })
    const after = applyProviderChange(before, { provider: 'grok' })
    expect(after.messages).toBe(before.messages)
    expect(after.runs).toBe(before.runs)
    expect(after.ensemble).toBe(before.ensemble)
  })

  it('does not mutate its input', () => {
    const before = chat({ provider: 'claude', linkedProviderSessionId: 'sess' })
    applyProviderChange(before, { provider: 'codex' })
    expect(before.provider).toBe('claude')
    expect(before.linkedProviderSessionId).toBe('sess')
  })
})

describe('applyPendingProviderChangeOnFinalize (turn-end)', () => {
  it('returns the same record when nothing is queued', () => {
    const c = chat()
    expect(applyPendingProviderChangeOnFinalize(c)).toBe(c)
  })

  it('applies a queued switch at finalize: provider switched, sessions cleared, pending gone', () => {
    const queued = queueProviderChange(
      chat({ provider: 'claude', linkedProviderSessionId: 'sess-claude' }),
      { provider: 'codex', providerMetadata: { selectedModelType: 'gpt-5.5' } }
    )
    const finalized = applyPendingProviderChangeOnFinalize(queued)
    expect(finalized.provider).toBe('codex')
    expect('linkedProviderSessionId' in finalized).toBe(false)
    expect(finalized.providerMetadata?.selectedModelType).toBe('gpt-5.5')
    expect(hasPendingProviderChange(finalized)).toBe(false)
  })

  it('applies a queued SAME-provider model change at finalize WITHOUT clearing the session', () => {
    const queued = queueProviderChange(
      chat({ provider: 'claude', linkedProviderSessionId: 'sess-claude' }),
      { provider: 'claude', providerMetadata: { selectedModelType: 'claude-opus' } }
    )
    const finalized = applyPendingProviderChangeOnFinalize(queued)
    expect(finalized.provider).toBe('claude')
    expect(finalized.linkedProviderSessionId).toBe('sess-claude')
    expect(finalized.providerMetadata?.selectedModelType).toBe('claude-opus')
    expect(hasPendingProviderChange(finalized)).toBe(false)
  })

  it('drops a queued historical provider without changing the active provider', () => {
    const queued = queueProviderChange(
      chat({ provider: 'claude', linkedProviderSessionId: 'sess-claude' }),
      { provider: 'cursor', providerMetadata: { selectedModelType: 'composer-2.5' } }
    )

    const finalized = applyPendingProviderChangeOnFinalize(queued)

    expect(finalized.provider).toBe('claude')
    expect(finalized.linkedProviderSessionId).toBe('sess-claude')
    expect(finalized.providerMetadata?.selectedModelType).toBeUndefined()
    expect(hasPendingProviderChange(finalized)).toBe(false)
  })
})
