import type { ProviderId } from '../../../main/store/types'

const providerModelColorClass = (provider: ProviderId): string => `provider-${provider}`

const getProviderLabel = (provider: ProviderId): string => {
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
  return 'Gemini'
}

/**
 * Explain offer policy without implying that run-management maturity controls
 * provider membership. Readiness and stronger assurance are reported
 * separately; this copy is used only after the authoritative offer gate says a
 * new run cannot be created.
 */
const getProviderOfferUnavailableReason = (provider: ProviderId): string => {
  if (provider === 'gemini') {
    return 'Gemini is retired for new runs; historical chats remain available.'
  }
  if (provider === 'antigravity') {
    return 'AntiGravity needs its consent or Gemini API setup before new runs.'
  }
  return `${getProviderLabel(provider)} is not currently offered for new runs.`
}

export { getProviderLabel, getProviderOfferUnavailableReason, providerModelColorClass }
