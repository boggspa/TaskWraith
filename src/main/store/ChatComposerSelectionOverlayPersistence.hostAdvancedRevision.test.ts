import * as fs from 'fs'
import * as path from 'path'
import { afterEach, describe, expect, it } from 'vitest'
import type { ChatComposerSelectionPatchRequest } from '../../shared/chatComposerSelectionPatch'
import {
  applyPendingProviderChangeOnFinalize,
  readPendingProviderChange
} from '../../shared/providerChangeQueue'
import { ChatComposerSelectionOverlayStore } from './ChatComposerSelectionOverlayPersistence'
import type { ChatRecord } from './types'

const testRoot = path.join('/tmp', `taskwraith-composer-overlay-host-revision-${process.pid}`)

afterEach(() => {
  fs.rmSync(testRoot, { recursive: true, force: true })
})

function chat(overrides: Partial<ChatRecord> = {}): ChatRecord {
  return {
    appChatId: 'chat-1',
    provider: 'claude',
    title: 'Host-advanced chat',
    scope: 'global',
    createdAt: 1,
    updatedAt: 1,
    persistenceRevision: 7,
    archived: false,
    messages: [
      {
        id: 'row-1',
        role: 'user',
        content: 'hello',
        timestamp: '2026-09-12T00:00:00.000Z'
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

/** A Host-native writer (appendTranscript / toggleEnsembleSeat / archiveThread)
 *  advances the durable revision without ever reading the overlay, so the
 *  record it lands carries none of the picker selection. */
function hostAdvanced(source: ChatRecord, revision: number, updatedAt = 100): ChatRecord {
  return {
    ...source,
    persistenceRevision: revision,
    updatedAt,
    messages: [
      ...source.messages,
      {
        id: `host-row-${revision}`,
        role: 'assistant',
        content: `host write at ${revision}`,
        timestamp: '2026-09-12T00:01:00.000Z'
      }
    ]
  }
}

describe('ChatComposerSelectionOverlayStore with Host-advanced revisions', () => {
  it('still applies an unconsumed overlay after the Host advances the record to base+1', async () => {
    const source = chat()
    const store = new ChatComposerSelectionOverlayStore(path.join(testRoot, 'chats'))
    await store.persist(
      source,
      request({ selectedModelType: 'claude-opus-5', workflowMode: 'plan' }),
      () => 42
    )

    const advanced = hostAdvanced(source, 8)
    const applied = store.apply(advanced)

    expect(applied.providerMetadata?.selectedModelType).toBe('claude-opus-5')
    expect(applied.workflowMode).toBe('plan')
    // Revision transparency: the fold never moves the Host CAS chain.
    expect(applied.persistenceRevision).toBe(8)
    expect(applied.messages).toBe(advanced.messages)
  })

  it('still applies an unconsumed overlay several Host revisions past base', async () => {
    const source = chat()
    const store = new ChatComposerSelectionOverlayStore(path.join(testRoot, 'chats'))
    await store.persist(source, request({ claudeReasoningEffort: 'high' }), () => 42)

    const applied = store.apply(hostAdvanced(source, 12))

    expect(applied.providerMetadata?.claudeReasoningEffort).toBe('high')
    expect(applied.persistenceRevision).toBe(12)
  })

  it('replays the stranded selection from disk after a restart', async () => {
    const source = chat()
    const chatsDir = path.join(testRoot, 'chats')
    await new ChatComposerSelectionOverlayStore(chatsDir).persist(
      source,
      request({ selectedModelType: 'claude-opus-5' }),
      () => 42
    )

    const restarted = new ChatComposerSelectionOverlayStore(chatsDir)
    const applied = restarted.apply(hostAdvanced(source, 9))

    expect(applied.providerMetadata?.selectedModelType).toBe('claude-opus-5')
    expect(applied.persistenceRevision).toBe(9)
  })

  it('treats a canonical checkpoint carrying the selection as consumed, at any later revision', async () => {
    const source = chat()
    const store = new ChatComposerSelectionOverlayStore(path.join(testRoot, 'chats'))
    const persisted = await store.persist(
      source,
      request({ selectedModelType: 'claude-opus-5' }),
      () => 42
    )

    // The desktop canonical save folded the selection in and landed at base+1.
    const checkpoint = { ...persisted.chat, persistenceRevision: 8 }
    expect(store.apply(checkpoint)).toBe(checkpoint)
    // A later ordinary checkpoint still carries it — the consumed overlay must
    // leave the record completely untouched (same reference).
    const later = { ...persisted.chat, persistenceRevision: 11, updatedAt: 150 }
    expect(store.apply(later)).toBe(later)
  })

  it('never folds into a record below the overlay base revision', async () => {
    const source = chat()
    const store = new ChatComposerSelectionOverlayStore(path.join(testRoot, 'chats'))
    await store.persist(source, request({ selectedModelType: 'claude-opus-5' }), () => 42)

    const reverted = { ...source, persistenceRevision: 6 }
    expect(store.apply(reverted)).toBe(reverted)
  })

  it('lets a later explicit pick overwrite the overlay and win the fold', async () => {
    const source = chat()
    const chatsDir = path.join(testRoot, 'chats')
    const store = new ChatComposerSelectionOverlayStore(chatsDir)
    await store.persist(source, request({ selectedModelType: 'claude-opus-5' }), () => 42)
    const advanced = hostAdvanced(source, 8)
    const second = await store.persist(
      advanced,
      request({ selectedModelType: 'claude-haiku-5' }),
      () => 120
    )

    expect(second.chat.persistenceRevision).toBe(8)
    expect(store.apply(advanced).providerMetadata?.selectedModelType).toBe('claude-haiku-5')
    const restarted = new ChatComposerSelectionOverlayStore(chatsDir)
    expect(restarted.apply(advanced).providerMetadata?.selectedModelType).toBe('claude-haiku-5')
  })

  it('does not regress updatedAt when folding into a record newer than the pick', async () => {
    const source = chat()
    const store = new ChatComposerSelectionOverlayStore(path.join(testRoot, 'chats'))
    await store.persist(source, request({ selectedModelType: 'claude-opus-5' }), () => 42)

    const applied = store.apply(hostAdvanced(source, 8, 500))

    expect(applied.updatedAt).toBe(500)
    expect(applied.providerMetadata?.selectedModelType).toBe('claude-opus-5')
  })

  it('folds a deferred provider change stranded by Host advancement', async () => {
    const source = chat()
    const store = new ChatComposerSelectionOverlayStore(path.join(testRoot, 'chats'))
    await store.persist(
      source,
      {
        ...request({ selectedModelType: 'claude-opus-5' }),
        deferProviderScoped: true,
        queuedAt: '2026-09-12T00:00:30.000Z'
      },
      () => 42
    )

    const applied = store.apply(hostAdvanced(source, 9))

    expect(readPendingProviderChange(applied)).toEqual({
      provider: 'claude',
      providerMetadata: { selectedModelType: 'claude-opus-5' },
      queuedAt: '2026-09-12T00:00:30.000Z'
    })
    // Deferred means the live metadata keeps the old value until turn end.
    expect(applied.providerMetadata?.selectedModelType).toBe('claude-sonnet-5')
  })

  it('stays consumed once turn-end finalize executes a deferred switch', async () => {
    const source = chat()
    const chatsDir = path.join(testRoot, 'chats')
    const store = new ChatComposerSelectionOverlayStore(chatsDir)
    await store.persist(
      source,
      {
        ...request({ selectedModelType: 'claude-opus-5' }),
        deferProviderScoped: true,
        queuedAt: '2026-09-12T00:00:30.000Z'
      },
      () => 42
    )

    // The checkpoint that folded the overlay in, then the run-finalize save
    // that executed the queued switch and dropped the queue entry.
    const checkpointed = { ...store.apply(source), persistenceRevision: 8 }
    const finalized: ChatRecord = {
      ...applyPendingProviderChangeOnFinalize(checkpointed),
      persistenceRevision: 9,
      updatedAt: 200
    }
    expect(readPendingProviderChange(finalized)).toBeNull()

    // The executed switch replaced the exact pre-switch values the overlay's
    // patch holds; reading the overlay as unconsumed here re-queued a settled
    // switch and reverted the provider metadata on every canonical read.
    const restarted = new ChatComposerSelectionOverlayStore(chatsDir)
    expect(restarted.apply(finalized)).toBe(finalized)
  })

  it('parses an overlay whose stored revision moved past the base+1 stride', async () => {
    const source = chat()
    const chatsDir = path.join(testRoot, 'chats')
    const store = new ChatComposerSelectionOverlayStore(chatsDir)
    await store.persist(source, request({ selectedModelType: 'claude-opus-5' }), () => 42)
    // Rewrite the sidecar with a revision further past base than persist's own
    // base+1 stride: consumption no longer rides on the exact +1.
    const overlayPath = path.join(testRoot, 'chat-composer-selections', 'chat-1.json')
    const stored = JSON.parse(fs.readFileSync(overlayPath, 'utf8')) as { revision: number }
    stored.revision = stored.revision + 3
    fs.writeFileSync(overlayPath, JSON.stringify(stored))

    const restarted = new ChatComposerSelectionOverlayStore(chatsDir)
    const applied = restarted.apply(hostAdvanced(source, 8))

    expect(applied.providerMetadata?.selectedModelType).toBe('claude-opus-5')
  })
})
