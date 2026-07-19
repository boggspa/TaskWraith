import { existsSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, sep } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { saveClipboardImageFromTrustedPaste } from './ClipboardImagePasteHandler'
import { TranscriptMediaAssetStore } from './services/TranscriptMediaAssetStore'

const scratchRoots: string[] = []

afterEach(() => {
  for (const root of scratchRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true })
  }
})

describe('saveClipboardImageFromTrustedPaste', () => {
  it('does not read the host clipboard without a matching one-shot intent', async () => {
    const readImage = vi.fn()
    const writeOwnedMany = vi.fn()

    await expect(
      saveClipboardImageFromTrustedPaste({
        senderId: 11,
        token: 'guessed',
        appChatId: 'chat-1',
        consumeIntent: () => false,
        readImage,
        assetStore: { writeOwnedMany },
        authorizePath: vi.fn()
      })
    ).resolves.toEqual([])

    expect(readImage).not.toHaveBeenCalled()
    expect(writeOwnedMany).not.toHaveBeenCalled()
  })

  it('persists and authorizes one chat-owned image only after consuming the sender intent', async () => {
    const calls: string[] = []
    const writeOwnedMany = vi.fn(() => {
      calls.push('persist')
      return {
        ok: true as const,
        assets: [
          {
            ok: true as const,
            persistenceVersion: 1 as const,
            sha256: 'clipboard-hash',
            path: '/managed/transcript-media/clipboard.png',
            mimeType: 'image/png',
            byteLength: 3
          }
        ]
      }
    })
    const result = await saveClipboardImageFromTrustedPaste({
      senderId: 11,
      token: 'trusted-token',
      appChatId: 'chat-1',
      consumeIntent: (senderId, token) => {
        calls.push(`consume:${senderId}:${String(token)}`)
        return true
      },
      readImage: () => {
        calls.push('read')
        return { isEmpty: () => false, toPNG: () => Buffer.from('png') }
      },
      assetStore: { writeOwnedMany },
      authorizePath: () => {
        calls.push('authorize')
      }
    })

    expect(result).toEqual(['/managed/transcript-media/clipboard.png'])
    expect(calls).toEqual(['consume:11:trusted-token', 'read', 'persist', 'authorize'])
    expect(writeOwnedMany).toHaveBeenCalledWith([
      expect.objectContaining({
        appChatId: 'chat-1',
        mimeType: 'image/png',
        buffer: Buffer.from('png')
      })
    ])
  })

  it.each(['scoped', 'global'] as const)(
    'puts clipboard bytes under transcript-media ownership so %s history deletion erases them',
    async (mode) => {
      const root = mkdtempSync(join(tmpdir(), 'taskwraith-clipboard-owned-test-'))
      scratchRoots.push(root)
      const assetRoot = join(root, 'transcript-media')
      const store = new TranscriptMediaAssetStore(assetRoot)

      const paths = await saveClipboardImageFromTrustedPaste({
        senderId: 11,
        token: 'trusted-token',
        appChatId: 'chat-owned-clipboard',
        consumeIntent: () => true,
        readImage: () => ({
          isEmpty: () => false,
          toPNG: () => Buffer.from('owned clipboard image bytes')
        }),
        assetStore: store,
        authorizePath: vi.fn()
      })

      expect(paths).toHaveLength(1)
      // TranscriptMediaAssetStore returns the canonical path. On macOS,
      // tmpdir() commonly spells /private/var as its /var symlink alias.
      expect(paths[0].startsWith(`${realpathSync.native(assetRoot)}${sep}`)).toBe(true)
      expect(existsSync(paths[0])).toBe(true)

      if (mode === 'scoped') {
        await store.revokeChatOwnershipStrict(['chat-owned-clipboard'])
      } else {
        await store.clearAllStrict()
      }
      expect(existsSync(paths[0])).toBe(false)
    }
  )

  it('does not authorize a path when chat-owned persistence fails closed', async () => {
    const authorizePath = vi.fn()
    await expect(
      saveClipboardImageFromTrustedPaste({
        senderId: 11,
        token: 'trusted-token',
        appChatId: 'chat-1',
        consumeIntent: () => true,
        readImage: () => ({ isEmpty: () => false, toPNG: () => Buffer.from('png') }),
        assetStore: {
          writeOwnedMany: () => ({ ok: false, reason: 'history_cleared' })
        },
        authorizePath
      })
    ).resolves.toEqual([])
    expect(authorizePath).not.toHaveBeenCalled()
  })
})
