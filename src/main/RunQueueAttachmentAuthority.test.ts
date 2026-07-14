import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  createMainOwnedRunQueueAttachmentStager,
  resolveOwnedPersistedRunQueueAttachment
} from './RunQueueAttachmentAuthority'
import { MAX_DURABLE_ATTACHMENT_REFS } from './ScheduledAttachmentDurability'
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

describe('createMainOwnedRunQueueAttachmentStager', () => {
  function freshFixture() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tw-queue-attachment-stage-'))
    roots.push(root)
    const workspacePath = path.join(root, 'workspace')
    fs.mkdirSync(workspacePath, { recursive: true })
    const firstPath = path.join(workspacePath, 'first.png')
    const secondPath = path.join(workspacePath, 'second.png')
    const pngHeader = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]
    fs.writeFileSync(firstPath, Buffer.from([...pngHeader, 0x11]))
    fs.writeFileSync(secondPath, Buffer.from([...pngHeader, 0x22]))
    const store = new TranscriptMediaAssetStore(path.join(root, 'assets'))
    return { store, workspacePath, firstPath, secondPath }
  }

  it('grants a fresh multi-attachment set in one batch before returning it', () => {
    const { store, workspacePath, firstPath, secondPath } = freshFixture()
    const grantMany = vi.spyOn(store, 'grantMany')
    const stage = createMainOwnedRunQueueAttachmentStager({ getAssetStore: () => store })

    const result = stage({
      chatId: 'chat-owner',
      workspacePath,
      externalPathGrants: [],
      attachments: [
        { id: 'first', name: 'first.png', path: firstPath },
        { id: 'second', name: 'second.png', path: secondPath }
      ]
    })

    expect(result.ok).toBe(true)
    expect(grantMany).toHaveBeenCalledTimes(1)
    expect(grantMany).toHaveBeenCalledWith([
      expect.objectContaining({ appChatId: 'chat-owner' }),
      expect.objectContaining({ appChatId: 'chat-owner' })
    ])
    if (!result.ok) return
    for (const attachment of result.attachments) {
      expect(
        store.owns({
          sha256: attachment.sha256,
          mimeType: attachment.mimeType,
          appChatId: 'chat-owner'
        })
      ).toBe(true)
    }
  })

  it('preserves global no-chat staging without minting ownership', () => {
    const { store, workspacePath, firstPath } = freshFixture()
    const grantMany = vi.spyOn(store, 'grantMany')
    const stage = createMainOwnedRunQueueAttachmentStager({ getAssetStore: () => store })

    expect(
      stage({
        workspacePath,
        externalPathGrants: [],
        attachments: [{ id: 'first', name: 'first.png', path: firstPath }]
      })
    ).toMatchObject({ ok: true, attachments: [expect.objectContaining({ id: 'first' })] })
    expect(grantMany).not.toHaveBeenCalled()
  })

  it('returns no durable refs when the ownership batch fails', () => {
    const { store, workspacePath, firstPath } = freshFixture()
    vi.spyOn(store, 'grantMany').mockReturnValue({ ok: false, reason: 'persistence_failed' })
    const stage = createMainOwnedRunQueueAttachmentStager({ getAssetStore: () => store })

    expect(
      stage({
        chatId: 'chat-owner',
        workspacePath,
        externalPathGrants: [],
        attachments: [{ id: 'first', name: 'first.png', path: firstPath }]
      })
    ).toEqual({ ok: false, reason: 'Attachment snapshot failed.' })
  })

  it('does not grant an earlier snapshot when a later queue attachment is invalid', () => {
    const { store, workspacePath, firstPath } = freshFixture()
    const invalidPath = path.join(workspacePath, 'invalid.txt')
    fs.writeFileSync(invalidPath, 'not an image')
    const stage = createMainOwnedRunQueueAttachmentStager({ getAssetStore: () => store })

    expect(
      stage({
        chatId: 'chat-owner',
        workspacePath,
        externalPathGrants: [],
        attachments: [
          { id: 'first', name: 'first.png', path: firstPath },
          { id: 'invalid', name: 'invalid.txt', path: invalidPath }
        ]
      })
    ).toEqual({ ok: false, reason: 'Attachment snapshot failed.' })
    const first = store.writeContentAddressed({
      buffer: fs.readFileSync(firstPath),
      mimeType: 'image/png'
    })
    expect(first.ok).toBe(true)
    if (!first.ok) return
    expect(
      store.owns({
        sha256: first.sha256,
        mimeType: first.mimeType,
        appChatId: 'chat-owner'
      })
    ).toBe(false)
  })

  it('rejects arrays above the main-authority ceiling before opening the store', () => {
    const getAssetStore = vi.fn()
    const stage = createMainOwnedRunQueueAttachmentStager({ getAssetStore })

    expect(
      stage({
        workspacePath: '/repo',
        externalPathGrants: [],
        attachments: Array.from(
          { length: MAX_DURABLE_ATTACHMENT_REFS + 1 },
          (_, index) => ({ path: `/repo/${index}.png` })
        )
      })
    ).toEqual({ ok: false, reason: 'Attachment snapshot failed.' })
    expect(getAssetStore).not.toHaveBeenCalled()
  })
})
