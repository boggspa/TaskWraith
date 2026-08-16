import { once } from 'node:events'
import { createWriteStream } from 'node:fs'
import type { ChatRecord } from './store/types'
import {
  streamChatMarkdownTranscript,
  type TranscriptMarkdownExportOptions,
  type TranscriptMarkdownStreamResult
} from './TranscriptMarkdownExport'

/**
 * Streams a transcript directly from the main process to a user-selected file.
 * At most one serialized message is resident beyond the canonical chat record,
 * and writable backpressure bounds how quickly those chunks are produced.
 */
export async function writeChatMarkdownTranscriptToFile(
  chat: ChatRecord,
  options: TranscriptMarkdownExportOptions,
  filePath: string
): Promise<TranscriptMarkdownStreamResult> {
  const output = createWriteStream(filePath, { encoding: 'utf8' })
  let streamFailure: unknown = null
  const outputError = new Promise<never>((_resolve, reject) => {
    output.once('error', (error) => {
      streamFailure = error
      reject(error)
    })
  })

  try {
    const result = await Promise.race([
      streamChatMarkdownTranscript(chat, options, async (chunk) => {
        if (streamFailure) throw streamFailure
        if (!output.write(chunk, 'utf8')) {
          await Promise.race([once(output, 'drain'), outputError])
        }
      }),
      outputError
    ])
    await Promise.race([
      new Promise<void>((resolve) => {
        output.end(resolve)
      }),
      outputError
    ])
    return result
  } catch (error) {
    output.destroy()
    throw error
  }
}
