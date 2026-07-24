import {
  MCP_READ_FILE_WINDOW_DEFAULT_LINES,
  MCP_READ_FILE_WINDOW_MAX_LINES
} from '../index.constants'

/**
 * Efficiency audit 2026-07 — optional line windowing for the read_file MCP
 * tool. Whole-file reads of large files were truncated client-side, sending
 * agents on shell `sed` detours (often denied under read-only postures).
 *
 * Windowing slices AFTER the hardened scoped read (ScopedPathAccess), so the
 * security boundary and the byte cap are unchanged. With neither offset nor
 * limit supplied the return is byte-identical to the pre-windowing behavior —
 * zero drift for existing callers.
 */
export function windowReadFileText(
  fullText: string,
  args: { offset?: unknown; limit?: unknown }
): string {
  const offsetArg = Number(args.offset)
  const limitArg = Number(args.limit)
  const hasOffset = Number.isFinite(offsetArg) && offsetArg >= 1
  const hasLimit = Number.isFinite(limitArg) && limitArg >= 1
  if (!hasOffset && !hasLimit) return fullText
  const lines = fullText.split('\n')
  const start = hasOffset ? Math.min(Math.trunc(offsetArg), lines.length + 1) : 1
  const maxLines = hasLimit
    ? Math.min(Math.trunc(limitArg), MCP_READ_FILE_WINDOW_MAX_LINES)
    : MCP_READ_FILE_WINDOW_DEFAULT_LINES
  const slice = lines.slice(start - 1, start - 1 + maxLines)
  if (slice.length === 0) {
    return `[read_file: offset ${start} is past the end of the file (${lines.length} lines)]`
  }
  const end = start - 1 + slice.length
  return `[read_file: lines ${start}-${end} of ${lines.length}]\n${slice.join('\n')}`
}
