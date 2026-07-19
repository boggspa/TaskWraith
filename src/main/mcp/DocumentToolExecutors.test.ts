import { describe, expect, it, vi } from 'vitest'
import {
  createDocumentToolExecutors,
  isDocumentMcpToolName,
  type DocumentToolDeps
} from './DocumentToolExecutors'

function makeDeps(overrides: Partial<DocumentToolDeps> = {}): DocumentToolDeps {
  return {
    readPdfBytes: async () => ({ ok: true, data: new Uint8Array([1, 2, 3]) }),
    jailImage: async (sourcePath) => ({ ok: true, realPath: `/jailed${sourcePath}` }),
    extractText: async () => ({
      pageCount: 2,
      pagesRead: 2,
      pages: [
        { pageNumber: 1, text: 'page one' },
        { pageNumber: 2, text: 'page two' }
      ],
      text: 'page one\n\npage two',
      needsOcr: false,
      truncated: false
    }),
    ocrImage: async () => ({ text: 'recognized text', blocks: [] }),
    ocrAvailable: () => ({ available: true }),
    ...overrides
  }
}

const ctx = { workspacePath: '/ws' }

describe('isDocumentMcpToolName', () => {
  it('recognizes the document tools and nothing else', () => {
    expect(isDocumentMcpToolName('document_extract_text')).toBe(true)
    expect(isDocumentMcpToolName('document_ocr_image')).toBe(true)
    expect(isDocumentMcpToolName('transcribe_audio')).toBe(false)
  })
})

describe('document_extract_text', () => {
  it('returns the extracted text with page counts', async () => {
    const executors = createDocumentToolExecutors(makeDeps())
    const result = await executors.executeDocumentTool(
      'document_extract_text',
      { sourcePath: 'doc.pdf' },
      ctx
    )

    expect(result.isError).toBeUndefined()
    expect(result.text).toContain('page one')
    expect(result.text).toContain('2 of 2 page(s)')
    expect(result.structuredContent).toMatchObject({ ok: true, pageCount: 2, needsOcr: false })
  })

  it('reads the bytes the authorizing read returned, not the raw path', async () => {
    const readPdfBytes = vi.fn(async () => ({ ok: true as const, data: new Uint8Array([9, 9]) }))
    const extractText = vi.fn(async () => ({
      pageCount: 1,
      pagesRead: 1,
      pages: [],
      text: '',
      needsOcr: false,
      truncated: false
    }))
    const executors = createDocumentToolExecutors(makeDeps({ readPdfBytes, extractText }))
    await executors.executeDocumentTool('document_extract_text', { sourcePath: 'doc.pdf' }, ctx)

    expect(readPdfBytes).toHaveBeenCalledWith('doc.pdf', ctx)
    // The extractor must consume the authorized bytes — never re-open a path,
    // which would leave a TOCTOU window after validation.
    expect(extractText).toHaveBeenCalledWith(
      expect.objectContaining({ data: new Uint8Array([9, 9]) })
    )
  })

  it('fails without extracting when authorization rejects the path', async () => {
    const extractText = vi.fn()
    const executors = createDocumentToolExecutors(
      makeDeps({
        readPdfBytes: async () => ({ ok: false, reason: 'outside workspace' }),
        extractText
      })
    )
    const result = await executors.executeDocumentTool(
      'document_extract_text',
      { sourcePath: '../../etc/passwd' },
      ctx
    )

    expect(result.isError).toBe(true)
    expect(result.text).toContain('outside workspace')
    expect(extractText).not.toHaveBeenCalled()
  })

  it('requires a sourcePath', async () => {
    const executors = createDocumentToolExecutors(makeDeps())
    const result = await executors.executeDocumentTool('document_extract_text', {}, ctx)

    expect(result.isError).toBe(true)
    expect(result.text).toContain('provide sourcePath')
  })

  it('points at the OCR tool when the PDF has no text layer', async () => {
    const executors = createDocumentToolExecutors(
      makeDeps({
        extractText: async () => ({
          pageCount: 3,
          pagesRead: 3,
          pages: [
            { pageNumber: 1, text: '' },
            { pageNumber: 2, text: '' },
            { pageNumber: 3, text: '' }
          ],
          text: '',
          needsOcr: true,
          truncated: false
        })
      })
    )
    const result = await executors.executeDocumentTool(
      'document_extract_text',
      { sourcePath: 'scan.pdf' },
      ctx
    )

    expect(result.text).toContain('document_ocr_image')
    expect(result.structuredContent).toMatchObject({ needsOcr: true })
  })

  it('surfaces truncation so the model knows it is not seeing everything', async () => {
    const executors = createDocumentToolExecutors(
      makeDeps({
        extractText: async () => ({
          pageCount: 900,
          pagesRead: 500,
          pages: [{ pageNumber: 1, text: 'x' }],
          text: 'x',
          needsOcr: false,
          truncated: true
        })
      })
    )
    const result = await executors.executeDocumentTool(
      'document_extract_text',
      { sourcePath: 'big.pdf' },
      ctx
    )

    expect(result.text).toContain('truncated by cap')
    expect(result.text).toContain('500 of 900')
  })

  it('passes an explicit page window through to the extractor', async () => {
    const extractText = vi.fn(async () => ({
      pageCount: 10,
      pagesRead: 2,
      pages: [],
      text: '',
      needsOcr: false,
      truncated: false
    }))
    const executors = createDocumentToolExecutors(makeDeps({ extractText }))
    await executors.executeDocumentTool(
      'document_extract_text',
      { sourcePath: 'doc.pdf', firstPage: 3, lastPage: 4 },
      ctx
    )

    expect(extractText).toHaveBeenCalledWith(
      expect.objectContaining({ firstPage: 3, lastPage: 4 })
    )
  })

  it('ignores nonsense page bounds rather than failing', async () => {
    const extractText = vi.fn(async () => ({
      pageCount: 1,
      pagesRead: 1,
      pages: [],
      text: '',
      needsOcr: false,
      truncated: false
    }))
    const executors = createDocumentToolExecutors(makeDeps({ extractText }))
    await executors.executeDocumentTool(
      'document_extract_text',
      { sourcePath: 'doc.pdf', firstPage: 'abc', lastPage: -5 },
      ctx
    )

    expect(extractText).toHaveBeenCalledWith(
      expect.objectContaining({ firstPage: undefined, lastPage: undefined })
    )
  })

  it('reports extractor errors as a recoverable tool error', async () => {
    const executors = createDocumentToolExecutors(
      makeDeps({
        extractText: async () => {
          throw new Error('PDF is 99 bytes, above the limit.')
        }
      })
    )
    const result = await executors.executeDocumentTool(
      'document_extract_text',
      { sourcePath: 'huge.pdf' },
      ctx
    )

    expect(result.isError).toBe(true)
    expect(result.text).toContain('above the limit')
  })
})

describe('document_ocr_image', () => {
  it('returns recognized text and blocks', async () => {
    const executors = createDocumentToolExecutors(
      makeDeps({
        ocrImage: async () => ({
          text: 'INVOICE 42',
          blocks: [{ text: 'INVOICE 42', confidence: 0.9, x: 0, y: 0, width: 1, height: 1 }]
        })
      })
    )
    const result = await executors.executeDocumentTool(
      'document_ocr_image',
      { sourcePath: 'scan.png' },
      ctx
    )

    expect(result.isError).toBeUndefined()
    expect(result.text).toContain('INVOICE 42')
    expect(result.structuredContent).toMatchObject({ ok: true, text: 'INVOICE 42' })
  })

  it('degrades with the capability reason when Vision is unavailable', async () => {
    const jailImage = vi.fn()
    const executors = createDocumentToolExecutors(
      makeDeps({
        ocrAvailable: () => ({
          available: false,
          reason: 'Native bridge features are available on macOS only.'
        }),
        jailImage
      })
    )
    const result = await executors.executeDocumentTool(
      'document_ocr_image',
      { sourcePath: 'scan.png' },
      ctx
    )

    expect(result.isError).toBe(true)
    expect(result.text).toContain('macOS only')
    // Gate must run BEFORE jailing, so the model gets the capability reason
    // rather than a confusing path error.
    expect(jailImage).not.toHaveBeenCalled()
  })

  it('reports an empty recognition without erroring', async () => {
    const executors = createDocumentToolExecutors(
      makeDeps({ ocrImage: async () => ({ text: '', blocks: [] }) })
    )
    const result = await executors.executeDocumentTool(
      'document_ocr_image',
      { sourcePath: 'blank.png' },
      ctx
    )

    expect(result.isError).toBeUndefined()
    expect(result.text).toContain('no text recognized')
  })

  it('surfaces daemon errors verbatim', async () => {
    const executors = createDocumentToolExecutors(
      makeDeps({
        ocrImage: async () => {
          throw new Error('Image is 99999999 bytes, above the OCR limit.')
        }
      })
    )
    const result = await executors.executeDocumentTool(
      'document_ocr_image',
      { sourcePath: 'huge.png' },
      ctx
    )

    expect(result.isError).toBe(true)
    expect(result.text).toContain('above the OCR limit')
  })
})
