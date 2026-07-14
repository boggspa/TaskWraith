export interface ClipboardImageLike {
  isEmpty: () => boolean
  toPNG: () => Buffer
}

export async function saveClipboardImageFromTrustedPaste(input: {
  senderId: number
  token: unknown
  consumeIntent: (senderId: number, token: unknown) => boolean
  readImage: () => ClipboardImageLike
  createFilePath: () => string
  writeFile: (path: string, data: Buffer) => Promise<void>
  authorizePath: (path: string) => void
}): Promise<string[]> {
  // Consume the user-gesture proof before any host clipboard read. This order
  // is the security boundary and must not be rearranged.
  if (!input.consumeIntent(input.senderId, input.token)) return []
  const image = input.readImage()
  if (image.isEmpty()) return []
  const filePath = input.createFilePath()
  await input.writeFile(filePath, image.toPNG())
  input.authorizePath(filePath)
  return [filePath]
}
