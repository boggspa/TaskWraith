import type { CopyTranscriptResult } from '../components/CopyTranscriptButton'

/**
 * Saves the main-built handoff Markdown for a chat as a `.md` file named for
 * the thread.
 *
 * Main returns the text rather than writing the file itself so the save goes
 * through the renderer's ordinary download path (same object-URL anchor the
 * roster/ledger exports use) and the clipboard is left untouched. The result
 * is re-shaped into `CopyTranscriptResult` so the popover renders download
 * outcomes through exactly the same status/error surface as the copy actions.
 */
export async function downloadChatMarkdownTranscript(
  chatId: string | null | undefined
): Promise<CopyTranscriptResult> {
  if (!chatId) return { ok: false, reason: 'empty' }
  const result = await window.api.downloadChatMarkdownTranscript(chatId)
  if (!result.ok) return result
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
