import { describe, expect, it } from 'vitest'
import type { WordDocumentModel } from '../../shared/office/officeModels'
import { buildZip, parseZip } from './ZipArchive'
import { buildDocx, OfficeCodecError, parseDocx } from './DocxCodec'

const SAMPLE: WordDocumentModel = {
  kind: 'word',
  blocks: [
    { type: 'heading', level: 1, runs: [{ text: 'Quarterly Report' }] },
    {
      type: 'paragraph',
      runs: [
        { text: 'Revenue was ' },
        { text: 'strong', bold: true },
        { text: ' and ' },
        { text: 'growing', italic: true },
        { text: ' — see ' },
        { text: 'the dashboard', link: 'https://example.com/dash' },
        { text: ' for details.' }
      ]
    },
    { type: 'heading', level: 2, runs: [{ text: 'Notes' }] },
    { type: 'list-item', ordered: false, level: 0, runs: [{ text: 'first bullet' }] },
    { type: 'list-item', ordered: false, level: 1, runs: [{ text: 'nested bullet' }] },
    { type: 'list-item', ordered: true, level: 0, runs: [{ text: 'step one' }] },
    {
      type: 'paragraph',
      runs: [
        { text: 'strike', strike: true },
        { text: ' und ', underline: true },
        { text: 'mono', code: true },
        { text: 'line1\nline2' }
      ]
    },
    {
      type: 'table',
      rows: [
        [[{ text: 'Region' }], [{ text: 'Total', bold: true }]],
        [[{ text: 'EMEA' }], [{ text: '42' }]]
      ]
    },
    { type: 'paragraph', runs: [] }
  ]
}

describe('buildDocx → parseDocx round-trip', () => {
  it('preserves headings, styled runs, lists, links, breaks and tables', () => {
    const archive = buildDocx(SAMPLE)
    const { model, warnings } = parseDocx(archive)
    expect(warnings).toEqual([])
    expect(model).toEqual(SAMPLE)
  })

  it('produces a structurally valid OOXML package', () => {
    const entries = parseZip(buildDocx(SAMPLE))
    expect([...entries.keys()].sort()).toEqual([
      '[Content_Types].xml',
      '_rels/.rels',
      'word/_rels/document.xml.rels',
      'word/document.xml',
      'word/numbering.xml',
      'word/styles.xml'
    ])
    const documentXml = entries.get('word/document.xml')!.toString('utf8')
    expect(documentXml).toContain('<w:pStyle w:val="Heading1"/>')
    expect(documentXml).toContain('<w:hyperlink r:id="rIdLink1">')
    expect(documentXml).toContain('xml:space="preserve"')
    const rels = entries.get('word/_rels/document.xml.rels')!.toString('utf8')
    expect(rels).toContain('Target="https://example.com/dash" TargetMode="External"')
  })

  it('escapes XML-hostile text', () => {
    const model: WordDocumentModel = {
      kind: 'word',
      blocks: [{ type: 'paragraph', runs: [{ text: '<script> & "quotes" </script>' }] }]
    }
    const { model: reparsed } = parseDocx(buildDocx(model))
    expect(reparsed).toEqual(model)
  })
})

describe('parseDocx against foreign-produced shapes', () => {
  it('reads content controls, tracked insertions and skips deletions', () => {
    const documentXml =
      '<?xml version="1.0"?><w:document xmlns:w="ns"><w:body>' +
      '<w:sdt><w:sdtContent><w:p><w:r><w:t>inside control</w:t></w:r></w:p></w:sdtContent></w:sdt>' +
      '<w:p><w:ins><w:r><w:t>inserted</w:t></w:r></w:ins><w:del><w:r><w:t>deleted</w:t></w:r></w:del></w:p>' +
      '</w:body></w:document>'
    const archive = buildZip([{ name: 'word/document.xml', data: Buffer.from(documentXml) }])
    const { model } = parseDocx(archive)
    expect(model.blocks).toEqual([
      { type: 'paragraph', runs: [{ text: 'inside control' }] },
      { type: 'paragraph', runs: [{ text: 'inserted' }] }
    ])
  })

  it('honors explicit off flags on run properties', () => {
    const documentXml =
      '<?xml version="1.0"?><w:document xmlns:w="ns"><w:body>' +
      '<w:p><w:r><w:rPr><w:b w:val="0"/><w:i w:val="false"/></w:rPr><w:t>plain</w:t></w:r></w:p>' +
      '</w:body></w:document>'
    const archive = buildZip([{ name: 'word/document.xml', data: Buffer.from(documentXml) }])
    const { model } = parseDocx(archive)
    expect(model.blocks[0]).toEqual({ type: 'paragraph', runs: [{ text: 'plain' }] })
  })

  it('warns about drawings without failing', () => {
    const documentXml =
      '<?xml version="1.0"?><w:document xmlns:w="ns"><w:body>' +
      '<w:p><w:r><w:drawing><wp:inline/></w:drawing><w:t>text</w:t></w:r></w:p>' +
      '</w:body></w:document>'
    const archive = buildZip([{ name: 'word/document.xml', data: Buffer.from(documentXml) }])
    const { model, warnings } = parseDocx(archive)
    expect(model.blocks[0]).toEqual({ type: 'paragraph', runs: [{ text: 'text' }] })
    expect(warnings.some((warning) => warning.includes('Images'))).toBe(true)
  })

  it('rejects archives without a document part', () => {
    const archive = buildZip([{ name: 'other.xml', data: Buffer.from('<x/>') }])
    expect(() => parseDocx(archive)).toThrow(OfficeCodecError)
    expect(() => parseDocx(Buffer.from('garbage'))).toThrow(/Not a valid \.docx/)
  })
})
