import { describe, expect, it } from 'vitest'
import type { ChatRecord } from '../main/store/types'
import {
  applyChatComposerSelectionPatch,
  chatComposerSelectionPatchTouchesProviderMetadata,
  parseChatComposerSelectionPatchRequest,
  sanitizeChatComposerSelectionPatch,
  shouldDeferProviderScopedComposerSelection
} from './chatComposerSelectionPatch'
import { readPendingProviderChange } from './providerChangeQueue'

function chat(overrides: Partial<ChatRecord> = {}): ChatRecord {
  return {
    appChatId: 'chat-1',
    provider: 'claude',
    title: 'Chat',
    scope: 'global',
    createdAt: 1,
    updatedAt: 1,
    archived: false,
    messages: [],
    runs: [],
    ...overrides
  }
}

describe('chat composer selection patch', () => {
  it('accepts only bounded allowlisted primitive metadata', () => {
    expect(
      sanitizeChatComposerSelectionPatch({
        selectedModelType: 'claude-opus-5',
        claudeFastMode: true,
        runtimeProfileId: null,
        geminiAuthProfileId: undefined
      })
    ).toEqual({
      selectedModelType: 'claude-opus-5',
      claudeFastMode: true,
      runtimeProfileId: null
    })
    expect(sanitizeChatComposerSelectionPatch({ messages: [] })).toBeNull()
    expect(sanitizeChatComposerSelectionPatch({ claudeFastMode: 'yes' })).toBeNull()
    expect(sanitizeChatComposerSelectionPatch({ permissionPresetId: 'root' })).toBeNull()
    expect(sanitizeChatComposerSelectionPatch({ customModel: 'x'.repeat(4_097) })).toBeNull()
  })

  it('parses the small request envelope and rejects malformed provider/defer fields', () => {
    expect(
      parseChatComposerSelectionPatchRequest({
        chatId: 'chat-1',
        provider: 'claude',
        deferProviderScoped: true,
        queuedAt: '2026-08-26T12:00:00.000Z',
        patch: { selectedModelType: 'claude-opus-5' }
      })
    ).toEqual({
      chatId: 'chat-1',
      provider: 'claude',
      deferProviderScoped: true,
      queuedAt: '2026-08-26T12:00:00.000Z',
      patch: { selectedModelType: 'claude-opus-5' }
    })
    expect(
      parseChatComposerSelectionPatchRequest({
        chatId: 'chat-1',
        provider: 'retired-provider',
        patch: { selectedModelType: 'model' }
      })
    ).toBeNull()
    expect(
      parseChatComposerSelectionPatchRequest({
        chatId: 'chat-1',
        provider: 'claude',
        deferProviderScoped: 'yes',
        patch: { selectedModelType: 'model' }
      })
    ).toBeNull()
  })

  it('patches metadata without cloning transcript arrays and skips exact no-ops', () => {
    const source = chat({
      providerMetadata: { selectedModelType: 'claude-sonnet-5' },
      workflowMode: 'normal'
    })
    const request = parseChatComposerSelectionPatchRequest({
      chatId: source.appChatId,
      provider: 'claude',
      patch: {
        selectedModelType: 'claude-opus-5',
        workflowMode: 'plan',
        approvalMode: 'plan'
      }
    })!
    const updated = applyChatComposerSelectionPatch(source, request, () => 42)

    expect(updated).not.toBe(source)
    expect(updated.messages).toBe(source.messages)
    expect(updated.runs).toBe(source.runs)
    expect(updated.workflowMode).toBe('plan')
    expect(updated.providerMetadata).toMatchObject({
      selectedModelType: 'claude-opus-5',
      workflowMode: 'plan',
      approvalMode: 'plan'
    })
    expect(updated.updatedAt).toBe(42)

    const noOp = applyChatComposerSelectionPatch(
      updated,
      { ...request, patch: { selectedModelType: 'claude-opus-5', workflowMode: 'plan' } },
      () => 99
    )
    expect(noOp).toBe(updated)
  })

  it('queues provider-scoped edits without changing the live provider or session', () => {
    const source = chat({ linkedProviderSessionId: 'session-1', workflowMode: 'normal' })
    const request = parseChatComposerSelectionPatchRequest({
      chatId: source.appChatId,
      provider: 'claude',
      deferProviderScoped: true,
      queuedAt: '2026-08-26T12:00:00.000Z',
      patch: {
        selectedModelType: 'claude-opus-5',
        claudeReasoningEffort: 'high',
        workflowMode: 'plan'
      }
    })!
    const updated = applyChatComposerSelectionPatch(source, request, () => 42)

    expect(updated.provider).toBe('claude')
    expect(updated.linkedProviderSessionId).toBe('session-1')
    expect(updated.workflowMode).toBe('plan')
    expect(readPendingProviderChange(updated)).toEqual({
      provider: 'claude',
      providerMetadata: request.patch,
      queuedAt: '2026-08-26T12:00:00.000Z'
    })
  })

  it('identifies patches that must use the busy-chat provider queue', () => {
    expect(chatComposerSelectionPatchTouchesProviderMetadata({ claudeFastMode: true })).toBe(true)
    expect(
      chatComposerSelectionPatchTouchesProviderMetadata({ permissionPresetId: 'read_only' })
    ).toBe(false)
  })
})

describe('provider-scoped selection routing', () => {
  // Mirror of the picker's READ rule (Composer.tsx `soloPendingProviderMetadata`
  // -> `pendingSelectedModel` -> `effectiveSelectedModel`), restated here so
  // this test reds the moment the WRITE stops matching the READ.
  function composerVisibleModel(record: ChatRecord): string {
    const pending = readPendingProviderChange(record)
    const pendingModel = pending?.providerMetadata?.selectedModelType
    return typeof pendingModel === 'string'
      ? pendingModel
      : String(
          (record.providerMetadata as { selectedModelType?: unknown } | undefined)
            ?.selectedModelType ?? ''
        )
  }

  it('keeps a pick visible when a queued provider change is pending on an idle chat', () => {
    // First pick, made while the run is live: correctly queued, and the
    // picker shows it because it reads the queued change.
    const busyWrite = applyChatComposerSelectionPatch(chat({ provider: 'muse' }), {
      chatId: 'chat-1',
      patch: { selectedModelType: 'muse-spark-1.3' },
      provider: 'muse',
      deferProviderScoped: true
    })
    expect(composerVisibleModel(busyWrite)).toBe('muse-spark-1.3')

    // Run has ended, so `isChatBusy` is false -- but the queued change has not
    // drained yet, and the picker still reads it. This is the exact decision
    // the renderer makes for the next pick.
    const defer = shouldDeferProviderScopedComposerSelection({
      chatKind: busyWrite.chatKind,
      touchesProviderScopedMetadata: true,
      busy: false,
      hasPendingProviderChange: readPendingProviderChange(busyWrite) !== null
    })
    const idleWrite = applyChatComposerSelectionPatch(busyWrite, {
      chatId: 'chat-1',
      patch: { selectedModelType: 'muse-contributor-spark-1.3' },
      provider: 'muse',
      deferProviderScoped: defer
    })

    expect(composerVisibleModel(idleWrite)).toBe('muse-contributor-spark-1.3')
  })

  it('writes flat when the chat is idle and nothing is queued', () => {
    expect(
      shouldDeferProviderScopedComposerSelection({
        chatKind: 'single',
        touchesProviderScopedMetadata: true,
        busy: false,
        hasPendingProviderChange: false
      })
    ).toBe(false)
  })

  it('never queues on an ensemble chat', () => {
    expect(
      shouldDeferProviderScopedComposerSelection({
        chatKind: 'ensemble',
        touchesProviderScopedMetadata: true,
        busy: true,
        hasPendingProviderChange: true
      })
    ).toBe(false)
  })

  it('leaves a non-provider-scoped patch alone even with a change queued', () => {
    expect(
      shouldDeferProviderScopedComposerSelection({
        chatKind: 'single',
        touchesProviderScopedMetadata: false,
        busy: true,
        hasPendingProviderChange: true
      })
    ).toBe(false)
  })
})
