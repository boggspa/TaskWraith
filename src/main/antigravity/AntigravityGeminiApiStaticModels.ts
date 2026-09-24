import { ANTIGRAVITY_GEMINI_API_MODEL_PREFIX } from './AntigravityGeminiApiModelDiscovery'
import { antigravityGeminiApiModelLabel } from './AntigravityGeminiApiModelNaming'
import { ANTIGRAVITY_GEMINI_API_STATIC_MODEL_IDS as STATIC_MODEL_IDS } from '../../shared/antigravityStaticModelIds'

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
/**
 * Refreshed 2026-07-26 against a real key. The previous list was HALF DEAD,
 * which is the worst possible state for a fallback — it exists so the provider
 * still offers something when discovery fails, and two of its four rows could
 * not run:
 *   - `gemini-3.1-pro` was not in `models.list` at all (the real id is
 *     `gemini-3.1-pro-preview`).
 *   - `gemini-2.5-flash` 404s with "no longer available to new users".
 * Every id below was verified present in live `models.list`, and
 * `gemini-3.5-flash` additionally completed a real tool-using run.
 *
 * Keep these CURRENT rather than historical: a fallback naming a retired model
 * is worse than a short list, because the failure lands at dispatch time on a
 * user who had no other option to pick.
 */
/** Shared with live discovery so a fallback row is indistinguishable in the UI. */
export function formatAntigravityGeminiApiLabel(modelId: string): string {
  return antigravityGeminiApiModelLabel(modelId)
}

export function antigravityGeminiApiStaticModels(): Array<{ id: string; label: string }> {
  return STATIC_MODEL_IDS.map((modelId) => ({
    id: `${ANTIGRAVITY_GEMINI_API_MODEL_PREFIX}${modelId}`,
    label: formatAntigravityGeminiApiLabel(modelId)
  }))
}

export { STATIC_MODEL_IDS as ANTIGRAVITY_GEMINI_API_STATIC_MODEL_IDS }
