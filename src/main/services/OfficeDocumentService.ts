/**
 * Office document service: converts between on-disk formats and the shared
 * office models, delegating ALL filesystem access to the hardened
 * WorkspaceFileEditorService primitives (descriptor-pinned reads/writes,
 * TOCTOU checks, etag optimistic concurrency). This module never touches
 * `fs` directly.
 *
 * Text formats (md/csv/tsv/ics/eml) travel the utf8 lane and keep change-set
 * recording; binary OOXML containers (docx/xlsx/pptx) travel the base64 lane
 * without change-set diffs (they are not meaningfully text-diffable).
 */

import { basename, dirname } from 'path'
import {
  OFFICE_BINARY_FORMATS,
  OFFICE_FORMAT_KINDS,
  officeFormatForPath,
  type OfficeDocumentReadResult,
  type OfficeFileFormat
} from '../../shared/office/officeFormats'
import {
  normalizeOfficeDocumentModel,
  type OfficeDocumentModel
} from '../../shared/office/officeModels'
import { buildDelimitedText, parseDelimitedText } from '../../shared/office/csvCodec'
import { buildIcs, parseIcs } from '../../shared/office/icsCodec'
import { systemTimeZone } from '../../shared/office/zonedTime'
import { buildEml, parseEml } from '../../shared/office/emlCodec'
import { markdownToWordModel, wordModelToMarkdown } from '../../shared/office/wordMarkdown'
import { deckModelToMarkdown } from '../../shared/office/deckMarkdown'
import { buildDocx, OfficeCodecError, parseDocx } from '../office/DocxCodec'
import { buildXlsx, parseXlsx } from '../office/XlsxCodec'
import { buildPptx, parsePptx } from '../office/PptxCodec'
import {
  deleteWorkspaceFile,
  readWorkspaceFile,
  writeWorkspaceFile,
  type RecordWorkspaceEditorChangeFn,
  type WorkspaceFileDeleteResult
} from './WorkspaceFileEditorService'

/** Office documents may exceed the plain-text editor cap (images-free OOXML stays small, but imports vary). */
export const MAX_OFFICE_FILE_BYTES = 25_000_000

export type OfficeDocumentErrorCode =
  | 'unsupported_format'
  | 'invalid_document'
  | 'kind_mismatch'
  | 'invalid_model'
  | 'unsafe_external_path'

export class OfficeDocumentError extends Error {
  readonly code: OfficeDocumentErrorCode

  constructor(code: OfficeDocumentErrorCode, message: string) {
    super(message)
    this.name = 'OfficeDocumentError'
    this.code = code
  }
}

interface DecodedDocument {
  model: OfficeDocumentModel
  warnings: string[]
}

function decodeDocument(format: OfficeFileFormat, raw: string | Buffer): DecodedDocument {
  try {
    switch (format) {
      case 'docx':
        return parseDocx(raw as Buffer)
      case 'xlsx':
        return parseXlsx(raw as Buffer)
      case 'pptx':
        return parsePptx(raw as Buffer)
      case 'md':
        return { model: markdownToWordModel(String(raw)), warnings: [] }
      case 'csv':
        return {
          model: {
            kind: 'sheet',
            sheets: [{ name: 'Sheet1', rows: parseDelimitedText(String(raw), ',') }]
          },
          warnings: []
        }
      case 'tsv':
        return {
          model: {
            kind: 'sheet',
            sheets: [{ name: 'Sheet1', rows: parseDelimitedText(String(raw), '\t') }]
          },
          warnings: []
        }
      case 'ics': {
        const parsed = parseIcs(String(raw), { displayZone: systemTimeZone() })
        return { model: parsed.model, warnings: parsed.warnings }
      }
      case 'eml': {
        const parsed = parseEml(String(raw))
        return { model: parsed.model, warnings: parsed.warnings }
      }
    }
  } catch (error) {
    if (error instanceof OfficeCodecError) {
      throw new OfficeDocumentError('invalid_document', error.message)
    }
    throw error
  }
}

interface EncodedDocument {
  content: string
  encoding: 'utf8' | 'base64'
  warnings: string[]
}

function encodeDocument(format: OfficeFileFormat, model: OfficeDocumentModel): EncodedDocument {
  switch (format) {
    case 'docx':
      if (model.kind !== 'word') throw kindMismatch(format, model.kind)
      return { content: buildDocx(model).toString('base64'), encoding: 'base64', warnings: [] }
    case 'xlsx':
      if (model.kind !== 'sheet') throw kindMismatch(format, model.kind)
      return { content: buildXlsx(model).toString('base64'), encoding: 'base64', warnings: [] }
    case 'pptx': {
      if (model.kind !== 'deck') throw kindMismatch(format, model.kind)
      const built = buildPptx(model)
      return {
        content: built.data.toString('base64'),
        encoding: 'base64',
        warnings: built.warnings
      }
    }
    case 'md':
      if (model.kind === 'word') {
        return { content: wordModelToMarkdown(model), encoding: 'utf8', warnings: [] }
      }
      if (model.kind === 'deck') {
        // Deck → markdown export keeps notes; import of that file reads as word.
        return { content: deckModelToMarkdown(model), encoding: 'utf8', warnings: [] }
      }
      throw kindMismatch(format, model.kind)
    case 'csv':
    case 'tsv': {
      if (model.kind !== 'sheet') throw kindMismatch(format, model.kind)
      const delimiter = format === 'csv' ? ',' : '\t'
      const warnings =
        model.sheets.length > 1
          ? [`Only the first sheet was exported to .${format}; the others need .xlsx.`]
          : []
      const rows = model.sheets[0]?.rows ?? []
      return { content: buildDelimitedText(rows, delimiter), encoding: 'utf8', warnings }
    }
    case 'ics':
      if (model.kind !== 'calendar') throw kindMismatch(format, model.kind)
      return { content: buildIcs(model), encoding: 'utf8', warnings: [] }
    case 'eml':
      if (model.kind !== 'mail') throw kindMismatch(format, model.kind)
      return {
        content: buildEml(model, { date: model.date ?? new Date().toUTCString() }),
        encoding: 'utf8',
        warnings: []
      }
  }
}

const kindMismatch = (format: OfficeFileFormat, kind: string): OfficeDocumentError =>
  new OfficeDocumentError('kind_mismatch', `A ${kind} document cannot be saved as .${format}.`)

function requireOfficeFormat(filePath: string): OfficeFileFormat {
  const format = officeFormatForPath(filePath)
  if (!format) {
    throw new OfficeDocumentError('unsupported_format', 'This file type is not an Office document.')
  }
  return format
}

export async function readOfficeDocument(
  workspacePath: string,
  filePath: string
): Promise<OfficeDocumentReadResult> {
  const format = requireOfficeFormat(filePath)
  // Office documents always read byte-exact. The utf8 lane's strictness is
  // right for source code, but it would reject a legacy cp1252 .eml or .ics
  // that every mail client opens fine — so decoding is decided here instead.
  const read = await readWorkspaceFile(workspacePath, filePath, {
    encoding: 'base64',
    maxBytes: MAX_OFFICE_FILE_BYTES
  })
  const bytes = Buffer.from(read.content, 'base64')
  const textWarnings: string[] = []
  let raw: string | Buffer = bytes
  if (!OFFICE_BINARY_FORMATS.has(format)) {
    const decodedText = decodeOfficeText(bytes)
    raw = decodedText.text
    if (decodedText.fallback) {
      textWarnings.push('File is not valid UTF-8; decoded as Latin-1. Saving rewrites it as UTF-8.')
    }
  }
  const decoded = decodeDocument(format, raw)
  // The editor works on the NORMALIZED model, so what the user sees is
  // exactly what a save will write — any clamping happens here, loudly,
  // instead of silently at save time.
  const model = normalizeOfficeDocumentModel(decoded.model) ?? decoded.model
  const truncationWarnings = summarizeReadTruncation(decoded.model, model)
  return {
    path: read.path,
    kind: OFFICE_FORMAT_KINDS[format],
    format,
    model,
    etag: read.etag ?? null,
    sizeBytes: read.sizeBytes,
    mtimeMs: read.mtimeMs,
    warnings: [...textWarnings, ...truncationWarnings, ...decoded.warnings]
  }
}

/**
 * UTF-8 when the bytes really are UTF-8, Latin-1 otherwise. Latin-1 maps
 * every byte to a codepoint, so nothing is lost on the way in; a later save
 * normalizes the file to UTF-8, which the warning states plainly.
 */
function decodeOfficeText(bytes: Buffer): { text: string; fallback: boolean } {
  const utf8 = bytes.toString('utf8')
  if (Buffer.from(utf8, 'utf8').equals(bytes)) return { text: utf8, fallback: false }
  return { text: bytes.toString('latin1'), fallback: true }
}

/**
 * Human-readable description of what read-time normalization clamped, so a
 * file exceeding the editor's limits announces the loss BEFORE the user
 * saves a truncated version over the original.
 */
function summarizeReadTruncation(
  original: OfficeDocumentModel,
  normalized: OfficeDocumentModel
): string[] {
  const warnings: string[] = []
  const suffix = 'Saving writes only what the editor shows.'
  if (original.kind === 'word' && normalized.kind === 'word') {
    if (normalized.blocks.length < original.blocks.length) {
      warnings.push(
        `Document truncated to the first ${normalized.blocks.length} of ${original.blocks.length} blocks. ${suffix}`
      )
    }
  } else if (original.kind === 'sheet' && normalized.kind === 'sheet') {
    original.sheets.forEach((sheet, index) => {
      const kept = normalized.sheets[index]
      if (!kept) {
        warnings.push(`Sheet "${sheet.name}" exceeds the workbook limit and was dropped. ${suffix}`)
        return
      }
      const originalCols = sheet.rows.reduce((max, row) => Math.max(max, row.length), 0)
      const keptCols = kept.rows.reduce((max, row) => Math.max(max, row.length), 0)
      if (kept.rows.length < sheet.rows.length || keptCols < originalCols) {
        warnings.push(
          `Sheet "${sheet.name}" truncated to ${kept.rows.length} rows × ${Math.max(keptCols, 1)} columns` +
            ` (file has ${sheet.rows.length} × ${Math.max(originalCols, 1)}). ${suffix}`
        )
      }
    })
  } else if (original.kind === 'deck' && normalized.kind === 'deck') {
    if (normalized.slides.length < original.slides.length) {
      warnings.push(
        `Deck truncated to the first ${normalized.slides.length} of ${original.slides.length} slides. ${suffix}`
      )
    }
  } else if (original.kind === 'calendar' && normalized.kind === 'calendar') {
    if (normalized.events.length < original.events.length) {
      warnings.push(
        `Calendar kept ${normalized.events.length} of ${original.events.length} events. ${suffix}`
      )
    }
  } else if (original.kind === 'mail' && normalized.kind === 'mail') {
    if (normalized.body.length < original.body.length) {
      warnings.push(
        `Message body truncated to ${normalized.body.length} of ${original.body.length} characters. ${suffix}`
      )
    }
  }
  return warnings
}

export interface OfficeDocumentWriteOptions {
  workspacePath: string
  workspaceId?: string
  filePath: string
  /** Untrusted model payload from the renderer; normalized before encoding. */
  model: unknown
  /** Etag from the previous read; null/undefined creates a new file. */
  baseEtag?: string | null
  recordChange?: RecordWorkspaceEditorChangeFn
}

export async function writeOfficeDocument(
  options: OfficeDocumentWriteOptions
): Promise<OfficeDocumentReadResult> {
  const format = requireOfficeFormat(options.filePath)
  const model = normalizeOfficeDocumentModel(options.model)
  if (!model) {
    throw new OfficeDocumentError('invalid_model', 'The document payload is not a valid model.')
  }
  const expectedKind = OFFICE_FORMAT_KINDS[format]
  if (model.kind !== expectedKind) throw kindMismatch(format, model.kind)

  // Surface silently-dropped images (bad format / over the size cap) so a
  // save never loses a pasted picture without telling the user.
  const droppedImageWarnings: string[] = []
  if (model.kind === 'word') {
    const requested = countRequestedImageBlocks(options.model)
    const kept = model.blocks.filter((block) => block.type === 'image').length
    if (requested > kept) {
      const dropped = requested - kept
      droppedImageWarnings.push(
        `${dropped} image${dropped === 1 ? ' was' : 's were'} removed: only PNG/JPEG/GIF up to 4 MB are supported.`
      )
    }
  }

  const encoded = encodeDocument(format, model)
  const written = await writeWorkspaceFile({
    workspacePath: options.workspacePath,
    workspaceId: options.workspaceId,
    filePath: options.filePath,
    content: encoded.content,
    baseEtag: options.baseEtag ?? null,
    origin: 'office-suite',
    contentEncoding: encoded.encoding,
    maxBytes: MAX_OFFICE_FILE_BYTES,
    // Change-set diffs only make sense for the text lane.
    recordChange: encoded.encoding === 'utf8' ? options.recordChange : undefined
  })

  return {
    path: written.path,
    kind: expectedKind,
    format,
    model,
    etag: written.etag ?? null,
    sizeBytes: written.sizeBytes,
    mtimeMs: written.mtimeMs,
    warnings: [...droppedImageWarnings, ...encoded.warnings]
  }
}

/**
 * External (grant-covered) documents reuse the workspace read/write pipeline
 * rooted at the file's parent directory — same hardened I/O, same etag
 * concurrency, same normalization warnings. Grant AUTHORITY lives entirely
 * in the IPC handler; these functions only add the path-shape guards and
 * report the document under its absolute path. Change-set recording and git
 * refreshes are registered-workspace concepts and never run here.
 */
function externalOfficeRoot(absolutePath: string): { root: string; name: string } {
  const root = dirname(absolutePath)
  const name = basename(absolutePath)
  if (!name || root === absolutePath) {
    throw new OfficeDocumentError('unsafe_external_path', 'This path cannot be opened.')
  }
  // Refuse filesystem roots as containment roots (mirrors the workspace-side
  // assertSafeWorkspaceRoot, which lives at the registration layer).
  if (dirname(root) === root) {
    throw new OfficeDocumentError(
      'unsafe_external_path',
      'Files directly under the filesystem root cannot be opened.'
    )
  }
  return { root, name }
}

export async function readExternalOfficeDocument(
  absolutePath: string
): Promise<OfficeDocumentReadResult> {
  const { root, name } = externalOfficeRoot(absolutePath)
  const result = await readOfficeDocument(root, name)
  return { ...result, path: absolutePath }
}

export interface ExternalOfficeDocumentWriteOptions {
  absolutePath: string
  /** Untrusted model payload from the renderer; normalized before encoding. */
  model: unknown
  baseEtag?: string | null
}

export async function writeExternalOfficeDocument(
  options: ExternalOfficeDocumentWriteOptions
): Promise<OfficeDocumentReadResult> {
  const { root, name } = externalOfficeRoot(options.absolutePath)
  const result = await writeOfficeDocument({
    workspacePath: root,
    filePath: name,
    model: options.model,
    baseEtag: options.baseEtag
  })
  return { ...result, path: options.absolutePath }
}

export interface OfficeDocumentImportOptions {
  workspacePath: string
  workspaceId?: string
  /** Destination path relative to the workspace; caller has already deduped it. */
  filePath: string
  /** Raw bytes of the dropped file, base64-encoded. */
  contentBase64: string
  recordChange?: RecordWorkspaceEditorChangeFn
}

/**
 * Imports a dropped file (an Outlook .eml/.ics drag-out, a downloaded .docx)
 * into the workspace by writing its raw bytes, then reads it back through the
 * normal decode path so the caller gets a model plus any import warnings.
 * Bytes are written verbatim — no model round-trip — so nothing is lost
 * between the dropped file and what lands on disk.
 */
export async function importOfficeDocument(
  options: OfficeDocumentImportOptions
): Promise<OfficeDocumentReadResult> {
  const format = requireOfficeFormat(options.filePath)
  const bytes = Buffer.from(options.contentBase64, 'base64')
  if (bytes.length === 0) {
    throw new OfficeDocumentError('invalid_document', 'The dropped file is empty.')
  }
  // Verbatim means verbatim: the utf8 lane is only safe when the bytes
  // survive a decode/encode round trip. A legacy cp1252 .eml (exactly what
  // older Outlook exports produce) would otherwise land with U+FFFD
  // replacements baked in, unrecoverably. Anything lossy goes down the
  // base64 lane instead, at the cost of a text change-set entry.
  const utf8Safe =
    !OFFICE_BINARY_FORMATS.has(format) &&
    Buffer.from(bytes.toString('utf8'), 'utf8').equals(bytes) &&
    !bytes.includes(0)
  const written = await writeWorkspaceFile({
    workspacePath: options.workspacePath,
    workspaceId: options.workspaceId,
    filePath: options.filePath,
    content: utf8Safe ? bytes.toString('utf8') : bytes.toString('base64'),
    contentEncoding: utf8Safe ? 'utf8' : 'base64',
    baseEtag: null,
    origin: 'office-import',
    maxBytes: MAX_OFFICE_FILE_BYTES,
    recordChange: utf8Safe ? options.recordChange : undefined
  })
  try {
    return await readOfficeDocument(options.workspacePath, options.filePath)
  } catch (error) {
    // An import that reports failure must not leave its bytes behind — that
    // would be both a lie and a way to land arbitrary content under an
    // office extension via a "failed" operation.
    try {
      await deleteWorkspaceFile({
        workspacePath: options.workspacePath,
        filePath: options.filePath,
        baseEtag: written.etag ?? null,
        origin: 'office-import',
        contentEncoding: utf8Safe ? 'utf8' : 'base64',
        maxBytes: MAX_OFFICE_FILE_BYTES
      })
    } catch {
      // Best effort: surface the original decode failure regardless.
    }
    throw error
  }
}

export interface OfficeDocumentDeleteOptions {
  workspacePath: string
  workspaceId?: string
  filePath: string
  /** Etag from the last read — external edits are never deleted silently. */
  baseEtag?: string | null
  recordChange?: RecordWorkspaceEditorChangeFn
}

/**
 * Deletes an office document. Restricted to office extensions so the binary
 * opt-in never becomes a generic binary-delete lane; text office formats
 * keep change-set recording, binary containers skip it (no text diff).
 */
export async function deleteOfficeDocument(
  options: OfficeDocumentDeleteOptions
): Promise<WorkspaceFileDeleteResult> {
  const format = requireOfficeFormat(options.filePath)
  const binary = OFFICE_BINARY_FORMATS.has(format)
  return deleteWorkspaceFile({
    workspacePath: options.workspacePath,
    workspaceId: options.workspaceId,
    filePath: options.filePath,
    baseEtag: options.baseEtag,
    origin: 'office-suite',
    contentEncoding: binary ? 'base64' : 'utf8',
    maxBytes: MAX_OFFICE_FILE_BYTES,
    recordChange: binary ? undefined : options.recordChange
  })
}

/** Defensive count of image blocks in the untrusted pre-normalization payload. */
function countRequestedImageBlocks(payload: unknown): number {
  if (typeof payload !== 'object' || payload === null) return 0
  const blocks = (payload as { blocks?: unknown }).blocks
  if (!Array.isArray(blocks)) return 0
  let count = 0
  for (const block of blocks) {
    if (
      typeof block === 'object' &&
      block !== null &&
      (block as { type?: unknown }).type === 'image'
    ) {
      count += 1
    }
  }
  return count
}
