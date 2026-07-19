import {
  mkdtempSync,
  writeFileSync,
  mkdirSync,
  readdirSync,
  rmSync,
  statSync,
  utimesSync
} from 'fs'
import { realpath } from 'fs/promises'
import os from 'os'
import path from 'path'
import { describe, expect, it } from 'vitest'
import {
  isPdfAttachmentPath,
  renderPdfAttachmentPages,
  type PdfAttachmentRenderOptions
} from './PdfAttachmentRenderService'

const PNG_BYTES = Buffer.from(
  '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000b49444154789c6360000200000500017a5eab3f0000000049454e44ae426082',
  'hex'
)

function tempDir(): string {
  return mkdtempSync(path.join(os.tmpdir(), 'tw-pdf-render-test-'))
}

function fakeExecThatWritesPng(): NonNullable<PdfAttachmentRenderOptions['execFile']> {
  return (_file, args, _options, callback) => {
    const prefix = args[args.length - 1]
    const outDir = path.dirname(prefix)
    const pageLimitIndex = args.indexOf('-l')
    const pageCount = pageLimitIndex >= 0 ? Number(args[pageLimitIndex + 1]) : 1
    mkdirSync(outDir, { recursive: true })
    for (let page = 1; page <= pageCount; page += 1) {
      writeFileSync(`${prefix}-${page}.png`, PNG_BYTES)
    }
    callback(null, '', '')
  }
}

describe('PdfAttachmentRenderService', () => {
  it('detects PDF paths without treating arbitrary files as PDFs', () => {
    expect(isPdfAttachmentPath('/tmp/spec.pdf')).toBe(true)
    expect(isPdfAttachmentPath('file:///tmp/spec.pdf')).toBe(true)
    expect(isPdfAttachmentPath('/tmp/spec.PDF?x=1')).toBe(true)
    expect(isPdfAttachmentPath('/tmp/spec.png')).toBe(false)
    expect(isPdfAttachmentPath('')).toBe(false)
  })

  it('renders bounded PDF page images through Poppler when available', async () => {
    const root = tempDir()
    const pdf = path.join(root, 'spec.pdf')
    writeFileSync(pdf, '%PDF-1.4\n')
    const result = await renderPdfAttachmentPages(
      [{ id: 'pdf-1', path: pdf, name: 'spec.pdf' }],
      {
        cacheDir: path.join(root, 'cache'),
        pdftoppmPath: '/fake/pdftoppm',
        sipsPath: null,
        execFile: fakeExecThatWritesPng(),
        maxPages: 1
      }
    )
    try {
      const realPdf = await realpath(pdf)
      expect(result.skipped).toEqual([])
      expect(result.rendered).toHaveLength(1)
      expect(result.rendered[0]).toMatchObject({
        id: 'pdf-1:pdf-page-1',
        name: 'spec.pdf page 1.png',
        sourcePdfPath: realPdf,
        pageIndex: 1
      })
      expect(result.rendered[0].path.endsWith('.png')).toBe(true)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('rerenders a same-size PDF replacement even when its mtime is restored', async () => {
    const root = tempDir()
    const pdf = path.join(root, 'replaceable.pdf')
    const cacheDir = path.join(root, 'cache')
    const fixedTime = new Date('2024-01-02T03:04:05.000Z')
    writeFileSync(pdf, '%PDF-A\n')
    utimesSync(pdf, fixedTime, fixedTime)
    let renderCalls = 0
    const execFile: NonNullable<PdfAttachmentRenderOptions['execFile']> = (
      _file,
      args,
      _options,
      callback
    ) => {
      renderCalls += 1
      const prefix = args[args.length - 1]
      mkdirSync(path.dirname(prefix), { recursive: true })
      writeFileSync(`${prefix}-1.png`, PNG_BYTES)
      callback(null, '', '')
    }

    try {
      const first = await renderPdfAttachmentPages([{ path: pdf }], {
        cacheDir,
        pdftoppmPath: '/fake/pdftoppm',
        sipsPath: null,
        execFile,
        maxPages: 1
      })
      writeFileSync(pdf, '%PDF-B\n')
      utimesSync(pdf, fixedTime, fixedTime)
      expect(statSync(pdf).size).toBe(Buffer.byteLength('%PDF-A\n'))
      expect(statSync(pdf).mtimeMs).toBe(fixedTime.getTime())

      const second = await renderPdfAttachmentPages([{ path: pdf }], {
        cacheDir,
        pdftoppmPath: '/fake/pdftoppm',
        sipsPath: null,
        execFile,
        maxPages: 1
      })

      expect(first.rendered).toHaveLength(1)
      expect(second.rendered).toHaveLength(1)
      expect(renderCalls).toBe(2)
      expect(second.rendered[0].path).not.toBe(first.rendered[0].path)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('never promotes or later accepts a partial PNG from a failed render', async () => {
    const root = tempDir()
    const pdf = path.join(root, 'partial.pdf')
    const cacheDir = path.join(root, 'cache')
    writeFileSync(pdf, '%PDF-1.4\n')
    let failedRenderCalls = 0
    const partialExec: NonNullable<PdfAttachmentRenderOptions['execFile']> = (
      _file,
      args,
      _options,
      callback
    ) => {
      failedRenderCalls += 1
      const prefix = args[args.length - 1]
      mkdirSync(path.dirname(prefix), { recursive: true })
      writeFileSync(`${prefix}-1.png`, PNG_BYTES.subarray(0, 8))
      callback(null, '', '')
    }

    try {
      const failed = await renderPdfAttachmentPages([{ path: pdf }], {
        cacheDir,
        pdftoppmPath: '/fake/pdftoppm',
        sipsPath: null,
        execFile: partialExec,
        maxPages: 1
      })
      expect(failedRenderCalls).toBe(1)
      expect(failed.rendered).toEqual([])
      expect(failed.skipped[0]?.reason).toBe('render_unavailable')
      expect(readdirSync(cacheDir).filter((entry) => !entry.startsWith('.render-'))).toEqual([])

      let successfulRenderCalls = 0
      const completeExec: NonNullable<PdfAttachmentRenderOptions['execFile']> = (
        _file,
        args,
        _options,
        callback
      ) => {
        successfulRenderCalls += 1
        const prefix = args[args.length - 1]
        mkdirSync(path.dirname(prefix), { recursive: true })
        writeFileSync(`${prefix}-1.png`, PNG_BYTES)
        callback(null, '', '')
      }
      const recovered = await renderPdfAttachmentPages([{ path: pdf }], {
        cacheDir,
        pdftoppmPath: '/fake/pdftoppm',
        sipsPath: null,
        execFile: completeExec,
        maxPages: 1
      })

      expect(successfulRenderCalls).toBe(1)
      expect(recovered.skipped).toEqual([])
      expect(recovered.rendered).toHaveLength(1)
      expect(readdirSync(cacheDir).some((entry) => entry.startsWith('.render-'))).toBe(false)
      expect(path.basename(path.dirname(recovered.rendered[0].path))).toMatch(/^[a-f0-9]{64}$/)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('skips oversized PDFs before invoking a renderer', async () => {
    const root = tempDir()
    const pdf = path.join(root, 'large.pdf')
    writeFileSync(pdf, '%PDF-1.4\n')
    let called = false
    const result = await renderPdfAttachmentPages([{ path: pdf }], {
      cacheDir: path.join(root, 'cache'),
      pdftoppmPath: '/fake/pdftoppm',
      execFile: (_file, _args, _options, callback) => {
        called = true
        callback(null, '', '')
      },
      maxPdfBytes: 4
    })
    try {
      expect(called).toBe(false)
      expect(result.rendered).toEqual([])
      expect(result.skipped[0]?.reason).toBe('too_large')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('falls back to macOS sips when Poppler is unavailable', async () => {
    const root = tempDir()
    const pdf = path.join(root, 'one-page.pdf')
    writeFileSync(pdf, '%PDF-1.4\n')
    const execFile: NonNullable<PdfAttachmentRenderOptions['execFile']> = (_file, args, _options, callback) => {
      const outIndex = args.indexOf('--out')
      writeFileSync(args[outIndex + 1], PNG_BYTES)
      callback(null, '', '')
    }
    const result = await renderPdfAttachmentPages([{ path: pdf, name: 'one-page.pdf' }], {
      cacheDir: path.join(root, 'cache'),
      platform: 'darwin',
      pdftoppmPath: null,
      sipsPath: '/fake/sips',
      execFile,
      maxPages: 4
    })
    try {
      expect(result.skipped).toEqual([])
      expect(result.rendered).toHaveLength(1)
      expect(result.rendered[0].name).toBe('one-page.pdf page 1.png')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
