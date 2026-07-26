import {
  ANTIGRAVITY_PROVIDER_ID,
  DEFAULT_PROVIDER,
  isAntigravityOptInEnabled,
  isLiveSelectableProvider
} from '../../shared/retiredProviders'
import { isAntigravityGeminiApiKeyConfigured } from '../antigravity/AntigravityGeminiApiKeyConfiguredSignal'
import type { AppSettings, ProviderId } from './types'

/**
 * Coerces persisted active/default selections without collapsing an admitted
 * conditional AntiGravity lane into Claude. This is persistence normalization,
 * not dispatch authority; every new run still crosses its runtime admission
 * boundary.
 */
export function coerceProviderForPersistence(
  provider: ProviderId | null | undefined,
  settings: Pick<AppSettings, 'antigravityEnabled' | 'antigravityOptInAcceptedAt'>,
  isGeminiApiKeyConfigured: () => boolean = isAntigravityGeminiApiKeyConfigured
): ProviderId {
  if (isLiveSelectableProvider(provider)) return provider
  if (
    provider === ANTIGRAVITY_PROVIDER_ID &&
    (isAntigravityOptInEnabled(settings) || isGeminiApiKeyConfigured())
  ) {
    return provider
  }
  return DEFAULT_PROVIDER
}
