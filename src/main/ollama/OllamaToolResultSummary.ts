import type { OllamaToolName } from './OllamaToolTiers'

const DEFAULT_MAX_CHARS = 8000
const READ_FILE_HEAD_LINES = 96
const SEARCH_SNIPPET_LINES = 24
const LIST_DIR_MAX_LINES = 80

function collapseWhitespace(value: string): string {
  return value.replace(/\s+/g, ' ').trim()
}

function summarizeReadFileOutput(output: string, maxChars: number): string {
  const lines = output.split(/\r?\n/)
  if (lines.length <= READ_FILE_HEAD_LINES && output.length <= maxChars) return output
  const head = lines.slice(0, READ_FILE_HEAD_LINES).join('\n')
  const omitted = Math.max(0, lines.length - READ_FILE_HEAD_LINES)
  const summary = `${head}\n[read_file summary: ${lines.length} lines total; showing first ${READ_FILE_HEAD_LINES}; ${omitted} lines omitted for context]`
  return summary.length <= maxChars
    ? summary
    : `${summary.slice(0, maxChars)}\n[tool result truncated for selected Ollama context budget]`
}

function summarizeSearchOutput(output: string, maxChars: number): string {
  const flattened = flattenSearchOutput(output)
  const lines = flattened.split(/\r?\n/).filter(Boolean)
  if (lines.length <= SEARCH_SNIPPET_LINES && flattened.length <= maxChars) return flattened
  const head = lines.slice(0, SEARCH_SNIPPET_LINES).join('\n')
  const summary = `${head}\n[workspace_search summary: ${lines.length} result lines; top ${SEARCH_SNIPPET_LINES} kept]`
  return summary.length <= maxChars
    ? summary
    : `${summary.slice(0, maxChars)}\n[tool result truncated for selected Ollama context budget]`
}

function flattenSearchOutput(output: string): string {
  const value = String(output || '').trim()
  if (!value.startsWith('{')) return output
  try {
    const parsed = JSON.parse(value) as {
      files?: unknown[]
      matches?: Array<{ path?: unknown; line?: unknown; text?: unknown }>
      symbols?: Array<{ path?: unknown; line?: unknown; name?: unknown; kind?: unknown }>
      count?: unknown
      truncated?: unknown
      query?: unknown
    }
    const rows: string[] = []
    if (Array.isArray(parsed.files)) {
      for (const file of parsed.files) {
        const path = String(file || '').trim()
        if (path) rows.push(path)
      }
    }
    if (Array.isArray(parsed.matches)) {
      for (const match of parsed.matches) {
        const path = String(match.path || '').trim()
        const line = Number(match.line)
        const text = String(match.text || '').trim()
        if (!path || !Number.isFinite(line)) continue
        rows.push(`${path}:${line}: ${text}`)
      }
    }
    if (Array.isArray(parsed.symbols)) {
      for (const symbol of parsed.symbols) {
        const path = String(symbol.path || '').trim()
        const line = Number(symbol.line)
        const name = String(symbol.name || '').trim()
        const kind = String(symbol.kind || '').trim()
        if (!path || !Number.isFinite(line) || !name) continue
        rows.push(`${path}:${line}: ${kind ? `${kind} ` : ''}${name}`)
      }
    }
    if (rows.length === 0) return output
    const suffix =
      parsed.truncated === true
        ? `\n[search truncated at ${String(parsed.count || rows.length)} results]`
        : ''
    return `${rows.join('\n')}${suffix}`
  } catch {
    return output
  }
}

function summarizeListDirectoryOutput(output: string, maxChars: number): string {
  const lines = output.split(/\r?\n/).filter(Boolean)
  if (lines.length <= LIST_DIR_MAX_LINES && output.length <= maxChars) return output
  const head = lines.slice(0, LIST_DIR_MAX_LINES).join('\n')
  const summary = `${head}\n[list_directory summary: ${lines.length} entries; first ${LIST_DIR_MAX_LINES} kept]`
  return summary.length <= maxChars
    ? summary
    : `${summary.slice(0, maxChars)}\n[tool result truncated for selected Ollama context budget]`
}

function summarizeGenericOutput(output: string, maxChars: number): string {
  const value = String(output || '')
  if (value.length <= maxChars) return value
  const headChars = Math.max(400, Math.floor(maxChars * 0.75))
  const tailChars = Math.max(120, maxChars - headChars - 80)
  return [
    value.slice(0, headChars).trimEnd(),
    `[tool result summarized: ${value.length} chars total; middle omitted]`,
    value.slice(-tailChars).trimStart()
  ].join('\n')
}

/** Heuristic post-processor before tool results re-enter the Ollama chat loop. */
export function summarizeOllamaToolResult(
  toolName: OllamaToolName | string,
  output: string,
  maxChars = DEFAULT_MAX_CHARS
): string {
  const value = String(output || '')
  if (!value) return value
  if (toolName === 'read_file') return summarizeReadFileOutput(value, maxChars)
  if (
    toolName === 'workspace_search' ||
    toolName === 'workspace_symbols' ||
    toolName === 'find_files'
  ) {
    return summarizeSearchOutput(value, maxChars)
  }
  if (toolName === 'list_directory') return summarizeListDirectoryOutput(value, maxChars)
  if (value.length <= maxChars) return value
  return summarizeGenericOutput(value, maxChars)
}

export function summarizeOllamaToolArgs(toolName: string, args: Record<string, unknown>): string {
  const path = collapseWhitespace(String(args.path || args.file_path || ''))
  const query = collapseWhitespace(String(args.query || ''))
  const command = collapseWhitespace(String(args.command || ''))
  if (path) return `${toolName} path=${path}`
  if (query) return `${toolName} query=${query.slice(0, 120)}`
  if (command) return `${toolName} command=${command.slice(0, 120)}`
  return toolName
}
