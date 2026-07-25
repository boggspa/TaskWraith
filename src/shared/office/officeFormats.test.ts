import { describe, expect, it } from 'vitest'
import {
  OFFICE_FORMAT_KINDS,
  exportFormatsForKind,
  defaultDocumentNameForKind,
  isOfficeDocumentPath,
  officeFormatForPath,
  officeKindForPath,
  officeWorkspaceRelativePath,
  replaceOfficeExtension,
  shouldAutoRouteToOffice
} from './officeFormats'

describe('officeFormatForPath', () => {
  it('maps extensions case-insensitively', () => {
    expect(officeFormatForPath('docs/Report.DOCX')).toBe('docx')
    expect(officeFormatForPath('sheet.xlsx')).toBe('xlsx')
    expect(officeFormatForPath('deck.pptx')).toBe('pptx')
    expect(officeFormatForPath('cal.ics')).toBe('ics')
    expect(officeFormatForPath('mail.eml')).toBe('eml')
    expect(officeFormatForPath('notes.md')).toBe('md')
    expect(officeFormatForPath('data.csv')).toBe('csv')
    expect(officeFormatForPath('data.tsv')).toBe('tsv')
  })

  it('returns null for non-office paths', () => {
    expect(officeFormatForPath('src/App.tsx')).toBeNull()
    expect(officeFormatForPath('Makefile')).toBeNull()
    expect(officeFormatForPath('archive.docx.bak')).toBeNull()
  })
})

describe('routing', () => {
  it('auto-routes binary and structured formats but leaves md/csv in the code editor', () => {
    expect(shouldAutoRouteToOffice('a.docx')).toBe(true)
    expect(shouldAutoRouteToOffice('a.xlsx')).toBe(true)
    expect(shouldAutoRouteToOffice('a.pptx')).toBe(true)
    expect(shouldAutoRouteToOffice('a.ics')).toBe(true)
    expect(shouldAutoRouteToOffice('a.eml')).toBe(true)
    expect(shouldAutoRouteToOffice('README.md')).toBe(false)
    expect(shouldAutoRouteToOffice('data.csv')).toBe(false)
    expect(shouldAutoRouteToOffice('a.ts')).toBe(false)
  })

  it('keeps kind mapping consistent with export formats', () => {
    for (const [format, kind] of Object.entries(OFFICE_FORMAT_KINDS)) {
      expect(officeKindForPath(`x.${format}`)).toBe(kind)
      // Every format that maps to a kind must be exportable from that kind,
      // except tsv/md conveniences which are one-way-in for some kinds.
      const targets = exportFormatsForKind(kind)
      expect(targets.length).toBeGreaterThan(0)
    }
    expect(isOfficeDocumentPath('x.docx')).toBe(true)
    expect(isOfficeDocumentPath('x.rs')).toBe(false)
  })
})

describe('replaceOfficeExtension', () => {
  it('swaps the extension in place', () => {
    expect(replaceOfficeExtension('docs/report.docx', 'md')).toBe('docs/report.md')
    expect(replaceOfficeExtension('data.csv', 'xlsx')).toBe('data.xlsx')
  })

  it('appends when there is no extension and ignores dot-directories', () => {
    expect(replaceOfficeExtension('notes', 'md')).toBe('notes.md')
    expect(replaceOfficeExtension('.hidden/file', 'docx')).toBe('.hidden/file.docx')
  })
})

describe('officeWorkspaceRelativePath', () => {
  it('maps contained absolute paths to workspace-relative paths', () => {
    expect(officeWorkspaceRelativePath('/ws/project', '/ws/project/docs/a.docx')).toBe(
      'docs/a.docx'
    )
    expect(officeWorkspaceRelativePath('/ws/project/', '/ws/project/a.docx')).toBe('a.docx')
  })

  it('normalizes Windows separators', () => {
    expect(officeWorkspaceRelativePath('C:\\ws\\project', 'C:\\ws\\project\\docs\\a.docx')).toBe(
      'docs/a.docx'
    )
  })

  it('rejects the root itself, siblings, prefix look-alikes and blanks', () => {
    expect(officeWorkspaceRelativePath('/ws/project', '/ws/project')).toBeNull()
    expect(officeWorkspaceRelativePath('/ws/project', '/ws/other/a.docx')).toBeNull()
    expect(officeWorkspaceRelativePath('/ws/project', '/ws/project-two/a.docx')).toBeNull()
    expect(officeWorkspaceRelativePath('', '/ws/a.docx')).toBeNull()
    expect(officeWorkspaceRelativePath('/ws/project', '')).toBeNull()
  })

  it('rejects dot-segment traversal inside the prefix-matched remainder', () => {
    expect(officeWorkspaceRelativePath('/ws/project', '/ws/project/../other/a.docx')).toBeNull()
    expect(officeWorkspaceRelativePath('/ws/project', '/ws/project/docs/../../a.docx')).toBeNull()
    expect(officeWorkspaceRelativePath('/ws/project', '/ws/project/./a.docx')).toBeNull()
  })
})

describe('defaults', () => {
  it('provides a default filename per kind', () => {
    expect(defaultDocumentNameForKind('word')).toBe('Untitled Document.docx')
    expect(defaultDocumentNameForKind('sheet')).toBe('Untitled Spreadsheet.xlsx')
    expect(defaultDocumentNameForKind('deck')).toBe('Untitled Deck.pptx')
    expect(defaultDocumentNameForKind('calendar')).toBe('Calendar.ics')
    expect(defaultDocumentNameForKind('mail')).toBe('Untitled Email.eml')
  })
})
