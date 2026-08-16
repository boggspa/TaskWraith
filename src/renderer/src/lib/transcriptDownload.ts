import type { CopyTranscriptResult } from '../components/CopyTranscriptButton'
import type { TranscriptExportScope } from '../../../shared/transcriptExportScope'

/**
 * Saves the main-built handoff Markdown for a chat as a `.md` file named for
 * the thread.
 *
 * Round exports use the renderer's ordinary object-URL download path. The
 * explicit entire-task scope is different: main streams it straight to the
 * user-selected file and returns only counts/name, so this module never sees
 * or constructs the complete task Markdown.
 */
export async function downloadChatMarkdownTranscript(
  chatId: string | null | undefined,
  scope?: TranscriptExportScope
): Promise<CopyTranscriptResult> {
  if (!chatId) return { ok: false, reason: 'empty' }
  const result = await window.api.downloadChatMarkdownTranscript(chatId, scope)
  if (!result.ok) return result
  if (result.streamed) {
    return {
      ok: true,
      messageCount: result.messageCount,
      charCount: result.charCount,
      omissions: result.omissions,
      fileName: result.fileName
    }
  }
  const blob = new Blob([result.markdown], { type: 'text/markdown;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = result.fileName
  document.body.appendChild(link)
  link.click()
  document.body.removeChild(link)
  URL.revokeObjectURL(url)
  return {
    ok: true,
    messageCount: result.messageCount,
    charCount: result.charCount,
    omissions: result.omissions,
    fileName: result.fileName
  }
}
