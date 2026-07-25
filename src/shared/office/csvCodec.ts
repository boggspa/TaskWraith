/**
 * RFC 4180 CSV/TSV codec for the Sheet editor. Tolerant on input (CRLF/CR/LF,
 * optional BOM, quoted newlines, doubled quotes); Excel/Google-friendly on
 * output (CRLF row endings, quoting only where required).
 */

export function parseDelimitedText(text: string, delimiter: ',' | '\t' | ';' = ','): string[][] {
  const source = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text
  const rows: string[][] = []
  let row: string[] = []
  let field = ''
  let inQuotes = false
  let sawAnything = false

  const pushField = (): void => {
    row.push(field)
    field = ''
  }
  const pushRow = (): void => {
    pushField()
    rows.push(row)
    row = []
  }

  for (let index = 0; index < source.length; index += 1) {
    const char = source[index]
    sawAnything = true
    if (inQuotes) {
      if (char === '"') {
        if (source[index + 1] === '"') {
          field += '"'
          index += 1
        } else {
          inQuotes = false
        }
      } else {
        field += char
      }
      continue
    }
    if (char === '"' && field === '') {
      inQuotes = true
      continue
    }
    if (char === delimiter) {
      pushField()
      continue
    }
    if (char === '\r') {
      if (source[index + 1] === '\n') index += 1
      pushRow()
      continue
    }
    if (char === '\n') {
      pushRow()
      continue
    }
    field += char
  }

  if (field !== '' || row.length > 0) pushRow()
  if (!sawAnything) return []
  // A trailing newline produces a phantom empty row — drop it.
  const last = rows[rows.length - 1]
  if (rows.length > 0 && last.length === 1 && last[0] === '') rows.pop()
  return rows
}

export function buildDelimitedText(rows: string[][], delimiter: ',' | '\t' | ';' = ','): string {
  const needsQuoting = (value: string): boolean =>
    value.includes(delimiter) || value.includes('"') || value.includes('\n') || value.includes('\r')
  const encodeField = (value: string): string =>
    needsQuoting(value) ? `"${value.replace(/"/g, '""')}"` : value
  return rows.map((row) => row.map(encodeField).join(delimiter)).join('\r\n') + '\r\n'
}
