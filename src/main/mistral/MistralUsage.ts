// Projected token/cost accounting for the Mistral Vibe ACP seat.
//
// ── WHY THIS ISN'T A COPY OF GrokUsage ────────────────────────────────────
// Grok projects cost from two flat module constants because every Grok CLI run
// bills at one rate. Mistral does not: the seat's two models are 15x apart on
// input and 25x apart on output.
//
//   devstral-small      $0.10 / $0.30  per Mtok
//   mistral-medium-3.5  $1.50 / $7.50  per Mtok
//
// A flat rate would therefore be wrong by more than an order of magnitude in
// one direction or the other, and this number is not cosmetic — it is the
// input to MistralQuotaEstimate, which is the ONLY signal the user has about
// how much of their plan they have consumed (Mistral publishes no numeric
// budget for any plan and exposes no quota endpoint). Mis-pricing the meter by
// 25x is the difference between "you're fine" and hitting a wall unwarned.
//
// So pricing is per-model, and an UNKNOWN model deliberately prices at the
// EXPENSIVE end rather than the cheap one. A meter that over-reports burn
// makes a user cautious; one that under-reports walks them into the wall it
// exists to prevent. Same reason MistralQuotaEstimate seeds its ceiling low.
//
// Rates are from the CLI's own bundled catalogue
// (vibe/core/config/vibe_schema.py DEFAULT_MODELS, v2.22.0) — the same source
// the CLI itself prices with, so they cannot silently disagree with what the
// user is actually billed.

import {
  estimateTokensFromChars,
  TOKEN_COUNT_CONFIDENCE_KEY,
  TOKEN_COUNT_ESTIMATED
} from '../../shared/tokenEstimate'
import { MISTRAL_MODEL_DEVSTRAL_SMALL, MISTRAL_MODEL_MEDIUM } from './MistralCliArgs'

export interface MistralModelRate {
  readonly inputUsdPerMillion: number
  readonly outputUsdPerMillion: number
}

const MISTRAL_MODEL_RATES: Readonly<Record<string, MistralModelRate>> = {
  [MISTRAL_MODEL_DEVSTRAL_SMALL]: { inputUsdPerMillion: 0.1, outputUsdPerMillion: 0.3 },
  [MISTRAL_MODEL_MEDIUM]: { inputUsdPerMillion: 1.5, outputUsdPerMillion: 7.5 },
  'mistral-large-2512': { inputUsdPerMillion: 0.5, outputUsdPerMillion: 1.5 },
  'zai-glm-5-2': { inputUsdPerMillion: 1.4, outputUsdPerMillion: 4.4 },
  'codestral-2508': { inputUsdPerMillion: 0.3, outputUsdPerMillion: 0.9 },
  'mistral-small-2603': { inputUsdPerMillion: 0.15, outputUsdPerMillion: 0.6 },
  'devstral-2512': { inputUsdPerMillion: 0.4, outputUsdPerMillion: 2.0 },
  'labs-leanstral-1-5': { inputUsdPerMillion: 0.0, outputUsdPerMillion: 0.0 },
  'mistral-medium-latest': { inputUsdPerMillion: 1.5, outputUsdPerMillion: 7.5 },
  'mistral-medium-2508': { inputUsdPerMillion: 0.4, outputUsdPerMillion: 2.0 },
  'mistral-medium-2505': { inputUsdPerMillion: 0.4, outputUsdPerMillion: 2.0 },
  'ministral-14b-2512': { inputUsdPerMillion: 0.2, outputUsdPerMillion: 0.2 },
  'ministral-8b-2512': { inputUsdPerMillion: 0.15, outputUsdPerMillion: 0.15 },
  'ministral-3b-2512': { inputUsdPerMillion: 0.1, outputUsdPerMillion: 0.1 }
}

/**
 * Rate for an unrecognised model id.
 *
 * The flagship's rate, NOT the default model's, and NOT models[0]. This is a
 * deliberate departure from `resolveModelRate` elsewhere in the codebase, whose
 * `models[0]` fallback silently mis-prices a missing row as whichever model
 * happens to sort first. Here an unknown id is far more likely to be a new
 * flagship-tier model than a new budget one, and pricing high fails safe for
 * the quota meter downstream.
 */
const MISTRAL_UNKNOWN_MODEL_RATE: MistralModelRate = MISTRAL_MODEL_RATES[MISTRAL_MODEL_MEDIUM]

export function mistralModelRate(model: string | null | undefined): MistralModelRate {
  const key = typeof model === 'string' ? model.trim().toLowerCase() : ''
  if (key === 'mistral-vibe-cli-latest') return MISTRAL_MODEL_RATES[MISTRAL_MODEL_MEDIUM]
  if (key === 'devstral-small-latest') return MISTRAL_MODEL_RATES[MISTRAL_MODEL_DEVSTRAL_SMALL]
  return MISTRAL_MODEL_RATES[key] ?? MISTRAL_UNKNOWN_MODEL_RATE
}

/**
 * Project token counts and USD cost for a completed Mistral turn.
 *
 * Vibe reports no native token usage over ACP, so — exactly like Grok — the
 * host projects from character counts. The result is tagged
 * TOKEN_COUNT_ESTIMATED so nothing downstream mistakes it for metered truth.
 */
export function estimateMistralTokenUsage(
  model: string | null | undefined,
  promptText: string | undefined,
  responseText: string | undefined,
  /** Chars streamed BEYOND the visible answer (thinking + tool payloads). */
  extraOutputChars = 0
): {
  input_tokens: number
  output_tokens: number
  total_tokens: number
  total_cost_usd: number
  [TOKEN_COUNT_CONFIDENCE_KEY]: typeof TOKEN_COUNT_ESTIMATED
} {
  const rate = mistralModelRate(model)
  const input_tokens = estimateTokensFromChars((promptText || '').length)
  const output_tokens = estimateTokensFromChars(
    (responseText || '').length + Math.max(0, extraOutputChars)
  )
  const total_cost_usd =
    (input_tokens / 1_000_000) * rate.inputUsdPerMillion +
    (output_tokens / 1_000_000) * rate.outputUsdPerMillion
  return {
    input_tokens,
    output_tokens,
    total_tokens: input_tokens + output_tokens,
    total_cost_usd,
    [TOKEN_COUNT_CONFIDENCE_KEY]: TOKEN_COUNT_ESTIMATED
  }
}
