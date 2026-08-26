import { modelRequiresApiKey } from '../../shared/apiKeyModelIndicator'
import { MISTRAL_CREDENTIAL_ENV_VARS, scrubMistralCredentialEnv } from './MistralCliArgs'

export type MistralCredentialLane = 'vibe-subscription' | 'byok-api-key'

export interface MistralCredentialLaunchInput {
  model: string | null | undefined
  resolvedEnv: Readonly<Record<string, string | undefined>>
  storedApiKeyPresent: boolean
  ambientApiKeyAllowed: boolean
}

export interface MistralCredentialLaunchResolution {
  lane: MistralCredentialLane
  childEnv: Record<string, string | undefined>
  credentialEnvPresent: boolean
  missingApiKey: boolean
}

/**
 * Resolve the credential lane from the model, never from credential presence.
 *
 * The picker uses `modelRequiresApiKey` to mark Mistral's API-only rows. Reusing
 * that predicate here makes the visible split executable: Vibe's two plan
 * models always have ambient/stored API credentials removed, while a key-marked
 * model can retain a credential only when it came from TaskWraith's encrypted
 * store or the user explicitly allowed an ambient BYOK key.
 */
export function resolveMistralCredentialLaunch(
  input: MistralCredentialLaunchInput
): MistralCredentialLaunchResolution {
  const lane: MistralCredentialLane = modelRequiresApiKey('mistral', input.model)
    ? 'byok-api-key'
    : 'vibe-subscription'
  const credentialEnvPresent = MISTRAL_CREDENTIAL_ENV_VARS.some((name) => {
    const value = input.resolvedEnv[name]
    return typeof value === 'string' && value.trim().length > 0
  })
  const storedApiKey = input.resolvedEnv.MISTRAL_API_KEY
  const storedApiKeyAvailable =
    input.storedApiKeyPresent && typeof storedApiKey === 'string' && storedApiKey.trim().length > 0
  const ambientApiKeyAvailable = input.ambientApiKeyAllowed && credentialEnvPresent
  const missingApiKey = lane === 'byok-api-key' && !storedApiKeyAvailable && !ambientApiKeyAvailable

  let childEnv = scrubMistralCredentialEnv({ ...input.resolvedEnv })
  if (lane === 'byok-api-key' && !missingApiKey) {
    if (storedApiKeyAvailable) {
      // A TaskWraith-stored key is exact authority for MISTRAL_API_KEY only. Do
      // not let an unrelated ambient MISTRAL_TOKEN compete with it.
      childEnv.MISTRAL_API_KEY = storedApiKey
    } else {
      childEnv = { ...input.resolvedEnv }
    }
  }

  return {
    lane,
    childEnv,
    credentialEnvPresent,
    missingApiKey
  }
}
