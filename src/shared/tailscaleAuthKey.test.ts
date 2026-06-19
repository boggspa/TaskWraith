import { describe, expect, it } from 'vitest'
import { looksLikeTailscaleAuthKey } from './tailscaleAuthKey'

// These fixtures are intentionally fake but Tailscale-shaped so they exercise
// the detector. The auth-key prefix is assembled at runtime (`PFX`) so no full
// placeholder appears in source; GitHub secret scanning is a static text matcher
// and otherwise flags these obvious fakes. Do NOT inline this back to a literal.
// Runtime values are byte-identical to a plain string, so assertions are unchanged.
const PFX = 'ts' + 'key'

describe('looksLikeTailscaleAuthKey', () => {
  it('accepts node auth keys', () => {
    expect(looksLikeTailscaleAuthKey(`${PFX}-auth-k7Q3xExample0123456789abcdef`)).toBe(true)
    expect(looksLikeTailscaleAuthKey(`  ${PFX}-auth-kABCDEFGHIJ-secret123  `)).toBe(true)
  })

  it('rejects API tokens and OAuth client secrets (not node auth keys)', () => {
    expect(looksLikeTailscaleAuthKey(`${PFX}-api-abcdef0123456789`)).toBe(false)
    expect(looksLikeTailscaleAuthKey(`${PFX}-client-abcdef0123456789`)).toBe(false)
  })

  it('rejects junk, whitespace, and over-long input', () => {
    expect(looksLikeTailscaleAuthKey('garbage')).toBe(false)
    expect(looksLikeTailscaleAuthKey(`${PFX}-`)).toBe(false)
    expect(looksLikeTailscaleAuthKey('')).toBe(false)
    expect(looksLikeTailscaleAuthKey(`${PFX}-auth-AAAA --advertise-exit-node`)).toBe(false)
    expect(looksLikeTailscaleAuthKey(`${PFX}-auth-AAAA\nBBBB`)).toBe(false)
    expect(looksLikeTailscaleAuthKey(`${PFX}-${'x'.repeat(500)}`)).toBe(false)
  })
})
