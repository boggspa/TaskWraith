import type { ProviderId } from '../../../main/store/types'
import { LIVE_SELECTABLE_PROVIDER_IDS } from '../../../shared/retiredProviders'

/**
 * Providers whose metadata read is local and cheap: Pi is an in-memory,
 * key-filtered catalogue in main and Ollama is two HTTP calls to a local
 * daemon. Neither spawns a CLI subprocess, so neither belongs in the user-idle
 * warmup queue, where Ollama sat sixth and needed a fresh 20-second window with
 * no pointer, key, wheel or focus event — a window a user who keeps working
 * never grants, and one that opening Settings itself resets. Until it ran,
 * the Providers card said "not signed in" and every Cloud row stayed disabled
 * after every launch, reload and crash, although the remembered sign-in was
 * intact the whole time.
 */
export const IMMEDIATE_PROVIDER_METADATA_IDS: readonly ProviderId[] = ['pi', 'ollama']

/** The providers the idle warmup queue owns for one boot. */
export function providerMetadataWarmupQueue(activeProvider: ProviderId): ProviderId[] {
  return (LIVE_SELECTABLE_PROVIDER_IDS as readonly ProviderId[]).filter(
    (provider) => provider !== activeProvider && !IMMEDIATE_PROVIDER_METADATA_IDS.includes(provider)
  )
}

/**
 * Providers whose full status is refreshed directly once the initial route
 * settles. Pi keeps its dedicated catalogue read; Ollama's status carries the
 * remembered Cloud sign-in, so it reaches the card and the picker without
 * waiting for an idle window. The active provider was already refreshed.
 */
export function providerMetadataBootRefreshes(activeProvider: ProviderId): ProviderId[] {
  return activeProvider === 'ollama' ? [] : ['ollama']
}

/**
 * The card the user is looking at must not be the one provider nobody asked.
 * Opening Settings is pointer and key activity that resets the idle queue, so
 * the Providers tab probes Ollama on open; other tabs ask for nothing.
 */
export function providersTabMetadataRefreshes(input: {
  showSettings: boolean
  settingsActiveTab: string
}): ProviderId[] {
  return input.showSettings && input.settingsActiveTab === 'providers' ? ['ollama'] : []
}
