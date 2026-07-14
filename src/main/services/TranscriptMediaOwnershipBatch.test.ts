import { describe, expect, it, vi } from 'vitest'
import type { TranscriptMediaRef } from '../store/types'
import {
  createOwnedToolResultMediaRefs,
  transferTranscriptMediaRefsBatch,
  type TranscriptMediaOwnershipBatchStore
} from './TranscriptMediaOwnershipBatch'

function imageBlock(suffix: string): { type: 'image'; mimeType: string; data: string } {
  return {
    type: 'image',
    mimeType: 'image/png',
    data: Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      Buffer.from(suffix)
    ]).toString('base64')
  }
}

function makeStoreHarness() {
  const write = vi.fn(
    (
      _input: Parameters<TranscriptMediaOwnershipBatchStore['write']>[0]
    ): ReturnType<TranscriptMediaOwnershipBatchStore['write']> => ({ ok: true })
  )
  const owns = vi.fn(
    (_input: Parameters<TranscriptMediaOwnershipBatchStore['owns']>[0]): boolean => true
  )
  const grantMany = vi.fn(
    (
      _inputs: Parameters<TranscriptMediaOwnershipBatchStore['grantMany']>[0]
    ): ReturnType<TranscriptMediaOwnershipBatchStore['grantMany']> => ({ ok: true })
  )
  const store: TranscriptMediaOwnershipBatchStore = { write, owns, grantMany }
  return { store, write, owns, grantMany }
}

function storeRef(
  id: string,
  source: TranscriptMediaRef['source'],
  overrides: Partial<TranscriptMediaRef> = {}
): TranscriptMediaRef {
  return {
    id,
    kind: 'image',
    format: 'raster',
    source,
    name: `${id}.png`,
    mimeType: 'image/png',
    sha256: `${id}-sha256-abcdefghijklmnopqrstuvwxyz0123456789`,
    assetId: `asset:${id}`,
    path: `/private/store/${id}.png`,
    thumbnail: { dataBase64: `thumb-${id}`, mimeType: 'image/png' },
    status: 'available',
    ...overrides
  }
}

describe('createOwnedToolResultMediaRefs', () => {
  it('writes assets without chat authority, then grants the successful set once', () => {
    const { store, write, grantMany } = makeStoreHarness()
    const events: string[] = []
    write.mockImplementation((input) => {
      events.push(`write:${input.sha256}`)
      return { ok: true }
    })
    grantMany.mockImplementation((inputs) => {
      events.push(`grant:${inputs.length}`)
      return { ok: true }
    })

    const refs = createOwnedToolResultMediaRefs({
      store,
      appChatId: 'chat-1',
      messageId: 'message-1',
      blocks: [imageBlock('first'), imageBlock('second')],
      thumbnailer: () => ({ dataBase64: 'thumbnail', mimeType: 'image/png' })
    })

    expect(write).toHaveBeenCalledTimes(2)
    for (const [input] of write.mock.calls) {
      expect(input).not.toHaveProperty('appChatId')
    }
    expect(grantMany).toHaveBeenCalledTimes(1)
    expect(grantMany).toHaveBeenCalledWith(
      refs.map((ref) => ({
        sha256: ref.sha256,
        mimeType: ref.mimeType,
        appChatId: 'chat-1'
      }))
    )
    expect(events.slice(0, 2).every((event) => event.startsWith('write:'))).toBe(true)
    expect(events[2]).toBe('grant:2')
    expect(refs).toHaveLength(2)
    expect(refs.every((ref) => ref.status === 'available' && Boolean(ref.sha256))).toBe(true)
  })

  it('excludes an individually failed write and redacts only that ref', () => {
    const { store, write, grantMany } = makeStoreHarness()
    write
      .mockReturnValueOnce({ ok: true })
      .mockReturnValueOnce({ ok: false, reason: 'content_address_collision' })

    const refs = createOwnedToolResultMediaRefs({
      store,
      appChatId: 'chat-1',
      messageId: 'message-1',
      blocks: [imageBlock('first'), imageBlock('second')],
      thumbnailer: () => ({ dataBase64: 'thumbnail', mimeType: 'image/png' })
    })

    expect(grantMany).toHaveBeenCalledTimes(1)
    expect(grantMany.mock.calls[0][0]).toEqual([
      {
        sha256: refs[0].sha256,
        mimeType: 'image/png',
        appChatId: 'chat-1'
      }
    ])
    expect(refs[0]).toMatchObject({ status: 'available', sha256: expect.any(String) })
    expect(refs[1]).toMatchObject({
      status: 'denied',
      thumbnail: { dataBase64: 'thumbnail', mimeType: 'image/png' }
    })
    expect(refs[1]).not.toHaveProperty('sha256')
    expect(refs[1]).not.toHaveProperty('assetId')
    expect(refs[1]).not.toHaveProperty('path')
  })

  it('poisons every duplicate ref when a later write of the same asset fails', () => {
    const { store, write, grantMany } = makeStoreHarness()
    write
      .mockReturnValueOnce({ ok: true })
      .mockReturnValueOnce({ ok: false, reason: 'content_address_collision' })
    const duplicate = imageBlock('duplicate')

    const refs = createOwnedToolResultMediaRefs({
      store,
      appChatId: 'chat-1',
      messageId: 'message-1',
      blocks: [duplicate, duplicate],
      thumbnailer: () => ({ dataBase64: 'thumbnail', mimeType: 'image/png' })
    })

    expect(write).toHaveBeenCalledTimes(2)
    expect(grantMany).not.toHaveBeenCalled()
    expect(refs).toHaveLength(2)
    expect(refs.every((ref) => ref.status === 'denied')).toBe(true)
    expect(refs.every((ref) => !ref.sha256 && !ref.assetId && !ref.path)).toBe(true)
    expect(refs.every((ref) => ref.thumbnail?.dataBase64 === 'thumbnail')).toBe(true)
  })

  it('redacts every persisted locator when the atomic grant fails but preserves error presentation', () => {
    const { store, grantMany } = makeStoreHarness()
    grantMany.mockReturnValue({ ok: false, reason: 'persistence_failed' })

    const refs = createOwnedToolResultMediaRefs({
      store,
      appChatId: 'chat-1',
      messageId: 'message-1',
      blocks: [
        imageBlock('valid'),
        {
          type: 'image',
          mimeType: 'image/svg+xml',
          data: Buffer.from('<svg/>').toString('base64')
        }
      ],
      thumbnailer: () => ({ dataBase64: 'thumbnail', mimeType: 'image/png' })
    })

    expect(grantMany).toHaveBeenCalledTimes(1)
    expect(refs[0]).toMatchObject({
      status: 'denied',
      thumbnail: { dataBase64: 'thumbnail', mimeType: 'image/png' }
    })
    expect(refs[0]).not.toHaveProperty('sha256')
    expect(refs[0]).not.toHaveProperty('assetId')
    expect(refs[0]).not.toHaveProperty('path')
    expect(refs[1]).toMatchObject({
      format: 'svg',
      mimeType: 'image/svg+xml',
      status: 'unsafe_svg'
    })
  })

  it('fails closed when an asset write or the grant call throws', () => {
    const { store, write, grantMany } = makeStoreHarness()
    write.mockImplementationOnce(() => {
      throw new Error('write failed')
    })
    grantMany.mockImplementationOnce(() => {
      throw new Error('grant failed')
    })

    const refs = createOwnedToolResultMediaRefs({
      store,
      appChatId: 'chat-1',
      messageId: 'message-1',
      blocks: [imageBlock('first'), imageBlock('second')],
      thumbnailer: () => ({ dataBase64: 'thumbnail', mimeType: 'image/png' })
    })

    expect(grantMany).toHaveBeenCalledTimes(1)
    expect(refs.every((ref) => ref.status === 'denied')).toBe(true)
    expect(refs.every((ref) => ref.thumbnail?.dataBase64 === 'thumbnail')).toBe(true)
    expect(refs.every((ref) => !ref.sha256 && !ref.assetId && !ref.path)).toBe(true)
  })

  it('keeps presentation but performs no asset or authority write without a canonical chat', () => {
    const { store, write, grantMany } = makeStoreHarness()

    const refs = createOwnedToolResultMediaRefs({
      store,
      messageId: 'message-1',
      blocks: [imageBlock('detached')],
      thumbnailer: () => ({ dataBase64: 'thumbnail', mimeType: 'image/png' })
    })

    expect(write).not.toHaveBeenCalled()
    expect(grantMany).not.toHaveBeenCalled()
    expect(refs).toEqual([
      expect.objectContaining({
        status: 'denied',
        thumbnail: { dataBase64: 'thumbnail', mimeType: 'image/png' }
      })
    ])
    expect(refs[0]).not.toHaveProperty('sha256')
    expect(refs[0]).not.toHaveProperty('assetId')
    expect(refs[0]).not.toHaveProperty('path')
  })
})

describe('transferTranscriptMediaRefsBatch', () => {
  it('verifies once and transfers generated, tool-result, and upload refs in one grant', () => {
    const { store, owns, grantMany } = makeStoreHarness()
    const verifyTransfer = vi.fn(() => true)
    const refs: TranscriptMediaRef[] = [
      storeRef('generated', 'generated'),
      storeRef('tool', 'tool_result'),
      storeRef('upload', 'upload'),
      storeRef('workspace', 'workspace_path'),
      storeRef('unsupported', 'tool_result', {
        sha256: undefined,
        assetId: undefined,
        path: undefined,
        status: 'unsupported'
      })
    ]
    const original = refs.map((ref) => ({
      ...ref,
      ...(ref.thumbnail ? { thumbnail: { ...ref.thumbnail } } : {})
    }))

    const transferred = transferTranscriptMediaRefsBatch({
      store,
      sourceAppChatId: 'source-chat',
      targetAppChatId: 'target-chat',
      refs,
      verifyTransfer
    })

    expect(verifyTransfer).toHaveBeenCalledTimes(1)
    expect(verifyTransfer).toHaveBeenCalledWith('source-chat', 'target-chat')
    expect(owns).toHaveBeenCalledTimes(3)
    expect(grantMany).toHaveBeenCalledTimes(1)
    expect(grantMany.mock.calls[0][0]).toEqual(
      refs.slice(0, 3).map((ref) => ({
        sha256: ref.sha256,
        mimeType: ref.mimeType,
        appChatId: 'target-chat'
      }))
    )
    expect(transferred).toEqual(refs)
    expect(transferred).not.toBe(refs)
    expect(refs).toEqual(original)
  })

  it('redacts a forged or unowned source ref without blocking owned peers', () => {
    const { store, owns, grantMany } = makeStoreHarness()
    const owned = storeRef('owned', 'generated')
    const forged = storeRef('forged', 'upload')
    owns.mockImplementation((input) => input.sha256 === owned.sha256)
    const refs = [owned, forged]

    const transferred = transferTranscriptMediaRefsBatch({
      store,
      sourceAppChatId: 'source-chat',
      targetAppChatId: 'target-chat',
      refs,
      verifyTransfer: () => true
    })

    expect(grantMany).toHaveBeenCalledTimes(1)
    expect(grantMany).toHaveBeenCalledWith([
      {
        sha256: owned.sha256,
        mimeType: owned.mimeType,
        appChatId: 'target-chat'
      }
    ])
    expect(transferred[0]).toBe(owned)
    expect(transferred[1]).toMatchObject({
      status: 'denied',
      thumbnail: forged.thumbnail
    })
    expect(transferred[1]).not.toHaveProperty('sha256')
    expect(transferred[1]).not.toHaveProperty('assetId')
    expect(transferred[1]).not.toHaveProperty('path')
  })

  it('deduplicates repeated assets across a flat transcript batch', () => {
    const { store, owns, grantMany } = makeStoreHarness()
    const first = storeRef('shared', 'upload')
    const duplicate = { ...first, id: 'shared-again' }

    const transferred = transferTranscriptMediaRefsBatch({
      store,
      sourceAppChatId: 'source-chat',
      targetAppChatId: 'target-chat',
      refs: [first, duplicate],
      verifyTransfer: () => true
    })

    expect(owns).toHaveBeenCalledTimes(1)
    expect(grantMany).toHaveBeenCalledTimes(1)
    expect(grantMany).toHaveBeenCalledWith([
      {
        sha256: first.sha256,
        mimeType: first.mimeType,
        appChatId: 'target-chat'
      }
    ])
    expect(transferred).toEqual([first, duplicate])
  })

  it('does not issue an empty target grant when every candidate is unowned', () => {
    const { store, owns, grantMany } = makeStoreHarness()
    owns.mockReturnValue(false)
    const refs = [storeRef('forged-one', 'generated'), storeRef('forged-two', 'upload')]

    const transferred = transferTranscriptMediaRefsBatch({
      store,
      sourceAppChatId: 'source-chat',
      targetAppChatId: 'target-chat',
      refs,
      verifyTransfer: () => true
    })

    expect(grantMany).not.toHaveBeenCalled()
    expect(transferred.every((ref) => ref.status === 'denied')).toBe(true)
    expect(transferred.every((ref) => !ref.sha256 && !ref.assetId && !ref.path)).toBe(true)
  })

  it('does not consult ownership or grant when the trusted relation is denied', () => {
    const { store, owns, grantMany } = makeStoreHarness()
    const generated = storeRef('generated', 'generated')
    const workspace = storeRef('workspace', 'workspace_path')
    const refs = [generated, workspace]

    const transferred = transferTranscriptMediaRefsBatch({
      store,
      sourceAppChatId: 'source-chat',
      targetAppChatId: 'target-chat',
      refs,
      verifyTransfer: () => false
    })

    expect(owns).not.toHaveBeenCalled()
    expect(grantMany).not.toHaveBeenCalled()
    expect(transferred[0]).toMatchObject({ status: 'denied', thumbnail: generated.thumbnail })
    expect(transferred[0]).not.toHaveProperty('sha256')
    expect(transferred[1]).toBe(workspace)
  })

  it('redacts the whole valid candidate set when the atomic target grant fails', () => {
    const { store, grantMany } = makeStoreHarness()
    grantMany.mockReturnValue({ ok: false, reason: 'persistence_failed' })
    const refs = [storeRef('generated', 'generated'), storeRef('upload', 'upload')]
    const original = refs.map((ref) => ({
      ...ref,
      ...(ref.thumbnail ? { thumbnail: { ...ref.thumbnail } } : {})
    }))

    const transferred = transferTranscriptMediaRefsBatch({
      store,
      sourceAppChatId: 'source-chat',
      targetAppChatId: 'target-chat',
      refs,
      verifyTransfer: () => true
    })

    expect(grantMany).toHaveBeenCalledTimes(1)
    expect(transferred.every((ref) => ref.status === 'denied')).toBe(true)
    expect(transferred.every((ref) => !ref.sha256 && !ref.assetId && !ref.path)).toBe(true)
    expect(transferred.map((ref) => ref.thumbnail)).toEqual(refs.map((ref) => ref.thumbnail))
    expect(refs).toEqual(original)
  })

  it('skips authority work when refs contain only harmless presentation data', () => {
    const { store, owns, grantMany } = makeStoreHarness()
    const verifyTransfer = vi.fn(() => true)
    const refs = [
      storeRef('unsupported', 'tool_result', {
        sha256: undefined,
        assetId: undefined,
        path: undefined,
        status: 'unsupported'
      }),
      storeRef('workspace', 'workspace_path')
    ]

    const transferred = transferTranscriptMediaRefsBatch({
      store,
      sourceAppChatId: 'source-chat',
      targetAppChatId: 'target-chat',
      refs,
      verifyTransfer
    })

    expect(verifyTransfer).not.toHaveBeenCalled()
    expect(owns).not.toHaveBeenCalled()
    expect(grantMany).not.toHaveBeenCalled()
    expect(transferred).toEqual(refs)
    expect(transferred).not.toBe(refs)
  })
})
