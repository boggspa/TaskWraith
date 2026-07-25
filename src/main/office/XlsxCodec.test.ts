import { describe, expect, it } from 'vitest'
import type { SheetDocumentModel } from '../../shared/office/officeModels'
import { buildZip, parseZip } from './ZipArchive'
import { buildXlsx, parseXlsx } from './XlsxCodec'
import { OfficeCodecError } from './DocxCodec'

const SAMPLE: SheetDocumentModel = {
  kind: 'sheet',
  sheets: [
    {
      name: 'Budget',
      rows: [
        ['Item', 'Cost', 'Qty', 'Total'],
        ['Desk', '120.5', '2', '=B2*C2'],
        ['Chair', '80', '4', '=B3*C3'],
        ['', '', 'Sum', '=SUM(D2:D3)'],
        ['note', 'TRUE', 'quote " <tag>', '']
      ]
    },
    { name: 'Empty', rows: [] }
  ]
}

describe('buildXlsx → parseXlsx round-trip', () => {
  it('preserves literals, formulas, booleans and sheet names', () => {
    const archive = buildXlsx(SAMPLE)
    const { model, warnings } = parseXlsx(archive)
    expect(warnings).toEqual([])
    expect(model.sheets).toHaveLength(2)
    expect(model.sheets[0].name).toBe('Budget')
    expect(model.sheets[1].name).toBe('Empty')
    // The parser normalizes rows to a rectangle; compare against padded rows.
    expect(model.sheets[0].rows).toEqual([
      ['Item', 'Cost', 'Qty', 'Total'],
      ['Desk', '120.5', '2', '=B2*C2'],
      ['Chair', '80', '4', '=B3*C3'],
      ['', '', 'Sum', '=SUM(D2:D3)'],
      ['note', 'TRUE', 'quote " <tag>', '']
    ])
  })

  it('writes cached formula values so other suites show results immediately', () => {
    const entries = parseZip(buildXlsx(SAMPLE))
    const sheet = entries.get('xl/worksheets/sheet1.xml')!.toString('utf8')
    expect(sheet).toContain('<c r="D2"><f>B2*C2</f><v>241</v></c>')
    expect(sheet).toContain('<c r="D4"><f>SUM(D2:D3)</f><v>561</v></c>')
    // Excel-required fills stay in styles.xml.
    expect(entries.get('xl/styles.xml')!.toString('utf8')).toContain('gray125')
  })

  it('sanitizes hostile sheet names, escapes quotes and dedupes collisions', () => {
    const model: SheetDocumentModel = {
      kind: 'sheet',
      sheets: [
        { name: 'bad[name]:with*chars?', rows: [['x']] },
        { name: 'Q1 "final"', rows: [['x']] },
        { name: 'Q1:EU', rows: [['x']] },
        { name: 'Q1/EU', rows: [['x']] }
      ]
    }
    const entries = parseZip(buildXlsx(model))
    const workbook = entries.get('xl/workbook.xml')!.toString('utf8')
    expect(workbook).toContain('name="bad name  with chars"')
    // Quote survives via attribute escaping — no attribute injection.
    expect(workbook).toContain('name="Q1 &quot;final&quot;"')
    // Both collapse to 'Q1 EU'; the second gets a dedupe suffix.
    expect(workbook).toContain('name="Q1 EU"')
    expect(workbook).toContain('name="Q1 EU 2"')
    // The workbook part stays well-formed XML.
    const { model: reparsed } = parseXlsx(buildXlsx(model))
    expect(reparsed.sheets.map((sheet) => sheet.name)).toEqual([
      'bad name  with chars',
      'Q1 "final"',
      'Q1 EU',
      'Q1 EU 2'
    ])
  })

  it('preserves high-precision numerics verbatim through import', () => {
    const archive = buildZip([
      {
        name: 'xl/workbook.xml',
        data: Buffer.from(
          '<?xml version="1.0"?><workbook xmlns="m" xmlns:r="r"><sheets><sheet name="S1" sheetId="1" r:id="rId1"/></sheets></workbook>'
        )
      },
      {
        name: 'xl/_rels/workbook.xml.rels',
        data: Buffer.from(
          '<?xml version="1.0"?><Relationships><Relationship Id="rId1" Type="t" Target="worksheets/sheet1.xml"/></Relationships>'
        )
      },
      {
        name: 'xl/worksheets/sheet1.xml',
        data: Buffer.from(
          '<?xml version="1.0"?><worksheet><sheetData><row r="1">' +
            '<c r="A1"><v>0.123456789012345</v></c>' +
            '<c r="B1"><v>1234567890123456</v></c>' +
            '</row></sheetData></worksheet>'
        )
      }
    ])
    const { model } = parseXlsx(archive)
    expect(model.sheets[0].rows[0]).toEqual(['0.123456789012345', '1234567890123456'])
  })
})

describe('parseXlsx against foreign-produced shapes', () => {
  const wrap = (sheetXml: string, extras: { name: string; data: string }[] = []): Buffer =>
    buildZip([
      {
        name: 'xl/workbook.xml',
        data: Buffer.from(
          '<?xml version="1.0"?><workbook xmlns="m" xmlns:r="r"><sheets><sheet name="S1" sheetId="1" r:id="rId1"/></sheets></workbook>'
        )
      },
      {
        name: 'xl/_rels/workbook.xml.rels',
        data: Buffer.from(
          '<?xml version="1.0"?><Relationships><Relationship Id="rId1" Type="t" Target="worksheets/sheet1.xml"/></Relationships>'
        )
      },
      { name: 'xl/worksheets/sheet1.xml', data: Buffer.from(sheetXml) },
      ...extras.map((extra) => ({ name: extra.name, data: Buffer.from(extra.data) }))
    ])

  it('resolves shared strings including rich-text runs', () => {
    const archive = wrap(
      '<?xml version="1.0"?><worksheet><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c></row></sheetData></worksheet>',
      [
        {
          name: 'xl/sharedStrings.xml',
          data: '<?xml version="1.0"?><sst><si><t>plain</t></si><si><r><t>ri</t></r><r><t>ch</t></r></si></sst>'
        }
      ]
    )
    const { model } = parseXlsx(archive)
    expect(model.sheets[0].rows[0]).toEqual(['plain', 'rich'])
  })

  it('prefers formulas over cached values and reads booleans/errors', () => {
    const archive = wrap(
      '<?xml version="1.0"?><worksheet><sheetData>' +
        '<row r="1"><c r="A1"><f>1+1</f><v>2</v></c><c r="B1" t="b"><v>1</v></c><c r="C1" t="e"><v>#REF!</v></c></row>' +
        '</sheetData></worksheet>'
    )
    const { model } = parseXlsx(archive)
    expect(model.sheets[0].rows[0]).toEqual(['=1+1', 'TRUE', '#REF!'])
  })

  it('fills gaps for sparse rows and missing r attributes', () => {
    const archive = wrap(
      '<?xml version="1.0"?><worksheet><sheetData>' +
        '<row r="2"><c r="C2"><v>9</v></c></row>' +
        '<row><c><v>1</v></c><c><v>2</v></c></row>' +
        '</sheetData></worksheet>'
    )
    const { model } = parseXlsx(archive)
    expect(model.sheets[0].rows).toEqual([
      ['', '', ''],
      ['', '', '9'],
      ['1', '2', '']
    ])
  })

  it('falls back to cached values for shared-formula followers with a warning', () => {
    const archive = wrap(
      '<?xml version="1.0"?><worksheet><sheetData>' +
        '<row r="1"><c r="A1"><f t="shared" ref="A1:A2" si="0">B1*2</f><v>4</v></c></row>' +
        '<row r="2"><c r="A2"><f t="shared" si="0"/><v>6</v></c></row>' +
        '</sheetData></worksheet>'
    )
    const { model, warnings } = parseXlsx(archive)
    expect(model.sheets[0].rows[0][0]).toBe('=B1*2')
    expect(model.sheets[0].rows[1][0]).toBe('6')
    expect(warnings.some((warning) => warning.includes('shared formula'))).toBe(true)
  })

  it('rejects archives without a workbook part', () => {
    const archive = buildZip([{ name: 'nope.xml', data: Buffer.from('<x/>') }])
    expect(() => parseXlsx(archive)).toThrow(OfficeCodecError)
  })
})
