/**
 * Which model rows earn the API-key glyph.
 *
 * WHY THIS EXISTS: model labels used to carry their lane in the string
 * ("Gemini API: 2.5 Flash-Lite"). In a tight picker that produced rows of
 * truncated near-identical text, so the prefixes were dropped — which left no
 * way at all to tell an API-key model from a subscription/CLI one. This restores
 * the distinction as a glyph instead of prose: same role as the Fast bolt, one
 * quiet mark on the row rather than words competing with the model name.
 *
 * Node-free and provider-typed as plain strings, same discipline as
 * `retiredProviders.ts` — shared must not import main's `ProviderId`.
 *
 * The predicate is deliberately narrow. It marks models that CANNOT run without
 * a user-supplied API key, not models that merely could bill per token. Claude,
 * Codex, Kimi, Grok and Cursor all authenticate with a subscription or CLI login
 * by default; that a Claude run may pick up `ANTHROPIC_API_KEY` is a per-run
 * credential choice, not a property of the model, so those rows stay unmarked.
 * Do NOT reach for `API_SPEND_PROVIDER_ORDER` here: that list is a spend-view
 * accounting roster (it includes the projected-equivalent providers) and would
 * mark almost every row, which is the same as marking none.
 */

import { ANTIGRAVITY_GEMINI_API_MODEL_ID_PREFIX } from './antigravityGeminiApiModelNaming'

/**
 * Providers where EVERY model needs the user's own key. Pi is BYOK-only by
 * construction (per-upstream keys in `PiKeyStore`; the picker fails closed to an
 * empty model list without one).
 */
const BYOK_ONLY_PROVIDERS: ReadonlySet<string> = new Set(['pi'])

/**
 * Providers with BOTH lanes, where the model id decides:
 * - AntiGravity: `gemini-api:` ids run on the key via the official SDK, while every
 *   other id runs the `agy` CLI on the user's own subscription login.
 * - Mistral: `devstral-small` and `mistral-medium-3.5` run on the Vibe subscription
 *   by default, while API-only models (Mistral Large 3, GLM 5.2, Codestral, Ministral, etc.)
 *   run on the user's Mistral API key (BYOK).
 */
const MIXED_LANE_PROVIDERS: ReadonlySet<string> = new Set(['antigravity', 'mistral'])

const MISTRAL_SUBSCRIPTION_MODELS: ReadonlySet<string> = new Set([
  'devstral-small',
  'devstral-small-latest',
  'mistral-medium-3.5',
  'mistral-vibe-cli-latest'
])

/** Tooltip/aria text. One string so every surface says the same thing. */
export const API_KEY_MODEL_INDICATOR_LABEL =
  'Runs on your API key — billed per token, separate from any subscription'

export function modelRequiresApiKey(
  provider: string | null | undefined,
  modelId: string | null | undefined
): boolean {
  const normalizedProvider = typeof provider === 'string' ? provider.trim().toLowerCase() : ''
  if (!normalizedProvider) return false
  if (BYOK_ONLY_PROVIDERS.has(normalizedProvider)) return true
  if (!MIXED_LANE_PROVIDERS.has(normalizedProvider)) return false
  const normalizedModel = typeof modelId === 'string' ? modelId.trim().toLowerCase() : ''
  if (normalizedProvider === 'antigravity') {
    return normalizedModel.startsWith(ANTIGRAVITY_GEMINI_API_MODEL_ID_PREFIX)
  }
  if (normalizedProvider === 'mistral') {
    return !MISTRAL_SUBSCRIPTION_MODELS.has(normalizedModel)
  }
  return false
}
