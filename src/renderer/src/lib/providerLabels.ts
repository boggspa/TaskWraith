import type { ProviderId } from '../../../main/store/types'
// The map itself moved to `shared/` when main started writing provider-labelled
// transcript copy (the durable ask_user_question marker). Re-exported here so
// every existing renderer import keeps working against the one source.
import { getProviderLabel } from '../../../shared/providerLabels'

const providerModelColorClass = (provider: ProviderId): string => `provider-${provider}`

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
