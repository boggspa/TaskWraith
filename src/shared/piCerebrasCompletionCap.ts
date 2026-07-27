/**
 * Pi passes a model's `maxTokens` through to Cerebras as
 * `max_completion_tokens`. Cerebras rate-limits the requested input plus
 * completion budget before a request is processed, so its 30k TPM starter
 * tier cannot accept Pi's bundled 40,960-token Cerebras model ceiling.
 *
 * This is intentionally an explicit user setting, not a silent catalogue
 * reduction: higher-quota Cerebras organizations should retain the models'
 * full advertised completion capacity.
 */
export const PI_CEREBRAS_MODEL_MAX_COMPLETION_TOKENS = 40_960

/** A conservative first cap for Cerebras organizations limited to 30k TPM. */
export const PI_CEREBRAS_30K_TPM_RECOMMENDED_MAX_COMPLETION_TOKENS = 16_384

/**
 * Accept only a positive whole-token cap no larger than Pi's bundled
 * Cerebras model maximum. Undefined means "use Pi's model default".
 */
export function normalizePiCerebrasMaxCompletionTokens(value: unknown): number | undefined {
  if (
    typeof value !== 'number' ||
    !Number.isFinite(value) ||
    !Number.isInteger(value) ||
    value < 1 ||
    value > PI_CEREBRAS_MODEL_MAX_COMPLETION_TOKENS
  ) {
    return undefined
  }
  return value
}
