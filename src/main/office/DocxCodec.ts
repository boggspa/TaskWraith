/**
 * WordprocessingML (.docx) codec. Builds a minimal-but-valid package (Word,
 * Pages, LibreOffice and Google Docs import it) and parses the structures
 * Word/Google actually emit: styled runs, heading styles, numbered/bullet
 * lists, hyperlinks, tables, content controls (w:sdt) and tracked
 * insertions (w:ins). Unknown constructs degrade to plain text.
 */

import type { WordBlock, WordDocumentModel, WordRun } from '../../shared/office/officeModels'
import { OFFICE_MODEL_LIMITS } from '../../shared/office/officeModels'
import {
  attrByLocalName,
  childByLocalName,
  childrenByLocalName,
  escapeXmlAttr,
  escapeXmlText,
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

const CONTENT_TYPES = `${XML_DECL}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/><Override PartName="/word/numbering.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml"/></Types>`

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

function paragraphXml(block: WordBlock, links: HyperlinkRegistry): string {
  switch (block.type) {
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
  const bodyXml = model.blocks.map((block) => paragraphXml(block, links)).join('')
  const sectPr =
    '<w:sectPr><w:pgSz w:w="12240" w:h="15840"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440"/></w:sectPr>'
  const documentXml = `${XML_DECL}<w:document xmlns:w="${W_NS}" xmlns:r="${R_NS}"><w:body>${bodyXml}${sectPr}</w:body></w:document>`

  const linkRels = [...links.idsByUrl.entries()]
    .map(
      ([url, id]) =>
        `<Relationship Id="${id}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="${escapeXmlAttr(url)}" TargetMode="External"/>`
    )
    .join('')
  const documentRels = `${XML_DECL}<Relationships xmlns="${REL_PKG_NS}"><Relationship Id="rIdStyles" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/><Relationship Id="rIdNumbering" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/numbering" Target="numbering.xml"/>${linkRels}</Relationships>`

  return buildZip([
    { name: '[Content_Types].xml', data: Buffer.from(CONTENT_TYPES, 'utf8') },
    { name: '_rels/.rels', data: Buffer.from(ROOT_RELS, 'utf8') },
    { name: 'word/document.xml', data: Buffer.from(documentXml, 'utf8') },
    { name: 'word/_rels/document.xml.rels', data: Buffer.from(documentRels, 'utf8') },
    { name: 'word/styles.xml', data: Buffer.from(STYLES_XML, 'utf8') },
    { name: 'word/numbering.xml', data: Buffer.from(numberingXml(), 'utf8') }
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
  warnings: string[]
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
        if (block.type === 'table') return
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
    warnings
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
        blocks.push(paragraphToBlock(child, context, numberingKinds))
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

  const hasDrawings = documentEntry.includes('<w:drawing>') || documentEntry.includes('<pic:pic')
  if (hasDrawings) warnings.push('Images and drawings are not imported.')

  return { model: { kind: 'word', blocks }, warnings }
}
