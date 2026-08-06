import type { ChatRecord, WorkspaceRecord } from './store/types'
import {
  buildChatMarkdownTranscript,
  buildChatMessageTranscript,
  type TranscriptMarkdownExportOptions
} from './TranscriptMarkdownExport'
import { buildDocx } from './office/DocxCodec'
import { markdownToWordModel } from '../shared/office/wordMarkdown'
import type { ArchivedChatExportFormat } from '../shared/archivedChatExport'

export interface ArchivedChatExportBuildResult {
  content: string | Buffer
  encoding: 'utf8' | 'binary'
  extension: string
  messageCount: number
  charCount: number
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

function htmlDocument(title: string, markdown: string): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(title)}</title>
  <style>
    :root { color-scheme: light dark; }
    body { max-width: 900px; margin: 40px auto; padding: 0 24px; font: 15px/1.55 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
    h1 { font-size: 28px; margin-bottom: 24px; }
    pre { white-space: pre-wrap; overflow-wrap: anywhere; font: 14px/1.55 ui-monospace, SFMono-Regular, Menlo, monospace; }
  </style>
</head>
<body>
  <h1>${escapeHtml(title)}</h1>
  <pre>${escapeHtml(markdown)}</pre>
</body>
</html>
`
}

export function buildArchivedChatExport(
  chat: ChatRecord,
  format: ArchivedChatExportFormat,
  options: TranscriptMarkdownExportOptions & { workspace?: WorkspaceRecord | null } = {}
): ArchivedChatExportBuildResult {
  if (format === 'text') {
    const result = buildChatMessageTranscript(chat)
    return {
      content: result.text,
      encoding: 'utf8',
      extension: 'txt',
      messageCount: result.messageCount,
      charCount: result.charCount
    }
  }

  const markdown = buildChatMarkdownTranscript(chat, options)
  if (format === 'markdown') {
    return {
      content: markdown.markdown,
      encoding: 'utf8',
      extension: 'md',
      messageCount: markdown.messageCount,
      charCount: markdown.charCount
    }
  }

  if (format === 'html') {
    const content = htmlDocument(chat.title || 'Archived thread', markdown.markdown)
    return {
      content,
      encoding: 'utf8',
      extension: 'html',
      messageCount: markdown.messageCount,
      charCount: content.length
    }
  }

  const content = buildDocx(markdownToWordModel(markdown.markdown))
  return {
    content,
    encoding: 'binary',
    extension: 'docx',
    messageCount: markdown.messageCount,
    charCount: content.byteLength
  }
}
