import { useMemo, useState } from 'react'
import type { SheetDocumentModel } from '../../../../shared/office/officeModels'
import { OFFICE_MODEL_LIMITS } from '../../../../shared/office/officeModels'
import {
  cellRefLabel,
  columnLabel,
  evaluateSheetGrid
} from '../../../../shared/office/sheetFormula'

interface SheetEditorViewProps {
  model: SheetDocumentModel
  onChange: (next: SheetDocumentModel) => void
}

interface CellSelection {
  row: number
  col: number
}

const cloneRows = (rows: string[][]): string[][] => rows.map((row) => [...row])

export function SheetEditorView({ model, onChange }: SheetEditorViewProps) {
  const [activeSheetIndex, setActiveSheetIndex] = useState(0)
  const [selection, setSelection] = useState<CellSelection | null>({ row: 0, col: 0 })

  const sheetIndex = Math.min(activeSheetIndex, model.sheets.length - 1)
  const sheet = model.sheets[sheetIndex] ?? { name: 'Sheet1', rows: [] }
  const columnCount = Math.max(1, ...sheet.rows.map((row) => row.length), 4)
  const evaluation = useMemo(() => evaluateSheetGrid(sheet.rows), [sheet.rows])

  const mutateSheet = (mutate: (rows: string[][]) => string[][], name?: string): void => {
    const sheets = model.sheets.map((entry, index) =>
      index === sheetIndex
        ? { name: name ?? entry.name, rows: mutate(cloneRows(entry.rows)) }
        : entry
    )
    onChange({ kind: 'sheet', sheets })
  }

  const setCell = (row: number, col: number, value: string): void => {
    mutateSheet((rows) => {
      while (rows.length <= row) rows.push([])
      while (rows[row].length <= col) rows[row].push('')
      rows[row][col] = value
      return rows
    })
  }

  const addRow = (): void => {
    if (sheet.rows.length >= OFFICE_MODEL_LIMITS.maxSheetRows) return
    mutateSheet((rows) => {
      rows.push(Array.from({ length: columnCount }, () => ''))
      return rows
    })
  }

  const addColumn = (): void => {
    if (columnCount >= OFFICE_MODEL_LIMITS.maxSheetCols) return
    mutateSheet((rows) => rows.map((row) => [...row, '']))
  }

  const addSheet = (): void => {
    if (model.sheets.length >= OFFICE_MODEL_LIMITS.maxSheets) return
    onChange({
      kind: 'sheet',
      sheets: [
        ...model.sheets,
        {
          name: `Sheet${model.sheets.length + 1}`,
          rows: [
            ['', '', ''],
            ['', '', '']
          ]
        }
      ]
    })
    setActiveSheetIndex(model.sheets.length)
    setSelection({ row: 0, col: 0 })
  }

  const selectedRaw = selection !== null ? (sheet.rows[selection.row]?.[selection.col] ?? '') : ''

  return (
    <div className="office-sheet-editor">
      <div className="office-editor-toolbar" role="toolbar" aria-label="Spreadsheet controls">
        <span className="office-sheet-cellref">
          {selection ? cellRefLabel({ row: selection.row, col: selection.col }) : '—'}
        </span>
        <input
          className="office-sheet-formula-bar"
          aria-label="Formula bar"
          placeholder="Value or =FORMULA(…)"
          value={selectedRaw}
          disabled={selection === null}
          onChange={(event) => {
            if (selection) setCell(selection.row, selection.col, event.target.value)
          }}
        />
        <button type="button" className="office-toolbar-button" onClick={addRow}>
          + Row
        </button>
        <button type="button" className="office-toolbar-button" onClick={addColumn}>
          + Column
        </button>
      </div>
      <div className="office-sheet-scroll">
        <table className="office-sheet-table">
          <thead>
            <tr>
              <th className="office-sheet-corner" aria-label="Row and column origin" />
              {Array.from({ length: columnCount }, (_, col) => (
                <th key={col} scope="col">
                  {columnLabel(col)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {sheet.rows.map((row, rowIndex) => (
              <tr key={rowIndex}>
                <th scope="row">{rowIndex + 1}</th>
                {Array.from({ length: columnCount }, (_, colIndex) => {
                  const raw = row[colIndex] ?? ''
                  const display = evaluation.display[rowIndex]?.[colIndex] ?? raw
                  const isSelected = selection?.row === rowIndex && selection?.col === colIndex
                  const hasError = evaluation.errors.has(`${rowIndex}:${colIndex}`)
                  return (
                    <td key={colIndex}>
                      <input
                        className={[
                          'office-sheet-cell',
                          isSelected ? 'is-selected' : '',
                          hasError ? 'has-error' : '',
                          raw.startsWith('=') ? 'is-formula' : ''
                        ]
                          .filter(Boolean)
                          .join(' ')}
                        aria-label={`Cell ${cellRefLabel({ row: rowIndex, col: colIndex })}`}
                        value={isSelected ? raw : display}
                        onFocus={() => setSelection({ row: rowIndex, col: colIndex })}
                        onChange={(event) => setCell(rowIndex, colIndex, event.target.value)}
                      />
                    </td>
                  )
                })}
              </tr>
            ))}
            {sheet.rows.length === 0 && (
              <tr>
                <td className="office-sheet-empty" colSpan={columnCount + 1}>
                  Empty sheet — use “+ Row” to start.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      <div className="office-sheet-tabs" role="tablist" aria-label="Sheets">
        {model.sheets.map((entry, index) => (
          <button
            key={index}
            type="button"
            role="tab"
            aria-selected={index === sheetIndex}
            className={`office-sheet-tab${index === sheetIndex ? ' is-active' : ''}`}
            onClick={() => {
              setActiveSheetIndex(index)
              setSelection({ row: 0, col: 0 })
            }}
          >
            {entry.name}
          </button>
        ))}
        <button
          type="button"
          className="office-sheet-tab office-sheet-tab-add"
          title="Add sheet"
          onClick={addSheet}
        >
          +
        </button>
        <input
          className="office-sheet-rename"
          aria-label="Rename active sheet"
          value={sheet.name}
          onChange={(event) => mutateSheet((rows) => rows, event.target.value.slice(0, 31))}
        />
      </div>
    </div>
  )
}
