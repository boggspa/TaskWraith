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

  it('maps the shared effort argument to Claude\'s provider-specific payload field', () => {
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

  it('rejects provider-incompatible or unknown controls before dispatch', () => {
    expect(
      resolveSubThreadDelegationRunSettings({ provider: 'kimi', reasoningEffort: 'high' })
    ).toMatchObject({ ok: false, message: expect.stringMatching(/default.*does not expose/i) })
    expect(
      resolveSubThreadDelegationRunSettings({ provider: 'codex', reasoningEffort: 'warp' })
    ).toMatchObject({ ok: false, message: expect.stringMatching(/reasoningEffort.*codex/i) })
    expect(
      resolveSubThreadDelegationRunSettings({ provider: 'claude', kimiThinking: true })
    ).toMatchObject({ ok: false, message: expect.stringMatching(/only supported for kimi/i) })
  })

  it('rejects a reasoning tier for a known model that does not expose reasoning controls', () => {
    expect(
      resolveSubThreadDelegationRunSettings({
        provider: 'grok',
        model: 'grok-composer-2.5-fast',
        reasoningEffort: 'high'
      })
    ).toMatchObject({
      ok: false,
      message: expect.stringMatching(/grok-composer-2\.5-fast.*does not expose/i)
    })
    expect(
      resolveSubThreadDelegationRunSettings({
        provider: 'cursor',
        reasoningEffort: 'high'
      })
    ).toMatchObject({
      ok: false,
      message: expect.stringMatching(/default.*does not expose/i)
    })
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

    expect(
      resolveSubThreadDelegationRunSettings({ provider: 'codex', recallChat })
    ).toEqual({
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

  it.each([
    { model: 'gpt-5.6-terra' },
    { reasoningEffort: 'high' },
    { kimiThinking: false }
  ])('rejects mutable model controls on recall: %o', (controls) => {
    const result = resolveSubThreadDelegationRunSettings({
      provider: 'codex',
      recallChat: makeSubThread({}),
      ...controls
    })
    expect(result).toMatchObject({
      ok: false,
      message: expect.stringMatching(/spawn-only.*session continuity/i)
    })
  })
})
