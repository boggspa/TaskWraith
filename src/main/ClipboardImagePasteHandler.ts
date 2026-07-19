import { createHash } from 'crypto'
import type { TranscriptMediaAssetStore } from './services/TranscriptMediaAssetStore'

export interface ClipboardImageLike {
  isEmpty: () => boolean
  toPNG: () => Buffer
}

type ClipboardImageAssetStore = Pick<TranscriptMediaAssetStore, 'writeOwnedMany'>

export async function saveClipboardImageFromTrustedPaste(input: {
  senderId: number
  token: unknown
  appChatId: string
  consumeIntent: (senderId: number, token: unknown) => boolean
  readImage: () => ClipboardImageLike
  assetStore: ClipboardImageAssetStore
  authorizePath: (path: string) => void
}): Promise<string[]> {
  // Consume the user-gesture proof before any host clipboard read. This order
  // is the security boundary and must not be rearranged.
  if (!input.consumeIntent(input.senderId, input.token)) return []
  const image = input.readImage()
  if (image.isEmpty()) return []

  const buffer = image.toPNG()
  const written = input.assetStore.writeOwnedMany([
    {
      sha256: createHash('sha256').update(buffer).digest('base64url'),
      mimeType: 'image/png',
      buffer,
      appChatId: input.appChatId
    }
  ])
  if (!written.ok || written.assets.length !== 1) return []

  const filePath = written.assets[0].path
  input.authorizePath(filePath)
  return [filePath]
}
