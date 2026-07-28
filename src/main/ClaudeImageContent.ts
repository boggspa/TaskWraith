// Image attachment delivery for the Claude Agent SDK lane.
//
// The SDK's options bag has NO `images` field (silently ignored) and the
// installed Claude CLI has no `--image` flag — both were load-bearing
// assumptions behind "attach an image to Claude" and neither has ever
// delivered a byte. The mechanism that actually works is the SDK's streaming
// input mode: `query({ prompt })` accepts an AsyncIterable<SDKUserMessage>,
// and a user message's content may carry base64 image blocks exactly like a
// raw Messages API call.
//
// This module builds that message. Reading and converting files is injected
// (fs + Electron nativeImage live in the caller) so everything here is
// unit-testable, and failures throw ClaudeImageAttachmentError with
// no-silent-omission copy — a run is never dispatched pretending the image
// made it when it didn't.

import type { SDKUserMessage } from '@anthropic-ai/claude-agent-sdk'

export type ClaudeImageMediaType = 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp'

export interface ClaudeImageAttachmentContent {
  mediaType: ClaudeImageMediaType
  dataBase64: string
}

/** Anthropic's per-image request cap. Anything larger must be converted or
 * downscaled by the injected converter before it can ship. */
export const CLAUDE_IMAGE_MAX_BYTES = 5 * 1024 * 1024

const MEDIA_TYPE_BY_EXTENSION: Record<string, ClaudeImageMediaType> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp'
}

export function claudeImageMediaTypeForPath(imagePath: string): ClaudeImageMediaType | null {
  const match = /\.([A-Za-z0-9]+)$/.exec(imagePath.trim())
  if (!match) return null
  return MEDIA_TYPE_BY_EXTENSION[match[1].toLowerCase()] ?? null
}

export class ClaudeImageAttachmentError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ClaudeImageAttachmentError'
  }
}

export interface LoadClaudeImageDeps {
  readFile: (imagePath: string) => Promise<Buffer>
  /** Convert an unsupported-format or oversized image into a supported,
   * under-cap payload (e.g. Electron nativeImage → JPEG). Return null when
   * the bytes cannot be decoded — the load then fails loudly. */
  convertToSupported?: (
    imagePath: string,
    buffer: Buffer
  ) => Promise<ClaudeImageAttachmentContent | null>
}

export async function loadClaudeImageAttachmentContents(
  imagePaths: string[],
  deps: LoadClaudeImageDeps
): Promise<ClaudeImageAttachmentContent[]> {
  const contents: ClaudeImageAttachmentContent[] = []
  for (const imagePath of imagePaths) {
    let buffer: Buffer
    try {
      buffer = await deps.readFile(imagePath)
    } catch (err) {
      throw new ClaudeImageAttachmentError(
        `The attached image could not be read (${imagePath}): ${
          err instanceof Error ? err.message : String(err)
        }. The run was not dispatched with the image silently omitted.`
      )
    }
    const mediaType = claudeImageMediaTypeForPath(imagePath)
    if (mediaType && buffer.byteLength <= CLAUDE_IMAGE_MAX_BYTES) {
      contents.push({ mediaType, dataBase64: buffer.toString('base64') })
      continue
    }
    const converted = deps.convertToSupported
      ? await deps.convertToSupported(imagePath, buffer)
      : null
    if (
      !converted ||
      Buffer.from(converted.dataBase64, 'base64').byteLength > CLAUDE_IMAGE_MAX_BYTES
    ) {
      throw new ClaudeImageAttachmentError(
        mediaType
          ? `The attached image is larger than Claude's ${Math.floor(
              CLAUDE_IMAGE_MAX_BYTES / (1024 * 1024)
            )}MB per-image limit and could not be downscaled (${imagePath}). ` +
              'The run was not dispatched with the image silently omitted.'
          : `The attached file is not an image format Claude accepts (png, jpeg, gif, webp) ` +
              `and could not be converted (${imagePath}). The run was not dispatched with the ` +
              'attachment silently omitted.'
      )
    }
    contents.push(converted)
  }
  return contents
}

/** One user turn carrying the composed prompt plus every attachment, shaped
 * for the SDK's streaming input mode. Images lead, text follows — the
 * ordering Anthropic documents as best for vision prompts. */
export function buildClaudeImageUserMessage(
  promptText: string,
  images: ClaudeImageAttachmentContent[]
): SDKUserMessage {
  return {
    type: 'user',
    message: {
      role: 'user',
      content: [
        ...images.map((image) => ({
          type: 'image' as const,
          source: {
            type: 'base64' as const,
            media_type: image.mediaType,
            data: image.dataBase64
          }
        })),
        { type: 'text' as const, text: promptText }
      ]
    },
    parent_tool_use_id: null
  } as SDKUserMessage
}

/** The single-shot input stream: yield the one composed user message, then
 * end — the SDK holds the turn open until the provider's result arrives. */
export async function* claudeImageUserMessageStream(
  promptText: string,
  images: ClaudeImageAttachmentContent[]
): AsyncGenerator<SDKUserMessage> {
  yield buildClaudeImageUserMessage(promptText, images)
}
