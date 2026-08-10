import type { ProviderId } from '../main/store/types'

/**
 * The human name for a provider.
 *
 * Lives in `shared/` because main now writes provider-labelled transcript copy
 * of its own (the durable `ask_user_question` marker), and a second copy of
 * this map in main would drift the moment a provider is added — silently
 * calling the newcomer "Gemini", which is what the fallback returns.
 * `renderer/src/lib/providerLabels.ts` re-exports this one.
 */
export function getProviderLabel(provider: ProviderId): string {
  if (provider === 'codex') return 'Codex'
  if (provider === 'claude') return 'Claude'
  if (provider === 'kimi') return 'Kimi'
  if (provider === 'grok') return 'Grok'
  if (provider === 'cursor') return 'Cursor'
  if (provider === 'ollama') return 'Ollama'
  // AntiGravity predates nothing here — it was simply missing, so every
  // surface using this map (run labels, working indicator, failure copy,
  // composer placeholder) called the provider "Gemini".
  if (provider === 'antigravity') return 'AntiGravity'
  if (provider === 'pi') return 'Pi'
  if (provider === 'mistral') return 'Mistral'
  if (provider === 'muse') return 'Muse'
  return 'Gemini'
}
