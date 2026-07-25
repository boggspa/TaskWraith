import { describe, expect, it } from 'vitest'
import {
  cellRefLabel,
  columnIndex,
  columnLabel,
  evaluateFormulaCell,
  evaluateSheetGrid,
  formatNumber,
  parseCellRef
} from './sheetFormula'

describe('column helpers', () => {
  it('round-trips column labels', () => {
    expect(columnLabel(0)).toBe('A')
    expect(columnLabel(25)).toBe('Z')
    expect(columnLabel(26)).toBe('AA')
    expect(columnLabel(701)).toBe('ZZ')
    expect(columnIndex('A')).toBe(0)
    expect(columnIndex('AA')).toBe(26)
    expect(columnIndex('zz')).toBe(701)
    expect(columnIndex('A1')).toBe(-1)
  })

  it('parses cell refs incl. absolute markers', () => {
    expect(parseCellRef('B12')).toEqual({ row: 11, col: 1 })
    expect(parseCellRef('$C$3')).toEqual({ row: 2, col: 2 })
    expect(parseCellRef('12B')).toBeNull()
    expect(cellRefLabel({ row: 11, col: 1 })).toBe('B12')
  })
})

describe('evaluateSheetGrid', () => {
  it('passes literals through and computes arithmetic with refs', () => {
    const { display, errors } = evaluateSheetGrid([
      ['1', '2', '=A1+B1'],
      ['label', '=C1*2', '=B2-1']
    ])
    expect(display).toEqual([
      ['1', '2', '3'],
      ['label', '6', '5']
    ])
    expect(errors.size).toBe(0)
  })

  it('supports SUM/AVERAGE/MIN/MAX/COUNT/COUNTA over ranges', () => {
    const rows = [
      ['1', '2', '3'],
      ['4', 'text', ''],
      ['=SUM(A1:C2)', '=AVERAGE(A1:A2)', '=COUNT(A1:C2)'],
      ['=COUNTA(A1:C2)', '=MIN(A1:C2)', '=MAX(A1:C2)']
    ]
    const { display } = evaluateSheetGrid(rows)
    expect(display[2]).toEqual(['10', '2.5', '4'])
    expect(display[3]).toEqual(['5', '1', '4'])
  })

  it('supports IF, comparisons, concatenation and text functions', () => {
    const rows = [
      ['5', '10', '=IF(A1<B1,"less","more")'],
      ['=CONCAT("a","b",A1)', '="x"&"y"', '=UPPER(TRIM("  hi  "))'],
      ['=LEN(C1)', '=ROUND(3.14159,2)', '=ABS(-4)^2']
    ]
    const { display } = evaluateSheetGrid(rows)
    expect(display[0][2]).toBe('less')
    expect(display[1]).toEqual(['ab5', 'xy', 'HI'])
    expect(display[2]).toEqual(['4', '3.14', '16'])
  })

  it('handles percent literals and unary minus', () => {
    const { display } = evaluateSheetGrid([['=50%*200', '=-A1']])
    expect(display[0]).toEqual(['100', '-100'])
  })

  it('reports Excel-style errors', () => {
    const { display, errors } = evaluateSheetGrid([
      ['=1/0', '=NOPE(1)', '=UNCLOSED(', '="a"+1'],
      ['=A2', '=Z99', '', '']
    ])
    expect(display[0]).toEqual(['#DIV/0!', '#NAME?', '#VALUE!', '#VALUE!'])
    expect(display[1][0]).toBe('#CYCLE!')
    // Deliberate deviation from Excel: a reference to a blank cell stays
    // blank in display rather than coercing to 0 (arithmetic still treats
    // blanks as 0 — see the dedicated test below).
    expect(display[1][1]).toBe('')
    expect(errors.get('0:0')).toBe('#DIV/0!')
  })

  it('detects mutual reference cycles', () => {
    const { display } = evaluateSheetGrid([['=B1', '=A1']])
    expect(display[0]).toEqual(['#CYCLE!', '#CYCLE!'])
  })

  it('treats blank referenced cells as 0 in arithmetic and skips text in SUM ranges', () => {
    const { display } = evaluateSheetGrid([
      ['', 'x', '3'],
      ['=A1+1', '=SUM(A1:C1)', '=B1&""']
    ])
    expect(display[1]).toEqual(['1', '3', 'x'])
  })
})

describe('evaluateFormulaCell', () => {
  it('returns raw scalar values for the xlsx cached-value writer', () => {
    expect(evaluateFormulaCell([['=2*3']], 0, 0)).toEqual({ value: 6, error: null })
    expect(evaluateFormulaCell([['="a"&"b"']], 0, 0)).toEqual({ value: 'ab', error: null })
    expect(evaluateFormulaCell([['=1/0']], 0, 0)).toEqual({ value: null, error: '#DIV/0!' })
  })
})

describe('formatNumber', () => {
  it('formats integers plainly and trims float noise', () => {
    expect(formatNumber(42)).toBe('42')
    expect(formatNumber(0.1 + 0.2)).toBe('0.3')
    expect(formatNumber(2.5)).toBe('2.5')
  })
})
