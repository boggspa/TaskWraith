import { describe, expect, it, vi } from 'vitest'
import { saveClipboardImageFromTrustedPaste } from './ClipboardImagePasteHandler'

describe('saveClipboardImageFromTrustedPaste', () => {
  it('does not read the host clipboard without a matching one-shot intent', async () => {
    const readImage = vi.fn()
    const writeFile = vi.fn()

    await expect(
      saveClipboardImageFromTrustedPaste({
        senderId: 11,
        token: 'guessed',
        consumeIntent: () => false,
        readImage,
        createFilePath: () => '/tmp/paste.png',
        writeFile,
        authorizePath: vi.fn()
      })
    ).resolves.toEqual([])

    expect(readImage).not.toHaveBeenCalled()
    expect(writeFile).not.toHaveBeenCalled()
  })

  it('writes and authorizes one image only after consuming the sender intent', async () => {
    const calls: string[] = []
    const result = await saveClipboardImageFromTrustedPaste({
      senderId: 11,
      token: 'trusted-token',
      consumeIntent: (senderId, token) => {
        calls.push(`consume:${senderId}:${String(token)}`)
        return true
      },
      readImage: () => {
        calls.push('read')
        return { isEmpty: () => false, toPNG: () => Buffer.from('png') }
      },
      createFilePath: () => '/tmp/paste.png',
      writeFile: async () => {
        calls.push('write')
      },
      authorizePath: () => {
        calls.push('authorize')
      }
    })

    expect(result).toEqual(['/tmp/paste.png'])
    expect(calls).toEqual(['consume:11:trusted-token', 'read', 'write', 'authorize'])
  })
})
