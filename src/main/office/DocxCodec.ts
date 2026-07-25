/**
 * WordprocessingML (.docx) codec. Builds a minimal-but-valid package (Word,
 * Pages, LibreOffice and Google Docs import it) and parses the structures
 * Word/Google actually emit: styled runs, heading styles, numbered/bullet
 * lists, hyperlinks, tables, content controls (w:sdt) and tracked
 * insertions (w:ins). Unknown constructs degrade to plain text.
 */

import type {
  WordBlock,
  WordDocumentModel,
  WordImage,
  WordRun
} from '../../shared/office/officeModels'
import { OFFICE_MODEL_LIMITS } from '../../shared/office/officeModels'
import {
  EMU_PER_PIXEL,
  parseRasterDataUri,
  rasterDataUriFromBytes
} from '../../shared/office/officeImages'
import {
  attrByLocalName,
  childByLocalName,
  childrenByLocalName,
  escapeXmlAttr,
  escapeXmlText,
  firstDescendantByLocalName,
  localName,
  parseMarkup,
  sanitizeXmlText,
  type XmlNode
} from '../../shared/office/xmlLite'
import { buildZip, parseZip, ZipArchiveError } from './ZipArchive'

export class OfficeCodecError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'OfficeCodecError'
  }
}

export interface DocxParseResult {
  model: WordDocumentModel
  warnings: string[]
}

// --- build -------------------------------------------------------------------

const XML_DECL = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\r\n'
const W_NS = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main'
const R_NS = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'
const REL_PKG_NS = 'http://schemas.openxmlformats.org/package/2006/relationships'
const WP_NS = 'http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing'
const A_NS = 'http://schemas.openxmlformats.org/drawingml/2006/main'
const PIC_NS = 'http://schemas.openxmlformats.org/drawingml/2006/picture'

const contentTypesXml = (imageExtensions: ReadonlySet<string>): string => {
  const imageDefaults = [...imageExtensions]
    .sort()
    .map((extension) => {
      const mime =
        extension === 'png' ? 'image/png' : extension === 'gif' ? 'image/gif' : 'image/jpeg'
      return `<Default Extension="${extension}" ContentType="${mime}"/>`
    })
    .join('')
  return `${XML_DECL}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>${imageDefaults}<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/><Override PartName="/word/numbering.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml"/></Types>`
}

const ROOT_RELS = `${XML_DECL}<Relationships xmlns="${REL_PKG_NS}"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`

const STYLES_XML = `${XML_DECL}<w:styles xmlns:w="${W_NS}"><w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Calibri" w:hAnsi="Calibri"/><w:sz w:val="22"/></w:rPr></w:rPrDefault></w:docDefaults><w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style><w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:basedOn w:val="Normal"/><w:pPr><w:keepNext/><w:spacing w:before="240" w:after="120"/><w:outlineLvl w:val="0"/></w:pPr><w:rPr><w:b/><w:sz w:val="32"/></w:rPr></w:style><w:style w:type="paragraph" w:styleId="Heading2"><w:name w:val="heading 2"/><w:basedOn w:val="Normal"/><w:pPr><w:keepNext/><w:spacing w:before="200" w:after="100"/><w:outlineLvl w:val="1"/></w:pPr><w:rPr><w:b/><w:sz w:val="26"/></w:rPr></w:style><w:style w:type="paragraph" w:styleId="Heading3"><w:name w:val="heading 3"/><w:basedOn w:val="Normal"/><w:pPr><w:keepNext/><w:spacing w:before="160" w:after="80"/><w:outlineLvl w:val="2"/></w:pPr><w:rPr><w:b/><w:sz w:val="24"/></w:rPr></w:style></w:styles>`

const BULLET_CHARS = ['•', '◦', '▪']

function numberingXml(): string {
  const bulletLevels = Array.from({ length: 9 }, (_, level) => {
    const char = BULLET_CHARS[level % BULLET_CHARS.length]
    return `<w:lvl w:ilvl="${level}"><w:start w:val="1"/><w:numFmt w:val="bullet"/><w:lvlText w:val="${char}"/><w:lvlJc w:val="left"/><w:pPr><w:ind w:left="${720 * (level + 1)}" w:hanging="360"/></w:pPr></w:lvl>`
  }).join('')
  const decimalLevels = Array.from({ length: 9 }, (_, level) => {
    return `<w:lvl w:ilvl="${level}"><w:start w:val="1"/><w:numFmt w:val="decimal"/><w:lvlText w:val="%${level + 1}."/><w:lvlJc w:val="left"/><w:pPr><w:ind w:left="${720 * (level + 1)}" w:hanging="360"/></w:pPr></w:lvl>`
  }).join('')
  return `${XML_DECL}<w:numbering xmlns:w="${W_NS}"><w:abstractNum w:abstractNumId="0">${bulletLevels}</w:abstractNum><w:abstractNum w:abstractNumId="1">${decimalLevels}</w:abstractNum><w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num><w:num w:numId="2"><w:abstractNumId w:val="1"/></w:num></w:numbering>`
}

interface HyperlinkRegistry {
  idsByUrl: Map<string, string>
}

interface MediaRegistry {
  entries: { relId: string; partName: string; data: Buffer }[]
}

function imageBlockXml(image: WordImage, media: MediaRegistry): string {
  const parsed = parseRasterDataUri(image.dataUri, OFFICE_MODEL_LIMITS.maxImageBytes)
  if (!parsed) return ''
  const ordinal = media.entries.length + 1
  const relId = `rIdImage${ordinal}`
  const partName = `media/image${ordinal}.${parsed.info.extension}`
  media.entries.push({ relId, partName, data: Buffer.from(parsed.bytes) })

  const widthPx = image.widthPx ?? parsed.info.widthPx ?? 480
  const heightPx = image.heightPx ?? parsed.info.heightPx ?? 360
  const cx = Math.max(1, Math.round(widthPx * EMU_PER_PIXEL))
  const cy = Math.max(1, Math.round(heightPx * EMU_PER_PIXEL))
  const name = escapeXmlAttr(image.name)

  return (
    `<w:p><w:r><w:drawing>` +
    `<wp:inline distT="0" distB="0" distL="0" distR="0">` +
    `<wp:extent cx="${cx}" cy="${cy}"/>` +
    `<wp:docPr id="${ordinal}" name="${name}"/>` +
    `<a:graphic><a:graphicData uri="${PIC_NS}">` +
    `<pic:pic>` +
    `<pic:nvPicPr><pic:cNvPr id="${ordinal}" name="${name}"/><pic:cNvPicPr/></pic:nvPicPr>` +
    `<pic:blipFill><a:blip r:embed="${relId}"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill>` +
    `<pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm>` +
    `<a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr>` +
    `</pic:pic>` +
    `</a:graphicData></a:graphic>` +
    `</wp:inline></w:drawing></w:r></w:p>`
  )
}

function runPropertiesXml(run: WordRun, inHyperlink: boolean): string {
  const props: string[] = []
  if (run.bold) props.push('<w:b/>')
  if (run.italic) props.push('<w:i/>')
  if (run.strike) props.push('<w:strike/>')
  if (run.underline || inHyperlink) props.push('<w:u w:val="single"/>')
  if (run.code) props.push('<w:rFonts w:ascii="Consolas" w:hAnsi="Consolas"/>')
  if (inHyperlink) props.push('<w:color w:val="0563C1"/>')
  return props.length > 0 ? `<w:rPr>${props.join('')}</w:rPr>` : ''
}

function runXml(run: WordRun, inHyperlink: boolean): string {
  const segments = sanitizeXmlText(run.text).split('\n')
  const pieces = segments.map(
    (segment) => `<w:t xml:space="preserve">${escapeXmlText(segment)}</w:t>`
  )
  const body = pieces.join('<w:br/>')
  return `<w:r>${runPropertiesXml(run, inHyperlink)}${body}</w:r>`
}

function runsXml(runs: WordRun[], links: HyperlinkRegistry): string {
  const parts: string[] = []
  for (const run of runs) {
    if (run.link) {
      let relId = links.idsByUrl.get(run.link)
      if (!relId) {
        relId = `rIdLink${links.idsByUrl.size + 1}`
        links.idsByUrl.set(run.link, relId)
      }
      parts.push(`<w:hyperlink r:id="${relId}">${runXml(run, true)}</w:hyperlink>`)
    } else {
      parts.push(runXml(run, false))
    }
  }
  return parts.join('')
}

function paragraphXml(block: WordBlock, links: HyperlinkRegistry, media: MediaRegistry): string {
  switch (block.type) {
    case 'image':
      return imageBlockXml(block.image, media)
    case 'heading':
      return `<w:p><w:pPr><w:pStyle w:val="Heading${block.level}"/></w:pPr>${runsXml(block.runs, links)}</w:p>`
    case 'list-item': {
      const numId = block.ordered ? 2 : 1
      return `<w:p><w:pPr><w:numPr><w:ilvl w:val="${block.level}"/><w:numId w:val="${numId}"/></w:numPr></w:pPr>${runsXml(block.runs, links)}</w:p>`
    }
    case 'table': {
      const columnCount = Math.max(1, ...block.rows.map((row) => row.length))
      const grid = Array.from({ length: columnCount }, () => '<w:gridCol w:w="2400"/>').join('')
      const rows = block.rows
        .map((row) => {
          const cells: string[] = []
          for (let index = 0; index < columnCount; index += 1) {
            const cellRuns = row[index] ?? []
            cells.push(
              `<w:tc><w:tcPr><w:tcW w:w="0" w:type="auto"/></w:tcPr><w:p>${runsXml(cellRuns, links)}</w:p></w:tc>`
            )
          }
          return `<w:tr>${cells.join('')}</w:tr>`
        })
        .join('')
      const borders =
        '<w:tblBorders><w:top w:val="single" w:sz="4" w:color="999999"/><w:left w:val="single" w:sz="4" w:color="999999"/><w:bottom w:val="single" w:sz="4" w:color="999999"/><w:right w:val="single" w:sz="4" w:color="999999"/><w:insideH w:val="single" w:sz="4" w:color="999999"/><w:insideV w:val="single" w:sz="4" w:color="999999"/></w:tblBorders>'
      return `<w:tbl><w:tblPr><w:tblW w:w="0" w:type="auto"/>${borders}</w:tblPr><w:tblGrid>${grid}</w:tblGrid>${rows}</w:tbl>`
    }
    default:
      return `<w:p>${runsXml(block.runs, links)}</w:p>`
  }
}

export function buildDocx(model: WordDocumentModel): Buffer {
  const links: HyperlinkRegistry = { idsByUrl: new Map() }
  const media: MediaRegistry = { entries: [] }
  const bodyXml = model.blocks.map((block) => paragraphXml(block, links, media)).join('')
  const sectPr =
    '<w:sectPr><w:pgSz w:w="12240" w:h="15840"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440"/></w:sectPr>'
  const documentXml = `${XML_DECL}<w:document xmlns:w="${W_NS}" xmlns:r="${R_NS}" xmlns:wp="${WP_NS}" xmlns:a="${A_NS}" xmlns:pic="${PIC_NS}"><w:body>${bodyXml}${sectPr}</w:body></w:document>`

  const linkRels = [...links.idsByUrl.entries()]
    .map(
      ([url, id]) =>
        `<Relationship Id="${id}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="${escapeXmlAttr(url)}" TargetMode="External"/>`
    )
    .join('')
  const mediaRels = media.entries
    .map(
      (entry) =>
        `<Relationship Id="${entry.relId}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="${entry.partName}"/>`
    )
    .join('')
  const documentRels = `${XML_DECL}<Relationships xmlns="${REL_PKG_NS}"><Relationship Id="rIdStyles" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/><Relationship Id="rIdNumbering" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/numbering" Target="numbering.xml"/>${linkRels}${mediaRels}</Relationships>`

  const imageExtensions = new Set(
    media.entries.map((entry) => entry.partName.slice(entry.partName.lastIndexOf('.') + 1))
  )

  return buildZip([
    { name: '[Content_Types].xml', data: Buffer.from(contentTypesXml(imageExtensions), 'utf8') },
    { name: '_rels/.rels', data: Buffer.from(ROOT_RELS, 'utf8') },
    { name: 'word/document.xml', data: Buffer.from(documentXml, 'utf8') },
    { name: 'word/_rels/document.xml.rels', data: Buffer.from(documentRels, 'utf8') },
    { name: 'word/styles.xml', data: Buffer.from(STYLES_XML, 'utf8') },
    { name: 'word/numbering.xml', data: Buffer.from(numberingXml(), 'utf8') },
    ...media.entries.map((entry) => ({ name: `word/${entry.partName}`, data: entry.data }))
  ])
}

// --- parse -------------------------------------------------------------------

function parseRelationships(entries: Map<string, Buffer>, partPath: string): Map<string, string> {
  const targets = new Map<string, string>()
  const relsEntry = entries.get(partPath)
  if (!relsEntry) return targets
  const root = parseMarkup(relsEntry.toString('utf8'))
  for (const rel of descendants(root, 'Relationship')) {
    const id = attrByLocalName(rel, 'Id')
    const target = attrByLocalName(rel, 'Target')
    if (id && target) targets.set(id, target)
  }
  return targets
}

function descendants(node: XmlNode, name: string): XmlNode[] {
  const found: XmlNode[] = []
  const walk = (current: XmlNode): void => {
    for (const child of current.children) {
      if (localName(child.tag) === name) found.push(child)
      walk(child)
    }
  }
  walk(node)
  return found
}

/** numId → ordered? map derived from numbering.xml (first level's numFmt). */
function parseNumberingKinds(entries: Map<string, Buffer>): Map<string, boolean> {
  const ordered = new Map<string, boolean>()
  const numberingEntry = entries.get('word/numbering.xml')
  if (!numberingEntry) return ordered
  const root = parseMarkup(numberingEntry.toString('utf8'))
  const abstractKinds = new Map<string, boolean>()
  for (const abstract of descendants(root, 'abstractNum')) {
    const id = attrByLocalName(abstract, 'abstractNumId')
    if (id === undefined) continue
    const firstLevel = childrenByLocalName(abstract, 'lvl')[0]
    const numFmt = firstLevel ? childByLocalName(firstLevel, 'numFmt') : undefined
    const format = numFmt ? attrByLocalName(numFmt, 'val') : undefined
    abstractKinds.set(id, format !== undefined && format !== 'bullet' && format !== 'none')
  }
  for (const num of descendants(root, 'num')) {
    const numId = attrByLocalName(num, 'numId')
    const abstractRef = childByLocalName(num, 'abstractNumId')
    const abstractId = abstractRef ? attrByLocalName(abstractRef, 'val') : undefined
    if (numId !== undefined && abstractId !== undefined) {
      ordered.set(numId, abstractKinds.get(abstractId) ?? false)
    }
  }
  return ordered
}

interface DocxRunContext {
  rels: Map<string, string>
  entries: Map<string, Buffer>
  warnings: string[]
  imageOrdinal: number
  /** Data URIs are encoded once per media part; repeats share the string. */
  imageDataUriByTarget: Map<string, string | null>
  totalImageBytes: number
  skippedNonRasterImages: number
  skippedOverBudgetImages: number
  skippedDrawingsWithoutImage: number
}

function resolveWordPartTarget(target: string): string {
  if (target.startsWith('/')) return target.slice(1)
  const segments = `word/${target}`.split('/')
  const resolved: string[] = []
  for (const segment of segments) {
    if (segment === '' || segment === '.') continue
    if (segment === '..') resolved.pop()
    else resolved.push(segment)
  }
  return resolved.join('/')
}

/**
 * Images referenced by a paragraph's drawings, converted to data URIs.
 * Bounded on three axes — per-image bytes, total document image count, and
 * cumulative decoded bytes — because a tiny DEFLATE archive can reference
 * one media part from thousands of paragraphs; each part is also encoded
 * exactly once, with repeats sharing the same string.
 */
function extractParagraphImages(node: XmlNode, context: DocxRunContext): WordImage[] {
  const images: WordImage[] = []
  for (const drawing of descendants(node, 'drawing')) {
    const blips = descendants(drawing, 'blip')
    if (blips.length === 0) {
      context.skippedDrawingsWithoutImage += 1
      continue
    }
    for (const blip of blips) {
      if (context.imageOrdinal >= OFFICE_MODEL_LIMITS.maxWordImages) {
        context.skippedOverBudgetImages += 1
        continue
      }
      const relId = attrByLocalName(blip, 'embed')
      const target = relId ? context.rels.get(relId) : undefined
      const partName = target ? resolveWordPartTarget(target) : undefined
      if (!partName) {
        context.skippedNonRasterImages += 1
        continue
      }
      let dataUri = context.imageDataUriByTarget.get(partName)
      if (dataUri === undefined) {
        const bytes = context.entries.get(partName)
        if (!bytes || bytes.length > OFFICE_MODEL_LIMITS.maxImageBytes) {
          context.imageDataUriByTarget.set(partName, null)
          context.skippedNonRasterImages += 1
          continue
        }
        if (context.totalImageBytes + bytes.length > OFFICE_MODEL_LIMITS.maxWordImageTotalBytes) {
          // Budget-dependent: do NOT cache, so an already-encoded part can
          // still be reused below while fresh parts stay skipped.
          context.skippedOverBudgetImages += 1
          continue
        }
        dataUri = rasterDataUriFromBytes(Uint8Array.from(bytes))
        context.imageDataUriByTarget.set(partName, dataUri)
        if (dataUri === null) {
          context.skippedNonRasterImages += 1
          continue
        }
        context.totalImageBytes += bytes.length
      } else if (dataUri === null) {
        context.skippedNonRasterImages += 1
        continue
      }
      context.imageOrdinal += 1
      const extent = firstDescendantByLocalName(drawing, 'extent')
      const cx = extent ? Number.parseInt(attrByLocalName(extent, 'cx') ?? '', 10) : Number.NaN
      const cy = extent ? Number.parseInt(attrByLocalName(extent, 'cy') ?? '', 10) : Number.NaN
      const docPr = firstDescendantByLocalName(drawing, 'docPr')
      const name =
        (docPr ? attrByLocalName(docPr, 'name') : undefined)?.trim() ||
        `image-${context.imageOrdinal}`
      const image: WordImage = { dataUri, name }
      if (Number.isFinite(cx) && cx > 0) image.widthPx = Math.max(1, Math.round(cx / EMU_PER_PIXEL))
      if (Number.isFinite(cy) && cy > 0)
        image.heightPx = Math.max(1, Math.round(cy / EMU_PER_PIXEL))
      images.push(image)
    }
  }
  return images
}

function flagEnabled(properties: XmlNode | undefined, name: string): boolean {
  if (!properties) return false
  const flag = childByLocalName(properties, name)
  if (!flag) return false
  const value = attrByLocalName(flag, 'val')
  return value === undefined || !['0', 'false', 'none'].includes(value.toLowerCase())
}

function appendDocxRun(runs: WordRun[], node: XmlNode, link: string | undefined): void {
  const properties = childByLocalName(node, 'rPr')
  let text = ''
  for (const child of node.children) {
    switch (localName(child.tag)) {
      case 't':
        text += child.text
        break
      case 'br':
      case 'cr':
        text += '\n'
        break
      case 'tab':
        text += '\t'
        break
      default:
        break
    }
  }
  if (text === '') return
  const run: WordRun = { text }
  if (flagEnabled(properties, 'b')) run.bold = true
  if (flagEnabled(properties, 'i')) run.italic = true
  if (flagEnabled(properties, 'strike')) run.strike = true
  const underline = properties ? childByLocalName(properties, 'u') : undefined
  if (underline && (attrByLocalName(underline, 'val') ?? 'single') !== 'none' && !link) {
    run.underline = true
  }
  const fonts = properties ? childByLocalName(properties, 'rFonts') : undefined
  const ascii = fonts ? attrByLocalName(fonts, 'ascii') : undefined
  if (ascii && /consolas|courier|mono/i.test(ascii)) run.code = true
  if (link) run.link = link
  runs.push(run)
}

function collectParagraphRuns(
  node: XmlNode,
  context: DocxRunContext,
  runs: WordRun[],
  link?: string
): void {
  for (const child of node.children) {
    const tag = localName(child.tag)
    if (tag === 'r') {
      appendDocxRun(runs, child, link)
    } else if (tag === 'hyperlink') {
      const relId = attrByLocalName(child, 'id')
      const target = relId ? context.rels.get(relId) : undefined
      const url = target && /^https?:\/\//i.test(target) ? target : undefined
      collectParagraphRuns(child, context, runs, url ?? link)
    } else if (tag === 'ins' || tag === 'sdtContent' || tag === 'smartTag') {
      collectParagraphRuns(child, context, runs, link)
    } else if (tag === 'sdt') {
      const content = childByLocalName(child, 'sdtContent')
      if (content) collectParagraphRuns(content, context, runs, link)
    }
    // w:del (tracked deletions) intentionally skipped.
  }
}

function paragraphToBlock(
  node: XmlNode,
  context: DocxRunContext,
  numberingKinds: Map<string, boolean>
): WordBlock {
  const properties = childByLocalName(node, 'pPr')
  const runs: WordRun[] = []
  collectParagraphRuns(node, context, runs)

  if (properties) {
    const style = childByLocalName(properties, 'pStyle')
    const styleId = style ? (attrByLocalName(style, 'val') ?? '') : ''
    const headingMatch = /^Heading(\d)$/i.exec(styleId)
    if (headingMatch || styleId === 'Title') {
      const rawLevel = headingMatch ? Number.parseInt(headingMatch[1], 10) : 1
      const level = Math.min(3, Math.max(1, rawLevel)) as 1 | 2 | 3
      return { type: 'heading', level, runs }
    }
    const numbering = childByLocalName(properties, 'numPr')
    if (numbering) {
      const levelNode = childByLocalName(numbering, 'ilvl')
      const idNode = childByLocalName(numbering, 'numId')
      const level = levelNode ? Number.parseInt(attrByLocalName(levelNode, 'val') ?? '0', 10) : 0
      const numId = idNode ? (attrByLocalName(idNode, 'val') ?? '') : ''
      return {
        type: 'list-item',
        ordered: numberingKinds.get(numId) ?? false,
        level: Math.min(8, Math.max(0, Number.isFinite(level) ? level : 0)),
        runs
      }
    }
  }
  return { type: 'paragraph', runs }
}

function tableToBlock(
  node: XmlNode,
  context: DocxRunContext,
  numberingKinds: Map<string, boolean>
): WordBlock {
  const rows: WordRun[][][] = []
  for (const rowNode of childrenByLocalName(node, 'tr')) {
    const cells: WordRun[][] = []
    for (const cellNode of childrenByLocalName(rowNode, 'tc')) {
      const cellRuns: WordRun[] = []
      const paragraphs = childrenByLocalName(cellNode, 'p')
      paragraphs.forEach((paragraph, index) => {
        const block = paragraphToBlock(paragraph, context, numberingKinds)
        if (index > 0) cellRuns.push({ text: '\n' })
        if (!('runs' in block)) return
        cellRuns.push(...block.runs)
      })
      cells.push(cellRuns)
    }
    rows.push(cells)
  }
  return { type: 'table', rows }
}

export function parseDocx(archive: Buffer): DocxParseResult {
  let entries: Map<string, Buffer>
  try {
    entries = parseZip(archive)
  } catch (error) {
    if (error instanceof ZipArchiveError) {
      throw new OfficeCodecError(`Not a valid .docx file: ${error.message}`)
    }
    throw error
  }
  const documentEntry = entries.get('word/document.xml')
  if (!documentEntry) {
    throw new OfficeCodecError('Not a valid .docx file: word/document.xml is missing.')
  }

  const warnings: string[] = []
  const context: DocxRunContext = {
    rels: parseRelationships(entries, 'word/_rels/document.xml.rels'),
    entries,
    warnings,
    imageOrdinal: 0,
    imageDataUriByTarget: new Map(),
    totalImageBytes: 0,
    skippedNonRasterImages: 0,
    skippedOverBudgetImages: 0,
    skippedDrawingsWithoutImage: 0
  }
  const numberingKinds = parseNumberingKinds(entries)
  const root = parseMarkup(documentEntry.toString('utf8'))
  const document = childByLocalName(root, 'document')
  const body = document ? childByLocalName(document, 'body') : undefined
  if (!body) {
    throw new OfficeCodecError('Not a valid .docx file: document body is missing.')
  }

  const blocks: WordBlock[] = []
  let truncated = false
  const visitBodyChildren = (parent: XmlNode): void => {
    for (const child of parent.children) {
      if (blocks.length >= OFFICE_MODEL_LIMITS.maxWordBlocks) {
        truncated = true
        return
      }
      const tag = localName(child.tag)
      if (tag === 'p') {
        const block = paragraphToBlock(child, context, numberingKinds)
        const images = extractParagraphImages(child, context)
        // A paragraph that only hosted a drawing becomes pure image blocks;
        // mixed paragraphs keep their text followed by the images.
        const hasText = !('runs' in block) || block.runs.some((run) => run.text.trim() !== '')
        if (hasText || images.length === 0) blocks.push(block)
        for (const image of images) blocks.push({ type: 'image', image })
      } else if (tag === 'tbl') {
        blocks.push(tableToBlock(child, context, numberingKinds))
      } else if (tag === 'sdt') {
        const content = childByLocalName(child, 'sdtContent')
        if (content) visitBodyChildren(content)
      }
      // sectPr, bookmarks, etc. carry no text content.
    }
  }
  visitBodyChildren(body)
  if (truncated) warnings.push('Document truncated: too many blocks for the editor.')
  if (context.skippedNonRasterImages > 0) {
    warnings.push(
      `${context.skippedNonRasterImages} embedded image${
        context.skippedNonRasterImages === 1 ? '' : 's'
      } in unsupported formats (EMF/WMF/TIFF…) were skipped.`
    )
  }
  if (context.skippedOverBudgetImages > 0) {
    warnings.push(
      `${context.skippedOverBudgetImages} image reference${
        context.skippedOverBudgetImages === 1 ? '' : 's'
      } beyond the editor's image budget (${OFFICE_MODEL_LIMITS.maxWordImages} images / ` +
        `${Math.round(OFFICE_MODEL_LIMITS.maxWordImageTotalBytes / 1_000_000)} MB) were skipped.`
    )
  }
  if (context.skippedDrawingsWithoutImage > 0) {
    warnings.push('Shapes and charts are not imported.')
  }

  return { model: { kind: 'word', blocks }, warnings }
}
