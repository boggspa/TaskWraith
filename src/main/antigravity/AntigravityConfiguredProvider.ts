import type { ProviderId } from '../store/types'
import {
  ANTIGRAVITY_PROVIDER_ID,
  isAntigravityOptInEnabled,
  type AntigravityOptInSettingsLike
} from '../../shared/retiredProviders'

export interface AntigravityConfiguredProviderStatus {
  ready: boolean
  configuredProviders: ReadonlySet<ProviderId>
}

export interface AntigravityConfiguredProviderModel {
  id: string
  label: string
}

/**
 * The dynamic AntiGravity offer gate shared by desktop snapshot consumers and
 * paired-device projections. A persisted opt-in alone is never enough: the
 * completed S4 discovery snapshot must also contain a nonempty official model
 * catalog. This is presentation/admission state, not transport authority.
 */
export function isAuthenticatedAntigravityConfiguredProvider(
  settings: AntigravityOptInSettingsLike | null | undefined,
  status: AntigravityConfiguredProviderStatus,
  modelsByProvider: ReadonlyMap<ProviderId, readonly AntigravityConfiguredProviderModel[]>
): boolean {
  const models = modelsByProvider.get(ANTIGRAVITY_PROVIDER_ID)
  return (
    isAntigravityOptInEnabled(settings) &&
    status.ready &&
    status.configuredProviders.has(ANTIGRAVITY_PROVIDER_ID) &&
    Array.isArray(models) &&
    models.length > 0
  )
}
