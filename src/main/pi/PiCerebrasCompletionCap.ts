import { writePiCerebrasModelRegistration } from '../../host-shared/pi/PiCerebrasModelRegistration'
import {
  PI_CEREBRAS_30K_TPM_RECOMMENDED_MAX_COMPLETION_TOKENS,
  PI_CEREBRAS_MODEL_MAX_COMPLETION_TOKENS,
  normalizePiCerebrasMaxCompletionTokens
} from '../../shared/piCerebrasCompletionCap'

export {
  PI_CEREBRAS_30K_TPM_RECOMMENDED_MAX_COMPLETION_TOKENS,
  PI_CEREBRAS_MODEL_MAX_COMPLETION_TOKENS,
  normalizePiCerebrasMaxCompletionTokens
}

/**
 * Pi reads `models.json` from PI_CODING_AGENT_DIR. TaskWraith gives every
 * run a fresh, owner-only directory. Register the selected Cerebras model and
 * its optional cap together, without changing the user's global Pi config.
 */
export function writePiCerebrasCompletionCapOverride(input: {
  isolatedHomeDir: string
  modelId: string
  maxCompletionTokens?: number
}): void {
  writePiCerebrasModelRegistration(input)
}

/** One predicate for "a Cerebras model hit a rate wall" — shared by the
 * error enrichment and the dispatch governor's 429 backoff so the two can
 * never drift apart on what counts as a Cerebras 429. */
export function isPiCerebrasRateLimitError(model: string, message: string): boolean {
  return model.startsWith('cerebras/') && /(?:^|\D)429(?:\D|$)/.test(message)
}

/**
 * Cerebras's 429 body is sometimes empty. Keep the raw error intact while
 * attaching the actionable Pi-specific explanation only for a Cerebras model.
 */
export function enrichPiCerebrasRateLimitError(model: string, message: string): string {
  if (!isPiCerebrasRateLimitError(model, message)) {
    return message
  }
  return `${message}\n\nCerebras rate-limit note: Pi normally requests up to ${PI_CEREBRAS_MODEL_MAX_COMPLETION_TOKENS.toLocaleString()} completion tokens. Cerebras reserves prompt tokens plus that requested completion budget before it records usage, so a 30,000 TPM project allocation can reject this turn before processing—even when the organization-level limit is higher. In Settings → Providers → Pi, apply a lower Cerebras completion cap (${PI_CEREBRAS_30K_TPM_RECOMMENDED_MAX_COMPLETION_TOKENS.toLocaleString()} is a conservative starting point for 30k TPM), or raise the API key's Cerebras project allocation. Other 429s, including Cerebras's 5-RPM project limit, can still occur.`
}
