import fs from 'fs'
import os from 'os'
import path from 'path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  MAX_REMOTE_IMAGE_MARKUP_JSON_BYTES,
  MAX_REMOTE_IMAGE_MARKUP_POINTS_PER_STROKE,
  appendRemoteImageMarkupToPrompt,
  dispatchFieldsFromPersistedRemoteImages,
  persistRemoteImageAttachments,
  parseRemoteImageMarkup,
  purgeLegacyRemoteAttachmentTempRoot
} from './RemoteAttachmentPersistence'

const tempRoots: string[] = []

afterEach(() => {
  for (const root of tempRoots.splice(0)) fs.rmSync(root, { recursive: true, force: true })
})

function pngBase64(bytes: number[] = [0x89, 0x50, 0x4e, 0x47]): string {
  return Buffer.from(bytes).toString('base64')
}

function validMarkup(attachmentId = 'att-1') {
  return {
    schemaVersion: 1,
    attachmentId,
    primitives: [
      {
        type: 'arrow' as const,
        start: { x: 0.12, y: 0.34 },
        end: { x: 0.56, y: 0.78 },
        color: { r: 1, g: 0, b: 0, a: 1 },
        thickness: 2
      }
    ]
  }
}

describe('persistRemoteImageAttachments', () => {
  it('publishes one atomic chat-owned batch and returns canonical store paths', () => {
    const writeOwnedMany = vi.fn(() => ({
      ok: true as const,
      assets: [
        {
          ok: true as const,
          persistenceVersion: 1 as const,
          sha256: 'digest',
          path: '/owned/transcript-media/digest.png',
          mimeType: 'image/png',
          byteLength: 4
        }
      ]
    }))

    const result = persistRemoteImageAttachments({
      appChatId: 'chat-a',
      attachments: [{ dataBase64: pngBase64(), mimeType: 'image/png' }],
      store: { writeOwnedMany }
    })

    expect(writeOwnedMany).toHaveBeenCalledOnce()
    expect(writeOwnedMany).toHaveBeenCalledWith([
      expect.objectContaining({
        appChatId: 'chat-a',
        mimeType: 'image/png',
        buffer: Buffer.from([0x89, 0x50, 0x4e, 0x47])
      })
    ])
    expect(result).toEqual([
      {
        path: '/owned/transcript-media/digest.png',
        mimeType: 'image/png',
        buffer: Buffer.from([0x89, 0x50, 0x4e, 0x47])
      }
    ])
  })

  it('carries id and validated markup through to the persisted dispatch fields', () => {
    const writeOwnedMany = vi.fn(() => ({
      ok: true as const,
      assets: [
        {
          ok: true as const,
          persistenceVersion: 1 as const,
          sha256: 'digest',
          path: '/owned/transcript-media/digest.png',
          mimeType: 'image/png',
          byteLength: 4
        }
      ]
    }))
    const markup = validMarkup('shot-9')

    const result = persistRemoteImageAttachments({
      appChatId: 'chat-a',
      attachments: [
        {
          dataBase64: pngBase64(),
          mimeType: 'image/png',
          id: 'shot-9',
          markup
        }
      ],
      store: { writeOwnedMany }
    })

    expect(result[0]?.id).toBe('shot-9')
    expect(result[0]?.markup).toEqual(markup)
    expect(result[0]?.markupPromptText).toContain('shot-9')
    expect(result[0]?.markupPromptText).toContain('(0.1200, 0.3400)')
    expect(result[0]?.markupPromptText).toContain('(0.5600, 0.7800)')
    expect(dispatchFieldsFromPersistedRemoteImages(result)).toEqual({
      imagePaths: ['/owned/transcript-media/digest.png'],
      markupPromptText: result[0]?.markupPromptText
    })
  })

  it('adds coordinates only to the provider prompt and states the coordinate space', () => {
    const coordinates = '[Image annotation on attachment "shot-9", schemaVersion 1]\n- arrow'

    expect(appendRemoteImageMarkupToPrompt('Fix this', undefined)).toBe('Fix this')
    expect(appendRemoteImageMarkupToPrompt('Fix this', '   ')).toBe('Fix this')
    expect(appendRemoteImageMarkupToPrompt('Fix this', coordinates)).toBe(
      'Fix this\n\n' +
        '[Attached-image annotation coordinates: normalized x/y in 0..1; origin is top-left.]\n' +
        coordinates
    )
    expect(appendRemoteImageMarkupToPrompt('', coordinates)).toBe(
      '[Attached-image annotation coordinates: normalized x/y in 0..1; origin is top-left.]\n' +
        coordinates
    )
  })

  it('rejects malformed or oversized markup before writing bytes', () => {
    const writeOwnedMany = vi.fn()
    const oversized = {
      schemaVersion: 1,
      attachmentId: 'shot-9',
      primitives: Array.from({ length: 32 }, () => ({
        type: 'stroke' as const,
        points: Array.from({ length: 80 }, (_, i) => ({
          x: (i % 10) / 10,
          y: (i % 10) / 10
        })),
        color: { r: 1, g: 0, b: 0, a: 1 },
        thickness: 2
      }))
    }
    expect(Buffer.byteLength(JSON.stringify(oversized), 'utf8')).toBeGreaterThan(
      MAX_REMOTE_IMAGE_MARKUP_JSON_BYTES
    )

    for (const markup of [
      { schemaVersion: 2, attachmentId: 'shot-9', primitives: [] },
      { schemaVersion: 1, attachmentId: '', primitives: [] },
      { schemaVersion: 1, attachmentId: 'other', primitives: [] },
      {
        schemaVersion: 1,
        attachmentId: 'shot-9',
        primitives: [
          {
            type: 'arrow',
            start: { x: 1.5, y: 0 },
            end: { x: 0, y: 0 },
            color: { r: 1, g: 0, b: 0, a: 1 },
            thickness: 2
          }
        ]
      },
      oversized
    ]) {
      expect(() =>
        persistRemoteImageAttachments({
          appChatId: 'chat-a',
          attachments: [
            {
              dataBase64: pngBase64(),
              mimeType: 'image/png',
              id: 'shot-9',
              markup
            }
          ],
          store: { writeOwnedMany }
        })
      ).toThrow(/metadata is invalid/)
    }
    expect(writeOwnedMany).not.toHaveBeenCalled()
  })

  it('rejects a stroke above the point cap even when JSON is small', () => {
    const writeOwnedMany = vi.fn()
    const markup = {
      schemaVersion: 1,
      attachmentId: 'shot-9',
      primitives: [
        {
          type: 'stroke',
          points: Array.from({ length: MAX_REMOTE_IMAGE_MARKUP_POINTS_PER_STROKE + 1 }, () => ({
            x: 0.1,
            y: 0.1
          })),
          color: { r: 1, g: 0, b: 0, a: 1 },
          thickness: 2
        }
      ]
    }
    expect(parseRemoteImageMarkup(markup).ok).toBe(false)
    expect(() =>
      persistRemoteImageAttachments({
        appChatId: 'chat-a',
        attachments: [
          {
            dataBase64: pngBase64(),
            mimeType: 'image/png',
            id: 'shot-9',
            markup
          }
        ],
        store: { writeOwnedMany }
      })
    ).toThrow(/points/)
    expect(writeOwnedMany).not.toHaveBeenCalled()
  })

  it('fails without exposing a path when the atomic ownership batch is blocked', () => {
    const writeOwnedMany = vi.fn(() => ({
      ok: false as const,
      reason: 'history_cleared' as const
    }))
    expect(() =>
      persistRemoteImageAttachments({
        appChatId: 'chat-a',
        attachments: [{ dataBase64: pngBase64(), mimeType: 'image/png' }],
        store: { writeOwnedMany }
      })
    ).toThrow('history_cleared')
  })

  it('rejects malformed, unsupported, oversized, and over-count input before writing', () => {
    const writeOwnedMany = vi.fn()
    for (const attachment of [
      { dataBase64: '%%%not-base64', mimeType: 'image/png' },
      { dataBase64: pngBase64(), mimeType: 'image/svg+xml' }
    ]) {
      expect(() =>
        persistRemoteImageAttachments({
          appChatId: 'chat-a',
          attachments: [attachment],
          store: { writeOwnedMany }
        })
      ).toThrow()
    }
    expect(() =>
      persistRemoteImageAttachments({
        appChatId: 'chat-a',
        attachments: Array.from({ length: 21 }, () => ({
          dataBase64: pngBase64(),
          mimeType: 'image/png'
        })),
        store: { writeOwnedMany }
      })
    ).toThrow('count')
    expect(writeOwnedMany).not.toHaveBeenCalled()
  })

  it('strictly removes only retired TaskWraith phone-staging files', () => {
    const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'tw-remote-legacy-test-'))
    tempRoots.push(parent)
    const root = path.join(parent, 'taskwraith-remote-attachments')
    fs.mkdirSync(root)
    fs.writeFileSync(path.join(root, 'chat-a-steer-123-0.png'), 'one')
    fs.writeFileSync(path.join(root, 'chat-a-124-1.jpg'), 'two')

    expect(purgeLegacyRemoteAttachmentTempRoot(root)).toBe(2)
    expect(fs.readdirSync(root)).toEqual([])
  })

  it('fails closed on unknown files, symlinks, and hard links', () => {
    const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'tw-remote-legacy-test-'))
    tempRoots.push(parent)
    const root = path.join(parent, 'taskwraith-remote-attachments')
    fs.mkdirSync(root)
    fs.writeFileSync(path.join(root, 'do-not-delete.txt'), 'user')
    expect(() => purgeLegacyRemoteAttachmentTempRoot(root)).toThrow('unknown entry')
    expect(fs.readFileSync(path.join(root, 'do-not-delete.txt'), 'utf8')).toBe('user')

    fs.unlinkSync(path.join(root, 'do-not-delete.txt'))
    const outside = path.join(parent, 'outside.png')
    fs.writeFileSync(outside, 'outside')
    const linked = path.join(root, 'chat-a-123-0.png')
    fs.linkSync(outside, linked)
    expect(() => purgeLegacyRemoteAttachmentTempRoot(root)).toThrow('unlink-safe')
    expect(fs.readFileSync(outside, 'utf8')).toBe('outside')
  })
})
