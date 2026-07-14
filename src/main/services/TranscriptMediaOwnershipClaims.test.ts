import fs from 'fs'
import os from 'os'
import path from 'path'
import { afterEach, describe, expect, it } from 'vitest'
import type { ChatRecord, TranscriptMediaRef } from '../store/types'
import { TranscriptMediaAssetStore } from './TranscriptMediaAssetStore'
import { sanitizeTranscriptMediaOwnershipClaims } from './TranscriptMediaOwnershipClaims'

const roots: string[] = []

function makeRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tw-media-claims-'))
  roots.push(root)
  return root
}

function chatWithRef(appChatId: string, ref: TranscriptMediaRef): ChatRecord {
  return {
    appChatId,
    title: appChatId,
    provider: 'codex',
    scope: 'global',
    chatKind: 'single',
    archived: false,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    messages: [
      {
        id: 'assistant-1',
        role: 'assistant',
        content: 'Generated media',
        timestamp: new Date().toISOString(),
        metadata: { mediaRefs: [ref] }
      }
    ],
    runs: []
  }
}

function generatedRef(sha256: string): TranscriptMediaRef {
  return {
    id: 'assistant-1:generated-image:1',
    kind: 'image',
    format: 'raster',
    source: 'generated',
    name: 'Generated image',
    mimeType: 'image/png',
    sha256,
    assetId: `run:run-1:generated-image:${sha256}`,
    path: `/renderer-authored/${sha256}.png`,
    thumbnail: { dataBase64: 'bounded-preview', mimeType: 'image/jpeg' },
    status: 'available'
  }
}

afterEach(() => {
  while (roots.length) {
    const root = roots.pop()
    if (root) fs.rmSync(root, { recursive: true, force: true })
  }
})

describe('sanitizeTranscriptMediaOwnershipClaims', () => {
  it('cannot turn a renderer-authored foreign hash into ownership after restart', () => {
    const root = makeRoot()
    const store = new TranscriptMediaAssetStore(root)
    const written = store.writeContentAddressed({
      mimeType: 'image/png',
      buffer: Buffer.from('victim-private-image'),
      appChatId: 'victim-chat'
    })
    expect(written.ok).toBe(true)
    if (!written.ok) return

    const sanitized = sanitizeTranscriptMediaOwnershipClaims(
      chatWithRef('attacker-chat', generatedRef(written.sha256)),
      store
    )
    const persistedRef = sanitized.messages[0].metadata?.mediaRefs?.[0]
    expect(persistedRef).toMatchObject({
      id: 'assistant-1:generated-image:1',
      source: 'generated',
      status: 'denied',
      thumbnail: { dataBase64: 'bounded-preview', mimeType: 'image/jpeg' }
    })
    expect(persistedRef).not.toHaveProperty('sha256')
    expect(persistedRef).not.toHaveProperty('assetId')
    expect(persistedRef).not.toHaveProperty('path')

    const restarted = new TranscriptMediaAssetStore(root)
    expect(
      restarted.owns({
        sha256: written.sha256,
        mimeType: written.mimeType,
        appChatId: 'attacker-chat'
      })
    ).toBe(false)
    expect(
      restarted.owns({
        sha256: written.sha256,
        mimeType: written.mimeType,
        appChatId: 'victim-chat'
      })
    ).toBe(true)
  })

  it('retains a store-backed ref only when the durable ledger already owns it', () => {
    const root = makeRoot()
    const store = new TranscriptMediaAssetStore(root)
    const written = store.writeContentAddressed({
      mimeType: 'image/png',
      buffer: Buffer.from('canonical-owned-image'),
      appChatId: 'canonical-chat'
    })
    expect(written.ok).toBe(true)
    if (!written.ok) return
    const input = chatWithRef('canonical-chat', generatedRef(written.sha256))

    expect(sanitizeTranscriptMediaOwnershipClaims(input, store)).toBe(input)
    expect(
      new TranscriptMediaAssetStore(root).owns({
        sha256: written.sha256,
        mimeType: written.mimeType,
        appChatId: 'canonical-chat'
      })
    ).toBe(true)
  })
})
