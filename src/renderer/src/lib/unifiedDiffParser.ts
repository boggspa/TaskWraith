export type ParsedDiffLineKind = 'add' | 'context' | 'del' | 'meta'

export interface ParsedDiffLine {
  kind: ParsedDiffLineKind
  oldLine: number | null
  newLine: number | null
  text: string
}

export interface ParsedDiffSection {
  header?: string
  lines: ParsedDiffLine[]
}

export interface ParsedUnifiedDiff {
  sections: ParsedDiffSection[]
  totalLineCount: number
  renderedLineCount: number
  omittedLineCount: number
  truncated: boolean
}

export interface ParseUnifiedDiffOptions {
  maxLines?: number
}

export const DEFAULT_DIFF_RENDER_LINE_LIMIT = 2500

const HUNK_HEADER_PATTERN = /@@\s+-(\d+)(?:,\d+)?\s+\+(\d+)(?:,\d+)?\s+@@/

const countRenderLines = (text: string, startIndex: number): number => {
  if (startIndex > text.length) return 0
  let count = 1
  let lineStart = startIndex
  for (let index = startIndex; index < text.length; index += 1) {
    if (text.charCodeAt(index) !== 10) continue
    if (text.startsWith('@@', lineStart)) count -= 1
    count += 1
    lineStart = index + 1
  }
  if (text.startsWith('@@', lineStart)) count -= 1
  return count
}

export const isDiffMetadataLine = (line: string): boolean => {
  return (
    line.startsWith('diff --git') ||
    line.startsWith('index ') ||
    line.startsWith('+++ ') ||
    line.startsWith('--- ') ||
    line.startsWith('rename from ') ||
    line.startsWith('rename to ') ||
    line.startsWith('new file mode ') ||
    line.startsWith('deleted file mode ') ||
    line.startsWith('\\ No newline at end of file')
  )
}

const getHunkStartLines = (header?: string): { oldLine: number; newLine: number } => {
  const match = header?.match(HUNK_HEADER_PATTERN)
  return {
    oldLine: match ? Number(match[1]) : 0,
    newLine: match ? Number(match[2]) : 0
  }
}

const classifyLine = (
  line: string,
  counters: { oldLine: number; newLine: number }
): ParsedDiffLine => {
  if (isDiffMetadataLine(line)) {
    return { kind: 'meta', oldLine: null, newLine: null, text: line }
  }

  if (line.startsWith('+')) {
    const parsedLine = {
      kind: 'add' as const,
      oldLine: null,
      newLine: counters.newLine > 0 ? counters.newLine : null,
      text: line
    }
    counters.newLine += 1
    return parsedLine
  }

  if (line.startsWith('-')) {
    const parsedLine = {
      kind: 'del' as const,
      oldLine: counters.oldLine > 0 ? counters.oldLine : null,
      newLine: null,
      text: line
    }
    counters.oldLine += 1
    return parsedLine
  }

  const parsedLine = {
    kind: 'context' as const,
    oldLine: counters.oldLine > 0 ? counters.oldLine : null,
    newLine: counters.newLine > 0 ? counters.newLine : null,
    text: line
  }
  counters.oldLine += counters.oldLine > 0 ? 1 : 0
  counters.newLine += counters.newLine > 0 ? 1 : 0
  return parsedLine
}

const stripDiffMarker = (text: string, marker: string): string => {
  return text.startsWith(marker) ? text.slice(marker.length) : text
}

/** Strip the unified-diff marker so a line can render as editor source. */
export const diffLineDisplayText = (line: ParsedDiffLine, side?: 'old' | 'new'): string => {
  if (side === 'old' && line.kind === 'add') return ''
  if (side === 'new' && line.kind === 'del') return ''
  if (line.kind === 'add') return stripDiffMarker(line.text, '+')
  if (line.kind === 'del') return stripDiffMarker(line.text, '-')
  if (line.kind === 'context') return stripDiffMarker(line.text, ' ')
  return line.text
}

export const isRenderableDiffLine = (line: ParsedDiffLine): boolean => line.kind !== 'meta'

export const diffLineNumber = (line: ParsedDiffLine): number | null => {
  if (line.kind === 'del') return line.oldLine
  return line.newLine ?? line.oldLine
}

export const parseUnifiedDiff = (
  text: string,
  options: ParseUnifiedDiffOptions = {}
): ParsedUnifiedDiff => {
  const maxLines = Math.max(0, options.maxLines ?? DEFAULT_DIFF_RENDER_LINE_LIMIT)
  const sections: ParsedDiffSection[] = []
  let current: ParsedDiffSection = { lines: [] }
  let counters = getHunkStartLines()
  let renderedLineCount = 0
  let totalLineCount = 0

  const pushCurrent = (): void => {
    if (current.lines.length > 0 || current.header) {
      sections.push(current)
    }
  }

  let index = 0
  while (index <= text.length) {
    if (renderedLineCount >= maxLines) {
      totalLineCount += countRenderLines(text, index)
      break
    }

    const nextBreak = text.indexOf('\n', index)
    const lineEnd = nextBreak === -1 ? text.length : nextBreak
    const line = text.slice(index, lineEnd)

    if (line.startsWith('@@')) {
      pushCurrent()
      current = { header: line, lines: [] }
      counters = getHunkStartLines(line)
    } else {
      totalLineCount += 1
      current.lines.push(classifyLine(line, counters))
      renderedLineCount += 1
    }

    if (nextBreak === -1) break
    index = nextBreak + 1
  }

  pushCurrent()

  return {
    sections,
    totalLineCount,
    renderedLineCount,
    omittedLineCount: Math.max(0, totalLineCount - renderedLineCount),
    truncated: renderedLineCount < totalLineCount
  }
}
