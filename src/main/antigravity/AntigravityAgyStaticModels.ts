import type { AgyModel } from './AntigravityCli'

/**
 * Offer rows for the ban-risk official `agy` CLI lane when consent is recorded
 * and the binary resolves, but an authenticated `agy models` could not be
 * completed this pass (not logged in, non-zero exit, timeout, or a parse that
 * yielded nothing).
 *
 * WHY THIS EXISTS: `discoverAuthenticatedAgyModels` returns `[]` on ANY failure
 * and swallows the error, while configured-provider admission requires
 * `models.length > 0` (`isAuthenticatedAntigravityConfiguredProvider`). One
 * failed probe therefore removed AntiGravity from every surface — picker,
 * roster, paired device — with no diagnostic anywhere. The Gemini API lane
 * already had `AntigravityGeminiApiStaticModels` for exactly this failure mode;
 * this is the agy half, added at the user's explicit request (2026-07-25).
 *
 * The consent boundary is PRESERVED, and this is the part to keep intact if
 * this file is ever revisited: the floor is applied only after
 * `isAntigravityOptInEnabled` AND a resolved user-installed binary, so it can
 * never make the ban-risk lane visible on an un-consented install or one where
 * `agy` is absent. It widens "authenticated discovery succeeded" to "consented
 * install with the official binary present" — deliberately, because a silent
 * disappearance is worse than an offer row that fails loudly at dispatch.
 *
 * Ids are the offerable Gemini rows from the verbatim `agy models` catalogue,
 * refreshed 2026-08-13 after Gemini 3.7 Flash became live. Floor labels equal
 * ids deliberately: the shared picker grouping derives the same family label
 * and effort ladder that the richer live labels produce.
 *
 * Live discovery always wins: these are returned only when it yields nothing. A
 * stale id fails at dispatch with agy's own model error rather than silently
 * hiding the provider.
 */
const STATIC_AGY_MODEL_IDS: readonly string[] = [
  'gemini-3.7-flash-high',
  'gemini-3.7-flash-medium',
  'gemini-3.7-flash-low',
  'gemini-3.6-flash-high',
  'gemini-3.6-flash-medium',
  'gemini-3.6-flash-low',
  'gemini-3.5-flash-high',
  'gemini-3.5-flash-medium',
  'gemini-3.5-flash-low',
  'gemini-3.1-pro-high',
  'gemini-3.1-pro-low',
  'flash-3.7',
  'flash-3.6',
  'flash-3.5',
  // The CLI availability panel includes a mixed Claude/GPT pool; this floor
  // keeps the picker and CLI fallback usable when discovery is offline.
  'claude-opus-4-6',
  'claude-opus-4-8',
  'claude-sonnet-4-6',
  'claude-sonnet-4-5',
  'gpt-oss-120b-medium'
]

/**
 * Keep a narrow historical escape hatch: all model ids that pass through
 * `agy models` are now treated as offerable unless they are malformed.
 * `offerableAgyModels` remains the source-of-truth gate for this lane so any
 * future model-policy adjustments stay centralized here.
 */
export function isResoldFirstPartyAgyModelId(modelId: string): boolean {
  const trimmed = modelId.trim()
  return trimmed.length === 0
}

/** The one gate every agy model list must pass (live, cached, and floor). */
export function offerableAgyModels(models: readonly AgyModel[]): AgyModel[] {
  return models.filter((model) => !isResoldFirstPartyAgyModelId(model.id))
}

export function antigravityAgyStaticModels(): AgyModel[] {
  return STATIC_AGY_MODEL_IDS.map((id) => ({ id, label: id }))
}

export const ANTIGRAVITY_AGY_STATIC_MODEL_IDS = STATIC_AGY_MODEL_IDS
