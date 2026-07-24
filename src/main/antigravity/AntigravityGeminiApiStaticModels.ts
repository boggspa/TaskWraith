import { ANTIGRAVITY_GEMINI_API_MODEL_PREFIX } from './AntigravityGeminiApiModelDiscovery'

/**
 * Offer rows for the separately billed Gemini API lane when the user has a key
 * configured but live `models.list` could not be verified this pass (network
 * failure, rate limit, rejected key, lane timeout).
 *
 * WHY THIS EXISTS: AntiGravity was the one provider with no static catalogue at
 * all, so a single failed probe made it vanish from every surface — picker,
 * roster, paired device — with no message anywhere. Every other provider is
 * always offered and authenticates when you pick it (see `resolveProviderRows`:
 * gating live rows on a discovery probe previously regressed Claude off the
 * picker). These rows restore that parity for the key lane ONLY.
 *
 * The ban-risk `agy` CLI lane keeps its strict "must have completed an
 * authenticated discovery" gate and is deliberately absent here: nothing may
 * make that lane visible without a proven, consented, authenticated connection.
 *
 * Live discovery always wins — these are appended only when it yields nothing,
 * and a stale id simply fails at dispatch with the kernel's normal API error
 * rather than silently hiding the provider.
 */
const STATIC_MODEL_IDS: readonly string[] = [
  'gemini-3.1-pro',
  'gemini-3.1-flash-lite',
  'gemini-2.5-pro',
  'gemini-2.5-flash'
]

const LABEL_PREFIX = 'Gemini API'

/** Shared with live discovery so a fallback row is indistinguishable in the UI. */
export function formatAntigravityGeminiApiLabel(modelId: string): string {
  return `${LABEL_PREFIX} · ${modelId} · separate billing`
}

export function antigravityGeminiApiStaticModels(): Array<{ id: string; label: string }> {
  return STATIC_MODEL_IDS.map((modelId) => ({
    id: `${ANTIGRAVITY_GEMINI_API_MODEL_PREFIX}${modelId}`,
    label: formatAntigravityGeminiApiLabel(modelId)
  }))
}

export const ANTIGRAVITY_GEMINI_API_STATIC_MODEL_IDS = STATIC_MODEL_IDS
