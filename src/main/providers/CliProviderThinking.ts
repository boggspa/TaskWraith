export interface CliProviderThinkingMergeOptions {
  cumulative?: boolean
}

/** Whether an incoming thinking chunk should be ignored. */
export function shouldIgnoreCliProviderThinkingChunk(
  text: string,
  options: CliProviderThinkingMergeOptions = {}
): boolean {
  if (!text) return true
  // Claude/Kimi cumulative envelopes may be whitespace-only when thinking is redacted.
  if (options.cumulative) return !text.trim()
  // Grok/Cursor append deltas preserve whitespace (match content token handling).
  return false
}

/**
 * Merge one thinking chunk into accumulated text. Returns null when the chunk is
 * ignored or would not change the accumulated trace.
 */
export function mergeCliProviderThinkingChunk(
  accumulated: string | undefined,
  text: string,
  options: CliProviderThinkingMergeOptions = {}
): string | null {
  if (shouldIgnoreCliProviderThinkingChunk(text, options)) return null
  if (options.cumulative) {
    const current = accumulated || ''
    if (text === current) return null
    return text
  }
  return `${accumulated || ''}${text}`
}