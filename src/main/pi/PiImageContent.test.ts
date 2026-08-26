import { describe, expect, it } from 'vitest'
import {
  loadPiRpcImageContents,
  PiImageAttachmentError,
  PI_RPC_IMAGE_MAX_BYTES
} from './PiImageContent'

describe('loadPiRpcImageContents', () => {
  it('builds Pi RPC image blocks for supported files', async () => {
    const bytes = Buffer.from('image-bytes')
    await expect(
      loadPiRpcImageContents(['/tmp/screen.png'], {
        readFile: async () => bytes
      })
    ).resolves.toEqual([
      {
        type: 'image',
        mimeType: 'image/png',
        data: bytes.toString('base64')
      }
    ])
  })

  it('converts unsupported and oversized images before the RPC boundary', async () => {
    const converted = Buffer.from('converted')
    const convertToSupported = async () => ({
      mediaType: 'image/jpeg' as const,
      dataBase64: converted.toString('base64')
    })

    const unsupported = await loadPiRpcImageContents(['/tmp/photo.heic'], {
      readFile: async () => Buffer.from('heic'),
      convertToSupported
    })
    expect(unsupported[0]).toEqual({
      type: 'image',
      mimeType: 'image/jpeg',
      data: converted.toString('base64')
    })

    const oversized = await loadPiRpcImageContents(['/tmp/scan.png'], {
      readFile: async () => Buffer.alloc(PI_RPC_IMAGE_MAX_BYTES + 1),
      convertToSupported
    })
    expect(oversized[0].mimeType).toBe('image/jpeg')
  })

  it('fails loudly instead of silently dropping an unreadable image', async () => {
    await expect(
      loadPiRpcImageContents(['/tmp/gone.png'], {
        readFile: async () => {
          throw new Error('ENOENT')
        }
      })
    ).rejects.toThrow(PiImageAttachmentError)
  })
})
