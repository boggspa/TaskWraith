import { describe, expect, it } from 'vitest'
import type { DeckDocumentModel } from '../../shared/office/officeModels'
import { buildZip, parseZip } from './ZipArchive'
import { buildPptx, parsePptx } from './PptxCodec'
import { OfficeCodecError } from './DocxCodec'

const SAMPLE: DeckDocumentModel = {
  kind: 'deck',
  slides: [
    {
      title: 'Launch Plan',
      bullets: [
        { text: 'Phase one', level: 0 },
        { text: 'Ship the beta', level: 1 },
        { text: 'Phase two & beyond', level: 0 }
      ],
      notes: ''
    },
    { title: 'Empty body', bullets: [], notes: '' }
  ]
}

describe('buildPptx → parsePptx round-trip', () => {
  it('preserves slide order, titles and leveled bullets', () => {
    const { data, warnings } = buildPptx(SAMPLE)
    expect(warnings).toEqual([])
    const { model, warnings: parseWarnings } = parsePptx(data)
    expect(parseWarnings).toEqual([])
    expect(model).toEqual(SAMPLE)
  })

  it('emits every part a minimal valid deck needs', () => {
    const entries = parseZip(buildPptx(SAMPLE).data)
    const names = [...entries.keys()]
    for (const required of [
      '[Content_Types].xml',
      '_rels/.rels',
      'ppt/presentation.xml',
      'ppt/_rels/presentation.xml.rels',
      'ppt/slideMasters/slideMaster1.xml',
      'ppt/slideMasters/_rels/slideMaster1.xml.rels',
      'ppt/slideLayouts/slideLayout1.xml',
      'ppt/slideLayouts/_rels/slideLayout1.xml.rels',
      'ppt/theme/theme1.xml',
      'ppt/slides/slide1.xml',
      'ppt/slides/_rels/slide1.xml.rels',
      'ppt/slides/slide2.xml'
    ]) {
      expect(names).toContain(required)
    }
    const presentation = entries.get('ppt/presentation.xml')!.toString('utf8')
    expect(presentation).toContain('<p:sldSz cx="12192000" cy="6858000"/>')
    const slide = entries.get('ppt/slides/slide1.xml')!.toString('utf8')
    expect(slide).toContain('<a:t>Phase two &amp; beyond</a:t>')
    expect(slide).toContain('lvl="1"')
  })

  it('warns when speaker notes would be dropped from the pptx export', () => {
    const withNotes: DeckDocumentModel = {
      kind: 'deck',
      slides: [{ title: 'T', bullets: [], notes: 'remember this' }]
    }
    const { warnings } = buildPptx(withNotes)
    expect(warnings.some((warning) => warning.includes('Speaker notes'))).toBe(true)
  })
})

describe('parsePptx against foreign-produced shapes', () => {
  it('reads notes slides referenced from slide rels', () => {
    const slideXml =
      '<?xml version="1.0"?><p:sld xmlns:p="p" xmlns:a="a"><p:cSld><p:spTree>' +
      '<p:sp><p:nvSpPr><p:nvPr><p:ph type="title"/></p:nvPr></p:nvSpPr><p:txBody><a:p><a:r><a:t>Titled</a:t></a:r></a:p></p:txBody></p:sp>' +
      '<p:sp><p:nvSpPr><p:nvPr><p:ph idx="1"/></p:nvPr></p:nvSpPr><p:txBody><a:p><a:r><a:t>bullet</a:t></a:r></a:p></p:txBody></p:sp>' +
      '</p:spTree></p:cSld></p:sld>'
    const notesXml =
      '<?xml version="1.0"?><p:notes xmlns:p="p" xmlns:a="a"><p:cSld><p:spTree>' +
      '<p:sp><p:nvSpPr><p:nvPr><p:ph type="body"/></p:nvPr></p:nvSpPr><p:txBody><a:p><a:r><a:t>note line</a:t></a:r></a:p></p:txBody></p:sp>' +
      '</p:spTree></p:cSld></p:notes>'
    const archive = buildZip([
      {
        name: 'ppt/presentation.xml',
        data: Buffer.from(
          '<?xml version="1.0"?><p:presentation xmlns:p="p" xmlns:r="r"><p:sldIdLst><p:sldId id="256" r:id="rId2"/></p:sldIdLst></p:presentation>'
        )
      },
      {
        name: 'ppt/_rels/presentation.xml.rels',
        data: Buffer.from(
          '<?xml version="1.0"?><Relationships><Relationship Id="rId2" Type="t" Target="slides/slide1.xml"/></Relationships>'
        )
      },
      { name: 'ppt/slides/slide1.xml', data: Buffer.from(slideXml) },
      {
        name: 'ppt/slides/_rels/slide1.xml.rels',
        data: Buffer.from(
          '<?xml version="1.0"?><Relationships><Relationship Id="rId9" Type="t" Target="../notesSlides/notesSlide1.xml"/></Relationships>'
        )
      },
      { name: 'ppt/notesSlides/notesSlide1.xml', data: Buffer.from(notesXml) }
    ])
    const { model } = parsePptx(archive)
    expect(model.slides).toEqual([
      { title: 'Titled', bullets: [{ text: 'bullet', level: 0 }], notes: 'note line' }
    ])
  })

  it('falls back to name-ordered slides when the id list is unreadable', () => {
    const slide = (text: string): string =>
      `<?xml version="1.0"?><p:sld xmlns:p="p" xmlns:a="a"><p:cSld><p:spTree><p:sp><p:nvSpPr><p:nvPr><p:ph type="title"/></p:nvPr></p:nvSpPr><p:txBody><a:p><a:r><a:t>${text}</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld></p:sld>`
    const archive = buildZip([
      {
        name: 'ppt/presentation.xml',
        data: Buffer.from('<?xml version="1.0"?><p:presentation xmlns:p="p"/>')
      },
      { name: 'ppt/slides/slide1.xml', data: Buffer.from(slide('one')) },
      { name: 'ppt/slides/slide2.xml', data: Buffer.from(slide('two')) }
    ])
    const { model } = parsePptx(archive)
    expect(model.slides.map((entry) => entry.title)).toEqual(['one', 'two'])
  })

  it('warns about tables/charts and rejects non-decks', () => {
    const archive = buildZip([
      {
        name: 'ppt/presentation.xml',
        data: Buffer.from('<?xml version="1.0"?><p:presentation xmlns:p="p"/>')
      },
      {
        name: 'ppt/slides/slide1.xml',
        data: Buffer.from(
          '<?xml version="1.0"?><p:sld xmlns:p="p" xmlns:a="a"><p:cSld><p:spTree><p:graphicFrame/></p:spTree></p:cSld></p:sld>'
        )
      }
    ])
    const { warnings } = parsePptx(archive)
    expect(warnings.some((warning) => warning.includes('Tables/charts'))).toBe(true)
    expect(() => parsePptx(Buffer.from('nope'))).toThrow(OfficeCodecError)
  })
})
