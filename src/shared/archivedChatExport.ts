export type ArchivedChatExportFormat = 'markdown' | 'text' | 'html' | 'docx'

export const ARCHIVED_CHAT_EXPORT_FORMATS: ReadonlyArray<{
  format: ArchivedChatExportFormat
  label: string
  extension: string
}> = [
  { format: 'markdown', label: 'Markdown', extension: 'md' },
  { format: 'text', label: 'Plain text', extension: 'txt' },
  { format: 'html', label: 'HTML', extension: 'html' },
  { format: 'docx', label: 'Word document', extension: 'docx' }
]

export function isArchivedChatExportFormat(value: unknown): value is ArchivedChatExportFormat {
  return ARCHIVED_CHAT_EXPORT_FORMATS.some((entry) => entry.format === value)
}

export function archivedChatExportExtension(format: ArchivedChatExportFormat): string {
  return ARCHIVED_CHAT_EXPORT_FORMATS.find((entry) => entry.format === format)?.extension || 'md'
}
