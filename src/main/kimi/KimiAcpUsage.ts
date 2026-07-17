/**
 * Kimi Code's ACP surface does not currently expose per-turn token usage.
 * Keep the fallback deliberately simple and auditable: Kimi's own pricing
 * documentation describes a typical English token as roughly 3-4 characters,
 * so TaskWraith uses the simple 4-character approximation for text it
 * can actually observe on the ACP channel.
 *
 * This is not provider-reported billing usage. Native session history, Kimi's
 * private system prompt, and cache attribution are opaque to the ACP client,
 * so every returned stats object carries explicit estimate provenance.
 */

export const KIMI_ACP_TOKEN_ESTIMATE_SOURCE = 'kimi-acp-visible-text-estimate'

export interface KimiAcpTokenEstimateInput {
  inputChars: number
  outputChars: number
  model: string
  serviceTier?: string | null
  durationMs?: number
  totalTokenLimit?: number
}

export interface KimiAcpTokenEstimateStats extends Record<string, unknown> {
  input_tokens: number
  output_tokens: number
  total_tokens: number
  duration_ms: number
  totalTokenLimit?: number
  _taskwraith_token_count_confidence: 'estimated'
  _taskwraith_usage_source: typeof KIMI_ACP_TOKEN_ESTIMATE_SOURCE
  _taskwraith_cost_rate_model: string
}

const finiteChars = (value: number): number =>
  Number.isFinite(value) ? Math.max(0, Math.trunc(value)) : 0

const estimateTokens = (chars: number): number => Math.ceil(finiteChars(chars) / 4)

/** Count only the serialized payload length; never retain tool content here. */
export function kimiAcpVisiblePayloadChars(value: unknown): number {
  if (typeof value === 'string') return value.length
  if (value === undefined || value === null) return 0
  try {
    return JSON.stringify(value)?.length || 0
  } catch {
    return String(value).length
  }
}

/**
 * Resolve the published API row used for a projected cost without changing the
 * model shown in TaskWraith's picker or transcript. Highspeed is a K2.7 service
 * tier in the UI, but Moonshot publishes a distinct (2x) pricing row for it.
 */
export function kimiCostRateModel(model: string, serviceTier?: string | null): string {
  const normalized = String(model || '')
    .trim()
    .toLowerCase()
  if (normalized === 'kimi-k3' || normalized === 'k3' || normalized === 'kimi-code/k3') {
    return 'kimi-k3'
  }
  return serviceTier === 'fast' ? 'kimi-k2.7-code-highspeed' : 'kimi-k2.7-code'
}

export function estimateKimiAcpTokenUsage(
  input: KimiAcpTokenEstimateInput
): KimiAcpTokenEstimateStats {
  const inputTokens = estimateTokens(input.inputChars)
  const outputTokens = estimateTokens(input.outputChars)
  const totalTokenLimit = finiteChars(input.totalTokenLimit || 0)
  return {
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    total_tokens: inputTokens + outputTokens,
    duration_ms: finiteChars(input.durationMs || 0),
    ...(totalTokenLimit > 0 ? { totalTokenLimit } : {}),
    _taskwraith_token_count_confidence: 'estimated',
    _taskwraith_usage_source: KIMI_ACP_TOKEN_ESTIMATE_SOURCE,
    _taskwraith_cost_rate_model: kimiCostRateModel(input.model, input.serviceTier)
  }
}
