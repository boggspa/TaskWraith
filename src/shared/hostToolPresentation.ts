import {
  HOST_HISTORY_MAX_TOOL_COMMAND_CHARS,
  HOST_HISTORY_MAX_TOOL_DIFF_HEADER,
  HOST_HISTORY_MAX_TOOL_DIFF_LINE_CHARS,
  HOST_HISTORY_MAX_TOOL_DIFF_LINES,
  HOST_HISTORY_MAX_TOOL_HUNKS,
  HOST_HISTORY_MAX_TOOL_FILE,
  HOST_HISTORY_MAX_TOOL_OUTPUT_CHARS,
  type HostHistoryToolCommand,
  type HostHistoryToolDiff,
  type HostHistoryToolDiffHunk,
  type HostHistoryToolDiffLine
} from './hostHistoryProtocol'

const PRESENTATION_SECRET_PATTERN =
  /((?:api[_-]?key|token|secret|password|authorization)\s*[:=]\s*)([^\s,;]+)/gi
// eslint-disable-next-line no-control-regex -- presentation sanitizers remove provider control bytes.
const UNSAFE_SINGLE_LINE_CONTROLS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g
// eslint-disable-next-line no-control-regex -- presentation sanitizers remove provider control bytes.
const UNSAFE_MULTILINE_CONTROLS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g

export interface HostToolPresentationInput {
  readonly toolName?: string
  readonly input?: Record<string, unknown>
  readonly output?: unknown
}

export interface HostToolPresentation {
  readonly file?: string
  readonly additions?: number
  readonly deletions?: number
  readonly diff?: HostHistoryToolDiff
  readonly command?: HostHistoryToolCommand
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function boundedSingleLine(value: unknown, max: number, trim = false): string | undefined {
  if (typeof value !== 'string') return undefined
  const cleaned = value
    .replace(UNSAFE_SINGLE_LINE_CONTROLS, ' ')
    .replace(PRESENTATION_SECRET_PATTERN, '$1[redacted]')
  const normalized = trim ? cleaned.trim() : cleaned
  if (!normalized) return undefined
  return normalized.length <= max ? normalized : `${normalized.slice(0, max - 1)}…`
}

function boundedMultiline(value: unknown): { text?: string; truncated: boolean } {
  if (typeof value !== 'string') return { truncated: false }
  const cleaned = value
    .replace(UNSAFE_MULTILINE_CONTROLS, ' ')
    .replace(PRESENTATION_SECRET_PATTERN, '$1[redacted]')
  if (!cleaned) return { truncated: false }
  return cleaned.length <= HOST_HISTORY_MAX_TOOL_OUTPUT_CHARS
    ? { text: cleaned, truncated: false }
    : {
        text: `${cleaned.slice(0, HOST_HISTORY_MAX_TOOL_OUTPUT_CHARS - 1)}…`,
        truncated: true
      }
}

function firstString(
  recordValue: Record<string, unknown>,
  keys: readonly string[],
  max = HOST_HISTORY_MAX_TOOL_COMMAND_CHARS
): string | undefined {
  for (const key of keys) {
    const value = boundedSingleLine(recordValue[key], max, true)
    if (value) return value
  }
  return undefined
}

function numericValue(
  recordValue: Record<string, unknown>,
  keys: readonly string[]
): number | undefined {
  for (const key of keys) {
    const value = recordValue[key]
    const numeric =
      typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN
    if (Number.isSafeInteger(numeric) && numeric >= 0) return numeric
  }
  return undefined
}

function textFromUnknown(value: unknown): string | undefined {
  if (typeof value === 'string') return value
  const valueRecord = record(value)
  if (!valueRecord) return undefined
  for (const key of ['text', 'output', 'stdout', 'stderr', 'result', 'content']) {
    const nested = textFromUnknown(valueRecord[key])
    if (nested) return nested
  }
  if (Array.isArray(valueRecord.content)) {
    const parts = valueRecord.content
      .map(textFromUnknown)
      .filter((part): part is string => Boolean(part))
    if (parts.length) return parts.join('')
  }
  return undefined
}

function lineArray(value: string): string[] {
  const normalized = value.replace(/\r\n?/g, '\n')
  const lines = normalized.split('\n')
  if (lines.at(-1) === '') lines.pop()
  return lines
}

function safeDiffText(value: string): { text: string; truncated: boolean } {
  const cleaned = value
    .replace(UNSAFE_SINGLE_LINE_CONTROLS, ' ')
    .replace(PRESENTATION_SECRET_PATTERN, '$1[redacted]')
  return cleaned.length <= HOST_HISTORY_MAX_TOOL_DIFF_LINE_CHARS
    ? { text: cleaned, truncated: false }
    : {
        text: `${cleaned.slice(0, HOST_HISTORY_MAX_TOOL_DIFF_LINE_CHARS - 1)}…`,
        truncated: true
      }
}

function lineNumber(value: Record<string, unknown>, keys: readonly string[]): number {
  return numericValue(value, keys) ?? 1
}

function boundedDiffLine(
  type: HostHistoryToolDiffLine['type'],
  text: string,
  oldLine?: number,
  newLine?: number
): { line: HostHistoryToolDiffLine; truncated: boolean } {
  const bounded = safeDiffText(text)
  return {
    line: {
      type,
      text: bounded.text,
      ...(oldLine !== undefined ? { oldLine } : {}),
      ...(newLine !== undefined ? { newLine } : {})
    },
    truncated: bounded.truncated
  }
}

function parseUnifiedDiff(value: string): HostHistoryToolDiff | undefined {
  const lines = lineArray(value)
  const hunks: HostHistoryToolDiffHunk[] = []
  let current: { header: string; lines: HostHistoryToolDiffLine[] } | undefined
  let oldLine: number | undefined
  let newLine: number | undefined
  let usedLines = 0
  let truncated = false

  for (const rawLine of lines) {
    if (rawLine.startsWith('@@')) {
      if (hunks.length >= HOST_HISTORY_MAX_TOOL_HUNKS) {
        truncated = true
        break
      }
      const match = rawLine.match(/^@@\s+-(\d+)(?:,\d+)?\s+\+(\d+)(?:,\d+)?\s+@@/)
      const header = safeDiffText(rawLine.slice(0, HOST_HISTORY_MAX_TOOL_DIFF_HEADER))
      current = { header: header.text, lines: [] }
      hunks.push(current)
      oldLine = match ? Number(match[1]) : undefined
      newLine = match ? Number(match[2]) : undefined
      truncated ||= header.truncated
      continue
    }
    if (!current || usedLines >= HOST_HISTORY_MAX_TOOL_DIFF_LINES) {
      if (current) truncated = true
      continue
    }
    const marker = rawLine[0]
    const type =
      marker === '+'
        ? 'add'
        : marker === '-'
          ? 'del'
          : marker === ' ' || marker === undefined
            ? 'context'
            : null
    if (!type) continue
    const bounded = boundedDiffLine(
      type,
      marker === '+' || marker === '-' || marker === ' ' ? rawLine.slice(1) : rawLine,
      type === 'add' ? undefined : oldLine,
      type === 'del' ? undefined : newLine
    )
    current.lines.push(bounded.line)
    truncated ||= bounded.truncated
    usedLines += 1
    if (type === 'add') {
      if (newLine !== undefined) newLine += 1
    } else if (type === 'del') {
      if (oldLine !== undefined) oldLine += 1
    } else {
      if (oldLine !== undefined) oldLine += 1
      if (newLine !== undefined) newLine += 1
    }
  }
  return hunks.length ? { hunks, ...(truncated ? { truncated: true } : {}) } : undefined
}

function replacementDiff(
  oldText: string,
  newText: string,
  input: Record<string, unknown>
): { diff: HostHistoryToolDiff; additions: number; deletions: number } {
  const oldLines = lineArray(oldText)
  const newLines = lineArray(newText)
  const oldStart = lineNumber(input, ['old_start', 'oldStart', 'line', 'line_start', 'start_line'])
  const newStart = lineNumber(input, ['new_start', 'newStart', 'line', 'line_start', 'start_line'])
  let prefix = 0
  while (
    prefix < oldLines.length &&
    prefix < newLines.length &&
    oldLines[prefix] === newLines[prefix]
  ) {
    prefix += 1
  }
  let suffix = 0
  while (
    suffix < oldLines.length - prefix &&
    suffix < newLines.length - prefix &&
    oldLines[oldLines.length - 1 - suffix] === newLines[newLines.length - 1 - suffix]
  ) {
    suffix += 1
  }

  const lines: HostHistoryToolDiffLine[] = []
  let truncated = false
  const push = (
    type: HostHistoryToolDiffLine['type'],
    text: string,
    oldLine?: number,
    newLine?: number
  ): void => {
    if (lines.length >= HOST_HISTORY_MAX_TOOL_DIFF_LINES) {
      truncated = true
      return
    }
    const bounded = boundedDiffLine(type, text, oldLine, newLine)
    lines.push(bounded.line)
    truncated ||= bounded.truncated
  }
  for (let index = 0; index < prefix; index += 1) {
    push('context', oldLines[index] ?? '', oldStart + index, newStart + index)
  }
  for (let index = prefix; index < oldLines.length - suffix; index += 1) {
    push('del', oldLines[index] ?? '', oldStart + index)
  }
  for (let index = prefix; index < newLines.length - suffix; index += 1) {
    push('add', newLines[index] ?? '', undefined, newStart + index)
  }
  for (let index = suffix; index > 0; index -= 1) {
    const oldIndex = oldLines.length - index
    const newIndex = newLines.length - index
    push('context', newLines[newIndex] ?? '', oldStart + oldIndex, newStart + newIndex)
  }
  const header = `@@ -${oldStart},${oldLines.length} +${newStart},${newLines.length} @@`
  return {
    diff: { hunks: [{ header, lines }], ...(truncated ? { truncated: true } : {}) },
    additions: Math.max(0, newLines.length - prefix - suffix),
    deletions: Math.max(0, oldLines.length - prefix - suffix)
  }
}

function commandFromInput(
  input: Record<string, unknown>,
  output: unknown
): HostHistoryToolCommand | undefined {
  const command =
    firstString(input, ['command', 'cmd', 'shellCommand', 'script']) ??
    (Array.isArray(input.argv)
      ? input.argv
          .map((part) => boundedSingleLine(part, HOST_HISTORY_MAX_TOOL_COMMAND_CHARS, true))
          .filter((part): part is string => Boolean(part))
          .join(' ')
      : undefined)
  const outputValue = textFromUnknown(
    output ?? input.output ?? input.stdout ?? input.stderr ?? input.result
  )
  const boundedOutput = boundedMultiline(outputValue)
  const exitCode = numericValue(input, ['exitCode', 'exit_code', 'statusCode', 'status_code'])
  if (!command && !boundedOutput.text && exitCode === undefined) return undefined
  return {
    ...(command ? { command } : {}),
    ...(boundedOutput.text ? { output: boundedOutput.text } : {}),
    ...(exitCode !== undefined ? { exitCode } : {}),
    ...(boundedOutput.truncated ? { truncated: true } : {})
  }
}

export function buildHostToolPresentation(input: HostToolPresentationInput): HostToolPresentation {
  const toolInput = input.input ?? {}
  const normalizedName = String(input.toolName ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
  const file = firstString(
    toolInput,
    ['file_path', 'filePath', 'path', 'target', 'target_file', 'target_file_path'],
    HOST_HISTORY_MAX_TOOL_FILE
  )
  const explicitAdditions = numericValue(toolInput, [
    'additions',
    'added',
    'linesAdded',
    'lines_added',
    'insertions'
  ])
  const explicitDeletions = numericValue(toolInput, [
    'deletions',
    'deleted',
    'linesDeleted',
    'linesRemoved',
    'lines_removed',
    'removals'
  ])
  const oldText = textFromUnknown(
    toolInput.old_string ?? toolInput.oldString ?? toolInput.oldText ?? toolInput.old_text
  )
  const newText = textFromUnknown(
    toolInput.new_string ?? toolInput.newString ?? toolInput.newText ?? toolInput.new_text
  )
  const content = textFromUnknown(
    toolInput.content ?? toolInput.new_content ?? toolInput.newContent
  )
  const patch = textFromUnknown(toolInput.patch ?? toolInput.diff)
  const writeLike = /(?:write|edit|replace|patch|create|delete|remove|move|rename)/.test(
    normalizedName
  )
  let diff: HostHistoryToolDiff | undefined
  let additions = explicitAdditions
  let deletions = explicitDeletions
  if (patch) {
    diff = parseUnifiedDiff(patch)
  } else if (oldText !== undefined || newText !== undefined) {
    const replacement = replacementDiff(oldText ?? '', newText ?? '', toolInput)
    diff = replacement.diff
    additions ??= replacement.additions
    deletions ??= replacement.deletions
  } else if (writeLike && content !== undefined) {
    const replacement = replacementDiff('', content, toolInput)
    diff = replacement.diff
    additions ??= replacement.additions
    deletions ??= replacement.deletions
  }
  if (diff && (additions === undefined || deletions === undefined)) {
    const diffLines = diff.hunks.flatMap((hunk) => hunk.lines)
    additions ??= diffLines.filter((line) => line.type === 'add').length
    deletions ??= diffLines.filter((line) => line.type === 'del').length
  }
  const command = /(?:shell|bash|terminal|command|exec|run)/.test(normalizedName)
    ? commandFromInput(toolInput, input.output)
    : undefined
  return {
    ...(file ? { file } : {}),
    ...(additions !== undefined ? { additions } : {}),
    ...(deletions !== undefined ? { deletions } : {}),
    ...(diff ? { diff } : {}),
    ...(command ? { command } : {})
  }
}
