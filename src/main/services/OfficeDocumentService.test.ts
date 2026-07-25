import { mkdtemp, readFile, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, describe, expect, it } from 'vitest'
import type {
  CalendarDocumentModel,
  SheetDocumentModel,
  WordDocumentModel
} from '../../shared/office/officeModels'
import { buildDocx } from '../office/DocxCodec'
import {
  MAX_OFFICE_FILE_BYTES,
  OfficeDocumentError,
  deleteOfficeDocument,
  readExternalOfficeDocument,
  readOfficeDocument,
  writeExternalOfficeDocument,
  writeOfficeDocument
} from './OfficeDocumentService'

let cleanupPaths: string[] = []

async function makeWorkspace(): Promise<string> {
  const workspace = await mkdtemp(join(tmpdir(), 'tw-office-'))
  cleanupPaths.push(workspace)
  return workspace
}

afterEach(async () => {
  await Promise.all(cleanupPaths.map((path) => rm(path, { recursive: true, force: true })))
  cleanupPaths = []
})

const WORD_MODEL: WordDocumentModel = {
  kind: 'word',
  blocks: [
    { type: 'heading', level: 1, runs: [{ text: 'Doc' }] },
    { type: 'paragraph', runs: [{ text: 'hello ' }, { text: 'world', bold: true }] }
  ]
}

describe('writeOfficeDocument / readOfficeDocument', () => {
  it('creates and round-trips a .docx through the base64 lane', async () => {
    const workspace = await makeWorkspace()
    const written = await writeOfficeDocument({
      workspacePath: workspace,
      filePath: 'report.docx',
      model: WORD_MODEL,
      baseEtag: null
    })
    expect(written.kind).toBe('word')
    expect(written.format).toBe('docx')
    expect(written.etag).toMatch(/^sha256:/)

    // The bytes on disk are a real ZIP, not base64 text.
    const onDisk = await readFile(join(workspace, 'report.docx'))
    expect(onDisk.subarray(0, 2).toString('latin1')).toBe('PK')

    const read = await readOfficeDocument(workspace, 'report.docx')
    expect(read.model).toEqual(WORD_MODEL)
    expect(read.etag).toBe(written.etag)
  })

  it('round-trips csv and ics through the utf8 lane with change recording', async () => {
    const workspace = await makeWorkspace()
    const recorded: string[] = []
    const sheet: SheetDocumentModel = {
      kind: 'sheet',
      sheets: [
        {
          name: 'Sheet1',
          rows: [
            ['a', 'b'],
            ['1', '2']
          ]
        }
      ]
    }
    await writeOfficeDocument({
      workspacePath: workspace,
      filePath: 'data.csv',
      model: sheet,
      baseEtag: null,
      recordChange: (input) => {
        recorded.push(input.filePath)
        return { id: 'cs' } as never
      }
    })
    expect(recorded).toEqual(['data.csv'])
    const read = await readOfficeDocument(workspace, 'data.csv')
    expect(read.model).toEqual(sheet)

    const calendar: CalendarDocumentModel = {
      kind: 'calendar',
      events: [
        {
          uid: 'e1',
          title: 'Standup',
          start: '2026-08-01T09:00',
          end: '2026-08-01T09:15',
          allDay: false
        }
      ]
    }
    await writeOfficeDocument({
      workspacePath: workspace,
      filePath: 'cal.ics',
      model: calendar,
      baseEtag: null
    })
    const readCalendar = await readOfficeDocument(workspace, 'cal.ics')
    expect(readCalendar.model).toEqual(calendar)
  })

  it('enforces optimistic concurrency across binary saves', async () => {
    const workspace = await makeWorkspace()
    const first = await writeOfficeDocument({
      workspacePath: workspace,
      filePath: 'doc.docx',
      model: WORD_MODEL,
      baseEtag: null
    })
    // Simulate an external overwrite.
    await writeFile(join(workspace, 'doc.docx'), buildDocx({ kind: 'word', blocks: [] }))
    await expect(
      writeOfficeDocument({
        workspacePath: workspace,
        filePath: 'doc.docx',
        model: WORD_MODEL,
        baseEtag: first.etag
      })
    ).rejects.toThrow(/changed on disk/)
  })

  it('rejects unsupported extensions, kind mismatches and invalid models', async () => {
    const workspace = await makeWorkspace()
    await expect(
      readOfficeDocument(workspace, 'code.ts').catch((error) => {
        expect(error).toBeInstanceOf(OfficeDocumentError)
        expect((error as OfficeDocumentError).code).toBe('unsupported_format')
        throw error
      })
    ).rejects.toThrow()

    await expect(
      writeOfficeDocument({
        workspacePath: workspace,
        filePath: 'sheet.xlsx',
        model: WORD_MODEL,
        baseEtag: null
      })
    ).rejects.toThrow(/cannot be saved as \.xlsx/)

    await expect(
      writeOfficeDocument({
        workspacePath: workspace,
        filePath: 'doc.docx',
        model: { nonsense: true },
        baseEtag: null
      })
    ).rejects.toThrow(/not a valid model/)
  })

  it('rejects paths escaping the workspace', async () => {
    const workspace = await makeWorkspace()
    await expect(readOfficeDocument(workspace, '../outside.docx')).rejects.toThrow(
      /outside the workspace/
    )
  })

  it('reports corrupt containers as invalid_document', async () => {
    const workspace = await makeWorkspace()
    await writeFile(join(workspace, 'broken.docx'), Buffer.from('this is not a zip'))
    await expect(
      readOfficeDocument(workspace, 'broken.docx').catch((error) => {
        expect((error as OfficeDocumentError).code).toBe('invalid_document')
        throw error
      })
    ).rejects.toThrow(/Not a valid \.docx/)
  })

  it('round-trips pptx speaker notes and warns on multi-sheet csv exports', async () => {
    const workspace = await makeWorkspace()
    const deckWrite = await writeOfficeDocument({
      workspacePath: workspace,
      filePath: 'deck.pptx',
      model: { kind: 'deck', slides: [{ title: 'T', bullets: [], notes: 'keep me' }] },
      baseEtag: null
    })
    expect(deckWrite.warnings).toEqual([])
    const deckRead = await readOfficeDocument(workspace, 'deck.pptx')
    expect(deckRead.model).toEqual({
      kind: 'deck',
      slides: [{ title: 'T', bullets: [], notes: 'keep me' }]
    })

    const multiSheet: SheetDocumentModel = {
      kind: 'sheet',
      sheets: [
        { name: 'A', rows: [['1']] },
        { name: 'B', rows: [['2']] }
      ]
    }
    const csvWrite = await writeOfficeDocument({
      workspacePath: workspace,
      filePath: 'flat.csv',
      model: multiSheet,
      baseEtag: null
    })
    expect(csvWrite.warnings.some((warning) => warning.includes('first sheet'))).toBe(true)
  })

  it('keeps the office byte cap far above the text editor cap', () => {
    expect(MAX_OFFICE_FILE_BYTES).toBeGreaterThan(10_000_000)
  })

  it('clamps oversized files at READ time with a loud truncation warning', async () => {
    const workspace = await makeWorkspace()
    // 300 columns exceeds the 256-column model cap.
    const wideRow = Array.from({ length: 300 }, (_, index) => `c${index}`).join(',')
    await writeFile(join(workspace, 'wide.csv'), `${wideRow}\r\n${wideRow}\r\n`)
    const read = await readOfficeDocument(workspace, 'wide.csv')
    expect(read.model.kind).toBe('sheet')
    if (read.model.kind === 'sheet') {
      expect(read.model.sheets[0].rows[0]).toHaveLength(256)
    }
    expect(
      read.warnings.some(
        (warning) => warning.includes('256 columns') && warning.includes('Saving writes only')
      )
    ).toBe(true)
    // What the editor shows is exactly what a save writes — no silent
    // second truncation at save time.
    const saved = await writeOfficeDocument({
      workspacePath: workspace,
      filePath: 'wide.csv',
      model: read.model,
      baseEtag: read.etag
    })
    expect(saved.model).toEqual(read.model)
  })

  it('warns when normalization drops oversized or invalid images on save', async () => {
    const workspace = await makeWorkspace()
    const result = await writeOfficeDocument({
      workspacePath: workspace,
      filePath: 'imgs.docx',
      model: {
        kind: 'word',
        blocks: [
          { type: 'paragraph', runs: [{ text: 'keep' }] },
          { type: 'image', image: { dataUri: 'data:image/svg+xml;base64,PHN2Zy8+', name: 'bad' } }
        ]
      },
      baseEtag: null
    })
    expect(result.warnings.some((warning) => warning.includes('image was removed'))).toBe(true)
  })
})

describe('external office documents', () => {
  it('round-trips a document by absolute path, reporting it under that path', async () => {
    const workspace = await makeWorkspace()
    const absolutePath = join(workspace, 'brief.docx')
    const written = await writeExternalOfficeDocument({
      absolutePath,
      model: WORD_MODEL,
      baseEtag: null
    })
    expect(written.path).toBe(absolutePath)
    expect((await readFile(absolutePath)).subarray(0, 2).toString('latin1')).toBe('PK')

    const read = await readExternalOfficeDocument(absolutePath)
    expect(read.path).toBe(absolutePath)
    expect(read.model).toEqual(WORD_MODEL)
    expect(read.etag).toBe(written.etag)
  })

  it('keeps etag concurrency on the external lane', async () => {
    const workspace = await makeWorkspace()
    const absolutePath = join(workspace, 'race.docx')
    const first = await writeExternalOfficeDocument({
      absolutePath,
      model: WORD_MODEL,
      baseEtag: null
    })
    await writeFile(absolutePath, buildDocx({ kind: 'word', blocks: [] }))
    await expect(
      writeExternalOfficeDocument({
        absolutePath,
        model: WORD_MODEL,
        baseEtag: first.etag
      })
    ).rejects.toThrow(/changed on disk/)
  })

  it('refuses filesystem-root parents and non-office extensions', async () => {
    await expect(readExternalOfficeDocument('/brief.docx')).rejects.toThrow(/filesystem root/)
    const workspace = await makeWorkspace()
    await expect(readExternalOfficeDocument(join(workspace, 'code.ts'))).rejects.toThrow(
      /not an Office document/
    )
  })

  it('never records change sets for external writes', async () => {
    const workspace = await makeWorkspace()
    const absolutePath = join(workspace, 'note.csv')
    // The external lane takes no recordChange callback at all; a text-format
    // external write must still succeed and leave no change-set behind.
    const result = await writeExternalOfficeDocument({
      absolutePath,
      model: { kind: 'sheet', sheets: [{ name: 'S', rows: [['x']] }] },
      baseEtag: null
    })
    expect(result.path).toBe(absolutePath)
    expect(result.warnings).toEqual([])
  })
})

describe('deleteOfficeDocument', () => {
  it('deletes binary office documents with etag concurrency', async () => {
    const workspace = await makeWorkspace()
    const written = await writeOfficeDocument({
      workspacePath: workspace,
      filePath: 'gone.docx',
      model: WORD_MODEL,
      baseEtag: null
    })
    const result = await deleteOfficeDocument({
      workspacePath: workspace,
      filePath: 'gone.docx',
      baseEtag: written.etag
    })
    expect(result.path).toBe('gone.docx')
    await expect(readFile(join(workspace, 'gone.docx'))).rejects.toThrow()
  })

  it('rejects stale etags and non-office extensions', async () => {
    const workspace = await makeWorkspace()
    const written = await writeOfficeDocument({
      workspacePath: workspace,
      filePath: 'keep.docx',
      model: WORD_MODEL,
      baseEtag: null
    })
    await writeFile(join(workspace, 'keep.docx'), buildDocx({ kind: 'word', blocks: [] }))
    await expect(
      deleteOfficeDocument({
        workspacePath: workspace,
        filePath: 'keep.docx',
        baseEtag: written.etag
      })
    ).rejects.toThrow(/changed on disk/)

    await writeFile(join(workspace, 'code.ts'), 'export {}')
    await expect(
      deleteOfficeDocument({ workspacePath: workspace, filePath: 'code.ts', baseEtag: 'sha256:x' })
    ).rejects.toThrow(/not an Office document/)
  })

  it('records change sets for text office formats but not binary ones', async () => {
    const workspace = await makeWorkspace()
    const recorded: { filePath: string; previousContent?: string }[] = []
    const record = (input: { filePath: string; previousContent?: string }): never => {
      recorded.push({ filePath: input.filePath, previousContent: input.previousContent })
      return { id: 'cs' } as never
    }

    const csv = await writeOfficeDocument({
      workspacePath: workspace,
      filePath: 'notes.csv',
      model: { kind: 'sheet', sheets: [{ name: 'S', rows: [['x']] }] },
      baseEtag: null
    })
    await deleteOfficeDocument({
      workspacePath: workspace,
      filePath: 'notes.csv',
      baseEtag: csv.etag,
      recordChange: record as never
    })
    expect(recorded).toHaveLength(1)
    expect(recorded[0].previousContent).toContain('x')

    const docx = await writeOfficeDocument({
      workspacePath: workspace,
      filePath: 'bin.docx',
      model: WORD_MODEL,
      baseEtag: null
    })
    await deleteOfficeDocument({
      workspacePath: workspace,
      filePath: 'bin.docx',
      baseEtag: docx.etag,
      recordChange: record as never
    })
    // Binary deletes skip change recording entirely.
    expect(recorded).toHaveLength(1)
  })
})
