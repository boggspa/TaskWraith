import { describe, expect, it, vi } from 'vitest'
import { BLACKBOARD_MAX_IMAGE_ATTACHMENTS, BLACKBOARD_MAX_IMAGE_BYTES } from './BlackboardMedia'
import {
  ingestBlackboardPostImages,
  inspectedBlackboardImageFromToolResult,
  resolveBlackboardPostImages
} from './BlackboardPostAttachments'

describe('resolveBlackboardPostImages', () => {
  it('combines current-chat aliases and authority-checked workspace snapshots', async () => {
    const inspectAttachment = vi.fn(async () => ({
      ok: true as const,
      dataBase64: Buffer.from('attachment').toString('base64'),
      mimeType: 'image/png',
      name: 'existing.png'
    }))
    const readWorkspaceImage = vi.fn(() => ({
      ok: true as const,
      image: {
        buffer: Buffer.from('workspace'),
        mimeType: 'image/png',
        name: 'capture.png'
      }
    }))

    const result = await resolveBlackboardPostImages({
      attachmentIds: ['attachment-1'],
      workspaceImagePaths: ['artifacts/capture.png'],
      inspectAttachment,
      readWorkspaceImage
    })

    expect(result.ok).toBe(true)
    if (result.ok)
      expect(result.images.map((image) => image.name)).toEqual(['existing.png', 'capture.png'])
    expect(inspectAttachment).toHaveBeenCalledWith('attachment-1')
    expect(readWorkspaceImage).toHaveBeenCalledWith('artifacts/capture.png')
  })

  it('rejects a combined attachment flood before resolving any bytes', async () => {
    const inspectAttachment = vi.fn()
    const readWorkspaceImage = vi.fn()
    const result = await resolveBlackboardPostImages({
      attachmentIds: Array.from(
        { length: BLACKBOARD_MAX_IMAGE_ATTACHMENTS },
        (_, index) => `attachment-${index}`
      ),
      workspaceImagePaths: ['extra.png'],
      inspectAttachment,
      readWorkspaceImage
    })

    expect(result).toMatchObject({ ok: false, code: 'blackboard_image_count_exceeded' })
    expect(inspectAttachment).not.toHaveBeenCalled()
    expect(readWorkspaceImage).not.toHaveBeenCalled()
  })

  it('rejects invalid and oversized inline inspection payloads', async () => {
    const invalid = await resolveBlackboardPostImages({
      attachmentIds: ['bad'],
      inspectAttachment: async () => ({ ok: true, dataBase64: '<not-base64>' }),
      readWorkspaceImage: () => ({ ok: false, error: 'unused' })
    })
    expect(invalid).toMatchObject({ ok: false, code: 'blackboard_image_resolution_failed' })

    const oversized = await resolveBlackboardPostImages({
      attachmentIds: ['large'],
      inspectAttachment: async () => ({
        ok: true,
        dataBase64: Buffer.alloc(BLACKBOARD_MAX_IMAGE_BYTES + 1).toString('base64')
      }),
      readWorkspaceImage: () => ({ ok: false, error: 'unused' })
    })
    expect(oversized).toMatchObject({ ok: false, code: 'blackboard_image_resolution_failed' })
  })

  it('extracts a rich image block without trusting structured attachment bytes', () => {
    expect(
      inspectedBlackboardImageFromToolResult('alias-1', {
        content: [{ type: 'image', data: 'c21hbGw=', mimeType: 'image/png' }],
        structuredContent: { attachment: { name: 'existing.png', data: 'ignored' } }
      })
    ).toEqual({
      ok: true,
      dataBase64: 'c21hbGw=',
      mimeType: 'image/png',
      name: 'existing.png'
    })
  })

  it('runs the shared ingest coordinator without touching storage when no images were requested', async () => {
    const writeOwnedMany = vi.fn()
    const result = await ingestBlackboardPostImages({
      appChatId: 'chat-1',
      entryId: 'entry-1',
      store: { writeOwnedMany }
    })

    expect(result).toEqual({ ok: true, mediaRefs: [] })
    expect(writeOwnedMany).not.toHaveBeenCalled()
  })
})
