import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { WorkspaceFileEntry } from '../../../../main/store/types'
import type { OfficeDocumentReadResult } from '../../../../shared/office/officeFormats'
import {
  OfficeSuitePanel,
  dedupeOfficeFileName,
  officeRailEntriesFromFiles,
  type OfficeRailEntry
} from './OfficeSuitePanel'
import { bulletsToText, textToBullets } from './DeckEditorView'

const RAIL: OfficeRailEntry[] = [
  { path: 'docs/plan.docx', name: 'plan.docx', format: 'docx', kind: 'word' },
  { path: 'budget.xlsx', name: 'budget.xlsx', format: 'xlsx', kind: 'sheet' },
  { path: 'team.ics', name: 'team.ics', format: 'ics', kind: 'calendar' }
]

const docFixture = (partial: Partial<OfficeDocumentReadResult>): OfficeDocumentReadResult => ({
  path: 'docs/plan.docx',
  kind: 'word',
  format: 'docx',
  model: { kind: 'word', blocks: [] },
  etag: 'sha256:abc',
  sizeBytes: 1234,
  warnings: [],
  ...partial
})

describe('OfficeSuitePanel', () => {
  it('renders the bound-workspace requirement when no workspace is set', () => {
    const html = renderToStaticMarkup(<OfficeSuitePanel />)
    expect(html).toContain('Office needs a bound workspace')
  })

  it('renders the empty state with grouped rail entries and the New picker', () => {
    const html = renderToStaticMarkup(
      <OfficeSuitePanel workspacePath="/ws" initialRailEntries={RAIL} />
    )
    expect(html).toContain('Word, sheets, decks, calendar &amp; mail')
    expect(html).toContain('Documents')
    expect(html).toContain('Spreadsheets')
    expect(html).toContain('Calendars')
    expect(html).toContain('plan.docx')
    expect(html).toContain('budget.xlsx')
    expect(html).toContain('Create a new office document')
    expect(html).toContain('Slide deck')
  })

  it('renders a word document into the contentEditable surface with formatting toolbar', () => {
    const html = renderToStaticMarkup(
      <OfficeSuitePanel
        workspacePath="/ws"
        initialDocument={docFixture({
          model: {
            kind: 'word',
            blocks: [
              { type: 'heading', level: 1, runs: [{ text: 'Plan' }] },
              { type: 'paragraph', runs: [{ text: 'go ' }, { text: 'fast', bold: true }] }
            ]
          }
        })}
      />
    )
    expect(html).toContain('office-word-surface')
    expect(html).toContain('<h1>Plan</h1>')
    expect(html).toContain('<strong>fast</strong>')
    expect(html).toContain('Bold')
    expect(html).toContain('Export…')
    expect(html).toContain('Word (.docx)')
    expect(html).toContain('Markdown (.md)')
    // Clean document: no dirty dot, Save disabled.
    expect(html).not.toContain('office-dirty-dot')
    expect(html).toContain('disabled')
  })

  it('renders a sheet with computed formula displays and sheet tabs', () => {
    const html = renderToStaticMarkup(
      <OfficeSuitePanel
        workspacePath="/ws"
        initialDocument={docFixture({
          path: 'budget.xlsx',
          kind: 'sheet',
          format: 'xlsx',
          model: {
            kind: 'sheet',
            sheets: [
              { name: 'Budget', rows: [['2', '3', '=A1*B1']] },
              { name: 'Notes', rows: [] }
            ]
          }
        })}
      />
    )
    expect(html).toContain('Formula bar')
    // A1 renders raw (it is the initial selection); C1 shows the computed value.
    expect(html).toContain('value="6"')
    expect(html).toContain('Budget')
    expect(html).toContain('Notes')
    expect(html).toContain('+ Row')
    expect(html).toContain('Excel (.xlsx)')
    expect(html).toContain('CSV (.csv)')
  })

  it('renders a deck with slide rail, bullets and notes fields', () => {
    const html = renderToStaticMarkup(
      <OfficeSuitePanel
        workspacePath="/ws"
        initialDocument={docFixture({
          path: 'deck.pptx',
          kind: 'deck',
          format: 'pptx',
          model: {
            kind: 'deck',
            slides: [
              { title: 'Kickoff', bullets: [{ text: 'why', level: 0 }], notes: 'smile' },
              { title: '', bullets: [], notes: '' }
            ]
          }
        })}
      />
    )
    expect(html).toContain('Kickoff')
    expect(html).toContain('Untitled slide')
    expect(html).toContain('Speaker notes')
    expect(html).toContain('+ Slide')
    expect(html).toContain('PowerPoint (.pptx)')
  })

  it('renders a calendar month derived from the first event', () => {
    const html = renderToStaticMarkup(
      <OfficeSuitePanel
        workspacePath="/ws"
        initialDocument={docFixture({
          path: 'team.ics',
          kind: 'calendar',
          format: 'ics',
          model: {
            kind: 'calendar',
            calendarName: 'Team Calendar',
            events: [
              {
                uid: 'e1',
                title: 'Offsite',
                start: '2026-08-10',
                end: '2026-08-12',
                allDay: true
              }
            ]
          }
        })}
      />
    )
    expect(html).toContain('August 2026')
    expect(html).toContain('Offsite')
    expect(html).toContain('+ Event')
    expect(html).toContain('Team Calendar')
    expect(html).toContain('iCalendar (.ics)')
  })

  it('renders the mail composer with headers and body', () => {
    const html = renderToStaticMarkup(
      <OfficeSuitePanel
        workspacePath="/ws"
        initialDocument={docFixture({
          path: 'note.eml',
          kind: 'mail',
          format: 'eml',
          model: {
            kind: 'mail',
            from: 'a@b.c',
            to: 'd@e.f',
            cc: '',
            bcc: '',
            subject: 'Weekly',
            body: 'Hello there',
            extraHeaders: [{ name: 'X-Priority', value: '1' }]
          }
        })}
      />
    )
    expect(html).toContain('value="a@b.c"')
    expect(html).toContain('value="Weekly"')
    expect(html).toContain('Hello there')
    expect(html).toContain('1 imported header')
    expect(html).toContain('Email (.eml)')
  })

  it('asks before discarding unsaved edits when opening another document', () => {
    const html = renderToStaticMarkup(
      <OfficeSuitePanel
        workspacePath="/ws"
        initialDocument={docFixture({})}
        initialPendingOpenPath="budget.xlsx"
      />
    )
    expect(html).toContain('Discard unsaved changes?')
    expect(html).toContain('Opening budget.xlsx discards them.')
    expect(html).toContain('Keep editing')
  })

  it('windows huge sheets in the grid while keeping the model intact', () => {
    const rows = Array.from({ length: 350 }, (_, index) => [String(index), 'x'])
    const html = renderToStaticMarkup(
      <OfficeSuitePanel
        workspacePath="/ws"
        initialDocument={docFixture({
          path: 'big.csv',
          kind: 'sheet',
          format: 'csv',
          model: { kind: 'sheet', sheets: [{ name: 'Big', rows }] }
        })}
      />
    )
    expect(html).toContain('Showing the first 300 of 350 rows')
    expect(html).toContain('saves write all of it')
    // Row 300 (index 299) rendered; row 301 not.
    expect(html).toContain('value="299"')
    expect(html).not.toContain('value="300"')
  })

  it('renders the delete affordance and its confirmation card', () => {
    const html = renderToStaticMarkup(
      <OfficeSuitePanel workspacePath="/ws" initialDocument={docFixture({})} initialConfirmDelete />
    )
    expect(html).toContain('Delete document?')
    expect(html).toContain('docs/plan.docx will be removed from this workspace.')
    expect(html).toContain('role="alertdialog"')
    expect(html).toContain('office-danger')
  })

  it('surfaces document warnings in a banner', () => {
    const html = renderToStaticMarkup(
      <OfficeSuitePanel
        workspacePath="/ws"
        initialDocument={docFixture({ warnings: ['Images and drawings are not imported.'] })}
      />
    )
    expect(html).toContain('office-banner-warning')
    expect(html).toContain('Images and drawings are not imported.')
  })
})

describe('officeRailEntriesFromFiles', () => {
  it('keeps only office files, sorted, with kind mapping', () => {
    const files: WorkspaceFileEntry[] = [
      { path: 'src/app.ts', name: 'app.ts', isDirectory: false, depth: 1 },
      { path: 'b.xlsx', name: 'b.xlsx', isDirectory: false, depth: 0 },
      { path: 'a.docx', name: 'a.docx', isDirectory: false, depth: 0 },
      { path: 'docs', name: 'docs', isDirectory: true, depth: 0 },
      { path: 'notes.md', name: 'notes.md', isDirectory: false, depth: 0 }
    ]
    expect(officeRailEntriesFromFiles(files)).toEqual([
      { path: 'a.docx', name: 'a.docx', format: 'docx', kind: 'word' },
      { path: 'b.xlsx', name: 'b.xlsx', format: 'xlsx', kind: 'sheet' },
      { path: 'notes.md', name: 'notes.md', format: 'md', kind: 'word' }
    ])
  })
})

describe('dedupeOfficeFileName', () => {
  it('suffixes with an incrementing counter before the extension', () => {
    const taken = new Set(['Untitled Document.docx', 'Untitled Document 2.docx'])
    expect(dedupeOfficeFileName('Untitled Document.docx', taken)).toBe('Untitled Document 3.docx')
    expect(dedupeOfficeFileName('Fresh.docx', taken)).toBe('Fresh.docx')
  })
})

describe('deck bullet text mapping', () => {
  it('round-trips bullets through the textarea format', () => {
    const bullets = [
      { text: 'top', level: 0 },
      { text: 'nested', level: 1 },
      { text: 'deep', level: 2 }
    ]
    expect(textToBullets(bulletsToText(bullets))).toEqual(bullets)
  })

  it('tolerates dash markers and blank input', () => {
    expect(textToBullets('- a\n  - b')).toEqual([
      { text: 'a', level: 0 },
      { text: 'b', level: 1 }
    ])
    expect(textToBullets('')).toEqual([])
  })
})
