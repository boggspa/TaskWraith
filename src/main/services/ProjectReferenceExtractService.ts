import { createHash } from 'crypto'
import fs from 'fs'
import path from 'path'

import {
  parseProjectReferenceExtractConsent,
  type ProjectReferenceExtract,
  type ProjectReferenceExtractConsent,
  type ProjectReferenceExtractKind,
  type ProjectReferenceExtractOfficeFormat,
  type ProjectReferenceExtractPageSpan,
  type ProjectReferenceExtractSource
} from '../../shared/projectReferenceExtract'
import { buildDelimitedText } from '../../shared/office/csvCodec'
import { deckModelToMarkdown } from '../../shared/office/deckMarkdown'
import { officeFormatForPath } from '../../shared/office/officeFormats'
import { wordModelToMarkdown } from '../../shared/office/wordMarkdown'
import type { ProjectReference } from '../../shared/projects'
import {
  extractPdfText as defaultExtractPdfText,
  type PdfTextExtractOptions,
  type PdfTextExtraction
} from '../documents/PdfTextExtractor'
import { assertFetchTargetAllowed, WebFetchBlockedError } from '../mcp/WebTools'
import { parseDocx, OfficeCodecError } from '../office/DocxCodec'
import { parsePptx } from '../office/PptxCodec'
import { parseXlsx } from '../office/XlsxCodec'
import {
  PROJECT_REFERENCE_EXTRACT_MAX_TEXT_CHARS,
  type ProjectReferenceExtractStore
} from './ProjectReferenceExtractStore'

/** Characters retained in a ready extract (matches store ceiling). */
export const PROJECT_REFERENCE_EXTRACT_KEEP_CHARS = PROJECT_REFERENCE_EXTRACT_MAX_TEXT_CHARS
/** Hard cap on a single URL response body before extraction. */
export const PROJECT_REFERENCE_EXTRACT_FETCH_MAX_BYTES = 5 * 1024 * 1024
const MAX_LOCAL_FILE_BYTES = 25_000_000
const FETCH_TIMEOUT_MS = 20_000
const MAX_FETCH_REDIRECTS = 5

export type ProjectReferenceExtractRequestResult =
  | { ok: true; extract: ProjectReferenceExtract }
  | {
      ok: false
      code: string
      message: string
      extract?: ProjectReferenceExtract
    }

export interface RequestProjectReferenceExtractInput {
  projectId: string
  referenceId: string
  chatId?: string
  /** Explicit user consent — required; catalogue access alone is never enough. */
  consent: ProjectReferenceExtractConsent
}

export interface ProjectReferenceExtractServiceDeps {
  store: ProjectReferenceExtractStore
  getReferences: () => readonly ProjectReference[]
  fetchImpl?: typeof fetch
  resolveHost?: (host: string) => Promise<string[]>
  extractPdfText?: (options: PdfTextExtractOptions) => Promise<PdfTextExtraction>
  now?: () => number
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function decodeHtmlEntities(value: string): string {
  return value
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&#(\d+);/g, (_, code) => {
      const num = Number(code)
      return Number.isFinite(num) ? String.fromCodePoint(num) : ' '
    })
}

function htmlDocumentToReadableText(html: string): string {
  const bodyMatch = html.match(/<body\b[^>]*>([\s\S]*?)<\/body>/i)
  const source = bodyMatch ? bodyMatch[1] : html
  const withBreaks = source
    .replace(/<script\b[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript\b[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<\/(p|div|section|article|h[1-6]|li|tr|br|header|footer|nav|table)>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
  return decodeHtmlEntities(withBreaks)
    .replace(/[ \t\f\v]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

function looksLikeHtml(contentType: string, raw: string): boolean {
  if (/\b(?:text\/html|application\/xhtml\+xml)\b/i.test(contentType)) return true
  if (contentType) return false
  return /<html[\s>]|<!doctype html|<body[\s>]/i.test(raw)
}

function truncateKeptText(text: string): { text: string; truncated: boolean } {
  if (text.length <= PROJECT_REFERENCE_EXTRACT_KEEP_CHARS) {
    return { text, truncated: false }
  }
  return {
    text: text.slice(0, PROJECT_REFERENCE_EXTRACT_KEEP_CHARS),
    truncated: true
  }
}

function readLocalFileBytes(filePath: string, maxBytes: number): Buffer {
  if (!path.isAbsolute(filePath) || filePath.includes('\0')) {
    throw Object.assign(new Error('Reference file path is invalid.'), { code: 'invalid_path' })
  }
  let fd: number | null = null
  try {
    const before = fs.lstatSync(filePath)
    if (before.isSymbolicLink() || !before.isFile()) {
      throw Object.assign(new Error('Reference path is not a regular file.'), {
        code: 'invalid_path'
      })
    }
    if (before.size <= 0) {
      throw Object.assign(new Error('Reference file is empty.'), { code: 'empty_file' })
    }
    if (before.size > maxBytes) {
      throw Object.assign(new Error('Reference file exceeds the extract size limit.'), {
        code: 'file_too_large'
      })
    }
    fd = fs.openSync(filePath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW)
    const opened = fs.fstatSync(fd)
    if (!opened.isFile() || opened.size !== before.size) {
      throw Object.assign(new Error('Reference file changed while opening.'), {
        code: 'invalid_path'
      })
    }
    const buffer = Buffer.allocUnsafe(opened.size)
    let offset = 0
    while (offset < buffer.length) {
      const read = fs.readSync(fd, buffer, offset, buffer.length - offset, offset)
      if (read <= 0) {
        throw Object.assign(new Error('Reference file read failed.'), { code: 'read_failed' })
      }
      offset += read
    }
    return buffer
  } catch (error) {
    if ((error as { code?: string }).code) throw error
    throw Object.assign(new Error('Could not read reference file.'), { code: 'read_failed' })
  } finally {
    if (fd !== null) {
      try {
        fs.closeSync(fd)
      } catch {
        // best-effort
      }
    }
  }
}

function sha256Hex(buffer: Buffer): string {
  return createHash('sha256').update(buffer).digest('hex')
}

function buildPdfPageSpans(pages: Array<{ pageNumber: number; text: string }>): {
  text: string
  pages: ProjectReferenceExtractPageSpan[]
} {
  let text = ''
  const spans: ProjectReferenceExtractPageSpan[] = []
  for (const page of pages) {
    const chunk = page.text || ''
    const startOffset = text.length
    if (text) text += '\n\n'
    const contentStart = text.length
    text += chunk
    spans.push({
      pageNumber: page.pageNumber,
      startOffset: chunk ? contentStart : startOffset,
      endOffset: text.length
    })
  }
  return { text, pages: spans }
}

function officeTextFromBytes(format: 'docx' | 'xlsx' | 'pptx', bytes: Buffer): string {
  switch (format) {
    case 'docx': {
      const { model } = parseDocx(bytes)
      return wordModelToMarkdown(model)
    }
    case 'xlsx': {
      const { model } = parseXlsx(bytes)
      const parts = model.sheets.map((sheet) => {
        const header = model.sheets.length > 1 ? `# ${sheet.name}\n` : ''
        return `${header}${buildDelimitedText(sheet.rows, ',')}`
      })
      return parts.join('\n\n')
    }
    case 'pptx': {
      const { model } = parsePptx(bytes)
      return deckModelToMarkdown(model)
    }
  }
}

/**
 * Consentful extractors for Project references. Never mutates catalogue rows or
 * elevates access — only writes revocable extract artifacts into the store.
 */
export class ProjectReferenceExtractService {
  constructor(private readonly deps: ProjectReferenceExtractServiceDeps) {}

  getActive(projectId: string, referenceId: string): ProjectReferenceExtract | null {
    return this.deps.store.getActive(projectId, referenceId)
  }

  revoke(extractId: string): ProjectReferenceExtractRequestResult {
    const result = this.deps.store.revoke(extractId, { now: this.now() })
    if (!result.ok) {
      return {
        ok: false,
        code: result.reason,
        message: `Could not revoke extract (${result.reason}).`
      }
    }
    return { ok: true, extract: result.extract }
  }

  readText(extractId: string): string | null {
    return this.deps.store.readText(extractId)
  }

  async requestExtract(
    input: RequestProjectReferenceExtractInput
  ): Promise<ProjectReferenceExtractRequestResult> {
    const consent = this.resolveConsent(input)
    if (!consent.ok) return consent

    const projectId = typeof input.projectId === 'string' ? input.projectId.trim() : ''
    const referenceId = typeof input.referenceId === 'string' ? input.referenceId.trim() : ''
    if (!projectId || !referenceId) {
      return {
        ok: false,
        code: 'invalid_input',
        message: 'projectId and referenceId are required.'
      }
    }

    const reference = this.deps
      .getReferences()
      .find((candidate) => candidate.id === referenceId && candidate.projectId === projectId)
    if (!reference) {
      return {
        ok: false,
        code: 'reference_not_found',
        message: 'Project reference was not found for this project.'
      }
    }

    if (reference.kind === 'folder' || reference.kind === 'connector') {
      return {
        ok: false,
        code: 'unsupported_kind',
        message: `P1 extracts do not support ${reference.kind} references.`
      }
    }

    // Pin the consented locator at request start. Consent/UI already named this
    // referenceId; a later catalogue edit must not silently retarget the fetch.
    const pinnedLocator = reference.locator

    if (reference.kind === 'url') {
      return this.extractUrl(reference, consent.consent, pinnedLocator)
    }
    if (reference.kind === 'file') {
      return this.extractFile(reference, consent.consent, pinnedLocator)
    }
    return {
      ok: false,
      code: 'unsupported_kind',
      message: 'Unsupported Project reference kind for extract.'
    }
  }

  /**
   * Re-load the catalogue row immediately before fetch/parse. Fail closed when
   * the locator drifted from the consent-time pin (require re-consent).
   * In-memory pin only — no extract-source schema bump.
   */
  private reloadPinnedReference(
    projectId: string,
    referenceId: string,
    pinnedLocator: string
  ): { ok: true; reference: ProjectReference } | { ok: false; code: string; message: string } {
    const reference = this.deps
      .getReferences()
      .find((candidate) => candidate.id === referenceId && candidate.projectId === projectId)
    if (!reference) {
      return {
        ok: false,
        code: 'reference_not_found',
        message: 'Project reference was not found for this project.'
      }
    }
    if (reference.locator !== pinnedLocator) {
      return {
        ok: false,
        code: 'locator_changed',
        message:
          'Project reference locator changed after consent. Re-consent is required before extract.'
      }
    }
    return { ok: true, reference }
  }

  private now(): number {
    return this.deps.now?.() ?? Date.now()
  }

  private resolveConsent(
    input: RequestProjectReferenceExtractInput
  ):
    | { ok: true; consent: ProjectReferenceExtractConsent }
    | { ok: false; code: string; message: string } {
    if (!isRecord(input.consent)) {
      return {
        ok: false,
        code: 'consent_required',
        message: 'Explicit extract consent is required.'
      }
    }
    const parsed = parseProjectReferenceExtractConsent(input.consent)
    if (!parsed) {
      return {
        ok: false,
        code: 'consent_required',
        message: 'Explicit extract consent is required.'
      }
    }
    const chatId =
      typeof input.chatId === 'string' && input.chatId.trim() ? input.chatId.trim() : undefined
    if (chatId && parsed.chatId && parsed.chatId !== chatId) {
      return {
        ok: false,
        code: 'consent_mismatch',
        message: 'Consent chatId does not match the request chatId.'
      }
    }
    return {
      ok: true,
      consent: chatId && !parsed.chatId ? { ...parsed, chatId } : parsed
    }
  }

  private async extractUrl(
    reference: ProjectReference,
    consent: ProjectReferenceExtractConsent,
    pinnedLocator: string
  ): Promise<ProjectReferenceExtractRequestResult> {
    const pinned = this.reloadPinnedReference(reference.projectId, reference.id, pinnedLocator)
    if (!pinned.ok) return pinned
    const locator = pinnedLocator.trim()
    let pendingId: string | null = null
    try {
      const fetched = await this.fetchUrlOnce(locator)
      const kept = truncateKeptText(fetched.text)
      const source: ProjectReferenceExtractSource = {
        locator,
        contentSha256: sha256Hex(fetched.raw),
        http: {
          finalUrl: fetched.finalUrl,
          status: fetched.status,
          fetchedAt: this.now()
        }
      }
      const pending = this.deps.store.putPending({
        projectId: pinned.reference.projectId,
        referenceId: pinned.reference.id,
        kind: 'url-html',
        consent,
        source,
        now: this.now()
      })
      if (!pending.ok) {
        return {
          ok: false,
          code: pending.reason,
          message: `Could not create extract (${pending.reason}).`
        }
      }
      pendingId = pending.extract.id
      return this.finishReady(pending.extract.id, kept.text, { truncated: kept.truncated })
    } catch (error) {
      return this.failAfterOptionalPending({
        pendingId,
        projectId: reference.projectId,
        referenceId: reference.id,
        kind: 'url-html',
        consent,
        source: { locator },
        error
      })
    }
  }

  private async extractFile(
    reference: ProjectReference,
    consent: ProjectReferenceExtractConsent,
    pinnedLocator: string
  ): Promise<ProjectReferenceExtractRequestResult> {
    const pinned = this.reloadPinnedReference(reference.projectId, reference.id, pinnedLocator)
    if (!pinned.ok) return pinned
    const locator = pinnedLocator
    let pendingId: string | null = null
    try {
      const bytes = readLocalFileBytes(locator, MAX_LOCAL_FILE_BYTES)
      const contentSha256 = sha256Hex(bytes)
      const lower = locator.toLowerCase()
      const isPdf =
        lower.endsWith('.pdf') || bytes.subarray(0, 5).toString('utf8').startsWith('%PDF-')
      if (isPdf) {
        const pending = this.deps.store.putPending({
          projectId: pinned.reference.projectId,
          referenceId: pinned.reference.id,
          kind: 'pdf-text',
          consent,
          source: { locator, contentSha256 },
          now: this.now()
        })
        if (!pending.ok) {
          return {
            ok: false,
            code: pending.reason,
            message: `Could not create extract (${pending.reason}).`
          }
        }
        pendingId = pending.extract.id
        const extractPdf = this.deps.extractPdfText ?? defaultExtractPdfText
        const extraction = await extractPdf({ data: new Uint8Array(bytes) })
        const mapped = buildPdfPageSpans(extraction.pages)
        const kept = truncateKeptText(mapped.text || extraction.text)
        let pages = mapped.pages
        if (kept.truncated) {
          pages = pages
            .map((span) => ({
              ...span,
              endOffset: Math.min(span.endOffset, kept.text.length),
              startOffset: Math.min(span.startOffset, kept.text.length)
            }))
            .filter((span) => span.endOffset >= span.startOffset)
        }
        return this.finishReady(pending.extract.id, kept.text, {
          truncated: kept.truncated || extraction.truncated,
          pages
        })
      }

      const format = officeFormatForPath(locator)
      if (format !== 'docx' && format !== 'xlsx' && format !== 'pptx') {
        return {
          ok: false,
          code: 'unsupported_format',
          message: 'P1 file extracts support PDF and Office (docx/xlsx/pptx) only.'
        }
      }
      const officeFormat = format as ProjectReferenceExtractOfficeFormat
      const pending = this.deps.store.putPending({
        projectId: pinned.reference.projectId,
        referenceId: pinned.reference.id,
        kind: 'office-text',
        consent,
        source: { locator, contentSha256, officeFormat },
        now: this.now()
      })
      if (!pending.ok) {
        return {
          ok: false,
          code: pending.reason,
          message: `Could not create extract (${pending.reason}).`
        }
      }
      pendingId = pending.extract.id
      const text = officeTextFromBytes(format, bytes)
      const kept = truncateKeptText(text)
      return this.finishReady(pending.extract.id, kept.text, { truncated: kept.truncated })
    } catch (error) {
      const kind: ProjectReferenceExtractKind = locator.toLowerCase().endsWith('.pdf')
        ? 'pdf-text'
        : 'office-text'
      const format = officeFormatForPath(locator)
      const source: ProjectReferenceExtractSource = {
        locator,
        ...(format === 'docx' || format === 'xlsx' || format === 'pptx'
          ? { officeFormat: format }
          : {})
      }
      return this.failAfterOptionalPending({
        pendingId,
        projectId: reference.projectId,
        referenceId: reference.id,
        kind,
        consent,
        source,
        error
      })
    }
  }

  private finishReady(
    extractId: string,
    text: string,
    options: { truncated?: boolean; pages?: readonly ProjectReferenceExtractPageSpan[] }
  ): ProjectReferenceExtractRequestResult {
    const ready = this.deps.store.markReady(extractId, text, {
      truncated: options.truncated === true,
      pages: options.pages,
      now: this.now()
    })
    if (!ready.ok) {
      const failed = this.deps.store.markFailed(
        extractId,
        {
          code: ready.reason,
          message: `Could not finalize extract (${ready.reason}).`
        },
        { now: this.now() }
      )
      return {
        ok: false,
        code: ready.reason,
        message: `Could not finalize extract (${ready.reason}).`,
        ...(failed.ok ? { extract: failed.extract } : {})
      }
    }
    return { ok: true, extract: ready.extract }
  }

  private async failAfterOptionalPending(input: {
    pendingId: string | null
    projectId: string
    referenceId: string
    kind: ProjectReferenceExtractKind
    consent: ProjectReferenceExtractConsent
    source: ProjectReferenceExtractSource
    error: unknown
  }): Promise<ProjectReferenceExtractRequestResult> {
    const { code, message } = this.errorCodeMessage(input.error)
    let extractId = input.pendingId
    if (!extractId) {
      const pending = this.deps.store.putPending({
        projectId: input.projectId,
        referenceId: input.referenceId,
        kind: input.kind,
        consent: input.consent,
        source: input.source,
        now: this.now()
      })
      if (pending.ok) extractId = pending.extract.id
    }
    if (extractId) {
      const failed = this.deps.store.markFailed(extractId, { code, message }, { now: this.now() })
      return {
        ok: false,
        code,
        message,
        ...(failed.ok ? { extract: failed.extract } : {})
      }
    }
    return { ok: false, code, message }
  }

  private errorCodeMessage(error: unknown): { code: string; message: string } {
    if (error instanceof WebFetchBlockedError) {
      return { code: 'ssrf_blocked', message: error.message }
    }
    if (error instanceof OfficeCodecError) {
      return { code: 'office_parse_failed', message: error.message }
    }
    const code =
      typeof error === 'object' &&
      error &&
      'code' in error &&
      typeof (error as { code: unknown }).code === 'string'
        ? (error as { code: string }).code
        : 'extract_failed'
    const message =
      error instanceof Error && error.message.trim()
        ? error.message
        : 'Project reference extract failed.'
    return { code, message }
  }

  /** One logical URL extract: SSRF on each hop, then a single body read capped at 5MB. */
  private async fetchUrlOnce(url: string): Promise<{
    text: string
    raw: Buffer
    status: number
    finalUrl: string
  }> {
    const fetchImpl = this.deps.fetchImpl ?? fetch
    const resolveHost = this.deps.resolveHost
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)
    try {
      let currentUrl = url
      let response: Response | null = null
      for (let hop = 0; hop <= MAX_FETCH_REDIRECTS; hop += 1) {
        await assertFetchTargetAllowed(currentUrl, resolveHost)
        response = await fetchImpl(currentUrl, {
          redirect: 'manual',
          signal: controller.signal,
          headers: { 'user-agent': 'TaskWraith-project-reference-extract/1.0' }
        })
        if (response.status >= 300 && response.status < 400) {
          const location = response.headers?.get?.('location')
          if (!location) break
          currentUrl = new URL(location, currentUrl).toString()
          continue
        }
        break
      }
      if (!response) {
        throw Object.assign(new Error('URL fetch produced no response.'), { code: 'fetch_failed' })
      }

      const contentLengthHeader = response.headers?.get?.('content-length')
      if (contentLengthHeader) {
        const contentLength = Number(contentLengthHeader)
        if (
          Number.isFinite(contentLength) &&
          contentLength > PROJECT_REFERENCE_EXTRACT_FETCH_MAX_BYTES
        ) {
          throw Object.assign(new Error('URL response exceeds the 5MB extract fetch limit.'), {
            code: 'fetch_too_large'
          })
        }
      }

      const rawBuffer = Buffer.from(await response.arrayBuffer())
      if (rawBuffer.byteLength > PROJECT_REFERENCE_EXTRACT_FETCH_MAX_BYTES) {
        throw Object.assign(new Error('URL response exceeds the 5MB extract fetch limit.'), {
          code: 'fetch_too_large'
        })
      }

      const contentType = String(response.headers?.get?.('content-type') || '')
      const rawText = rawBuffer.toString('utf8')
      const text = looksLikeHtml(contentType, rawText)
        ? htmlDocumentToReadableText(rawText) || rawText.trim()
        : rawText
      return {
        text,
        raw: rawBuffer,
        status: response.status,
        finalUrl: currentUrl
      }
    } catch (error) {
      if ((error as { name?: string })?.name === 'AbortError') {
        throw Object.assign(new Error('URL fetch timed out.'), { code: 'fetch_timeout' })
      }
      throw error
    } finally {
      clearTimeout(timer)
    }
  }
}
