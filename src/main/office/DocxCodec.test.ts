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

  it('keeps text and warns when a drawing carries no importable image', () => {
    const documentXml =
      '<?xml version="1.0"?><w:document xmlns:w="ns"><w:body>' +
      '<w:p><w:r><w:drawing><wp:inline/></w:drawing><w:t>text</w:t></w:r></w:p>' +
      '</w:body></w:document>'
    const archive = buildZip([{ name: 'word/document.xml', data: Buffer.from(documentXml) }])
    const { model, warnings } = parseDocx(archive)
    expect(model.blocks[0]).toEqual({ type: 'paragraph', runs: [{ text: 'text' }] })
    expect(warnings.some((warning) => warning.includes('Shapes and charts'))).toBe(true)
  })

  it('rejects archives without a document part', () => {
    const archive = buildZip([{ name: 'other.xml', data: Buffer.from('<x/>') }])
    expect(() => parseDocx(archive)).toThrow(OfficeCodecError)
    expect(() => parseDocx(Buffer.from('garbage'))).toThrow(/Not a valid \.docx/)
  })
})

describe('embedded images', () => {
  const PNG_URI =
    'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='

  it('round-trips image blocks through media parts and inline drawings', () => {
    const model: WordDocumentModel = {
      kind: 'word',
      blocks: [
        { type: 'paragraph', runs: [{ text: 'before' }] },
        {
          type: 'image',
          image: { dataUri: PNG_URI, name: 'pixel.png', widthPx: 120, heightPx: 80 }
        },
        { type: 'paragraph', runs: [{ text: 'after' }] }
      ]
    }
    const archive = buildDocx(model)
    const entries = parseZip(archive)
    expect(entries.has('word/media/image1.png')).toBe(true)
    const contentTypes = entries.get('[Content_Types].xml')!.toString('utf8')
    expect(contentTypes).toContain('Extension="png"')
    const documentXml = entries.get('word/document.xml')!.toString('utf8')
    expect(documentXml).toContain('<wp:extent cx="1143000" cy="762000"/>')
    expect(documentXml).toContain('r:embed="rIdImage1"')

    const { model: reparsed, warnings } = parseDocx(archive)
    expect(warnings).toEqual([])
    expect(reparsed).toEqual(model)
  })

  it('replaces an image-only paragraph with the image block alone', () => {
    const model: WordDocumentModel = {
      kind: 'word',
      blocks: [
        { type: 'image', image: { dataUri: PNG_URI, name: 'only.png', widthPx: 1, heightPx: 1 } }
      ]
    }
    const { model: reparsed } = parseDocx(buildDocx(model))
    expect(reparsed.blocks).toHaveLength(1)
    expect(reparsed.blocks[0].type).toBe('image')
  })

  it('caps repeated references to one media part instead of exploding memory', () => {
    // One tiny PNG referenced from 55 paragraphs: import must stop at the
    // 40-image budget, encode the part once (shared string), and say so.
    const png = Buffer.from(PNG_URI.split(',')[1], 'base64')
    const paragraph =
      '<w:p><w:r><w:drawing><wp:inline><wp:extent cx="9525" cy="9525"/><a:blip r:embed="rId1"/></wp:inline></w:drawing></w:r></w:p>'
    const documentXml =
      '<?xml version="1.0"?><w:document xmlns:w="ns"><w:body>' +
      paragraph.repeat(55) +
      '</w:body></w:document>'
    const rels =
      '<?xml version="1.0"?><Relationships><Relationship Id="rId1" Type="t" Target="media/image1.png"/></Relationships>'
    const archive = buildZip([
      { name: 'word/document.xml', data: Buffer.from(documentXml) },
      { name: 'word/_rels/document.xml.rels', data: Buffer.from(rels) },
      { name: 'word/media/image1.png', data: png }
    ])
    const { model, warnings } = parseDocx(archive)
    const imageBlocks = model.blocks.filter((block) => block.type === 'image')
    expect(imageBlocks).toHaveLength(40)
    // All 40 share the identical encoded string — one encode, not forty.
    const uris = new Set(
      imageBlocks.map((block) => (block.type === 'image' ? block.image.dataUri : ''))
    )
    expect(uris.size).toBe(1)
    expect(warnings.some((warning) => warning.includes('image budget'))).toBe(true)
  })

  it('warns about unsupported embedded formats instead of failing', () => {
    const documentXml =
      '<?xml version="1.0"?><w:document xmlns:w="ns"><w:body>' +
      '<w:p><w:r><w:drawing><wp:inline><a:blip r:embed="rId1"/></wp:inline></w:drawing></w:r></w:p>' +
      '</w:body></w:document>'
    const rels =
      '<?xml version="1.0"?><Relationships><Relationship Id="rId1" Type="t" Target="media/image1.emf"/></Relationships>'
    const archive = buildZip([
      { name: 'word/document.xml', data: Buffer.from(documentXml) },
      { name: 'word/_rels/document.xml.rels', data: Buffer.from(rels) },
      { name: 'word/media/image1.emf', data: Buffer.from([0x01, 0x00, 0x00, 0x00]) }
    ])
    const { model, warnings } = parseDocx(archive)
    expect(model.blocks.some((block) => block.type === 'image')).toBe(false)
    expect(warnings.some((warning) => warning.includes('unsupported formats'))).toBe(true)
  })

  it('warns once about shapes/charts (drawings without an image)', () => {
    const documentXml =
      '<?xml version="1.0"?><w:document xmlns:w="ns"><w:body>' +
      '<w:p><w:r><w:drawing><wp:inline><a:graphic/></wp:inline></w:drawing></w:r><w:r><w:t>text</w:t></w:r></w:p>' +
      '</w:body></w:document>'
    const archive = buildZip([{ name: 'word/document.xml', data: Buffer.from(documentXml) }])
    const { model, warnings } = parseDocx(archive)
    expect(model.blocks[0]).toEqual({ type: 'paragraph', runs: [{ text: 'text' }] })
    expect(warnings).toEqual(['Shapes and charts are not imported.'])
  })
})
