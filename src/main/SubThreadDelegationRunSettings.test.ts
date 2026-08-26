import { describe, expect, it } from 'vitest'
import { resolveSubThreadDelegationRunSettings } from './SubThreadDelegationRunSettings'
import type { ChatRecord } from './store/types'

function makeSubThread(overrides: Partial<ChatRecord>): ChatRecord {
  return {
    appChatId: 'sub-1',
    title: 'Delegated seat',
    provider: 'codex',
    parentChatId: 'parent-1',
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

describe('resolveSubThreadDelegationRunSettings', () => {
  it('keeps the provider default when a fresh delegation omits model controls', () => {
    expect(resolveSubThreadDelegationRunSettings({ provider: 'codex' })).toEqual({
      ok: true,
      requestedModel: 'cli-default',
      runPayload: { model: 'cli-default' },
      providerMetadataPatch: { selectedModelType: 'cli-default' }
    })
  })

  it('maps a fresh Codex model and effort onto the run and persisted seat settings', () => {
    expect(
      resolveSubThreadDelegationRunSettings({
        provider: 'codex',
        model: '  gpt-5.6-terra  ',
        reasoningEffort: 'XHIGH'
      })
    ).toEqual({
      ok: true,
      requestedModel: 'gpt-5.6-terra',
      reasoningEffort: 'xhigh',
      runPayload: { model: 'gpt-5.6-terra', reasoningEffort: 'xhigh' },
      providerMetadataPatch: {
        selectedModelType: 'gpt-5.6-terra',
        codexReasoningEffort: 'xhigh'
      }
    })
  })

  it("maps the shared effort argument to Claude's provider-specific payload field", () => {
    expect(
      resolveSubThreadDelegationRunSettings({
        provider: 'claude',
        model: 'claude-opus-4-8-1m',
        reasoningEffort: 'max'
      })
    ).toMatchObject({
      ok: true,
      requestedModel: 'claude-opus-4-8-1m',
      runPayload: {
        model: 'claude-opus-4-8-1m',
        claudeReasoningEffort: 'max'
      },
      providerMetadataPatch: {
        selectedModelType: 'claude-opus-4-8-1m',
        claudeReasoningEffort: 'max'
      }
    })
  })

  it('keeps K2.7 Coding thinking on and rejects attempts to disable it', () => {
    expect(
      resolveSubThreadDelegationRunSettings({
        provider: 'kimi',
        model: 'kimi-k2.7-code',
        kimiThinking: true
      })
    ).toEqual({
      ok: true,
      requestedModel: 'kimi-k2.7-code',
      kimiThinking: true,
      runPayload: { model: 'kimi-k2.7-code', kimiThinking: true },
      providerMetadataPatch: {
        selectedModelType: 'kimi-k2.7-code',
        kimiThinkingEnabled: true
      }
    })
    expect(
      resolveSubThreadDelegationRunSettings({ provider: 'kimi', kimiThinking: false })
    ).toMatchObject({ ok: false, message: expect.stringMatching(/always on.*cannot be disabled/i) })
  })

  it('supports K3 Low, High, and Max effort while keeping thinking on', () => {
    expect(
      resolveSubThreadDelegationRunSettings({
        provider: 'kimi',
        model: 'kimi-k3',
        reasoningEffort: 'HIGH'
      })
    ).toEqual({
      ok: true,
      requestedModel: 'kimi-k3',
      reasoningEffort: 'high',
      kimiThinking: true,
      runPayload: { model: 'kimi-k3', reasoningEffort: 'high', kimiThinking: true },
      providerMetadataPatch: {
        selectedModelType: 'kimi-k3',
        kimiReasoningEffort: 'high',
        kimiThinkingEnabled: true
      }
    })
  })

  it('preserves fixed-256K K3 as a distinct route with the same effort ladder', () => {
    expect(
      resolveSubThreadDelegationRunSettings({
        provider: 'kimi',
        model: 'kimi-k3-256k',
        reasoningEffort: 'LOW'
      })
    ).toEqual({
      ok: true,
      requestedModel: 'kimi-k3-256k',
      reasoningEffort: 'low',
      kimiThinking: true,
      runPayload: { model: 'kimi-k3-256k', reasoningEffort: 'low', kimiThinking: true },
      providerMetadataPatch: {
        selectedModelType: 'kimi-k3-256k',
        kimiReasoningEffort: 'low',
        kimiThinkingEnabled: true
      }
    })
  })

  it('normalizes K2.7 to its fixed On setting and rejects unknown controls before dispatch', () => {
    expect(
      resolveSubThreadDelegationRunSettings({ provider: 'kimi', reasoningEffort: 'high' })
    ).toEqual({
      ok: true,
      requestedModel: 'cli-default',
      reasoningEffort: 'on',
      kimiThinking: true,
      runPayload: { model: 'cli-default', reasoningEffort: 'on', kimiThinking: true },
      providerMetadataPatch: {
        selectedModelType: 'cli-default',
        kimiReasoningEffort: 'on',
        kimiThinkingEnabled: true
      }
    })
    expect(
      resolveSubThreadDelegationRunSettings({ provider: 'codex', reasoningEffort: 'warp' })
    ).toMatchObject({ ok: false, message: expect.stringMatching(/reasoningEffort.*codex/i) })
    expect(
      resolveSubThreadDelegationRunSettings({ provider: 'claude', kimiThinking: true })
    ).toMatchObject({ ok: false, message: expect.stringMatching(/only supported for kimi/i) })
  })

  it('omits reasoning for Grok/Cursor models that do not expose an effort axis', () => {
    expect(
      resolveSubThreadDelegationRunSettings({
        provider: 'grok',
        model: 'grok-composer-2.5-fast',
        reasoningEffort: 'high'
      })
    ).toEqual({
      ok: true,
      requestedModel: 'grok-composer-2.5-fast',
      runPayload: { model: 'grok-composer-2.5-fast' },
      providerMetadataPatch: { selectedModelType: 'grok-composer-2.5-fast' }
    })
    expect(
      resolveSubThreadDelegationRunSettings({
        provider: 'cursor',
        reasoningEffort: 'high'
      })
    ).toEqual({
      ok: true,
      requestedModel: 'cli-default',
      runPayload: { model: 'cli-default' },
      providerMetadataPatch: { selectedModelType: 'cli-default' }
    })
  })

  it('supports Extra High for Grok 4.6 while retaining Grok 4.5 limits', () => {
    expect(
      resolveSubThreadDelegationRunSettings({
        provider: 'grok',
        model: 'grok-4.6',
        reasoningEffort: 'xhigh'
      })
    ).toMatchObject({
      ok: true,
      requestedModel: 'grok-4.6',
      runPayload: { model: 'grok-4.6', reasoningEffort: 'xhigh' },
      providerMetadataPatch: { grokReasoningEffort: 'xhigh' }
    })
    expect(
      resolveSubThreadDelegationRunSettings({
        provider: 'cursor',
        model: 'grok-4.6',
        reasoningEffort: 'xhigh'
      })
    ).toMatchObject({
      ok: true,
      requestedModel: 'grok-4.6',
      runPayload: { model: 'grok-4.6', reasoningEffort: 'xhigh' },
      providerMetadataPatch: { cursorReasoningEffort: 'xhigh' }
    })
    expect(
      resolveSubThreadDelegationRunSettings({
        provider: 'grok',
        model: 'grok-4.5',
        reasoningEffort: 'xhigh'
      })
    ).toMatchObject({
      ok: true,
      requestedModel: 'grok-4.5',
      reasoningEffort: 'high',
      runPayload: { model: 'grok-4.5', reasoningEffort: 'high' }
    })
  })

  it('max-maps delegated reasoning through each provider wire vocabulary', () => {
    const cases = [
      {
        request: {
          provider: 'mistral' as const,
          model: 'devstral-small',
          reasoningEffort: 'ultracode'
        },
        effort: 'max',
        metadataKey: 'mistralReasoningEffort'
      },
      {
        request: {
          provider: 'pi' as const,
          model: 'deepseek/deepseek-v4-flash',
          reasoningEffort: 'ultratask'
        },
        effort: 'max',
        metadataKey: 'piReasoningEffort'
      },
      {
        request: {
          provider: 'muse' as const,
          model: 'muse-spark-1.2',
          reasoningEffort: 'max'
        },
        effort: 'ultra',
        metadataKey: 'museReasoningEffort'
      },
      {
        request: {
          provider: 'antigravity' as const,
          model: 'gemini-3.6-flash-medium',
          reasoningEffort: 'ultratask'
        },
        effort: 'high',
        metadataKey: 'antigravityReasoningEffort'
      },
      {
        request: {
          provider: 'ollama' as const,
          model: 'qwen3.5:9b',
          reasoningEffort: 'ultratask'
        },
        effort: 'on',
        metadataKey: 'ollamaReasoningEffort'
      },
      {
        request: {
          provider: 'ollama' as const,
          model: 'gpt-oss:20b',
          reasoningEffort: 'max'
        },
        effort: 'high',
        metadataKey: 'ollamaReasoningEffort'
      }
    ]

    for (const { request, effort, metadataKey } of cases) {
      const result = resolveSubThreadDelegationRunSettings(request)
      expect(result).toMatchObject({
        ok: true,
        requestedModel: request.model,
        reasoningEffort: effort,
        runPayload: { model: request.model, reasoningEffort: effort },
        providerMetadataPatch: { [metadataKey]: effort }
      })
    }
  })

  it('omits an effort for known non-thinking Pi, Mistral, and Ollama models', () => {
    for (const request of [
      {
        provider: 'pi' as const,
        model: 'mistral/mistral-large-2512',
        reasoningEffort: 'max'
      },
      {
        provider: 'mistral' as const,
        model: 'mistral-large-2512',
        reasoningEffort: 'max'
      },
      {
        provider: 'ollama' as const,
        model: 'gemma3:4b',
        reasoningEffort: 'max'
      }
    ]) {
      expect(resolveSubThreadDelegationRunSettings(request)).toEqual({
        ok: true,
        requestedModel: request.model,
        runPayload: { model: request.model },
        providerMetadataPatch: { selectedModelType: request.model }
      })
    }
  })

  it('inherits the latest seat settings on recall', () => {
    const recallChat = makeSubThread({
      requestedModel: 'gpt-5.6-sol',
      providerMetadata: {
        selectedModelType: 'gpt-5.6-sol',
        codexReasoningEffort: 'max'
      },
      runs: [
        {
          runId: 'run-1',
          provider: 'codex',
          startedAt: '2026-07-11T10:00:00.000Z',
          requestedModel: 'gpt-5.6-terra',
          providerMetadata: { codexReasoningEffort: 'high' },
          status: 'completed'
        },
        {
          runId: 'run-2',
          provider: 'codex',
          startedAt: '2026-07-11T11:00:00.000Z',
          requestedModel: 'gpt-5.6-sol',
          providerMetadata: { codexReasoningEffort: 'max' },
          status: 'completed'
        }
      ]
    })

    expect(resolveSubThreadDelegationRunSettings({ provider: 'codex', recallChat })).toEqual({
      ok: true,
      requestedModel: 'gpt-5.6-sol',
      reasoningEffort: 'max',
      runPayload: { model: 'gpt-5.6-sol', reasoningEffort: 'max' },
      providerMetadataPatch: {
        selectedModelType: 'gpt-5.6-sol',
        codexReasoningEffort: 'max'
      }
    })
  })

  it.each([{ model: 'gpt-5.6-terra' }, { reasoningEffort: 'high' }, { kimiThinking: false }])(
    'rejects mutable model controls on recall: %o',
    (controls) => {
      const result = resolveSubThreadDelegationRunSettings({
        provider: 'codex',
        recallChat: makeSubThread({}),
        ...controls
      })
      expect(result).toMatchObject({
        ok: false,
        message: expect.stringMatching(/spawn-only.*session continuity/i)
      })
    }
  )
})
