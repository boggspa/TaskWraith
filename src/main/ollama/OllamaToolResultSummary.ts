import type { OllamaToolName } from './OllamaToolTiers'

const DEFAULT_MAX_CHARS = 8000
const READ_FILE_HEAD_LINES = 96
const SEARCH_SNIPPET_LINES = 24
const LIST_DIR_MAX_LINES = 80

/**
 * Per-run truncation caps applied to tool results before they re-enter the
 * Ollama chat loop. Historically these were the flat constants above for every
 * model, which starved large-window local models: a 24B tag with a measured
 * 262K+ window was clamped to the same 96 read lines as a 1.2B — the single
 * biggest driver of read→edit-fail→read loops, since the model could never see
 * the region it was asked to edit.
 */
export interface OllamaToolResultLimits {
  maxChars: number
  readFileHeadLines: number
  searchSnippetLines: number
  listDirMaxLines: number
}

export const OLLAMA_DEFAULT_TOOL_RESULT_LIMITS: OllamaToolResultLimits = {
  maxChars: DEFAULT_MAX_CHARS,
  readFileHeadLines: READ_FILE_HEAD_LINES,
  searchSnippetLines: SEARCH_SNIPPET_LINES,
  listDirMaxLines: LIST_DIR_MAX_LINES
}

/**
 * Upper bound on `readFileHeadLines`: the read_file schema promises callers a
 * 2,000-line default window, so a model whose window can hold one must actually
 * receive it — a schema that promises 2,000 and delivers 96 reads as a broken
 * tool to a competent caller.
 */
const READ_FILE_HEAD_LINES_MAX = 2000
const MAX_CHARS_MAX = 160_000

/**
 * Scale the truncation caps to the model's MEASURED context window (daemon
 * `/api/show` → `OllamaModelInfo.contextLength`), bounded by the run profile's
 * context cap. Only a measurement may widen the caps — an unmeasured window
 * keeps the conservative floor, same doctrine as `resolveOllamaContextBudget`'s
 * `default:` arm: the floor is a placeholder pending the probe, not a throttle.
 *
 * The chars budget is ~10% of the usable window (≈3.6 chars/token → 0.36 chars
 * per window-token), so even a maximal read_file result leaves the demand-driven
 * `num_ctx` ample room for the transcript around it.
 */
export function resolveOllamaToolResultLimits(input?: {
  measuredContextTokens?: number | null
  contextCapTokens?: number | null
}): OllamaToolResultLimits {
  const measured =
    typeof input?.measuredContextTokens === 'number' &&
    Number.isFinite(input.measuredContextTokens) &&
    input.measuredContextTokens > 0
      ? Math.trunc(input.measuredContextTokens)
      : undefined
  if (!measured) return OLLAMA_DEFAULT_TOOL_RESULT_LIMITS
  const cap =
    typeof input?.contextCapTokens === 'number' &&
    Number.isFinite(input.contextCapTokens) &&
    input.contextCapTokens > 0
      ? Math.trunc(input.contextCapTokens)
      : undefined
  const usable = cap ? Math.min(measured, cap) : measured
  const clamp = (floor: number, value: number, ceiling: number): number =>
    Math.min(ceiling, Math.max(floor, Math.round(value)))
  return {
    maxChars: clamp(DEFAULT_MAX_CHARS, usable * 0.36, MAX_CHARS_MAX),
    readFileHeadLines: clamp(READ_FILE_HEAD_LINES, usable / 64, READ_FILE_HEAD_LINES_MAX),
    searchSnippetLines: clamp(SEARCH_SNIPPET_LINES, usable / 512, 200),
    listDirMaxLines: clamp(LIST_DIR_MAX_LINES, usable / 256, 300)
  }
}

function normalizeLimits(
  maxCharsOrLimits: number | OllamaToolResultLimits | undefined
): OllamaToolResultLimits {
  if (typeof maxCharsOrLimits === 'number' && Number.isFinite(maxCharsOrLimits)) {
    return { ...OLLAMA_DEFAULT_TOOL_RESULT_LIMITS, maxChars: Math.trunc(maxCharsOrLimits) }
  }
  if (maxCharsOrLimits && typeof maxCharsOrLimits === 'object') return maxCharsOrLimits
  return OLLAMA_DEFAULT_TOOL_RESULT_LIMITS
}

function collapseWhitespace(value: string): string {
  return value.replace(/\s+/g, ' ').trim()
}

/** Window header emitted by the read_file executor for offset/limit reads. */
const READ_FILE_WINDOW_HEADER = /^\[read_file: lines (\d+)-(\d+) of (\d+)\]$/

function summarizeReadFileOutput(output: string, limits: OllamaToolResultLimits): string {
  const lines = output.split(/\r?\n/)
  const headLines = limits.readFileHeadLines
  if (lines.length <= headLines && output.length <= limits.maxChars) return output
  // A windowed read (`offset`/`limit` args) carries its own header line; keep
  // the paging guidance continuous with the window instead of restarting at 1.
  const windowHeader = lines[0] ? READ_FILE_WINDOW_HEADER.exec(lines[0]) : null
  const head = lines.slice(0, headLines).join('\n')
  const contentLineCount = lines.length - (windowHeader ? 1 : 0)
  const keptContentLines = Math.min(
    windowHeader ? Math.max(0, headLines - 1) : headLines,
    contentLineCount
  )
  const firstLine = windowHeader ? Number(windowHeader[1]) : 1
  const totalLines = windowHeader ? Number(windowHeader[3]) : lines.length
  const lastLine = firstLine + keptContentLines - 1
  const summary = [
    head,
    // Teach the continuation instead of a dead-end "omitted" note: without it a
    // model re-reads from the top, gets an identical result, and loops.
    `[read_file summary: showing lines ${firstLine}-${lastLine} of ${totalLines}; to continue, call read_file again with the same path plus {"offset": ${lastLine + 1}} — do not re-read from line 1]`
  ].join('\n')
  return summary.length <= limits.maxChars
    ? summary
    : `${summary.slice(0, limits.maxChars)}\n[tool result truncated for selected Ollama context budget]`
}

function summarizeSearchOutput(output: string, limits: OllamaToolResultLimits): string {
  const flattened = flattenSearchOutput(output)
  const lines = flattened.split(/\r?\n/).filter(Boolean)
  if (lines.length <= limits.searchSnippetLines && flattened.length <= limits.maxChars) {
    return flattened
  }
  const head = lines.slice(0, limits.searchSnippetLines).join('\n')
  const summary = `${head}\n[workspace_search summary: ${lines.length} result lines; top ${limits.searchSnippetLines} kept]`
  return summary.length <= limits.maxChars
    ? summary
    : `${summary.slice(0, limits.maxChars)}\n[tool result truncated for selected Ollama context budget]`
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

function summarizeListDirectoryOutput(output: string, limits: OllamaToolResultLimits): string {
  const lines = output.split(/\r?\n/).filter(Boolean)
  if (lines.length <= limits.listDirMaxLines && output.length <= limits.maxChars) return output
  const head = lines.slice(0, limits.listDirMaxLines).join('\n')
  const summary = `${head}\n[list_directory summary: ${lines.length} entries; first ${limits.listDirMaxLines} kept]`
  return summary.length <= limits.maxChars
    ? summary
    : `${summary.slice(0, limits.maxChars)}\n[tool result truncated for selected Ollama context budget]`
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
  maxCharsOrLimits: number | OllamaToolResultLimits = OLLAMA_DEFAULT_TOOL_RESULT_LIMITS
): string {
  const value = String(output || '')
  if (!value) return value
  const limits = normalizeLimits(maxCharsOrLimits)
  if (toolName === 'read_file') return summarizeReadFileOutput(value, limits)
  if (
    toolName === 'workspace_search' ||
    toolName === 'workspace_symbols' ||
    toolName === 'find_files'
  ) {
    return summarizeSearchOutput(value, limits)
  }
  if (toolName === 'list_directory') return summarizeListDirectoryOutput(value, limits)
  if (value.length <= limits.maxChars) return value
  return summarizeGenericOutput(value, limits.maxChars)
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
