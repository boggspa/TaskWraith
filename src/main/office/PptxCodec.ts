/**
 * PresentationML (.pptx) codec. Builds a minimal 16:9 deck (one master, one
 * "title and body" layout, an Office-shaped theme) that PowerPoint, Keynote
 * and Google Slides all open; parses titles, body bullets (with indent
 * levels) and speaker notes from decks produced by those suites.
 *
 * v1 export limitation: speaker notes live in the model and in Markdown
 * exports but are not written into the .pptx (no notesMaster part) — the
 * writer reports this as a warning when notes exist.
 */

import type { DeckDocumentModel, DeckSlide } from '../../shared/office/officeModels'
import { OFFICE_MODEL_LIMITS } from '../../shared/office/officeModels'
import {
  attrByLocalName,
  childByLocalName,
  descendantsByLocalName,
  escapeXmlText,
  firstDescendantByLocalName,
  localName,
  parseMarkup,
  sanitizeXmlText,
  type XmlNode
} from '../../shared/office/xmlLite'
import { OfficeCodecError } from './DocxCodec'
import { buildZip, parseZip, ZipArchiveError } from './ZipArchive'

export interface PptxParseResult {
  model: DeckDocumentModel
  warnings: string[]
}

export interface PptxBuildResult {
  data: Buffer
  warnings: string[]
}

const XML_DECL = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\r\n'
const P_NS = 'http://schemas.openxmlformats.org/presentationml/2006/main'
const A_NS = 'http://schemas.openxmlformats.org/drawingml/2006/main'
const R_NS = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'
const REL_PKG_NS = 'http://schemas.openxmlformats.org/package/2006/relationships'
const REL_OD = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'

// --- build -------------------------------------------------------------------

const THEME_XML = `${XML_DECL}<a:theme xmlns:a="${A_NS}" name="TaskWraith"><a:themeElements><a:clrScheme name="TaskWraith"><a:dk1><a:sysClr val="windowText" lastClr="000000"/></a:dk1><a:lt1><a:sysClr val="window" lastClr="FFFFFF"/></a:lt1><a:dk2><a:srgbClr val="44546A"/></a:dk2><a:lt2><a:srgbClr val="E7E6E6"/></a:lt2><a:accent1><a:srgbClr val="4472C4"/></a:accent1><a:accent2><a:srgbClr val="ED7D31"/></a:accent2><a:accent3><a:srgbClr val="A5A5A5"/></a:accent3><a:accent4><a:srgbClr val="FFC000"/></a:accent4><a:accent5><a:srgbClr val="5B9BD5"/></a:accent5><a:accent6><a:srgbClr val="70AD47"/></a:accent6><a:hlink><a:srgbClr val="0563C1"/></a:hlink><a:folHlink><a:srgbClr val="954F72"/></a:folHlink></a:clrScheme><a:fontScheme name="TaskWraith"><a:majorFont><a:latin typeface="Calibri Light"/><a:ea typeface=""/><a:cs typeface=""/></a:majorFont><a:minorFont><a:latin typeface="Calibri"/><a:ea typeface=""/><a:cs typeface=""/></a:minorFont></a:fontScheme><a:fmtScheme name="Office"><a:fillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:fillStyleLst><a:lnStyleLst><a:ln w="6350"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln><a:ln w="12700"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln><a:ln w="19050"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln></a:lnStyleLst><a:effectStyleLst><a:effectStyle><a:effectLst/></a:effectStyle><a:effectStyle><a:effectLst/></a:effectStyle><a:effectStyle><a:effectLst/></a:effectStyle></a:effectStyleLst><a:bgFillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:bgFillStyleLst></a:fmtScheme></a:themeElements></a:theme>`

const EMPTY_GRP_SP_PR =
  '<p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>'

const MASTER_XML = `${XML_DECL}<p:sldMaster xmlns:a="${A_NS}" xmlns:r="${R_NS}" xmlns:p="${P_NS}"><p:cSld><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>${EMPTY_GRP_SP_PR}</p:spTree></p:cSld><p:clrMap bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" accent1="accent1" accent2="accent2" accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" hlink="hlink" folHlink="folHlink"/><p:sldLayoutIdLst><p:sldLayoutId id="2147483649" r:id="rId1"/></p:sldLayoutIdLst><p:txStyles><p:titleStyle/><p:bodyStyle/><p:otherStyle/></p:txStyles></p:sldMaster>`

const MASTER_RELS = `${XML_DECL}<Relationships xmlns="${REL_PKG_NS}"><Relationship Id="rId1" Type="${REL_OD}/slideLayout" Target="../slideLayouts/slideLayout1.xml"/><Relationship Id="rId2" Type="${REL_OD}/theme" Target="../theme/theme1.xml"/></Relationships>`

const LAYOUT_XML = `${XML_DECL}<p:sldLayout xmlns:a="${A_NS}" xmlns:r="${R_NS}" xmlns:p="${P_NS}" type="txAndObj" preserve="1"><p:cSld name="Title and Content"><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>${EMPTY_GRP_SP_PR}<p:sp><p:nvSpPr><p:cNvPr id="2" name="Title 1"/><p:cNvSpPr><a:spLocks noGrp="1"/></p:cNvSpPr><p:nvPr><p:ph type="title"/></p:nvPr></p:nvSpPr><p:spPr><a:xfrm><a:off x="838200" y="365125"/><a:ext cx="10515600" cy="1325563"/></a:xfrm></p:spPr><p:txBody><a:bodyPr/><a:lstStyle/><a:p><a:endParaRPr/></a:p></p:txBody></p:sp><p:sp><p:nvSpPr><p:cNvPr id="3" name="Content 2"/><p:cNvSpPr><a:spLocks noGrp="1"/></p:cNvSpPr><p:nvPr><p:ph idx="1"/></p:nvPr></p:nvSpPr><p:spPr><a:xfrm><a:off x="838200" y="1825625"/><a:ext cx="10515600" cy="4351338"/></a:xfrm></p:spPr><p:txBody><a:bodyPr/><a:lstStyle/><a:p><a:endParaRPr/></a:p></p:txBody></p:sp></p:spTree></p:cSld><p:clrMapOvr><a:overrideClrMapping bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" accent1="accent1" accent2="accent2" accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" hlink="hlink" folHlink="folHlink"/></p:clrMapOvr></p:sldLayout>`

const LAYOUT_RELS = `${XML_DECL}<Relationships xmlns="${REL_PKG_NS}"><Relationship Id="rId1" Type="${REL_OD}/slideMaster" Target="../slideMasters/slideMaster1.xml"/></Relationships>`

const SLIDE_RELS = `${XML_DECL}<Relationships xmlns="${REL_PKG_NS}"><Relationship Id="rId1" Type="${REL_OD}/slideLayout" Target="../slideLayouts/slideLayout1.xml"/></Relationships>`

function slideTextParagraphs(slide: DeckSlide): string {
  if (slide.bullets.length === 0) return '<a:p><a:endParaRPr/></a:p>'
  return slide.bullets
    .map((bullet) => {
      const text = escapeXmlText(sanitizeXmlText(bullet.text))
      const level = bullet.level > 0 ? ` lvl="${Math.min(8, bullet.level)}"` : ''
      return `<a:p><a:pPr${level}><a:buFont typeface="Arial"/><a:buChar char="•"/></a:pPr><a:r><a:t>${text}</a:t></a:r></a:p>`
    })
    .join('')
}

function slideXml(slide: DeckSlide): string {
  const title = escapeXmlText(sanitizeXmlText(slide.title))
  return `${XML_DECL}<p:sld xmlns:a="${A_NS}" xmlns:r="${R_NS}" xmlns:p="${P_NS}"><p:cSld><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>${EMPTY_GRP_SP_PR}<p:sp><p:nvSpPr><p:cNvPr id="2" name="Title 1"/><p:cNvSpPr><a:spLocks noGrp="1"/></p:cNvSpPr><p:nvPr><p:ph type="title"/></p:nvPr></p:nvSpPr><p:spPr/><p:txBody><a:bodyPr/><a:lstStyle/><a:p><a:r><a:t>${title}</a:t></a:r></a:p></p:txBody></p:sp><p:sp><p:nvSpPr><p:cNvPr id="3" name="Content 2"/><p:cNvSpPr><a:spLocks noGrp="1"/></p:cNvSpPr><p:nvPr><p:ph idx="1"/></p:nvPr></p:nvSpPr><p:spPr/><p:txBody><a:bodyPr/><a:lstStyle/>${slideTextParagraphs(slide)}</p:txBody></p:sp></p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sld>`
}

export function buildPptx(model: DeckDocumentModel): PptxBuildResult {
  const warnings: string[] = []
  const slides = model.slides.length > 0 ? model.slides : [{ title: '', bullets: [], notes: '' }]
  if (slides.some((slide) => slide.notes.trim() !== '')) {
    warnings.push('Speaker notes are not written to .pptx yet — export Markdown to keep them.')
  }

  const slideOverrides = slides
    .map(
      (_, index) =>
        `<Override PartName="/ppt/slides/slide${index + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>`
    )
    .join('')
  const contentTypes = `${XML_DECL}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/><Override PartName="/ppt/slideMasters/slideMaster1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideMaster+xml"/><Override PartName="/ppt/slideLayouts/slideLayout1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideLayout+xml"/><Override PartName="/ppt/theme/theme1.xml" ContentType="application/vnd.openxmlformats-officedocument.theme+xml"/>${slideOverrides}</Types>`

  const rootRels = `${XML_DECL}<Relationships xmlns="${REL_PKG_NS}"><Relationship Id="rId1" Type="${REL_OD}/officeDocument" Target="ppt/presentation.xml"/></Relationships>`

  const slideIdEntries = slides
    .map((_, index) => `<p:sldId id="${256 + index}" r:id="rIdSlide${index + 1}"/>`)
    .join('')
  const presentationXml = `${XML_DECL}<p:presentation xmlns:a="${A_NS}" xmlns:r="${R_NS}" xmlns:p="${P_NS}"><p:sldMasterIdLst><p:sldMasterId id="2147483648" r:id="rIdMaster1"/></p:sldMasterIdLst><p:sldIdLst>${slideIdEntries}</p:sldIdLst><p:sldSz cx="12192000" cy="6858000"/><p:notesSz cx="6858000" cy="9144000"/></p:presentation>`

  const presentationRels = `${XML_DECL}<Relationships xmlns="${REL_PKG_NS}"><Relationship Id="rIdMaster1" Type="${REL_OD}/slideMaster" Target="slideMasters/slideMaster1.xml"/><Relationship Id="rIdTheme1" Type="${REL_OD}/theme" Target="theme/theme1.xml"/>${slides
    .map(
      (_, index) =>
        `<Relationship Id="rIdSlide${index + 1}" Type="${REL_OD}/slide" Target="slides/slide${index + 1}.xml"/>`
    )
    .join('')}</Relationships>`

  const data = buildZip([
    { name: '[Content_Types].xml', data: Buffer.from(contentTypes, 'utf8') },
    { name: '_rels/.rels', data: Buffer.from(rootRels, 'utf8') },
    { name: 'ppt/presentation.xml', data: Buffer.from(presentationXml, 'utf8') },
    { name: 'ppt/_rels/presentation.xml.rels', data: Buffer.from(presentationRels, 'utf8') },
    { name: 'ppt/slideMasters/slideMaster1.xml', data: Buffer.from(MASTER_XML, 'utf8') },
    {
      name: 'ppt/slideMasters/_rels/slideMaster1.xml.rels',
      data: Buffer.from(MASTER_RELS, 'utf8')
    },
    { name: 'ppt/slideLayouts/slideLayout1.xml', data: Buffer.from(LAYOUT_XML, 'utf8') },
    {
      name: 'ppt/slideLayouts/_rels/slideLayout1.xml.rels',
      data: Buffer.from(LAYOUT_RELS, 'utf8')
    },
    { name: 'ppt/theme/theme1.xml', data: Buffer.from(THEME_XML, 'utf8') },
    ...slides.flatMap((slide, index) => [
      { name: `ppt/slides/slide${index + 1}.xml`, data: Buffer.from(slideXml(slide), 'utf8') },
      { name: `ppt/slides/_rels/slide${index + 1}.xml.rels`, data: Buffer.from(SLIDE_RELS, 'utf8') }
    ])
  ])
  return { data, warnings }
}

// --- parse -------------------------------------------------------------------

function parseRels(entries: Map<string, Buffer>, relsPath: string): Map<string, string> {
  const map = new Map<string, string>()
  const entry = entries.get(relsPath)
  if (!entry) return map
  const root = parseMarkup(entry.toString('utf8'))
  for (const rel of descendantsByLocalName(root, 'Relationship')) {
    const id = attrByLocalName(rel, 'Id')
    const target = attrByLocalName(rel, 'Target')
    if (id && target) map.set(id, target)
  }
  return map
}

const resolveTarget = (baseDir: string, target: string): string => {
  if (target.startsWith('/')) return target.slice(1)
  const segments = `${baseDir}/${target}`.split('/')
  const resolved: string[] = []
  for (const segment of segments) {
    if (segment === '' || segment === '.') continue
    if (segment === '..') resolved.pop()
    else resolved.push(segment)
  }
  return resolved.join('/')
}

function placeholderType(shape: XmlNode): string | undefined {
  const ph = firstDescendantByLocalName(shape, 'ph')
  return ph ? attrByLocalName(ph, 'type') : undefined
}

function shapeParagraphs(shape: XmlNode): { text: string; level: number }[] {
  const body = firstDescendantByLocalName(shape, 'txBody')
  if (!body) return []
  const paragraphs: { text: string; level: number }[] = []
  for (const paragraph of body.children.filter((child) => localName(child.tag) === 'p')) {
    let text = ''
    for (const child of paragraph.children) {
      const tag = localName(child.tag)
      if (tag === 'r') {
        const t = childByLocalName(child, 't')
        if (t) text += t.text
      } else if (tag === 'br') {
        text += '\n'
      } else if (tag === 'fld') {
        const t = childByLocalName(child, 't')
        if (t) text += t.text
      }
    }
    const props = childByLocalName(paragraph, 'pPr')
    const levelAttr = props ? attrByLocalName(props, 'lvl') : undefined
    const level = levelAttr ? Number.parseInt(levelAttr, 10) : 0
    paragraphs.push({ text, level: Number.isFinite(level) ? Math.min(8, Math.max(0, level)) : 0 })
  }
  return paragraphs
}

export function parsePptx(archive: Buffer): PptxParseResult {
  let entries: Map<string, Buffer>
  try {
    entries = parseZip(archive)
  } catch (error) {
    if (error instanceof ZipArchiveError) {
      throw new OfficeCodecError(`Not a valid .pptx file: ${error.message}`)
    }
    throw error
  }
  const presentationEntry = entries.get('ppt/presentation.xml')
  if (!presentationEntry) {
    throw new OfficeCodecError('Not a valid .pptx file: ppt/presentation.xml is missing.')
  }

  const warnings: string[] = []
  const presentationRels = parseRels(entries, 'ppt/_rels/presentation.xml.rels')
  const presentationRoot = parseMarkup(presentationEntry.toString('utf8'))
  const slideIds = descendantsByLocalName(presentationRoot, 'sldId')

  const slidePaths: string[] = []
  for (const slideId of slideIds) {
    const relId =
      attrByLocalName(slideId, 'id') === undefined ? undefined : attrByLocalName(slideId, 'id')
    // r:id lives in the relationship namespace; attrByLocalName('id') may hit
    // the numeric slide id first, so look up both attribute spellings.
    const rid = slideId.attrs['r:id'] ?? relId
    const target = rid ? presentationRels.get(rid) : undefined
    if (target) slidePaths.push(resolveTarget('ppt', target))
  }
  if (slidePaths.length === 0) {
    // Fallback: enumerate slide parts in name order.
    for (const name of [...entries.keys()].sort()) {
      if (/^ppt\/slides\/slide\d+\.xml$/.test(name)) slidePaths.push(name)
    }
  }

  const slides: DeckSlide[] = []
  for (const slidePath of slidePaths.slice(0, OFFICE_MODEL_LIMITS.maxDeckSlides)) {
    const slideEntry = entries.get(slidePath)
    if (!slideEntry) {
      warnings.push(`Slide part ${slidePath} is missing and was skipped.`)
      continue
    }
    const slideRoot = parseMarkup(slideEntry.toString('utf8'))
    const shapes = descendantsByLocalName(slideRoot, 'sp')
    let title = ''
    const bullets: { text: string; level: number }[] = []
    for (const shape of shapes) {
      const type = placeholderType(shape)
      const paragraphs = shapeParagraphs(shape)
      if (type === 'title' || type === 'ctrTitle') {
        title = paragraphs
          .map((paragraph) => paragraph.text)
          .join(' ')
          .trim()
      } else {
        for (const paragraph of paragraphs) {
          if (paragraph.text.trim() === '') continue
          bullets.push({ text: paragraph.text, level: paragraph.level })
        }
      }
    }
    if (descendantsByLocalName(slideRoot, 'graphicFrame').length > 0) {
      warnings.push(`Tables/charts on ${slidePath.split('/').pop()} are not imported.`)
    }

    // Speaker notes, when the slide references a notesSlide part.
    let notes = ''
    const slideRelsPath = slidePath.replace(/slides\/(slide\d+\.xml)$/, 'slides/_rels/$1.rels')
    const slideRels = parseRels(entries, slideRelsPath)
    for (const target of slideRels.values()) {
      if (!target.includes('notesSlide')) continue
      const notesEntry = entries.get(resolveTarget('ppt/slides', target))
      if (!notesEntry) continue
      const notesRoot = parseMarkup(notesEntry.toString('utf8'))
      const noteShapes = descendantsByLocalName(notesRoot, 'sp')
      const noteLines: string[] = []
      for (const shape of noteShapes) {
        if (placeholderType(shape) !== 'body') continue
        for (const paragraph of shapeParagraphs(shape)) {
          if (paragraph.text.trim() !== '') noteLines.push(paragraph.text)
        }
      }
      notes = noteLines.join('\n')
    }

    slides.push({ title, bullets, notes })
  }

  if (slidePaths.length > OFFICE_MODEL_LIMITS.maxDeckSlides) {
    warnings.push(`Deck truncated to the first ${OFFICE_MODEL_LIMITS.maxDeckSlides} slides.`)
  }
  if (slides.length === 0) slides.push({ title: '', bullets: [], notes: '' })

  return { model: { kind: 'deck', slides }, warnings }
}
