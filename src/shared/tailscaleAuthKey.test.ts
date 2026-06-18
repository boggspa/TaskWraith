import { describe, expect, it } from 'vitest'
import { looksLikeTailscaleAuthKey } from './tailscaleAuthKey'

describe('looksLikeTailscaleAuthKey', () => {
  it('accepts node auth keys', () => {
    expect(looksLikeTailscaleAuthKey('tskey-auth-k7Q3xExample0123456789abcdef')).toBe(true)
    expect(looksLikeTailscaleAuthKey('  tskey-auth-kABCDEFGHIJ-secret123  ')).toBe(true)
  })

  it('rejects API tokens and OAuth client secrets (not node auth keys)', () => {
    expect(looksLikeTailscaleAuthKey('tskey-api-abcdef0123456789')).toBe(false)
    expect(looksLikeTailscaleAuthKey('tskey-client-abcdef0123456789')).toBe(false)
  })

  it('rejects junk, whitespace, and over-long input', () => {
    expect(looksLikeTailscaleAuthKey('garbage')).toBe(false)
    expect(looksLikeTailscaleAuthKey('tskey-')).toBe(false)
    expect(looksLikeTailscaleAuthKey('')).toBe(false)
    expect(looksLikeTailscaleAuthKey('tskey-auth-AAAA --advertise-exit-node')).toBe(false)
    expect(looksLikeTailscaleAuthKey('tskey-auth-AAAA\nBBBB')).toBe(false)
    expect(looksLikeTailscaleAuthKey(`tskey-${'x'.repeat(500)}`)).toBe(false)
  })
})
