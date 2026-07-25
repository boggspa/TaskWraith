/**
 * SpreadsheetML (.xlsx) codec. Writes inline-string workbooks with cached
 * formula values (no sharedStrings part needed on output); reads the cell
 * types Excel/Google actually emit: shared strings (incl. rich-text runs),
 * inline strings, cached formula strings, booleans, errors and numbers.
 * Formulas are preferred over their cached values on import so edits keep
 * recalculating.
 */

import type { SheetDocumentModel, SheetGrid } from '../../shared/office/officeModels'
import { OFFICE_MODEL_LIMITS } from '../../shared/office/officeModels'
import {
  columnIndex,
  columnLabel,
  createSheetEvaluator,
  type SheetEvaluator
} from '../../shared/office/sheetFormula'
import {
  attrByLocalName,
  childByLocalName,
  childrenByLocalName,
  deepText,
  descendantsByLocalName,
  escapeXmlAttr,
  escapeXmlText,
  firstDescendantByLocalName,
  parseMarkup,
  sanitizeXmlText
} from '../../shared/office/xmlLite'
import { OfficeCodecError } from './DocxCodec'
import { buildZip, parseZip, ZipArchiveError } from './ZipArchive'

export interface XlsxParseResult {
  model: SheetDocumentModel
  warnings: string[]
}

const XML_DECL = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\r\n'
const MAIN_NS = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main'
const R_NS = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'
const REL_PKG_NS = 'http://schemas.openxmlformats.org/package/2006/relationships'

// --- build -------------------------------------------------------------------

const STYLES_XML = `${XML_DECL}<styleSheet xmlns="${MAIN_NS}"><fonts count="1"><font><sz val="11"/><name val="Calibri"/></font></fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills><borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/></cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>`

const isNumericLiteral = (value: string): boolean =>
  /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(value.trim()) && value.trim() !== ''

function cellXml(
  rows: string[][],
  rowIndex: number,
  colIndex: number,
  evaluator: SheetEvaluator
): string {
  const raw = rows[rowIndex]?.[colIndex] ?? ''
  if (raw === '') return ''
  const ref = `${columnLabel(colIndex)}${rowIndex + 1}`
  if (raw.startsWith('=')) {
    const formula = escapeXmlText(sanitizeXmlText(raw.slice(1)))
    const cached = evaluator.valueAt(rowIndex, colIndex)
    if (cached.error !== null) {
      return `<c r="${ref}" t="e"><f>${formula}</f><v>${escapeXmlText(cached.error)}</v></c>`
    }
    if (typeof cached.value === 'number' && Number.isFinite(cached.value)) {
      return `<c r="${ref}"><f>${formula}</f><v>${cached.value}</v></c>`
    }
    if (typeof cached.value === 'boolean') {
      return `<c r="${ref}" t="b"><f>${formula}</f><v>${cached.value ? 1 : 0}</v></c>`
    }
    const text = escapeXmlText(sanitizeXmlText(String(cached.value ?? '')))
    return `<c r="${ref}" t="str"><f>${formula}</f><v>${text}</v></c>`
  }
  if (isNumericLiteral(raw)) {
    return `<c r="${ref}"><v>${raw.trim()}</v></c>`
  }
  if (raw === 'TRUE' || raw === 'FALSE') {
    return `<c r="${ref}" t="b"><v>${raw === 'TRUE' ? 1 : 0}</v></c>`
  }
  const text = escapeXmlText(sanitizeXmlText(raw))
  return `<c r="${ref}" t="inlineStr"><is><t xml:space="preserve">${text}</t></is></c>`
}

function worksheetXml(grid: SheetGrid): string {
  const rowCount = grid.rows.length
  let colCount = 1
  for (const row of grid.rows) {
    if (row.length > colCount) colCount = row.length
  }
  const dimension = `A1:${columnLabel(Math.max(0, colCount - 1))}${Math.max(1, rowCount)}`
  // One shared evaluator per sheet: dependent formula chains stay O(cells)
  // instead of re-evaluating from scratch for every cached value.
  const evaluator = createSheetEvaluator(grid.rows)
  const rowsXml = grid.rows
    .map((row, rowIndex) => {
      const cells = row
        .map((_, colIndex) => cellXml(grid.rows, rowIndex, colIndex, evaluator))
        .filter((cell) => cell !== '')
      if (cells.length === 0) return ''
      return `<row r="${rowIndex + 1}">${cells.join('')}</row>`
    })
    .filter((row) => row !== '')
    .join('')
  return `${XML_DECL}<worksheet xmlns="${MAIN_NS}"><dimension ref="${dimension}"/><sheetData>${rowsXml}</sheetData></worksheet>`
}

/**
 * Excel-legal, ≤31-char, DEDUPLICATED sheet names: distinct model names must
 * never collide after sanitization (ECMA-376 forbids duplicate sheet names).
 */
function workbookSheetNames(sheets: SheetGrid[]): string[] {
  const used = new Set<string>()
  return sheets.map((sheet, index) => {
    const base =
      sheet.name
        .replace(/[\\/?*[\]:]/g, ' ')
        .slice(0, 31)
        .trim() || `Sheet${index + 1}`
    let candidate = base
    let counter = 2
    while (used.has(candidate.toLowerCase())) {
      const suffix = ` ${counter}`
      candidate = `${base.slice(0, 31 - suffix.length)}${suffix}`
      counter += 1
    }
    used.add(candidate.toLowerCase())
    return candidate
  })
}

export function buildXlsx(model: SheetDocumentModel): Buffer {
  const sheets = model.sheets.length > 0 ? model.sheets : [{ name: 'Sheet1', rows: [] }]

  const overrides = sheets
    .map(
      (_, index) =>
        `<Override PartName="/xl/worksheets/sheet${index + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`
    )
    .join('')
  const contentTypes = `${XML_DECL}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>${overrides}</Types>`

  const rootRels = `${XML_DECL}<Relationships xmlns="${REL_PKG_NS}"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`

  const sheetNames = workbookSheetNames(sheets)
  const sheetEntries = sheets
    .map(
      (_, index) =>
        `<sheet name="${escapeXmlAttr(sheetNames[index])}" sheetId="${index + 1}" r:id="rIdSheet${index + 1}"/>`
    )
    .join('')
  const workbookXml = `${XML_DECL}<workbook xmlns="${MAIN_NS}" xmlns:r="${R_NS}"><sheets>${sheetEntries}</sheets></workbook>`

  const workbookRels = `${XML_DECL}<Relationships xmlns="${REL_PKG_NS}">${sheets
    .map(
      (_, index) =>
        `<Relationship Id="rIdSheet${index + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${index + 1}.xml"/>`
    )
    .join(
      ''
    )}<Relationship Id="rIdStyles" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`

  return buildZip([
    { name: '[Content_Types].xml', data: Buffer.from(contentTypes, 'utf8') },
    { name: '_rels/.rels', data: Buffer.from(rootRels, 'utf8') },
    { name: 'xl/workbook.xml', data: Buffer.from(workbookXml, 'utf8') },
    { name: 'xl/_rels/workbook.xml.rels', data: Buffer.from(workbookRels, 'utf8') },
    { name: 'xl/styles.xml', data: Buffer.from(STYLES_XML, 'utf8') },
    ...sheets.map((sheet, index) => ({
      name: `xl/worksheets/sheet${index + 1}.xml`,
      data: Buffer.from(worksheetXml(sheet), 'utf8')
    }))
  ])
}

// --- parse -------------------------------------------------------------------

function parseSharedStrings(entries: Map<string, Buffer>): string[] {
  const entry = entries.get('xl/sharedStrings.xml')
  if (!entry) return []
  const root = parseMarkup(entry.toString('utf8'))
  const sst = childByLocalName(root, 'sst')
  if (!sst) return []
  return childrenByLocalName(sst, 'si').map((si) =>
    descendantsByLocalName(si, 't')
      .map((t) => t.text)
      .join('')
  )
}

function normalizeWorkbookTarget(target: string): string {
  if (target.startsWith('/')) return target.slice(1)
  return `xl/${target}`
}

function parseCellReference(ref: string | undefined, fallbackCol: number): number {
  if (!ref) return fallbackCol
  const match = /^([A-Za-z]+)\d+$/.exec(ref)
  if (!match) return fallbackCol
  const col = columnIndex(match[1])
  return col >= 0 ? col : fallbackCol
}

export function parseXlsx(archive: Buffer): XlsxParseResult {
  let entries: Map<string, Buffer>
  try {
    entries = parseZip(archive)
  } catch (error) {
    if (error instanceof ZipArchiveError) {
      throw new OfficeCodecError(`Not a valid .xlsx file: ${error.message}`)
    }
    throw error
  }
  const workbookEntry = entries.get('xl/workbook.xml')
  if (!workbookEntry) {
    throw new OfficeCodecError('Not a valid .xlsx file: xl/workbook.xml is missing.')
  }

  const warnings: string[] = []
  const sharedStrings = parseSharedStrings(entries)

  const rels = new Map<string, string>()
  const relsEntry = entries.get('xl/_rels/workbook.xml.rels')
  if (relsEntry) {
    const relsRoot = parseMarkup(relsEntry.toString('utf8'))
    for (const rel of descendantsByLocalName(relsRoot, 'Relationship')) {
      const id = attrByLocalName(rel, 'Id')
      const target = attrByLocalName(rel, 'Target')
      if (id && target) rels.set(id, normalizeWorkbookTarget(target))
    }
  }

  const workbookRoot = parseMarkup(workbookEntry.toString('utf8'))
  const sheetNodes = descendantsByLocalName(workbookRoot, 'sheet')
  const sheets: SheetGrid[] = []

  sheetNodes.slice(0, OFFICE_MODEL_LIMITS.maxSheets).forEach((sheetNode, sheetIndex) => {
    const name = attrByLocalName(sheetNode, 'name') ?? `Sheet${sheetIndex + 1}`
    const relId = attrByLocalName(sheetNode, 'id')
    const target = relId ? rels.get(relId) : undefined
    const sheetPath = target ?? `xl/worksheets/sheet${sheetIndex + 1}.xml`
    const sheetEntry = entries.get(sheetPath)
    if (!sheetEntry) {
      warnings.push(`Worksheet "${name}" is missing from the package and was skipped.`)
      return
    }

    const sheetRoot = parseMarkup(sheetEntry.toString('utf8'))
    const sheetData = firstDescendantByLocalName(sheetRoot, 'sheetData')
    const rows: string[][] = []
    let truncatedRows = false
    let truncatedCols = false

    if (sheetData) {
      for (const rowNode of childrenByLocalName(sheetData, 'row')) {
        const rowAttr = attrByLocalName(rowNode, 'r')
        const parsedRowIndex = rowAttr ? Number.parseInt(rowAttr, 10) - 1 : rows.length
        const rowIndex =
          Number.isFinite(parsedRowIndex) && parsedRowIndex >= 0 ? parsedRowIndex : rows.length
        if (rowIndex >= OFFICE_MODEL_LIMITS.maxSheetRows) {
          truncatedRows = true
          continue
        }
        while (rows.length <= rowIndex) rows.push([])
        const row = rows[rowIndex]

        let fallbackCol = 0
        for (const cellNode of childrenByLocalName(rowNode, 'c')) {
          const colIndex = parseCellReference(attrByLocalName(cellNode, 'r'), fallbackCol)
          fallbackCol = colIndex + 1
          if (colIndex >= OFFICE_MODEL_LIMITS.maxSheetCols) {
            truncatedCols = true
            continue
          }
          while (row.length <= colIndex) row.push('')

          const cellType = attrByLocalName(cellNode, 't') ?? 'n'
          const valueNode = childByLocalName(cellNode, 'v')
          const formulaNode = childByLocalName(cellNode, 'f')
          const rawValue = valueNode?.text ?? ''

          // Prefer a real formula over its cached value so edits recalc.
          const formulaText = formulaNode ? formulaNode.text.trim() : ''
          if (formulaText !== '') {
            row[colIndex] = `=${formulaText}`
            continue
          }
          if (formulaNode && formulaText === '') {
            // Shared-formula follower cells carry no text; fall back to cache.
            warnings.push(
              `Sheet "${name}": shared formula at ${columnLabel(colIndex)}${rowIndex + 1} imported as its cached value.`
            )
          }

          switch (cellType) {
            case 's': {
              const stringIndex = Number.parseInt(rawValue, 10)
              row[colIndex] = sharedStrings[stringIndex] ?? ''
              break
            }
            case 'inlineStr': {
              const inline = childByLocalName(cellNode, 'is')
              row[colIndex] = inline ? deepText(inline) : ''
              break
            }
            case 'str':
              row[colIndex] = rawValue
              break
            case 'b':
              row[colIndex] = rawValue === '1' ? 'TRUE' : 'FALSE'
              break
            case 'e':
              row[colIndex] = rawValue
              break
            default: {
              // Keep the file's own decimal text verbatim: reformatting here
              // (e.g. to 12 significant digits) would silently corrupt
              // 15-17-digit values on the next save.
              row[colIndex] = rawValue.trim()
              break
            }
          }
        }
      }
    }

    if (truncatedRows) {
      warnings.push(`Sheet "${name}" truncated to ${OFFICE_MODEL_LIMITS.maxSheetRows} rows.`)
    }
    if (truncatedCols) {
      warnings.push(`Sheet "${name}" truncated to ${OFFICE_MODEL_LIMITS.maxSheetCols} columns.`)
    }
    // Normalize ragged rows to a rectangle for the grid editor.
    const width = Math.max(1, ...rows.map((row) => row.length))
    for (const row of rows) {
      while (row.length < width) row.push('')
    }
    sheets.push({ name, rows })
  })

  if (sheetNodes.length > OFFICE_MODEL_LIMITS.maxSheets) {
    warnings.push(`Workbook truncated to the first ${OFFICE_MODEL_LIMITS.maxSheets} sheets.`)
  }
  if (sheets.length === 0) sheets.push({ name: 'Sheet1', rows: [] })

  return { model: { kind: 'sheet', sheets }, warnings }
}
