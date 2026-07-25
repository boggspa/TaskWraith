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
import { buildEml, parseEml } from '../../shared/office/emlCodec'
import { markdownToWordModel, wordModelToMarkdown } from '../../shared/office/wordMarkdown'
import { deckModelToMarkdown } from '../../shared/office/deckMarkdown'
import { buildDocx, OfficeCodecError, parseDocx } from '../office/DocxCodec'
import { buildXlsx, parseXlsx } from '../office/XlsxCodec'
import { buildPptx, parsePptx } from '../office/PptxCodec'
import {
  readWorkspaceFile,
  writeWorkspaceFile,
  type RecordWorkspaceEditorChangeFn
} from './WorkspaceFileEditorService'

/** Office documents may exceed the plain-text editor cap (images-free OOXML stays small, but imports vary). */
export const MAX_OFFICE_FILE_BYTES = 25_000_000

export type OfficeDocumentErrorCode =
  | 'unsupported_format'
  | 'invalid_document'
  | 'kind_mismatch'
  | 'invalid_model'

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
        const parsed = parseIcs(String(raw))
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
  const binary = OFFICE_BINARY_FORMATS.has(format)
  const read = await readWorkspaceFile(workspacePath, filePath, {
    encoding: binary ? 'base64' : 'utf8',
    maxBytes: MAX_OFFICE_FILE_BYTES
  })
  const raw = binary ? Buffer.from(read.content, 'base64') : read.content
  const decoded = decodeDocument(format, raw)
  return {
    path: read.path,
    kind: OFFICE_FORMAT_KINDS[format],
    format,
    model: decoded.model,
    etag: read.etag ?? null,
    sizeBytes: read.sizeBytes,
    mtimeMs: read.mtimeMs,
    warnings: decoded.warnings
  }
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
    warnings: encoded.warnings
  }
}
