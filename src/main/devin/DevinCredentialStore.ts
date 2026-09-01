import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

/**
 * Parsed Devin credentials from ~/.local/share/devin/credentials.toml
 * (Windows: %APPDATA%\devin\credentials.toml).
 *
 * Written by `devin auth login`. Contains windsurf_api_key + api_server_url.
 */
export interface DevinStoredCredentials {
  apiKey: string | null
  apiServerUrl: string | null
}

export interface DevinCredentialStoreOptions {
  /** Override the credentials file path (for testing). */
  credentialsPath?: string
  /** Override platform detection (for testing). */
  platform?: NodeJS.Platform
}

const MAX_CREDENTIALS_FILE_BYTES = 64 * 1024

/**
 * Resolve the default credentials.toml path for the current platform.
 */
export function defaultDevinCredentialsPath(platform: NodeJS.Platform = process.platform): string {
  if (platform === 'win32') {
    const appData = process.env.APPDATA || join(homedir(), 'AppData', 'Roaming')
    return join(appData, 'devin', 'credentials.toml')
  }
  return join(homedir(), '.local', 'share', 'devin', 'credentials.toml')
}

/**
 * Minimal TOML parser for Devin's flat key-value credentials file.
 *
 * Devin's credentials.toml uses a simple structure:
 *   windsurf_api_key = "sk-..."
 *   api_server_url = "https://..."
 *
 * This parser handles flat key-value pairs (no nested tables, no arrays).
 * It is NOT a general-purpose TOML parser — only what Devin writes.
 */
function parseFlatToml(raw: string): Record<string, string> {
  const result: Record<string, string> = {}
  for (const line of raw.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const eqIndex = trimmed.indexOf('=')
    if (eqIndex < 0) continue
    const key = trimmed.slice(0, eqIndex).trim()
    const rawValue = trimmed.slice(eqIndex + 1).trim()
    // Strip surrounding quotes
    const value =
      rawValue.startsWith('"') && rawValue.endsWith('"')
        ? rawValue.slice(1, -1)
        : rawValue.startsWith("'") && rawValue.endsWith("'")
          ? rawValue.slice(1, -1)
          : rawValue
    result[key] = value
  }
  return result
}

/**
 * Read and parse Devin's stored credentials from credentials.toml.
 *
 * Returns null fields when the file is missing, unreadable, or empty.
 * Never throws — all errors are swallowed and reported as null values.
 */
export function readDevinStoredCredentials(
  options: DevinCredentialStoreOptions = {}
): DevinStoredCredentials {
  const credentialsPath = options.credentialsPath ?? defaultDevinCredentialsPath(options.platform)

  if (!existsSync(credentialsPath)) {
    return { apiKey: null, apiServerUrl: null }
  }

  let raw: string
  try {
    raw = readFileSync(credentialsPath, 'utf8')
  } catch {
    return { apiKey: null, apiServerUrl: null }
  }

  if (raw.length > MAX_CREDENTIALS_FILE_BYTES) {
    return { apiKey: null, apiServerUrl: null }
  }

  const parsed = parseFlatToml(raw)

  // Devin writes windsurf_api_key (snake_case). Accept both forms.
  const apiKey = parsed.windsurf_api_key || parsed.api_key || null
  const apiServerUrl = parsed.api_server_url || null

  return {
    apiKey: apiKey && apiKey.trim() ? apiKey.trim() : null,
    apiServerUrl: apiServerUrl && apiServerUrl.trim() ? apiServerUrl.trim() : null
  }
}

/**
 * Validate an API server URL for Devin.
 *
 * Rules (from Synara source):
 * - HTTPS only, except HTTP allowed on loopback (127.0.0.1, localhost, ::1)
 * - No embedded credentials (user:pass@)
 * - Hash/query are stripped (not rejected)
 *
 * Returns the normalized URL string, or null if invalid.
 */
export function validateDevinApiServerUrl(raw: string | null): string | null {
  if (!raw || !raw.trim()) return null
  const trimmed = raw.trim()

  let url: URL
  try {
    url = new URL(trimmed)
  } catch {
    return null
  }

  // Strip hash and query
  url.hash = ''
  url.search = ''

  // Reject embedded credentials
  if (url.username || url.password) return null

  // HTTPS required, except loopback
  const isLoopback =
    url.hostname === '127.0.0.1' ||
    url.hostname === 'localhost' ||
    url.hostname === '::1' ||
    url.hostname === '[::1]'
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && isLoopback)) return null

  return url.toString()
}
