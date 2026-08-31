/**
 * The bounded fallback floors shared by the Electron catalog and the pure
 * Node Host. These are model ids only; lane admission still comes from the
 * owning consent/credential checks at each call site.
 */

export const ANTIGRAVITY_AGY_STATIC_MODEL_IDS = [
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
  'claude-opus-4-6',
  'claude-opus-4-8',
  'claude-sonnet-4-6',
  'claude-sonnet-4-5',
  'gpt-oss-120b-medium'
] as const

/** Bare Gemini model ids; the persisted/API wire namespace adds `gemini-api:`. */
export const ANTIGRAVITY_GEMINI_API_STATIC_MODEL_IDS = [
  'gemini-3.6-flash',
  'gemini-3.5-flash',
  'gemini-3.1-pro-preview',
  'gemini-3.1-flash-lite'
] as const
