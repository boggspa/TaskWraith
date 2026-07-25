/**
 * Office file-format registry: which on-disk formats exist, which editor kind
 * owns each, which are binary ZIP containers, and how open/export routing
 * decides between the Office suite and the plain code editor.
 */

import type { OfficeDocumentKind, OfficeDocumentModel } from './officeModels'

export type OfficeFileFormat = 'docx' | 'md' | 'xlsx' | 'csv' | 'tsv' | 'pptx' | 'ics' | 'eml'

export const OFFICE_FORMAT_KINDS: Record<OfficeFileFormat, OfficeDocumentKind> = {
  docx: 'word',
  md: 'word',
  xlsx: 'sheet',
  csv: 'sheet',
  tsv: 'sheet',
  pptx: 'deck',
  ics: 'calendar',
  eml: 'mail'
}

/** Formats stored as ZIP/OOXML containers — read and written through the base64 IPC lane. */
export const OFFICE_BINARY_FORMATS: ReadonlySet<OfficeFileFormat> = new Set([
  'docx',
  'xlsx',
  'pptx'
])

/**
 * Formats the Files tree hands over to the Office suite on open. Markdown,
 * CSV and TSV deliberately stay in the code editor by default — they are
 * legitimate source files — but remain openable from the Office rail.
 */
export const OFFICE_AUTO_ROUTE_FORMATS: ReadonlySet<OfficeFileFormat> = new Set([
  'docx',
  'xlsx',
  'pptx',
  'ics',
  'eml'
])

export function officeFormatForPath(filePath: string): OfficeFileFormat | null {
  const match = /\.([A-Za-z0-9]+)$/.exec(filePath)
  if (!match) return null
  const extension = match[1].toLowerCase()
  return extension in OFFICE_FORMAT_KINDS ? (extension as OfficeFileFormat) : null
}

export function officeKindForPath(filePath: string): OfficeDocumentKind | null {
  const format = officeFormatForPath(filePath)
  return format ? OFFICE_FORMAT_KINDS[format] : null
}

export function isOfficeDocumentPath(filePath: string): boolean {
  return officeFormatForPath(filePath) !== null
}

export function shouldAutoRouteToOffice(filePath: string): boolean {
  const format = officeFormatForPath(filePath)
  return format !== null && OFFICE_AUTO_ROUTE_FORMATS.has(format)
}

/** Save-as / export targets per editor kind, most-compatible format first. */
export function exportFormatsForKind(kind: OfficeDocumentKind): OfficeFileFormat[] {
  switch (kind) {
    case 'word':
      return ['docx', 'md']
    case 'sheet':
      return ['xlsx', 'csv', 'tsv']
    case 'deck':
      return ['pptx', 'md']
    case 'calendar':
      return ['ics']
    case 'mail':
      return ['eml']
  }
}

export function officeFormatLabel(format: OfficeFileFormat): string {
  switch (format) {
    case 'docx':
      return 'Word (.docx)'
    case 'md':
      return 'Markdown (.md)'
    case 'xlsx':
      return 'Excel (.xlsx)'
    case 'csv':
      return 'CSV (.csv)'
    case 'tsv':
      return 'TSV (.tsv)'
    case 'pptx':
      return 'PowerPoint (.pptx)'
    case 'ics':
      return 'iCalendar (.ics)'
    case 'eml':
      return 'Email (.eml)'
  }
}

export function officeKindLabel(kind: OfficeDocumentKind): string {
  switch (kind) {
    case 'word':
      return 'Document'
    case 'sheet':
      return 'Spreadsheet'
    case 'deck':
      return 'Slide deck'
    case 'calendar':
      return 'Calendar'
    case 'mail':
      return 'Email'
  }
}

export function defaultDocumentNameForKind(kind: OfficeDocumentKind): string {
  switch (kind) {
    case 'word':
      return 'Untitled Document.docx'
    case 'sheet':
      return 'Untitled Spreadsheet.xlsx'
    case 'deck':
      return 'Untitled Deck.pptx'
    case 'calendar':
      return 'Calendar.ics'
    case 'mail':
      return 'Untitled Email.eml'
  }
}

/** Swap (or append) the file extension so `report.docx` exports as `report.md`. */
export function replaceOfficeExtension(filePath: string, format: OfficeFileFormat): string {
  const slash = Math.max(filePath.lastIndexOf('/'), filePath.lastIndexOf('\\'))
  const dot = filePath.lastIndexOf('.')
  const stem = dot > slash + 1 ? filePath.slice(0, dot) : filePath
  return `${stem}.${format}`
}

/**
 * Maps an absolute path (a project file reference locator) to a
 * workspace-relative path when it lies strictly inside the workspace root.
 * Separator-normalized so Windows locators match; returns null for the root
 * itself, paths outside the root, or blank inputs. Purely lexical — callers
 * that touch the filesystem still go through the main-process containment
 * checks.
 */
export function officeWorkspaceRelativePath(
  workspaceRoot: string,
  absolutePath: string
): string | null {
  const normalize = (value: string): string => value.trim().replace(/\\/g, '/').replace(/\/+$/, '')
  const root = normalize(workspaceRoot)
  const target = normalize(absolutePath)
  if (!root || !target || target === root) return null
  if (!target.startsWith(`${root}/`)) return null
  const relative = target.slice(root.length + 1)
  if (!relative) return null
  // Dot segments could re-escape after the prefix check; the main process
  // re-validates containment, but the affordance should never offer them.
  if (relative.split('/').some((segment) => segment === '..' || segment === '.')) return null
  return relative
}

/** Read/write result exchanged over the office document IPC channels. */
export interface OfficeDocumentReadResult {
  path: string
  kind: OfficeDocumentKind
  format: OfficeFileFormat
  model: OfficeDocumentModel
  etag: string | null
  sizeBytes: number
  mtimeMs?: number
  warnings: string[]
}
