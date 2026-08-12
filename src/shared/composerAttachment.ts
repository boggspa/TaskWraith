export type ComposerAttachmentKind = 'file' | 'directory'

export interface ComposerAttachmentReference {
  id?: string
  path: string
  name?: string
  /** Missing on legacy rows, where attachments were always files. */
  kind?: ComposerAttachmentKind
}

export function isDirectoryComposerAttachment(
  value: unknown
): value is ComposerAttachmentReference & { kind: 'directory' } {
  return Boolean(
    value && typeof value === 'object' && (value as { kind?: unknown }).kind === 'directory'
  )
}

export function composerAttachmentKind(value: unknown): ComposerAttachmentKind {
  return isDirectoryComposerAttachment(value) ? 'directory' : 'file'
}
