import fs from 'fs'
import os from 'os'
import path from 'path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  persistRemoteImageAttachments,
  purgeLegacyRemoteAttachmentTempRoot
} from './RemoteAttachmentPersistence'

const tempRoots: string[] = []

afterEach(() => {
  for (const root of tempRoots.splice(0)) fs.rmSync(root, { recursive: true, force: true })
})

function pngBase64(bytes: number[] = [0x89, 0x50, 0x4e, 0x47]): string {
  return Buffer.from(bytes).toString('base64')
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
