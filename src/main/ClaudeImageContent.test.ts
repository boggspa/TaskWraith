import { describe, expect, it } from 'vitest'
import {
  buildClaudeImageUserMessage,
  CLAUDE_IMAGE_MAX_BYTES,
  claudeImageMediaTypeForPath,
  claudeImageUserMessageStream,
  ClaudeImageAttachmentError,
  loadClaudeImageAttachmentContents
} from './ClaudeImageContent'

const png = (bytes: number): Buffer => Buffer.alloc(bytes, 7)

describe('claudeImageMediaTypeForPath', () => {
  it('maps the accepted extensions case-insensitively', () => {
    expect(claudeImageMediaTypeForPath('/a/b/sketch.png')).toBe('image/png')
    expect(claudeImageMediaTypeForPath('/a/b/photo.JPG')).toBe('image/jpeg')
    expect(claudeImageMediaTypeForPath('/a/b/photo.jpeg')).toBe('image/jpeg')
    expect(claudeImageMediaTypeForPath('x.gif')).toBe('image/gif')
    expect(claudeImageMediaTypeForPath('x.webp')).toBe('image/webp')
  })

  it('returns null for anything Claude does not accept directly', () => {
    expect(claudeImageMediaTypeForPath('/a/photo.heic')).toBeNull()
    expect(claudeImageMediaTypeForPath('/a/doc.pdf')).toBeNull()
    expect(claudeImageMediaTypeForPath('/a/no-extension')).toBeNull()
  })
})

describe('loadClaudeImageAttachmentContents', () => {
  it('loads supported files under the cap as base64', async () => {
    const contents = await loadClaudeImageAttachmentContents(['/img/a.png'], {
      readFile: async () => png(16)
    })
    expect(contents).toEqual([{ mediaType: 'image/png', dataBase64: png(16).toString('base64') }])
  })

  it('routes unsupported formats through the converter', async () => {
    const contents = await loadClaudeImageAttachmentContents(['/img/a.heic'], {
      readFile: async () => png(16),
      convertToSupported: async () => ({
        mediaType: 'image/jpeg',
        dataBase64: png(8).toString('base64')
      })
    })
    expect(contents[0].mediaType).toBe('image/jpeg')
  })

  it('routes oversized files through the converter', async () => {
    let converted = false
    await loadClaudeImageAttachmentContents(['/img/a.png'], {
      readFile: async () => png(CLAUDE_IMAGE_MAX_BYTES + 1),
      convertToSupported: async () => {
        converted = true
        return { mediaType: 'image/jpeg', dataBase64: png(8).toString('base64') }
      }
    })
    expect(converted).toBe(true)
  })

  it('throws no-silent-omission copy when conversion cannot help', async () => {
    await expect(
      loadClaudeImageAttachmentContents(['/img/a.heic'], {
        readFile: async () => png(16),
        convertToSupported: async () => null
      })
    ).rejects.toThrow(ClaudeImageAttachmentError)
    await expect(
      loadClaudeImageAttachmentContents(['/img/a.heic'], {
        readFile: async () => png(16)
      })
    ).rejects.toThrow(/not dispatched with the attachment silently omitted/)
  })

  it('throws loudly when the file cannot be read', async () => {
    await expect(
      loadClaudeImageAttachmentContents(['/img/gone.png'], {
        readFile: async () => {
          throw new Error('ENOENT')
        }
      })
    ).rejects.toThrow(/could not be read/)
  })
})

describe('buildClaudeImageUserMessage', () => {
  it('leads with image blocks and ends with the prompt text', () => {
    const message = buildClaudeImageUserMessage('What is this?', [
      { mediaType: 'image/png', dataBase64: 'QUJD' }
    ])
    expect(message.type).toBe('user')
    expect(message.parent_tool_use_id).toBeNull()
    const content = message.message.content as unknown as Array<Record<string, unknown>>
    expect(content).toHaveLength(2)
    expect(content[0].type).toBe('image')
    expect((content[0].source as Record<string, unknown>).media_type).toBe('image/png')
    expect(content[1]).toEqual({ type: 'text', text: 'What is this?' })
  })
})

describe('claudeImageUserMessageStream', () => {
  it('yields exactly one composed message', async () => {
    const seen: unknown[] = []
    for await (const message of claudeImageUserMessageStream('hi', [
      { mediaType: 'image/png', dataBase64: 'QUJD' }
    ])) {
      seen.push(message)
    }
    expect(seen).toHaveLength(1)
  })
})
