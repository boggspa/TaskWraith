/**
 * PDF text-layer extraction via pdfjs-dist (Mozilla, Apache-2.0, pure JS).
 *
 * Why bundled rather than shelling out to poppler's `pdftotext`: this runs on
 * every machine and platform with no user install step, which is the whole point
 * — the sibling `pdftoppm` dependency in PdfAttachmentRenderService silently
 * degrades to `sips` when poppler is absent, and we didn't want a second feature
 * with a "works on my machine" failure mode. The don't-bundle precedent
 * (the ffmpeg precedent §6) is specifically about ffmpeg's
 * licensing and the universal-build native-dep ban; pdfjs is neither.
 *
 * What this does NOT do: rasterize. Page images remain
 * PdfAttachmentRenderService's job (pdftoppm/sips). This module only reads the
 * text layer — and reports when there ISN'T one, which is the signal the caller
 * uses to fall back to on-device Vision OCR over a rasterized page.
 *
 * Security posture: pdfjs is a parser fed untrusted input, so it runs with
 * `isEvalSupported: false` (no eval-based font/CMap fast paths) and with PDF
 * JavaScript and external fetches off. Every dimension the caller doesn't
 * control is capped — bytes in, pages read, characters out, wall-clock.
 */

/** A PDF larger than this is rejected outright rather than parsed. */
export const MAX_PDF_BYTES = 80 * 1024 * 1024
/** Upper bound on pages read in one call, regardless of what the caller asks. */
export const MAX_PDF_PAGES = 500
/** Characters returned before extraction stops. Bounds a pathological PDF that
 * decompresses into hundreds of MB of glyphs. */
export const MAX_PDF_TEXT_CHARS = 2_000_000
/** Wall-clock ceiling for one extraction. */
export const DEFAULT_PDF_TIMEOUT_MS = 60_000

export interface PdfPageText {
  pageNumber: number
  text: string
}

export interface PdfTextExtraction {
  pageCount: number
  /** Pages actually read — may be fewer than pageCount when capped. */
  pagesRead: number
  pages: PdfPageText[]
  text: string
  /**
   * True when every page read came back empty. That is the scanned/image-only
   * case: there is no text layer to extract and the caller should rasterize and
   * OCR instead. Distinct from an error — the parse succeeded, the PDF just has
   * no glyphs.
   */
  needsOcr: boolean
  /** True when a cap stopped extraction early (pages or characters). */
  truncated: boolean
}

export interface PdfTextExtractOptions {
  data: Uint8Array
  /** 1-based, inclusive. Defaults to the whole document, subject to MAX_PDF_PAGES. */
  firstPage?: number
  lastPage?: number
  timeoutMs?: number
  /** Injected for tests; defaults to a lazy dynamic import of pdfjs-dist. */
  loadPdfjs?: () => Promise<PdfjsModule>
}

/** The slice of pdfjs's surface this module uses — keeps the dep injectable. */
export interface PdfjsModule {
  getDocument: (params: Record<string, unknown>) => {
    promise: Promise<PdfjsDocument>
    destroy?: () => Promise<void> | void
  }
}

export interface PdfjsDocument {
  numPages: number
  getPage: (pageNumber: number) => Promise<PdfjsPage>
  destroy?: () => Promise<void> | void
}

export interface PdfjsPage {
  getTextContent: () => Promise<{ items: Array<{ str?: string; hasEOL?: boolean }> }>
  cleanup?: () => void
}

export class PdfTextExtractionError extends Error {}

/**
 * pdfjs-dist v6 ships ESM only while the main process bundles to CJS, so it has
 * to be pulled in with a dynamic import rather than a static one.
 *
 * The `legacy/` build is REQUIRED, not an optimisation: the default
 * `build/pdf.mjs` assumes browser globals and throws
 * `ReferenceError: DOMMatrix is not defined` at import time in the Electron main
 * process (pdfjs itself warns "Please use the `legacy` build in Node.js
 * environments"). That also means `legacy/` must survive any electron-builder
 * pruning — see the pdfjs entries in electron-builder.yml.
 */
let pdfjsPromise: Promise<PdfjsModule> | null = null

function defaultLoadPdfjs(): Promise<PdfjsModule> {
  if (!pdfjsPromise) {
    pdfjsPromise = import('pdfjs-dist/legacy/build/pdf.mjs') as unknown as Promise<PdfjsModule>
  }
  return pdfjsPromise
}

/** Test-only: drop the cached module handle. */
export function __resetPdfjsModuleCache(): void {
  pdfjsPromise = null
}

function clampPageRange(
  numPages: number,
  firstPage?: number,
  lastPage?: number
): { start: number; end: number; capped: boolean } {
  // A malformed PDF can report zero pages. Return an empty range (start > end)
  // so the read loop never runs — asking such a document for page 1 throws.
  if (numPages < 1) return { start: 1, end: 0, capped: false }
  const start = Math.max(1, Math.min(firstPage ?? 1, numPages))
  const requestedEnd = Math.min(lastPage ?? numPages, numPages)
  const end = Math.max(start, requestedEnd)
  const cappedEnd = Math.min(end, start + MAX_PDF_PAGES - 1)
  return { start, end: cappedEnd, capped: cappedEnd < end }
}

/**
 * Join the text runs pdfjs returns for a page. pdfjs emits positioned glyph runs
 * rather than lines, so `hasEOL` is the only line-break signal available; without
 * honouring it every page collapses into one unreadable line.
 */
function joinTextItems(items: Array<{ str?: string; hasEOL?: boolean }>): string {
  let out = ''
  for (const item of items) {
    if (typeof item.str === 'string') out += item.str
    if (item.hasEOL) out += '\n'
  }
  return out.replace(/[ \t]+\n/g, '\n').trim()
}

export async function extractPdfText(options: PdfTextExtractOptions): Promise<PdfTextExtraction> {
  const { data } = options
  if (!data || data.byteLength === 0) {
    throw new PdfTextExtractionError('PDF is empty.')
  }
  if (data.byteLength > MAX_PDF_BYTES) {
    throw new PdfTextExtractionError(
      `PDF is ${data.byteLength} bytes, above the ${MAX_PDF_BYTES}-byte extraction limit.`
    )
  }

  const pdfjs = await (options.loadPdfjs ?? defaultLoadPdfjs)()
  const timeoutMs = options.timeoutMs ?? DEFAULT_PDF_TIMEOUT_MS

  const task = pdfjs.getDocument({
    data,
    // Untrusted-input posture: no eval-based fast paths, no PDF-embedded
    // JavaScript, and no network fetches for fonts or linearized ranges.
    isEvalSupported: false,
    enableXfa: false,
    disableAutoFetch: true,
    disableRange: true,
    disableStream: true,
    useSystemFonts: false,
    // pdfjs is chatty on malformed-but-recoverable files; those are expected
    // here and the recovered text is still useful.
    verbosity: 0
  })

  let timer: NodeJS.Timeout | undefined
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(
      () => reject(new PdfTextExtractionError(`PDF extraction exceeded ${timeoutMs}ms.`)),
      timeoutMs
    )
  })

  let doc: PdfjsDocument | undefined
  try {
    doc = await Promise.race([task.promise, timeout])
    const { start, end, capped } = clampPageRange(doc.numPages, options.firstPage, options.lastPage)

    const pages: PdfPageText[] = []
    let text = ''
    let truncated = capped

    for (let pageNumber = start; pageNumber <= end; pageNumber += 1) {
      const page = await Promise.race([doc.getPage(pageNumber), timeout])
      try {
        const content = await Promise.race([page.getTextContent(), timeout])
        const pageText = joinTextItems(content.items)
        pages.push({ pageNumber, text: pageText })
        if (pageText) text += (text ? '\n\n' : '') + pageText
      } finally {
        page.cleanup?.()
      }
      if (text.length >= MAX_PDF_TEXT_CHARS) {
        text = text.slice(0, MAX_PDF_TEXT_CHARS)
        truncated = true
        break
      }
    }

    return {
      pageCount: doc.numPages,
      pagesRead: pages.length,
      pages,
      text,
      // Only meaningful when we actually read something; a zero-page read is an
      // error case, not an OCR signal.
      needsOcr: pages.length > 0 && pages.every((page) => page.text.length === 0),
      truncated
    }
  } finally {
    if (timer) clearTimeout(timer)
    try {
      await doc?.destroy?.()
    } catch {
      // best-effort teardown — the extraction result already stands
    }
    try {
      await task.destroy?.()
    } catch {
      // ditto
    }
  }
}
