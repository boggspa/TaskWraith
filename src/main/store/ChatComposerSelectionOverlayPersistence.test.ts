import * as fs from 'fs'
import * as path from 'path'
import { afterEach, describe, expect, it } from 'vitest'
import type { ChatComposerSelectionPatchRequest } from '../../shared/chatComposerSelectionPatch'
import { readPendingProviderChange } from '../../shared/providerChangeQueue'
import { ChatComposerSelectionOverlayStore } from './ChatComposerSelectionOverlayPersistence'
import type { ChatRecord } from './types'

const testRoot = path.join('/tmp', `taskwraith-composer-selection-overlay-${process.pid}`)

afterEach(() => {
  fs.rmSync(testRoot, { recursive: true, force: true })
})

function chat(overrides: Partial<ChatRecord> = {}): ChatRecord {
  return {
    appChatId: 'chat-1',
    provider: 'claude',
    title: 'Large chat',
    scope: 'global',
    createdAt: 1,
    updatedAt: 1,
    persistenceRevision: 7,
    archived: false,
    messages: [
      {
        id: 'large-message',
        role: 'user',
        content: 'x'.repeat(8 * 1024 * 1024),
        timestamp: '2026-08-26T12:00:00.000Z'
      }
    ],
    runs: [],
    providerMetadata: { selectedModelType: 'claude-sonnet-5' },
    ...overrides
  }
}

function request(
  patch: ChatComposerSelectionPatchRequest['patch']
): ChatComposerSelectionPatchRequest {
  return {
    chatId: 'chat-1',
    provider: 'claude',
    deferProviderScoped: false,
    patch
  }
}

describe('ChatComposerSelectionOverlayStore', () => {
  it('persists an 8 MiB chat selection as a tiny overlay without cloning transcript arrays', async () => {
    const source = chat()
    const store = new ChatComposerSelectionOverlayStore(path.join(testRoot, 'chats'))

    const result = await store.persist(
      source,
      request({ selectedModelType: 'claude-opus-5', claudeReasoningEffort: 'high' }),
      () => 42
    )

    expect(result.changed).toBe(true)
    expect(result.chat.messages).toBe(source.messages)
    expect(result.chat.runs).toBe(source.runs)
    expect(result.chat.persistenceRevision).toBe(8)
    expect(result.chat.providerMetadata).toMatchObject({
      selectedModelType: 'claude-opus-5',
      claudeReasoningEffort: 'high'
    })
    const files = fs.readdirSync(path.join(testRoot, 'chat-composer-selections'))
    expect(files).toEqual(['chat-1.json'])
    expect(
      fs.statSync(path.join(testRoot, 'chat-composer-selections', 'chat-1.json')).size
    ).toBeLessThan(2_000)
  })

  it('replays after restart and is superseded by the next ordinary chat revision', async () => {
    const source = chat()
    const chatsDir = path.join(testRoot, 'chats')
    const writer = new ChatComposerSelectionOverlayStore(chatsDir)
    const persisted = await writer.persist(
      source,
      request({ permissionPresetId: 'read_only', workflowMode: 'normal' }),
      () => 42
    )
    const restarted = new ChatComposerSelectionOverlayStore(chatsDir)

    const replayed = restarted.apply(source)
    expect(replayed).toMatchObject({
      persistenceRevision: 8,
      updatedAt: 42,
      workflowMode: 'normal',
      providerMetadata: {
        permissionPresetId: 'read_only',
        workflowMode: 'normal'
      }
    })
    expect(replayed.messages).toBe(source.messages)

    const ordinaryCheckpoint = { ...persisted.chat, persistenceRevision: 9 }
    expect(restarted.apply(ordinaryCheckpoint)).toBe(ordinaryCheckpoint)
  })

  it('coalesces later overlay writes at one revision and skips exact no-ops', async () => {
    const source = chat()
    const store = new ChatComposerSelectionOverlayStore(path.join(testRoot, 'chats'))
    const first = await store.persist(
      source,
      request({ selectedModelType: 'claude-opus-5' }),
      () => 42
    )
    const second = await store.persist(
      first.chat,
      request({ claudeReasoningEffort: 'high' }),
      () => 43
    )
    const noOp = await store.persist(
      second.chat,
      request({ claudeReasoningEffort: 'high' }),
      () => 44
    )

    expect(second.chat.persistenceRevision).toBe(8)
    expect(second.chat.providerMetadata).toMatchObject({
      selectedModelType: 'claude-opus-5',
      claudeReasoningEffort: 'high'
    })
    expect(noOp).toEqual({ chat: second.chat, changed: false })

    const restarted = new ChatComposerSelectionOverlayStore(path.join(testRoot, 'chats'))
    expect(restarted.apply(source).providerMetadata).toMatchObject({
      selectedModelType: 'claude-opus-5',
      claudeReasoningEffort: 'high'
    })
  })

  it('materializes immediate and busy-deferred fields in their distinct locations', async () => {
    const source = chat()
    const chatsDir = path.join(testRoot, 'chats')
    const store = new ChatComposerSelectionOverlayStore(chatsDir)
    const immediate = await store.persist(
      source,
      request({ permissionPresetId: 'read_only', approvalMode: 'plan' }),
      () => 42
    )
    const deferred = await store.persist(
      immediate.chat,
      {
        ...request({ selectedModelType: 'claude-opus-5' }),
        deferProviderScoped: true,
        queuedAt: '2026-08-26T12:00:00.000Z'
      },
      () => 43
    )

    const replayed = new ChatComposerSelectionOverlayStore(chatsDir).apply(source)
    expect(replayed.providerMetadata).toMatchObject({
      permissionPresetId: 'read_only',
      approvalMode: 'plan',
      selectedModelType: 'claude-sonnet-5'
    })
    expect(readPendingProviderChange(replayed)).toEqual({
      provider: 'claude',
      providerMetadata: { selectedModelType: 'claude-opus-5' },
      queuedAt: '2026-08-26T12:00:00.000Z'
    })
    expect(deferred.chat.persistenceRevision).toBe(8)
  })

  it('removes the adjacent overlay with chat deletion', async () => {
    const store = new ChatComposerSelectionOverlayStore(path.join(testRoot, 'chats'))
    await store.persist(chat(), request({ selectedModelType: 'claude-opus-5' }))

    store.delete('chat-1')

    expect(fs.existsSync(path.join(testRoot, 'chat-composer-selections', 'chat-1.json'))).toBe(
      false
    )
  })
})
