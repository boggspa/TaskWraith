import { describe, expect, it, vi } from 'vitest'
import type { TranscriptMediaRef } from '../store/types'
import {
  BLACKBOARD_MAX_IMAGE_ATTACHMENTS,
  BLACKBOARD_MAX_IMAGE_BYTES,
  BLACKBOARD_MAX_THUMBNAIL_BYTES,
  blackboardMediaRefsForAgent,
  formatBlackboardMediaForPrompt,
  persistBlackboardImages,
  sanitizeBlackboardMediaRefs
} from './BlackboardMedia'

const PNG_BYTES = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex')

function mediaRef(overrides: Partial<TranscriptMediaRef> = {}): TranscriptMediaRef {
  return {
    id: overrides.id || 'blackboard:entry-1:image:0:abc',
    kind: 'image',
    format: 'raster',
    source: 'upload',
    name: 'capture.png',
    mimeType: 'image/png',
    sha256: 'a'.repeat(43),
    assetId: 'blackboard-image:a',
    byteLength: 16,
    thumbnail: {
      dataBase64: Buffer.from('thumb').toString('base64'),
      mimeType: 'image/jpeg',
      width: 64,
      height: 32
    },
    status: 'available',
    ...overrides
  }
}

describe('sanitizeBlackboardMediaRefs', () => {
  it('keeps bounded pathless raster refs and caps the attachment count', () => {
    const refs = Array.from({ length: BLACKBOARD_MAX_IMAGE_ATTACHMENTS + 2 }, (_, index) =>
      mediaRef({
        id: `blackboard:entry-1:image:${index}`,
        sha256: `${String(index).padStart(2, '0')}${'a'.repeat(41)}`,
        path: `/private/secret-${index}.png`
      })
    )

    const sanitized = sanitizeBlackboardMediaRefs(refs)
    expect(sanitized).toHaveLength(BLACKBOARD_MAX_IMAGE_ATTACHMENTS)
    expect(sanitized.every((ref) => ref.path === undefined)).toBe(true)
  })

  it('drops unsupported, thumbnail-less, and oversized-preview refs', () => {
    expect(sanitizeBlackboardMediaRefs([mediaRef({ mimeType: 'image/svg+xml' })])).toEqual([])
    expect(sanitizeBlackboardMediaRefs([mediaRef({ thumbnail: undefined })])).toEqual([])
    expect(
      sanitizeBlackboardMediaRefs([
        mediaRef({
          thumbnail: {
            dataBase64: Buffer.alloc(BLACKBOARD_MAX_THUMBNAIL_BYTES + 1).toString('base64'),
            mimeType: 'image/jpeg'
          }
        })
      ])
    ).toEqual([])
  })

  it('projects only an opaque inspection alias to agents', () => {
    const projected = blackboardMediaRefsForAgent([mediaRef()])
    expect(projected).toEqual([
      expect.objectContaining({
        attachmentId: 'blackboard:entry-1:image:0:abc',
        name: 'capture.png',
        inspectWith: 'inspect_chat_attachment'
      })
    ])
    expect(projected[0]).not.toHaveProperty('sha256')
    expect(projected[0]).not.toHaveProperty('thumbnail')
    expect(formatBlackboardMediaForPrompt([mediaRef()])).toContain('inspect_chat_attachment')
  })
})

describe('persistBlackboardImages', () => {
  it('sniffs bytes, generates a bounded preview, and publishes exact chat ownership', () => {
    const writeOwnedMany = vi.fn(() => ({ ok: true as const, assets: [] }))
    const result = persistBlackboardImages({
      appChatId: 'chat-1',
      entryId: 'entry-1',
      images: [{ buffer: PNG_BYTES, name: '/tmp/capture.png', mimeType: 'image/jpeg' }],
      store: { writeOwnedMany },
      thumbnailer: () => ({
        dataBase64: Buffer.from('preview').toString('base64'),
        mimeType: 'image/jpeg',
        width: 120,
        height: 80
      })
    })

    expect(result.ok).toBe(true)
    expect(writeOwnedMany).toHaveBeenCalledWith([
      expect.objectContaining({ appChatId: 'chat-1', mimeType: 'image/png' })
    ])
    if (result.ok) {
      expect(result.mediaRefs).toHaveLength(1)
      expect(result.mediaRefs[0]).toMatchObject({
        id: expect.stringContaining('blackboard:entry-1:image:0:'),
        source: 'upload',
        name: 'capture.png',
        mimeType: 'image/png',
        status: 'available'
      })
      expect(result.mediaRefs[0].path).toBeUndefined()
    }
  })

  it('rejects oversized originals and attachment floods before persistence', () => {
    const store = { writeOwnedMany: vi.fn(() => ({ ok: true as const, assets: [] })) }
    expect(
      persistBlackboardImages({
        appChatId: 'chat-1',
        entryId: 'entry-1',
        images: [{ buffer: Buffer.alloc(BLACKBOARD_MAX_IMAGE_BYTES + 1) }],
        store
      })
    ).toMatchObject({ ok: false, code: 'blackboard_image_too_large' })
    expect(
      persistBlackboardImages({
        appChatId: 'chat-1',
        entryId: 'entry-1',
        images: Array.from({ length: BLACKBOARD_MAX_IMAGE_ATTACHMENTS + 1 }, () => ({
          buffer: PNG_BYTES
        })),
        store
      })
    ).toMatchObject({ ok: false, code: 'blackboard_image_count_exceeded' })
    expect(store.writeOwnedMany).not.toHaveBeenCalled()
  })

  it('retries at smaller edges until the preview is inside its byte budget', () => {
    const edges: number[] = []
    const result = persistBlackboardImages({
      appChatId: 'chat-1',
      entryId: 'entry-1',
      images: [{ buffer: PNG_BYTES }],
      store: { writeOwnedMany: () => ({ ok: true, assets: [] }) },
      thumbnailer: ({ maxEdge }) => {
        edges.push(maxEdge)
        return {
          dataBase64: Buffer.alloc(
            maxEdge === 384 ? BLACKBOARD_MAX_THUMBNAIL_BYTES + 1 : 16
          ).toString('base64'),
          mimeType: 'image/jpeg'
        }
      }
    })

    expect(result.ok).toBe(true)
    expect(edges).toEqual([384, 320])
  })
})
