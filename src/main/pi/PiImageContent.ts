import {
  CLAUDE_IMAGE_MAX_BYTES,
  claudeImageMediaTypeForPath,
  type ClaudeImageAttachmentContent
} from '../ClaudeImageContent'

/** Pi RPC's `ImageContent` wire shape (`@earendil-works/pi-ai`). */
export interface PiRpcImageContent {
  type: 'image'
  mimeType: string
  data: string
}

/**
 * Keep the same conservative per-image ceiling as the existing Claude image
 * lane. Pi forwards these bytes to multiple upstream APIs; normalizing large
 * inputs before the RPC boundary avoids provider-specific request failures.
 */
export const PI_RPC_IMAGE_MAX_BYTES = CLAUDE_IMAGE_MAX_BYTES

export class PiImageAttachmentError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'PiImageAttachmentError'
  }
}

export interface LoadPiImageDeps {
  readFile: (imagePath: string) => Promise<Buffer>
  convertToSupported?: (
    imagePath: string,
    buffer: Buffer
  ) => Promise<ClaudeImageAttachmentContent | null>
}

export async function loadPiRpcImageContents(
  imagePaths: readonly string[],
  deps: LoadPiImageDeps
): Promise<PiRpcImageContent[]> {
  const images: PiRpcImageContent[] = []
  for (const imagePath of imagePaths) {
    let buffer: Buffer
    try {
      buffer = await deps.readFile(imagePath)
    } catch (error) {
      throw new PiImageAttachmentError(
        `The attached image could not be read for Pi (${imagePath}): ${
          error instanceof Error ? error.message : String(error)
        }. The run was not dispatched with the image silently omitted.`
      )
    }

    const mediaType = claudeImageMediaTypeForPath(imagePath)
    if (mediaType && buffer.byteLength <= PI_RPC_IMAGE_MAX_BYTES) {
      images.push({ type: 'image', mimeType: mediaType, data: buffer.toString('base64') })
      continue
    }

    const converted = deps.convertToSupported
      ? await deps.convertToSupported(imagePath, buffer)
      : null
    const convertedBytes = converted ? Buffer.from(converted.dataBase64, 'base64').byteLength : 0
    if (!converted || convertedBytes === 0 || convertedBytes > PI_RPC_IMAGE_MAX_BYTES) {
      throw new PiImageAttachmentError(
        mediaType
          ? `The attached image is larger than the ${Math.floor(
              PI_RPC_IMAGE_MAX_BYTES / (1024 * 1024)
            )}MB Pi RPC limit and could not be downscaled (${imagePath}). ` +
              'The run was not dispatched with the image silently omitted.'
          : `The attached file is not an image format Pi accepts (png, jpeg, gif, webp) ` +
              `and could not be converted (${imagePath}). The run was not dispatched with the ` +
              'attachment silently omitted.'
      )
    }
    images.push({
      type: 'image',
      mimeType: converted.mediaType,
      data: converted.dataBase64
    })
  }
  return images
}
