/**
 * Single chars→tokens estimation authority for LIVE display surfaces.
 *
 * Three independent `/4` implementations had grown (renderer
 * `liveOutputTokens`, Grok terminal projection, Kimi-ACP estimator), each
 * counting different lanes — which is why the Working indicator's "≈N tokens"
 * tracked assistant text everywhere but thinking/tool payloads only on some
 * providers. Every estimator now routes through here, and estimated stats are
 * tagged with a confidence marker so display surfaces can keep the "≈" honest
 * even when an estimate rides the authoritative telemetry lane.
 */

export const APPROX_CHARS_PER_TOKEN = 4

/** Marker key/value carried on estimated usage stats (Kimi-ACP precedent). */
export const TOKEN_COUNT_CONFIDENCE_KEY = '_taskwraith_token_count_confidence'
export const TOKEN_COUNT_ESTIMATED = 'estimated'

export function estimateTokensFromChars(charCount: number): number {
  if (!Number.isFinite(charCount) || charCount <= 0) return 0
  return Math.ceil(charCount / APPROX_CHARS_PER_TOKEN)
}

/** Count only the serialized payload length; never retain the content. */
export function visiblePayloadChars(value: unknown): number {
  if (typeof value === 'string') return value.length
  if (value === undefined || value === null) return 0
  try {
    return JSON.stringify(value)?.length || 0
  } catch {
    return String(value).length
  }
}

/** Live estimated usage snapshot for providers with no mid-stream usage
 * envelope (Grok, Cursor pre-terminal). Shaped like provider stats so it can
 * ride the existing working-telemetry reporters unchanged. */
export function buildEstimatedStreamUsage(counts: {
  outputChars: number
  inputChars?: number
}): Record<string, unknown> {
  const output_tokens = estimateTokensFromChars(counts.outputChars)
  const input_tokens = estimateTokensFromChars(counts.inputChars || 0)
  return {
    input_tokens,
    output_tokens,
    total_tokens: input_tokens + output_tokens,
    [TOKEN_COUNT_CONFIDENCE_KEY]: TOKEN_COUNT_ESTIMATED
  }
}

/** True when a stats object self-identifies as a chars→tokens estimate. */
export function statsAreEstimated(stats: Record<string, unknown> | null | undefined): boolean {
  return Boolean(stats) && stats?.[TOKEN_COUNT_CONFIDENCE_KEY] === TOKEN_COUNT_ESTIMATED
}
