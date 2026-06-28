import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'fs'
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
  '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c6360000002000100ffff03000006000557bfab2d0000000049454e44ae426082',
  'hex'
)

function tempDir(): string {
  return mkdtempSync(path.join(os.tmpdir(), 'tw-pdf-render-test-'))
}

function fakeExecThatWritesPng(): NonNullable<PdfAttachmentRenderOptions['execFile']> {
  return (_file, args, _options, callback) => {
    const prefix = args[args.length - 1]
    const outDir = path.dirname(prefix)
    mkdirSync(outDir, { recursive: true })
    writeFileSync(`${prefix}-1.png`, PNG_BYTES)
    writeFileSync(`${prefix}-2.png`, PNG_BYTES)
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
