// Which file under `<KIMI_CODE_HOME>/credentials/` holds the Kimi Code OAuth
// login that the managed provider will actually use.
//
// Kimi Code 2.x scopes OAuth storage by environment. A login against the
// default (mainland, auth.kimi.com) hosts keeps the historical slot
// `oauth/kimi-code` -> `credentials/kimi-code.json`. Any other environment —
// including the global region (auth.kimi.ai / api.kimi.ai) — gets a hashed
// slot `oauth/kimi-code-env-<16 hex>` -> `credentials/kimi-code-env-<hex>.json`,
// and `kimi login` records that slot in config.toml:
//
//   [providers."managed:kimi-code".oauth]
//   storage = "file"
//   key = "oauth/kimi-code-env-0123456789abcdef"
//
// The runtime reads its credential from the slot config.toml names, so every
// TaskWraith reader (managed-run admission, Settings status, usage, sign-out)
// must resolve the same slot instead of assuming `kimi-code.json`.
//
// Pure string parsing only: no fs, no credential contents.

/** The default-environment Kimi Code OAuth slot name. */
export const KIMI_DEFAULT_OAUTH_CREDENTIAL_NAME = 'kimi-code'

/** The provider table `kimi login` provisions in config.toml. */
export const KIMI_MANAGED_PROVIDER_NAME = 'managed:kimi-code'

const MANAGED_PROVIDER_OAUTH_TABLE =
  /^\[\s*providers\s*\.\s*(?:"managed:kimi-code"|'managed:kimi-code')\s*\.\s*oauth\s*\]\s*(?:#.*)?$/

const OAUTH_KEY_LINE = /^key\s*=\s*(["'])oauth\/([^"']*)\1\s*(?:#.*)?$/

/**
 * Mirrors Kimi's own FileTokenStorage rule (a bare basename that does not
 * start with a dot), narrowed to a conservative character set so the result
 * can never name a path outside `credentials/`.
 */
const SAFE_SLOT_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/

/**
 * Resolve the OAuth slot name the managed Kimi Code provider is bound to.
 * Returns the default slot when config.toml is absent or names no slot, and
 * `null` when it names a slot TaskWraith cannot safely map to a file.
 */
export function kimiOAuthCredentialName(configBody: string | null | undefined): string | null {
  if (!configBody) return KIMI_DEFAULT_OAUTH_CREDENTIAL_NAME
  let inManagedOAuthTable = false
  for (const line of configBody.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (trimmed.startsWith('[')) {
      inManagedOAuthTable = MANAGED_PROVIDER_OAUTH_TABLE.test(trimmed)
      continue
    }
    if (!inManagedOAuthTable) continue
    const match = trimmed.match(OAUTH_KEY_LINE)
    if (!match) continue
    const name = match[2]
    return SAFE_SLOT_NAME.test(name) && !name.includes('..') ? name : null
  }
  return KIMI_DEFAULT_OAUTH_CREDENTIAL_NAME
}

/** `credentials/`-relative file name for the managed OAuth slot, or null. */
export function kimiOAuthCredentialFileName(configBody: string | null | undefined): string | null {
  const name = kimiOAuthCredentialName(configBody)
  return name ? `${name}.json` : null
}
