// Pure Kimi credential helpers — no Electron / fs imports so the parse +
// path-order logic is unit-testable in isolation. The kimi-cli → Kimi Code
// migration moved the live credential to ~/.kimi-code/credentials/kimi-code.json
// (the legacy ~/.kimi path's token expired the evening of the migration), so
// new-first ordering is what actually reaches a valid token for the usage
// endpoint. Both generations write the same JSON shape (access_token +
// unix-seconds expires_at).

import os from 'os'
import { join } from 'path'

/**
 * Extract a non-expired access token from a Kimi credential file body. Returns
 * null for malformed JSON, a missing/blank token, or an expired one. `nowMs` is
 * injectable for deterministic expiry tests.
 */
export function selectValidKimiAccessToken(rawJson: string, nowMs: number = Date.now()): string | null {
  try {
    const parsed = JSON.parse(rawJson)
    const accessToken = String(parsed?.access_token || '').trim()
    if (!accessToken) return null
    const expiresAt = Number(parsed?.expires_at || 0)
    if (Number.isFinite(expiresAt) && expiresAt > 0 && expiresAt * 1000 <= nowMs) {
      return null
    }
    return accessToken
  } catch {
    return null
  }
}

/** Credential locations tried in order: Kimi Code home first, legacy second. */
export function kimiCredentialCandidatePaths(): string[] {
  return [
    join(os.homedir(), '.kimi-code', 'credentials', 'kimi-code.json'),
    join(os.homedir(), '.kimi', 'credentials', 'kimi-code.json')
  ]
}
