import type { ProjectReference } from '../../../shared/projects'

export type ProjectReferencePresentationKind =
  | 'document'
  | 'spreadsheet'
  | 'presentation'
  | 'pdf'
  | 'code'
  | 'image'
  | 'audio'
  | 'video'
  | 'folder'
  | 'website'
  | 'connector'
  | 'file'

export interface ProjectReferencePresentation {
  kind: ProjectReferencePresentationKind
  label: string
}

const EXTENSIONS: ReadonlyArray<{
  kind: ProjectReferencePresentationKind
  label: string
  values: ReadonlySet<string>
}> = [
  {
    kind: 'document',
    label: 'Document',
    values: new Set(['doc', 'docx', 'docm', 'odt', 'rtf', 'pages'])
  },
  {
    kind: 'spreadsheet',
    label: 'Sheet',
    values: new Set(['xls', 'xlsx', 'xlsm', 'xlsb', 'ods', 'csv', 'tsv', 'numbers'])
  },
  {
    kind: 'presentation',
    label: 'Slides',
    values: new Set(['ppt', 'pptx', 'pptm', 'odp', 'key'])
  },
  { kind: 'pdf', label: 'PDF', values: new Set(['pdf']) },
  {
    kind: 'image',
    label: 'Image',
    values: new Set([
      'avif',
      'bmp',
      'gif',
      'heic',
      'jpeg',
      'jpg',
      'png',
      'svg',
      'tif',
      'tiff',
      'webp'
    ])
  },
  {
    kind: 'audio',
    label: 'Audio',
    values: new Set(['aac', 'aiff', 'flac', 'm4a', 'mp3', 'ogg', 'opus', 'wav'])
  },
  {
    kind: 'video',
    label: 'Video',
    values: new Set(['avi', 'm4v', 'mkv', 'mov', 'mp4', 'mpeg', 'mpg', 'webm'])
  },
  {
    kind: 'code',
    label: 'Code',
    values: new Set([
      'c',
      'cc',
      'cpp',
      'cs',
      'css',
      'go',
      'h',
      'hpp',
      'html',
      'java',
      'js',
      'json',
      'jsx',
      'kt',
      'kts',
      'md',
      'php',
      'pl',
      'py',
      'rb',
      'rs',
      'scss',
      'sh',
      'sql',
      'swift',
      'toml',
      'ts',
      'tsx',
      'vue',
      'xml',
      'yaml',
      'yml'
    ])
  }
]

const CODE_FILENAMES = new Set([
  '.editorconfig',
  '.gitignore',
  'dockerfile',
  'gemfile',
  'makefile',
  'package-lock.json',
  'package.json'
])

export interface ProjectReferenceAttention {
  /** Definitively gone at the last explicit probe. */
  missing: ProjectReference[]
  /** Probeable kinds that have never been verified. */
  unverified: ProjectReference[]
  /** missing + unverified — what a "Verify all" pass should act on. */
  actionable: ProjectReference[]
}

/**
 * The needs-attention rollup over one Project's library. Deliberate
 * exclusions: Off entries (exclusion is intentional user state, not a
 * problem) and URL kinds (never probeable — no network on the library's
 * behalf), so every surfaced item has a real remedy.
 */
export function summarizeReferenceAttention(
  references: ReadonlyArray<
    Pick<ProjectReference, 'kind' | 'contextPolicy'> & Partial<Pick<ProjectReference, 'lastVerified'>>
  >
): ProjectReferenceAttention {
  const missing: ProjectReference[] = []
  const unverified: ProjectReference[] = []
  for (const reference of references) {
    if (reference.contextPolicy === 'off') continue
    if (reference.kind === 'url') continue
    if (reference.lastVerified?.status === 'missing') {
      missing.push(reference as ProjectReference)
    } else if (!reference.lastVerified) {
      unverified.push(reference as ProjectReference)
    }
  }
  return { missing, unverified, actionable: [...missing, ...unverified] }
}

/**
 * Formats a catalogue entry without changing its authority kind. Office,
 * code, and media labels are presentation-only derivations over `file`, so
 * old Project registries can round-trip the entry without losing it.
 */
export function projectReferencePresentation(
  reference: Pick<ProjectReference, 'kind' | 'locator'>
): ProjectReferencePresentation {
  if (reference.kind === 'folder') return { kind: 'folder', label: 'Folder' }
  if (reference.kind === 'url') return { kind: 'website', label: 'Website' }
  if (reference.kind === 'connector') return { kind: 'connector', label: 'GitHub' }

  const filename = reference.locator.split(/[\\/]/).pop()?.toLowerCase() ?? ''
  if (CODE_FILENAMES.has(filename)) return { kind: 'code', label: 'Code' }
  const extension = filename.includes('.') ? filename.slice(filename.lastIndexOf('.') + 1) : ''
  for (const candidate of EXTENSIONS) {
    if (candidate.values.has(extension)) {
      return { kind: candidate.kind, label: candidate.label }
    }
  }
  return { kind: 'file', label: 'File' }
}
