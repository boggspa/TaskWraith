// Credential-state probe for the Devin seat.
//
// Devin's credential lanes are fully observable without spawning the binary:
// the ambient WINDSURF_API_KEY / DEVIN_API_KEY (behind devinAmbientApiKeyEnabled)
// and the CLI's own credentials.toml written by `devin auth login`. The status
// card (CliProviderRuntime → summariseDevinStatus) and the configured-provider
// detector (getDevinConfiguredCredentialPresent) both read this one predicate,
// so picker admission and the sign-in card can never disagree about the same
// key. It reuses the launch-lane resolver so "signed in" means exactly "a run
// would launch with a credential".
//
// Pure: reads only the env passed in and the credentials file. It reports
// presence, never the key value, and never touches the network.

import { resolveDevinCredentialLaunch, type DevinCredentialLane } from './DevinCredentialLane'
import type { DevinCredentialStoreOptions } from './DevinCredentialStore'

/**
 * Vocabulary shared with ProviderAuthStatus.deriveAuthState('devin') and the
 * renderer's summariseDevinStatus: both treat 'windsurf-api-key' and
 * 'authenticated' as signed in and 'missing' as not signed in.
 */
export type DevinCredentialAuthState = 'windsurf-api-key' | 'authenticated' | 'missing'

export interface DevinCredentialProbeInput {
  env: Readonly<Record<string, string | undefined>>
  ambientApiKeyAllowed: boolean
  credentialStoreOptions?: DevinCredentialStoreOptions
}

export interface DevinCredentialProbeResult {
  credentialPresent: boolean
  /** The lane a launch would use; null when no credential is available. */
  authSource: Exclude<DevinCredentialLane, 'none'> | null
  authState: DevinCredentialAuthState
}

export function probeDevinCredentialState(
  input: DevinCredentialProbeInput
): DevinCredentialProbeResult {
  const resolution = resolveDevinCredentialLaunch({
    resolvedEnv: input.env,
    storedApiKeyPresent: false,
    ambientApiKeyAllowed: input.ambientApiKeyAllowed,
    ...(input.credentialStoreOptions
      ? { credentialStoreOptions: input.credentialStoreOptions }
      : {})
  })
  if (resolution.lane === 'none') {
    return { credentialPresent: false, authSource: null, authState: 'missing' }
  }
  return {
    credentialPresent: true,
    authSource: resolution.lane,
    authState: resolution.lane === 'env-key' ? 'windsurf-api-key' : 'authenticated'
  }
}
