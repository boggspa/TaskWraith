// Project a TaskWraith Settings Kimi API key into a managed seat's isolated
// config.toml.
//
// Kimi Code authenticates its managed provider (`[providers."managed:kimi-code"]`,
// written by `kimi login`) either from the OAuth slot named by its `.oauth`
// sub-table or from an inline `api_key`. Kimi refuses a provider that declares
// both ("apiKey and oauth ... are mutually exclusive"), so the projection sets
// `api_key` and drops that provider's `.oauth` sub-table. Everything else —
// base_url, model aliases, services — is kept, because the isolated config is
// deliberately TRANSFORMED from the user's real config rather than synthesised.
//
// The result is only ever written to the seat's private, 0600, per-turn
// config.toml, which KimiAcpHome removes after every process exit. The user's
// real ~/.kimi-code/config.toml is never modified. Pure string transforms; the
// key never appears in any returned message.

const MANAGED_PROVIDER_TABLE =
  /^\[\s*providers\s*\.\s*(?:"managed:kimi-code"|'managed:kimi-code')\s*\]\s*(?:#.*)?$/
const MANAGED_PROVIDER_OAUTH_TABLE =
  /^\[\s*providers\s*\.\s*(?:"managed:kimi-code"|'managed:kimi-code')\s*\.\s*oauth(?:\s*\.[^\]]*)?\s*\]\s*(?:#.*)?$/
const KIMI_TYPE_LINE = /^type\s*=\s*["']kimi["']\s*(?:#.*)?$/
const CREDENTIAL_LINE = /^(?:api_key|api_key_env|oauth)\s*=/

/** Printable ASCII without spaces or quotes: every real Kimi key shape, and
 *  nothing that needs TOML escaping or could break out of the string. */
const PROJECTABLE_KEY = /^[\x21\x23-\x26\x28-\x5b\x5d-\x7e]{8,512}$/

export function isProjectableKimiApiKey(apiKey: unknown): apiKey is string {
  return typeof apiKey === 'string' && PROJECTABLE_KEY.test(apiKey.trim())
}

/** Whether config.toml has the `kimi login` managed provider to attach a key to. */
export function kimiConfigHasManagedProvider(configBody: string): boolean {
  let inProvider = false
  for (const line of configBody.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (trimmed.startsWith('[')) {
      inProvider = MANAGED_PROVIDER_TABLE.test(trimmed)
      continue
    }
    if (inProvider && KIMI_TYPE_LINE.test(trimmed)) return true
  }
  return false
}

/**
 * Return `configBody` with the managed provider authenticated by `apiKey`
 * instead of OAuth, or `null` when there is no managed provider or the key is
 * not projectable (the caller then reports the seat as not authenticated).
 */
export function projectKimiManagedApiKey(configBody: string, apiKey: string): string | null {
  if (!isProjectableKimiApiKey(apiKey) || !kimiConfigHasManagedProvider(configBody)) return null
  const key = apiKey.trim()
  const out: string[] = []
  let section: 'provider' | 'provider-oauth' | 'other' = 'other'
  for (const line of configBody.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (trimmed.startsWith('[')) {
      if (MANAGED_PROVIDER_TABLE.test(trimmed)) {
        section = 'provider'
        out.push(line, `api_key = "${key}"`)
        continue
      }
      if (MANAGED_PROVIDER_OAUTH_TABLE.test(trimmed)) {
        section = 'provider-oauth'
        continue
      }
      section = 'other'
    }
    if (section === 'provider-oauth') continue
    if (section === 'provider' && CREDENTIAL_LINE.test(trimmed)) continue
    out.push(line)
  }
  return out.join('\n')
}
