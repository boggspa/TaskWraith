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
  readOfficeDocument,
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

  it('surfaces builder warnings (pptx notes) and multi-sheet csv exports', async () => {
    const workspace = await makeWorkspace()
    const deckWrite = await writeOfficeDocument({
      workspacePath: workspace,
      filePath: 'deck.pptx',
      model: { kind: 'deck', slides: [{ title: 'T', bullets: [], notes: 'keep me' }] },
      baseEtag: null
    })
    expect(deckWrite.warnings.some((warning) => warning.includes('Speaker notes'))).toBe(true)

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
})
