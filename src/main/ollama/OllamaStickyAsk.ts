/**
 * Ollama-only sticky-ask remnants for recovery nudges.
 * Leaf module — imported by Provider and HarnessGates without cycles.
 */

export const OLLAMA_STICKY_ASK_MAX_CHARS = 240

const CURRENT_REQUEST_HEADER = 'Current user request:'

/** Same section boundaries compaction uses so sticky quotes stop at the ask body. */
const REQUEST_BLOCK_END_RE =
  /\n\n(?=(?:Recent panel context:|Recent tagged transcript:|Your role instructions:|Participant roster:|Do this turn:|Role boundary contract:|Authority and role boundary:|Dynamic ensemble state:|Workspace subject:|Workspace churn:|Scout briefs:|Shared blackboard|Bounded prior-seat summary:|Respond now as |You are a LOCAL model))/

/** Live request body only (last Current user request: … next major section). */
export function extractOllamaStickyAskText(composedPrompt: string): string {
  const text = String(composedPrompt || '')
  const start = text.lastIndexOf(CURRENT_REQUEST_HEADER)
  if (start < 0) return text.trim()
  const after = text.slice(start + CURRENT_REQUEST_HEADER.length)
  const endMatch = after.match(REQUEST_BLOCK_END_RE)
  const body =
    endMatch && typeof endMatch.index === 'number' ? after.slice(0, endMatch.index) : after
  return body.trim()
}

/** Trim and bound a request excerpt for sticky-ask remnants. */
export function boundOllamaStickyAskExcerpt(text: string): string {
  const trimmed = (text || '').trim()
  if (!trimmed) return ''
  if (trimmed.length <= OLLAMA_STICKY_ASK_MAX_CHARS) return trimmed
  return `${trimmed.slice(0, OLLAMA_STICKY_ASK_MAX_CHARS)}…`
}

/** Append `\nStill answering: «…»` when a non-empty bound excerpt is present. */
export function appendOllamaStickyAskRemnant(body: string, excerpt?: string): string {
  const bounded = boundOllamaStickyAskExcerpt(excerpt || '')
  if (!bounded) return body
  return `${body}\nStill answering: «${bounded}»`
}
