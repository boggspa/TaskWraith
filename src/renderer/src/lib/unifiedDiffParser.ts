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

export const parseUnifiedDiff = (
  text: string,
  options: ParseUnifiedDiffOptions = {}
): ParsedUnifiedDiff => {
  const maxLines = Math.max(0, options.maxLines ?? DEFAULT_DIFF_RENDER_LINE_LIMIT)
  const rawLines = text.split('\n')
  const sections: ParsedDiffSection[] = []
  let current: ParsedDiffSection = { lines: [] }
  let counters = getHunkStartLines()
  let renderedLineCount = 0

  const pushCurrent = (): void => {
    if (current.lines.length > 0 || current.header) {
      sections.push(current)
    }
  }

  for (const line of rawLines) {
    if (renderedLineCount >= maxLines) continue

    if (line.startsWith('@@')) {
      pushCurrent()
      current = { header: line, lines: [] }
      counters = getHunkStartLines(line)
      continue
    }

    current.lines.push(classifyLine(line, counters))
    renderedLineCount += 1
  }

  pushCurrent()

  return {
    sections,
    totalLineCount: rawLines.length,
    renderedLineCount,
    omittedLineCount: Math.max(0, rawLines.length - renderedLineCount),
    truncated: renderedLineCount < rawLines.length
  }
}
