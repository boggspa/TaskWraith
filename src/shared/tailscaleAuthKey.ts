/**
 * Pure, node-free validation for Tailscale auth keys — shared by the main
 * process (before invoking `tailscale up`) and the renderer (to gate the
 * "Link this Mac" button before a round-trip).
 *
 * Node auth keys look like `tskey-auth-<id>-<secret>` (or a bare `tskey-…`).
 * We deliberately REJECT `tskey-api-…` (API access tokens) and
 * `tskey-client-…` (OAuth client secrets): those are NOT node auth keys —
 * passing them to `tailscale up --auth-key` only fails, while giving false
 * confidence and routing a different class of secret down the same path.
 *
 * The charset excludes whitespace (so a key with an embedded space/newline is
 * rejected) and the length is bounded (no multi-megabyte payloads reach the
 * CLI argv / file).
 */
const AUTH_KEY_RE = /^tskey-[A-Za-z0-9-]{10,200}$/
const NON_AUTH_PREFIXES = ['tskey-api-', 'tskey-client-']

export function looksLikeTailscaleAuthKey(value: string): boolean {
  const trimmed = value.trim()
  if (!AUTH_KEY_RE.test(trimmed)) return false
  return !NON_AUTH_PREFIXES.some((prefix) => trimmed.startsWith(prefix))
}

/**
 * OAuth client SECRET for the multi-host discovery enumerator — distinct from a
 * node auth key. Tailscale OAuth client secrets are `tskey-client-<id>-<secret>`.
 * This is the credential the user provisions with the `devices:core:read` scope;
 * it lives HOST-SIDE only (never the phone) and is exchanged for a short-lived
 * access token. Same charset/length bounds as auth keys (no whitespace, capped).
 */
const OAUTH_CLIENT_SECRET_RE = /^tskey-client-[A-Za-z0-9-]{10,200}$/

export function looksLikeTailscaleOAuthClientSecret(value: string): boolean {
  return OAUTH_CLIENT_SECRET_RE.test(value.trim())
}
