import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { resolveOwnedPersistedRunQueueAttachment } from './RunQueueAttachmentAuthority'
import { TranscriptMediaAssetStore } from './services/TranscriptMediaAssetStore'

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true })
})

function ownedFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tw-queue-attachment-authority-'))
  roots.push(root)
  const store = new TranscriptMediaAssetStore(root)
  const persisted = store.writeContentAddressed({
    buffer: Buffer.from('owned queue image'),
    mimeType: 'image/png',
    appChatId: 'chat-owner'
  })
  if (!persisted.ok) throw new Error(persisted.reason)
  return { store, persisted }
}

describe('resolveOwnedPersistedRunQueueAttachment', () => {
  it('accepts a valid persisted ref for the chat that already owns it', () => {
    const { store, persisted } = ownedFixture()
    expect(
      resolveOwnedPersistedRunQueueAttachment({
        store,
        attachment: persisted,
        appChatId: 'chat-owner'
      })
    ).toMatchObject({
      ok: true,
      attachment: {
        persistenceVersion: 1,
        sha256: persisted.sha256,
        mimeType: persisted.mimeType,
        byteLength: persisted.byteLength,
        path: persisted.path
      }
    })
  })

  it('denies cross-chat replay without minting ownership for the target chat', () => {
    const { store, persisted } = ownedFixture()
    expect(
      resolveOwnedPersistedRunQueueAttachment({
        store,
        attachment: persisted,
        appChatId: 'chat-attacker'
      })
    ).toEqual({ ok: false, reason: 'not_owner' })
    expect(
      store.owns({
        sha256: persisted.sha256,
        mimeType: persisted.mimeType,
        appChatId: 'chat-attacker'
      })
    ).toBe(false)
  })
})
