import { describe, expect, it, vi } from 'vitest'
import {
  MAX_PDF_BYTES,
  MAX_PDF_PAGES,
  PdfTextExtractionError,
  extractPdfText,
  type PdfjsModule
} from './PdfTextExtractor'

/** Build a fake pdfjs module whose pages return the supplied text runs. */
function fakePdfjs(
  pages: Array<Array<{ str?: string; hasEOL?: boolean }>>,
  hooks: { onDestroy?: () => void; pageDelayMs?: number } = {}
): PdfjsModule {
  return {
    getDocument: () => ({
      promise: Promise.resolve({
        numPages: pages.length,
        getPage: async (pageNumber: number) => {
          if (hooks.pageDelayMs) {
            await new Promise((resolve) => setTimeout(resolve, hooks.pageDelayMs))
          }
          return {
            getTextContent: async () => ({ items: pages[pageNumber - 1] ?? [] }),
            cleanup: () => undefined
          }
        }
      }),
      destroy: () => {
        hooks.onDestroy?.()
      }
    })
  }
}

const bytes = (n = 1024) => new Uint8Array(n).fill(1)

describe('extractPdfText', () => {
  it('extracts text across pages and joins them', async () => {
    const result = await extractPdfText({
      data: bytes(),
      loadPdfjs: async () =>
        fakePdfjs([[{ str: 'first page' }], [{ str: 'second page' }]])
    })

    expect(result.pageCount).toBe(2)
    expect(result.pagesRead).toBe(2)
    expect(result.text).toBe('first page\n\nsecond page')
    expect(result.pages[1]).toEqual({ pageNumber: 2, text: 'second page' })
    expect(result.needsOcr).toBe(false)
    expect(result.truncated).toBe(false)
  })

  it('honours hasEOL so a page is not collapsed into one line', async () => {
    // pdfjs emits positioned glyph runs, not lines — hasEOL is the only
    // line-break signal, so dropping it makes every page unreadable.
    const result = await extractPdfText({
      data: bytes(),
      loadPdfjs: async () =>
        fakePdfjs([[{ str: 'line one', hasEOL: true }, { str: 'line two' }]])
    })

    expect(result.text).toBe('line one\nline two')
  })

  it('flags needsOcr when every page read is empty', async () => {
    // The scanned/image-only case: parsing succeeded, there is just no text
    // layer. This is the signal the caller uses to rasterize and OCR instead.
    const result = await extractPdfText({
      data: bytes(),
      loadPdfjs: async () => fakePdfjs([[], []])
    })

    expect(result.needsOcr).toBe(true)
    expect(result.text).toBe('')
  })

  it('does not flag needsOcr when only some pages are empty', async () => {
    const result = await extractPdfText({
      data: bytes(),
      loadPdfjs: async () => fakePdfjs([[], [{ str: 'has text' }]])
    })

    expect(result.needsOcr).toBe(false)
  })

  it('does not flag needsOcr when no pages were read at all', async () => {
    const result = await extractPdfText({
      data: bytes(),
      loadPdfjs: async () => fakePdfjs([])
    })

    expect(result.pagesRead).toBe(0)
    expect(result.needsOcr).toBe(false)
  })

  it('clamps an out-of-range page window to the document', async () => {
    const result = await extractPdfText({
      data: bytes(),
      firstPage: 0,
      lastPage: 99,
      loadPdfjs: async () => fakePdfjs([[{ str: 'only page' }]])
    })

    expect(result.pagesRead).toBe(1)
    expect(result.text).toBe('only page')
  })

  it('reads a requested sub-range only', async () => {
    const result = await extractPdfText({
      data: bytes(),
      firstPage: 2,
      lastPage: 3,
      loadPdfjs: async () =>
        fakePdfjs([[{ str: 'a' }], [{ str: 'b' }], [{ str: 'c' }], [{ str: 'd' }]])
    })

    expect(result.pages.map((p) => p.pageNumber)).toEqual([2, 3])
    expect(result.text).toBe('b\n\nc')
  })

  it('caps the page count and reports truncation', async () => {
    const pages = Array.from({ length: MAX_PDF_PAGES + 10 }, () => [{ str: 'x' }])
    const result = await extractPdfText({
      data: bytes(),
      loadPdfjs: async () => fakePdfjs(pages)
    })

    expect(result.pageCount).toBe(MAX_PDF_PAGES + 10)
    expect(result.pagesRead).toBe(MAX_PDF_PAGES)
    expect(result.truncated).toBe(true)
  })

  it('rejects an oversized PDF before parsing it', async () => {
    const loadPdfjs = vi.fn()
    await expect(
      extractPdfText({ data: new Uint8Array(MAX_PDF_BYTES + 1), loadPdfjs })
    ).rejects.toThrow(PdfTextExtractionError)
    // The cap must short-circuit — never hand an oversized buffer to the parser.
    expect(loadPdfjs).not.toHaveBeenCalled()
  })

  it('rejects an empty PDF', async () => {
    await expect(
      extractPdfText({ data: new Uint8Array(0), loadPdfjs: vi.fn() })
    ).rejects.toThrow(/empty/i)
  })

  it('fails with a timeout rather than hanging', async () => {
    await expect(
      extractPdfText({
        data: bytes(),
        timeoutMs: 10,
        loadPdfjs: async () => fakePdfjs([[{ str: 'slow' }]], { pageDelayMs: 200 })
      })
    ).rejects.toThrow(/exceeded 10ms/)
  })

  it('tears the loading task down even when extraction throws', async () => {
    const onDestroy = vi.fn()
    await expect(
      extractPdfText({
        data: bytes(),
        timeoutMs: 10,
        loadPdfjs: async () => fakePdfjs([[{ str: 'slow' }]], { pageDelayMs: 200, onDestroy })
      })
    ).rejects.toThrow()
    expect(onDestroy).toHaveBeenCalled()
  })
})

/**
 * End-to-end against the REAL pdfjs build. This is the test that catches the
 * import-path class of failure: the default `build/` tree throws
 * "ReferenceError: DOMMatrix is not defined" under Node, so if someone swaps the
 * import away from `legacy/` (or electron-builder prunes it), this goes red
 * rather than the feature silently dying in a packaged app.
 */
describe('extractPdfText (real pdfjs)', () => {
  // Windows CI cold-loads pdfjs slower than the default 5s vitest timeout.
  it(
    'reads text out of an actual PDF',
    async () => {
      const pdf = buildMinimalPdf('Hello TaskWraith')
      const result = await extractPdfText({ data: pdf })

      expect(result.pageCount).toBe(1)
      expect(result.text).toContain('Hello TaskWraith')
      expect(result.needsOcr).toBe(false)
    },
    20_000
  )

  it('reports needsOcr for a page with no text layer', async () => {
    const pdf = buildMinimalPdf(null)
    const result = await extractPdfText({ data: pdf })

    expect(result.pagesRead).toBe(1)
    expect(result.needsOcr).toBe(true)
  })
})

/**
 * Hand-build a single-page PDF. Written out rather than pulled from a fixture
 * file so the byte offsets in the xref table stay correct by construction.
 */
function buildMinimalPdf(text: string | null): Uint8Array {
  const content = text ? `BT /F1 24 Tf 20 100 Td (${text}) Tj ET\n` : '\n'
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] /Contents 4 0 R ' +
      '/Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${content.length} >>\nstream\n${content}endstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'
  ]

  let pdf = '%PDF-1.4\n'
  const offsets: number[] = []
  objects.forEach((body, index) => {
    offsets.push(pdf.length)
    pdf += `${index + 1} 0 obj\n${body}\nendobj\n`
  })

  const xrefStart = pdf.length
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`
  for (const offset of offsets) {
    pdf += `${String(offset).padStart(10, '0')} 00000 n \n`
  }
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF\n`

  return new Uint8Array(Buffer.from(pdf, 'latin1'))
}
