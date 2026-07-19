import type { McpToolExecutionResult } from './McpBridgeRuntime'
import type { PdfTextExtractOptions, PdfTextExtraction } from '../documents/PdfTextExtractor'

/**
 * Document tools — reading DOCUMENTS as text, the gap that previously forced
 * agents to shell out to `pdftotext` / `tesseract` (neither of which is present
 * on a stock machine).
 *
 * `document_extract_text` pulls the text layer out of a workspace PDF via the
 * BUNDLED pdfjs build — no host binary, so it behaves identically on every
 * machine and platform. This is deliberately distinct from
 * PdfAttachmentRenderService, which RASTERIZES an attached PDF to at most 4 page
 * images: that path shows the model what a page looks like, this one lets it
 * actually read a 300-page document.
 *
 * `document_ocr_image` runs ON-DEVICE Vision OCR (`document.ocrImage`) over a
 * workspace image. Same recognizer that has backed attached-window capture since
 * the appwatch work, now reachable for scans, screenshots and photos. On-device
 * only — no network, mirroring the transcribe_audio privacy invariant.
 *
 * The two compose for scanned PDFs: `document_extract_text` reports
 * `needsOcr: true` when a PDF has no text layer, and the page images the
 * attachment pipeline already produces can then be fed to `document_ocr_image`.
 *
 * Both are READ-ONLY (orchestration): they write no file, emit no media ref, and
 * return structured text — the same posture as `transcribe_audio`. Source paths
 * are realpath-jailed by the injected `jail*` deps before anything reads them.
 */

export const DOCUMENT_MCP_TOOL_NAMES = ['document_extract_text', 'document_ocr_image'] as const
export type DocumentMcpToolName = (typeof DOCUMENT_MCP_TOOL_NAMES)[number]

export function isDocumentMcpToolName(name: string): name is DocumentMcpToolName {
  return (DOCUMENT_MCP_TOOL_NAMES as readonly string[]).includes(name)
}

export interface DocumentToolContext {
  appChatId?: string
  appRunId?: string
  workspacePath?: string
}

export type DocumentJailedInput =
  | { ok: true; realPath: string; cleanup?: () => boolean | void }
  | { ok: false; reason: string }

type Awaitable<T> = T | Promise<T>

export interface DocumentOcrBlock {
  text: string
  confidence: number
  x: number
  y: number
  width: number
  height: number
}

export type DocumentPdfRead =
  | { ok: true; data: Uint8Array }
  | { ok: false; reason: string }

export interface DocumentToolDeps {
  /**
   * Authorize, size-cap, magic-byte check and READ a workspace PDF in one step.
   *
   * Deliberately not a jail-then-read-by-path pair: reopening the path after
   * validating it leaves a TOCTOU window where the file can be swapped for one
   * outside the workspace. The wiring reads from the already-open descriptor
   * `openAuthorizedWorkspaceFile` returns, so the bytes are provably the bytes
   * that were authorized. (The OCR path below still needs a path, because the
   * daemon opens the file itself — that one is staged to a main-owned snapshot.)
   */
  readPdfBytes: (sourcePath: string, ctx: DocumentToolContext) => Awaitable<DocumentPdfRead>
  /** Realpath-jail a workspace raster image. Rejects SVG, same as the image tools. */
  jailImage: (sourcePath: string, ctx: DocumentToolContext) => Awaitable<DocumentJailedInput>
  extractText: (options: PdfTextExtractOptions) => Promise<PdfTextExtraction>
  /** `document.ocrImage` daemon RPC. */
  ocrImage: (params: { sourcePath: string }) => Promise<{ text: string; blocks: DocumentOcrBlock[] }>
  /**
   * Native-capability gate. Vision is macOS-only, so on Windows/Linux this
   * returns unavailable with a reason and the tool degrades gracefully rather
   * than erroring out of the daemon transport.
   */
  ocrAvailable: () => { available: boolean; reason?: string }
}

export interface DocumentToolExecutors {
  executeDocumentTool: (
    toolName: DocumentMcpToolName,
    rawArgs: unknown,
    ctx: DocumentToolContext
  ) => Promise<McpToolExecutionResult>
}

function asRecord(value: unknown): Record<string, any> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, any>)
    : {}
}

function fail(toolName: string, message: string): McpToolExecutionResult {
  const value = { ok: false, tool: toolName, error: message }
  const text = JSON.stringify(value)
  return { text, isError: true, structuredContent: value, content: [{ type: 'text', text }] }
}

function ok(toolName: string, text: string, structured: Record<string, unknown>): McpToolExecutionResult {
  const value = { ok: true, tool: toolName, ...structured }
  return { text, structuredContent: value, content: [{ type: 'text', text }] }
}

/** Optional 1-based page bound. Returns undefined for absent/invalid values so
 * the extractor falls back to the whole document. */
function optionalPage(value: unknown): number | undefined {
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) return undefined
  const truncated = Math.trunc(parsed)
  return truncated >= 1 ? truncated : undefined
}

export function createDocumentToolExecutors(deps: DocumentToolDeps): DocumentToolExecutors {
  const { readPdfBytes, jailImage, extractText, ocrImage, ocrAvailable } = deps

  async function executeExtractText(
    args: Record<string, any>,
    ctx: DocumentToolContext
  ): Promise<McpToolExecutionResult> {
    const sourcePath = typeof args.sourcePath === 'string' ? args.sourcePath.trim() : ''
    if (!sourcePath) {
      return fail('document_extract_text', 'provide sourcePath (a PDF inside the workspace)')
    }

    const read = await readPdfBytes(sourcePath, ctx)
    if (!read.ok) {
      return fail('document_extract_text', `could not read PDF: ${read.reason}`)
    }

    try {
      const result = await extractText({
        data: read.data,
        firstPage: optionalPage(args.firstPage),
        lastPage: optionalPage(args.lastPage)
      })

      // Lead with the text itself — it is what the model came for. The counts
      // ride along so it knows whether it is looking at the whole document.
      const header =
        `PDF text (${result.pagesRead} of ${result.pageCount} page(s)` +
        (result.truncated ? ', truncated by cap' : '') +
        ')'
      const body = result.needsOcr
        ? '(no text layer — this PDF is scanned or image-only. Rasterize the pages and read them with document_ocr_image.)'
        : result.text || '(no text found)'

      return ok('document_extract_text', `${header}\n\n${body}`, {
        text: result.text,
        pageCount: result.pageCount,
        pagesRead: result.pagesRead,
        truncated: result.truncated,
        needsOcr: result.needsOcr,
        pages: result.pages
      })
    } catch (error) {
      return fail('document_extract_text', error instanceof Error ? error.message : String(error))
    }
  }

  async function executeOcrImage(
    args: Record<string, any>,
    ctx: DocumentToolContext
  ): Promise<McpToolExecutionResult> {
    const sourcePath = typeof args.sourcePath === 'string' ? args.sourcePath.trim() : ''
    if (!sourcePath) {
      return fail('document_ocr_image', 'provide sourcePath (an image inside the workspace)')
    }

    // Gate BEFORE jailing so a non-macOS host gets the capability reason rather
    // than a confusing path error.
    const capability = ocrAvailable()
    if (!capability.available) {
      return fail('document_ocr_image', capability.reason || 'On-device OCR is unavailable on this system.')
    }

    const jailed = await jailImage(sourcePath, ctx)
    if (!jailed.ok) {
      return fail('document_ocr_image', `could not read image: ${jailed.reason}`)
    }

    try {
      const result = await ocrImage({ sourcePath: jailed.realPath })
      const trimmed = result.text.trim()
      const header = `OCR (on-device Vision): ${trimmed ? trimmed : '(no text recognized)'}`
      const text = `${header}\n\nblocks: ${JSON.stringify(result.blocks)}`

      return ok('document_ocr_image', text, {
        text: result.text,
        blocks: result.blocks
      })
    } catch (error) {
      // Daemon messages (unsupported image, size cap, recognizer failure) ride
      // through verbatim — graceful fail, never a crash.
      return fail('document_ocr_image', error instanceof Error ? error.message : String(error))
    } finally {
      jailed.cleanup?.()
    }
  }

  return {
    executeDocumentTool(toolName, rawArgs, ctx) {
      const args = asRecord(rawArgs)
      switch (toolName) {
        case 'document_extract_text':
          return executeExtractText(args, ctx)
        case 'document_ocr_image':
          return executeOcrImage(args, ctx)
        default:
          return Promise.resolve(fail(String(toolName), 'unknown document tool'))
      }
    }
  }
}
