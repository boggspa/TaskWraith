import { modelRequiresApiKey } from '../../shared/apiKeyModelIndicator'
import { mistralApiModelVibeConfig } from './MistralApiModelEnv'
import {
  MISTRAL_CREDENTIAL_ENV_VARS,
  scrubMistralCredentialEnv,
  type MistralThinkingLevel
} from './MistralCliArgs'

export type MistralCredentialLane = 'vibe-subscription' | 'byok-api-key'

export interface MistralCredentialLaunchInput {
  model: string | null | undefined
  resolvedEnv: Readonly<Record<string, string | undefined>>
  storedApiKeyPresent: boolean
  ambientApiKeyAllowed: boolean
  /** The run's Vibe thinking level, already normalized; null when it names none. */
  thinkingLevel?: MistralThinkingLevel | null
}

export interface MistralCredentialLaunchResolution {
  lane: MistralCredentialLane
  childEnv: Record<string, string | undefined>
  /**
   * Env for the desktop's read-only opening turn, which runs at thinking `off`.
   * The same object as `childEnv` unless the model is pinned through
   * VIBE_MODELS, where switching thinking over ACP would write the model into
   * the user's ~/.vibe/config.toml; that opening is pinned at `off` instead.
   */
  introductionChildEnv: Record<string, string | undefined>
  /**
   * The thinking level to request for the working turn. The input level on the
   * subscription lane. On the API-key lane it is the level the pinned session
   * opens at, so the request never needs a config write.
   */
  thinkingLevel: MistralThinkingLevel | null
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
 *
 * A launchable key-marked model is also pinned into the session through
 * VIBE_MODELS / VIBE_ACTIVE_MODEL (see MistralApiModelEnv). Without that, Vibe
 * cannot select it and the turn runs Vibe's persisted model on the API key.
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
  let introductionChildEnv = childEnv
  let thinkingLevel = input.thinkingLevel ?? null
  if (lane === 'byok-api-key' && !missingApiKey) {
    if (storedApiKeyAvailable) {
      // A TaskWraith-stored key is exact authority for MISTRAL_API_KEY only. Do
      // not let an unrelated ambient MISTRAL_TOKEN compete with it.
      childEnv.MISTRAL_API_KEY = storedApiKey
    } else {
      childEnv = { ...input.resolvedEnv }
    }
    introductionChildEnv = childEnv
    const working = mistralApiModelVibeConfig(input.model, thinkingLevel)
    const opening = mistralApiModelVibeConfig(input.model, 'off')
    if (working && opening) {
      introductionChildEnv = { ...childEnv, ...opening.env }
      childEnv = { ...childEnv, ...working.env }
      thinkingLevel = working.thinkingLevel
    }
  }

  return {
    lane,
    childEnv,
    introductionChildEnv,
    thinkingLevel,
    credentialEnvPresent,
    missingApiKey
  }
}
