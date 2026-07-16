import { describe, it, expect } from 'vitest'
import { homedir } from 'os'
import { join } from 'path'
import {
  kimiCredentialCandidatePaths,
  selectValidKimiAccessToken
} from './KimiCredential'

describe('selectValidKimiAccessToken', () => {
  const future = Math.floor((Date.now() + 3_600_000) / 1000)
  const past = Math.floor((Date.now() - 3_600_000) / 1000)

  it('returns a valid, unexpired access token', () => {
    expect(
      selectValidKimiAccessToken(JSON.stringify({ access_token: 'TOK', expires_at: future }))
    ).toBe('TOK')
  })

  it('returns null for an expired token', () => {
    expect(
      selectValidKimiAccessToken(JSON.stringify({ access_token: 'TOK', expires_at: past }))
    ).toBeNull()
  })

  it('accepts a token with no expiry field', () => {
    expect(selectValidKimiAccessToken(JSON.stringify({ access_token: 'TOK' }))).toBe('TOK')
  })

  it('returns null for malformed JSON or a missing token', () => {
    expect(selectValidKimiAccessToken('not json')).toBeNull()
    expect(selectValidKimiAccessToken(JSON.stringify({ refresh_token: 'x' }))).toBeNull()
    expect(selectValidKimiAccessToken(JSON.stringify({ access_token: '   ' }))).toBeNull()
  })

  it('honours an injected clock for deterministic expiry', () => {
    const at = 1_000_000 // unix seconds
    expect(
      selectValidKimiAccessToken(JSON.stringify({ access_token: 'T', expires_at: at }), at * 1000 - 1)
    ).toBe('T')
    expect(
      selectValidKimiAccessToken(JSON.stringify({ access_token: 'T', expires_at: at }), at * 1000 + 1)
    ).toBeNull()
  })
})

describe('kimiCredentialCandidatePaths', () => {
  it('tries the Kimi Code home before the legacy home', () => {
    const paths = kimiCredentialCandidatePaths()
    // Build expectations with join — the product path.join()s, so '/'-joined
    // template strings mismatch on Windows ('\' separators).
    expect(paths[0]).toBe(join(homedir(), '.kimi-code', 'credentials', 'kimi-code.json'))
    expect(paths[1]).toBe(join(homedir(), '.kimi', 'credentials', 'kimi-code.json'))
  })
})
