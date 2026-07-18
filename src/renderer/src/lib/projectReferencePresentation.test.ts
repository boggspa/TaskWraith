import { describe, expect, it } from 'vitest'

import { projectReferencePresentation } from './projectReferencePresentation'

describe('projectReferencePresentation', () => {
  it.each([
    ['/work/brief.docx', 'document', 'Document'],
    ['/work/forecast.xlsx', 'spreadsheet', 'Sheet'],
    ['/work/review.pptx', 'presentation', 'Slides'],
    ['/work/contract.PDF', 'pdf', 'PDF'],
    ['/work/App.tsx', 'code', 'Code'],
    ['/work/package.json', 'code', 'Code'],
    ['/work/mockup.png', 'image', 'Image'],
    ['/work/interview.m4a', 'audio', 'Audio'],
    ['/work/demo.mov', 'video', 'Video'],
    ['/work/archive.zip', 'file', 'File']
  ])('classifies %s as %s', (locator, kind, label) => {
    expect(projectReferencePresentation({ kind: 'file', locator })).toEqual({ kind, label })
  })

  it('keeps authority kinds distinct from derived file formats', () => {
    expect(projectReferencePresentation({ kind: 'folder', locator: '/work/report.xlsx' })).toEqual({
      kind: 'folder',
      label: 'Folder'
    })
    expect(
      projectReferencePresentation({ kind: 'url', locator: 'https://example.com/a.pdf' })
    ).toEqual({
      kind: 'website',
      label: 'Website'
    })
  })
})
