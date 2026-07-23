import type { ProviderId } from '../store/types'
import {
  ANTIGRAVITY_PROVIDER_ID,
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
 * paired-device projections. The completed discovery snapshot is the
 * admission boundary: its AntiGravity entry can come from either the
 * consented agy lane or the configured Gemini API-key lane, and must contain a
 * nonempty official model catalog. This is presentation/admission state, not
 * transport authority.
 */
export function isAuthenticatedAntigravityConfiguredProvider(
  _settings: AntigravityOptInSettingsLike | null | undefined,
  status: AntigravityConfiguredProviderStatus,
  modelsByProvider: ReadonlyMap<ProviderId, readonly AntigravityConfiguredProviderModel[]>
): boolean {
  const models = modelsByProvider.get(ANTIGRAVITY_PROVIDER_ID)
  return (
    status.ready &&
    status.configuredProviders.has(ANTIGRAVITY_PROVIDER_ID) &&
    Array.isArray(models) &&
    models.length > 0
  )
}
