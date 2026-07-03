const SCRUBBED_CLI_ENV_KEYS = new Set([
  'APPLE_ID',
  'APPLE_API_KEY',
  'APPLE_API_KEY_ID',
  'APPLE_API_ISSUER',
  'APPLE_APP_SPECIFIC_PASSWORD',
  'APPLE_PASSWORD',
  'APPLE_TEAM_ID',
  'APPLE_KEYCHAIN_PROFILE',
  'APP_STORE_CONNECT_API_KEY',
  'APP_STORE_CONNECT_API_KEY_ID',
  'APP_STORE_CONNECT_API_ISSUER_ID',
  'ASC_KEY_ID',
  'ASC_ISSUER_ID',
  'ASC_PRIVATE_KEY',
  'CSC_LINK',
  'CSC_KEY_PASSWORD',
  'CSC_NAME',
  'MACOS_CSC_LINK',
  'MACOS_CSC_KEY_PASSWORD',
  'WINDOWS_CSC_LINK',
  'WINDOWS_CSC_KEY_PASSWORD',
  'GH_TOKEN',
  'GH_ENTERPRISE_TOKEN',
  'GITHUB_TOKEN',
  'GITHUB_ENTERPRISE_TOKEN',
  'HOMEBREW_GITHUB_API_TOKEN',
  'NPM_TOKEN',
  'NODE_AUTH_TOKEN',
  'YARN_NPM_AUTH_TOKEN',
  'FASTLANE_SESSION',
  'MATCH_PASSWORD',
  'TWINE_API_TOKEN',
  'CARGO_REGISTRY_TOKEN'
])

export function shouldScrubCliEnvKey(key: string): boolean {
  const normalized = String(key || '').trim().toUpperCase()
  if (!normalized) return false
  if (SCRUBBED_CLI_ENV_KEYS.has(normalized)) return true
  if (normalized.startsWith('ASC_')) return true
  if (normalized.startsWith('APP_STORE_CONNECT_')) return true
  if (normalized.startsWith('CSC_')) return true
  if (normalized.startsWith('MACOS_CSC_') || normalized.startsWith('WINDOWS_CSC_')) return true
  if (normalized.startsWith('CARGO_REGISTRY_')) return true
  return false
}

export function scrubCliEnv(
  env: Record<string, string | undefined>
): Record<string, string> {
  const scrubbed: Record<string, string> = {}
  for (const [key, value] of Object.entries(env)) {
    if (typeof value !== 'string') continue
    if (shouldScrubCliEnvKey(key)) continue
    scrubbed[key] = value
  }
  return scrubbed
}
