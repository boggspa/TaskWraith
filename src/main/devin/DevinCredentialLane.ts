import {
  DEVIN_API_KEY_ENV,
  DEVIN_API_SERVER_URL_ENV,
  DEVIN_API_SERVER_URL_ENV_ALT,
  DEVIN_CREDENTIAL_ENV_VARS,
  DEVIN_ENDPOINT_ENV_VARS,
  scrubDevinCredentialEnv
} from './DevinCliArgs'
import {
  readDevinStoredCredentials,
  validateDevinApiServerUrl,
  type DevinCredentialStoreOptions
} from './DevinCredentialStore'

export type DevinCredentialLane = 'env-key' | 'stored-toml' | 'none'

export interface DevinCredentialLaunchInput {
  resolvedEnv: Readonly<Record<string, string | undefined>>
  storedApiKeyPresent: boolean
  ambientApiKeyAllowed: boolean
  /**
   * Explicit `devinApiServerUrl` from TaskWraith settings. When non-empty it
   * WINS over both endpoint env vars and the stored credentials.toml
   * `api_server_url`: the user typed it into the UI on purpose. It is validated
   * by validateDevinApiServerUrl before it reaches the child; an invalid value
   * is reported through `settingsApiServerUrlRejected` and is never silently
   * replaced by a different endpoint.
   */
  settingsApiServerUrl?: string | null
  credentialStoreOptions?: DevinCredentialStoreOptions
}

export interface DevinCredentialLaunchResolution {
  lane: DevinCredentialLane
  childEnv: Record<string, string | undefined>
  credentialEnvPresent: boolean
  missingApiKey: boolean
  apiServerUrl: string | null
  /**
   * True when `settingsApiServerUrl` was non-empty but failed validation. The
   * caller must refuse to launch: falling through to the env/TOML endpoint
   * would send a run the user pointed at a custom server to a different one.
   */
  settingsApiServerUrlRejected: boolean
}

/**
 * Find the first non-empty Devin API key from the environment.
 */
function findEnvApiKey(
  env: Readonly<Record<string, string | undefined>>
): string | null {
  for (const key of DEVIN_CREDENTIAL_ENV_VARS) {
    const value = env[key]
    if (typeof value === 'string' && value.trim().length > 0) return value.trim()
  }
  return null
}

/**
 * Find the first non-empty Devin API server URL from the environment.
 */
function findEnvApiServerUrl(
  env: Readonly<Record<string, string | undefined>>
): string | null {
  for (const key of [DEVIN_API_SERVER_URL_ENV, DEVIN_API_SERVER_URL_ENV_ALT]) {
    const value = env[key]
    if (typeof value === 'string' && value.trim().length > 0) return value.trim()
  }
  return null
}

/**
 * Resolve the explicit settings endpoint.
 *   - `{ url }`            non-empty and valid → this URL wins
 *   - `{ rejected: true }` non-empty but invalid → caller must refuse to launch
 *   - `null`               empty/unset → fall through to env, then TOML
 */
function resolveSettingsApiServerUrl(
  raw: string | null | undefined
): { url: string; rejected: false } | { url: null; rejected: true } | null {
  if (typeof raw !== 'string' || raw.trim().length === 0) return null
  const validated = validateDevinApiServerUrl(raw)
  return validated ? { url: validated, rejected: false } : { url: null, rejected: true }
}

/**
 * Inject an explicit settings endpoint. BOTH endpoint env vars are cleared
 * first so an ambient `DEVIN_API_SERVER_URL` alias cannot outvote the setting
 * inside the CLI; only the canonical var is then written.
 */
function injectExplicitApiServerUrl(
  childEnv: Record<string, string | undefined>,
  url: string
): void {
  for (const key of DEVIN_ENDPOINT_ENV_VARS) delete childEnv[key]
  childEnv[DEVIN_API_SERVER_URL_ENV] = url
}

/**
 * Resolve the credential lane for a Devin ACP launch.
 *
 * Resolution order:
 *   1. Env key (WINDSURF_API_KEY / DEVIN_API_KEY) — if ambient allowed or stored
 *   2. Stored credentials.toml — if present
 *   3. None — missing
 *
 * The child environment always has credential env vars scrubbed first, then
 * the authoritative key is injected from the resolved lane. This prevents
 * ambient keys from leaking when the lane resolves to stored-toml.
 *
 * Endpoint precedence (independent of the key lane): explicit settings URL >
 * endpoint env vars > stored credentials.toml `api_server_url`.
 */
export function resolveDevinCredentialLaunch(
  input: DevinCredentialLaunchInput
): DevinCredentialLaunchResolution {
  const envApiKey = findEnvApiKey(input.resolvedEnv)
  const credentialEnvPresent = envApiKey !== null
  const settingsUrl = resolveSettingsApiServerUrl(input.settingsApiServerUrl)
  const settingsApiServerUrlRejected = settingsUrl?.rejected === true
  const explicitUrl = settingsUrl && !settingsUrl.rejected ? settingsUrl.url : null

  // Lane 1: env key (ambient or TaskWraith-stored)
  const storedKeyInEnv =
    input.storedApiKeyPresent && credentialEnvPresent
  const ambientKeyAllowed = input.ambientApiKeyAllowed && credentialEnvPresent

  if (storedKeyInEnv || ambientKeyAllowed) {
    const childEnv = scrubDevinCredentialEnv({ ...input.resolvedEnv })
    // Inject the canonical key
    childEnv[DEVIN_API_KEY_ENV] = envApiKey!
    // Explicit setting wins; otherwise pass the env endpoint through as before.
    const envUrl = findEnvApiServerUrl(input.resolvedEnv)
    if (explicitUrl) {
      injectExplicitApiServerUrl(childEnv, explicitUrl)
    } else if (envUrl) {
      childEnv[DEVIN_API_SERVER_URL_ENV] = envUrl
    }
    return {
      lane: 'env-key',
      childEnv,
      credentialEnvPresent: true,
      missingApiKey: false,
      apiServerUrl: explicitUrl ?? validateDevinApiServerUrl(envUrl),
      settingsApiServerUrlRejected
    }
  }

  // Lane 2: stored credentials.toml
  const stored = readDevinStoredCredentials(input.credentialStoreOptions)
  if (stored.apiKey) {
    const childEnv = scrubDevinCredentialEnv({ ...input.resolvedEnv })
    childEnv[DEVIN_API_KEY_ENV] = stored.apiKey
    if (explicitUrl) {
      injectExplicitApiServerUrl(childEnv, explicitUrl)
    } else if (stored.apiServerUrl) {
      childEnv[DEVIN_API_SERVER_URL_ENV] = stored.apiServerUrl
    }
    return {
      lane: 'stored-toml',
      childEnv,
      credentialEnvPresent: true,
      missingApiKey: false,
      apiServerUrl: explicitUrl ?? validateDevinApiServerUrl(stored.apiServerUrl),
      settingsApiServerUrlRejected
    }
  }

  // Lane 3: no credentials
  const childEnv = scrubDevinCredentialEnv({ ...input.resolvedEnv })
  return {
    lane: 'none',
    childEnv,
    credentialEnvPresent: false,
    missingApiKey: true,
    apiServerUrl: null,
    settingsApiServerUrlRejected
  }
}
