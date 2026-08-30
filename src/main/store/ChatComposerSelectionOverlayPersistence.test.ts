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
    // Revision transparency: the record stays at the Host-visible revision (7);
    // the overlay's own base+1 pair lives only in the sidecar file.
    expect(result.chat.persistenceRevision).toBe(7)
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
      persistenceRevision: 7,
      updatedAt: 42,
      workflowMode: 'normal',
      providerMetadata: {
        permissionPresetId: 'read_only',
        workflowMode: 'normal'
      }
    })
    expect(replayed.messages).toBe(source.messages)

    // The canonical checkpoint that folds the selection in lands at base+1 and
    // supersedes the overlay; a later revision ignores the stale overlay too.
    const foldedCheckpoint = { ...persisted.chat, persistenceRevision: 8 }
    expect(restarted.apply(foldedCheckpoint)).toBe(foldedCheckpoint)
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

    expect(second.chat.persistenceRevision).toBe(7)
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
    expect(deferred.chat.persistenceRevision).toBe(7)
  })

  it('never moves the record revision off the Host CAS chain (2026-08-30 wedge)', async () => {
    // Regression: the overlay used to stamp persistenceRevision = base+1, a
    // revision the Host had never written. Every saveChatThroughHost after a
    // picker change then asked the Host to CAS against base+1 while its record
    // sat at base — thread_record_revision_conflict on every persist, and the
    // conflict recovery re-derived the same unsatisfiable revision because it
    // also reads through apply(). 842 conflicts in three days on the live
    // release profile; one thread failing 95/95 persists.
    const source = chat()
    const store = new ChatComposerSelectionOverlayStore(path.join(testRoot, 'chats'))

    const result = await store.persist(
      source,
      request({ selectedModelType: 'claude-opus-5' }),
      () => 42
    )

    // The patched record stays at the Host-visible revision...
    expect(result.chat.persistenceRevision).toBe(7)
    // ...and replaying the overlay over the durable record does not move it
    // either, so the next whole-record persist keeps
    // expectedRevision === the Host's revision.
    const replayed = store.apply(source)
    expect(replayed.providerMetadata).toMatchObject({ selectedModelType: 'claude-opus-5' })
    expect(replayed.persistenceRevision).toBe(7)
    // The canonical checkpoint that folds the selection in lands at base+1 and
    // supersedes the overlay (the record itself now carries the patch).
    const checkpointed = { ...result.chat, persistenceRevision: 8 }
    expect(store.apply(checkpointed)).toBe(checkpointed)
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
