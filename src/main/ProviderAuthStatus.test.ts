import { describe, expect, it } from 'vitest'
import { buildProviderAuthStatusV2 } from './ProviderAuthStatus'

/**
 * Pins the stable schema for the `provider_auth_status` MCP tool.
 * The old `appServer` field conflated lifecycle, transport, and
 * capability — these tests prove each concern now has its own
 * actionable axis and that no provider branch leaks `'unknown'`.
 */

describe('buildProviderAuthStatusV2 — gemini', () => {
  it('marks the provider authenticated when an API key is configured', () => {
    const result = buildProviderAuthStatusV2({
      provider: 'gemini',
      available: true,
      apiKeyConfigured: true,
      rawAuthState: 'api-key'
    })
    expect(result).toEqual({
      provider: 'gemini',
      serverState: 'lazy',
      transport: 'cli',
      approvalSupport: true,
      mcpStatusSupport: false,
      authState: 'authenticated'
    })
  })

  it('translates oauth-login-required into a missing state with a human reason', () => {
    const result = buildProviderAuthStatusV2({
      provider: 'gemini',
      available: true,
      rawAuthState: 'oauth-login-required'
    })
    expect(result.authState).toBe('missing')
    expect(result.authReason).toBe('Gemini OAuth login required')
  })

  it('treats raw oauth/vertex-ai profile kinds as authenticated', () => {
    expect(
      buildProviderAuthStatusV2({
        provider: 'gemini',
        available: true,
        rawAuthState: 'google-oauth'
      }).authState
    ).toBe('authenticated')
    expect(
      buildProviderAuthStatusV2({
        provider: 'gemini',
        available: true,
        rawAuthState: 'vertex-ai'
      }).authState
    ).toBe('authenticated')
  })

  it('falls back to not-queried (not unknown) when no signal is available', () => {
    const result = buildProviderAuthStatusV2({
      provider: 'gemini',
      available: true,
      rawAuthState: 'unknown'
    })
    expect(result.authState).toBe('not-queried')
  })

  it('marks transport unavailable when the CLI binary is missing', () => {
    const result = buildProviderAuthStatusV2({
      provider: 'gemini',
      available: false,
      errorReason: 'gemini binary not found on PATH'
    })
    expect(result.serverState).toBe('unavailable')
    expect(result.transport).toBe('unavailable')
    expect(result.authState).toBe('missing')
    expect(result.authReason).toBe('gemini binary not found on PATH')
  })
})

describe('buildProviderAuthStatusV2 — codex', () => {
  it('reports started + app-server transport when the client is running', () => {
    const result = buildProviderAuthStatusV2({
      provider: 'codex',
      available: true,
      codexClientStarted: true
    })
    expect(result.serverState).toBe('started')
    expect(result.transport).toBe('app-server')
    expect(result.approvalSupport).toBe(true)
    expect(result.mcpStatusSupport).toBe(true)
  })

  it('reports lazy when the binary exists but the client has not started', () => {
    const result = buildProviderAuthStatusV2({
      provider: 'codex',
      available: true,
      codexClientStarted: false
    })
    expect(result.serverState).toBe('lazy')
    expect(result.transport).toBe('app-server')
  })

  it('keeps codex reachable when the client is up even without a CLI binary', () => {
    const result = buildProviderAuthStatusV2({
      provider: 'codex',
      available: false,
      codexClientStarted: true
    })
    expect(result.serverState).toBe('started')
    expect(result.transport).toBe('app-server')
  })

  it('returns not-queried with a pointer to account/read', () => {
    const result = buildProviderAuthStatusV2({
      provider: 'codex',
      available: true,
      codexClientStarted: true
    })
    expect(result.authState).toBe('not-queried')
    expect(result.authReason).toContain('account/read')
  })

  it('projects definitive private-home account states', () => {
    expect(
      buildProviderAuthStatusV2({
        provider: 'codex',
        available: true,
        codexClientStarted: true,
        rawAuthState: 'apiKey'
      }).authState
    ).toBe('authenticated')
    expect(
      buildProviderAuthStatusV2({
        provider: 'codex',
        available: true,
        codexClientStarted: true,
        rawAuthState: 'missing'
      })
    ).toMatchObject({
      authState: 'missing',
      authReason: expect.stringContaining('sign-in')
    })
  })

  it('marks codex unavailable when neither binary nor client are present', () => {
    const result = buildProviderAuthStatusV2({
      provider: 'codex',
      available: false,
      codexClientStarted: false,
      errorReason: 'no codex binary, no app-server'
    })
    expect(result.serverState).toBe('unavailable')
    expect(result.transport).toBe('unavailable')
    expect(result.authState).toBe('missing')
    expect(result.authReason).toBe('no codex binary, no app-server')
  })
})

describe('buildProviderAuthStatusV2 — claude', () => {
  it('uses sdk transport and disables in-app approval support', () => {
    const result = buildProviderAuthStatusV2({
      provider: 'claude',
      available: true,
      apiKeyConfigured: true
    })
    expect(result.transport).toBe('sdk')
    expect(result.approvalSupport).toBe(false)
    expect(result.mcpStatusSupport).toBe(false)
    expect(result.authState).toBe('authenticated')
  })

  it('reports missing when the CLI explicitly says so', () => {
    const result = buildProviderAuthStatusV2({
      provider: 'claude',
      available: true,
      rawAuthState: 'missing'
    })
    expect(result.authState).toBe('missing')
    expect(result.authReason).toBe('Claude CLI reports no credentials')
  })

  it('downgrades unknown to not-observable (instead of leaking unknown)', () => {
    const result = buildProviderAuthStatusV2({
      provider: 'claude',
      available: true,
      rawAuthState: 'unknown'
    })
    expect(result.authState).toBe('not-observable')
    expect(result.authReason).toContain('Claude CLI')
  })
})

describe('buildProviderAuthStatusV2 — kimi', () => {
  it('uses cli transport and enables approval support', () => {
    const result = buildProviderAuthStatusV2({
      provider: 'kimi',
      available: true,
      rawAuthState: 'api-key',
      apiKeyConfigured: false
    })
    expect(result.transport).toBe('cli')
    expect(result.approvalSupport).toBe(true)
    expect(result.mcpStatusSupport).toBe(true)
    expect(result.authState).toBe('authenticated')
  })

  it('does not treat the Settings usage key as managed ACP authentication', () => {
    const result = buildProviderAuthStatusV2({
      provider: 'kimi',
      available: true,
      rawAuthState: 'unknown',
      apiKeyConfigured: true
    })
    expect(result.authState).toBe('not-observable')
  })

  it('recognises an OAuth-only admitted runtime as authenticated', () => {
    const result = buildProviderAuthStatusV2({
      provider: 'kimi',
      available: true,
      apiKeyConfigured: false,
      rawAuthState: 'oauth'
    })
    expect(result.authState).toBe('authenticated')
  })

  it('does not claim missing credentials when the admitted runtime did not expose auth state', () => {
    const result = buildProviderAuthStatusV2({
      provider: 'kimi',
      available: true,
      apiKeyConfigured: false,
      rawAuthState: 'unknown'
    })
    expect(result.authState).toBe('not-observable')
    expect(result.authReason).toContain('not observed')
  })

  it('reports an explicit missing credential state without implying API-key-only auth', () => {
    const result = buildProviderAuthStatusV2({
      provider: 'kimi',
      available: true,
      apiKeyConfigured: false,
      rawAuthState: 'missing'
    })
    expect(result.authState).toBe('missing')
    expect(result.authReason).toContain('OAuth login or config.toml provider API key')
  })

  it('marks an unqualified runtime unavailable even when OAuth exists', () => {
    const result = buildProviderAuthStatusV2({
      provider: 'kimi',
      available: false,
      rawAuthState: 'oauth',
      errorReason: 'Kimi inventory does not advertise the qualified ACP-only transport posture.'
    })
    expect(result.serverState).toBe('unavailable')
    expect(result.transport).toBe('unavailable')
    expect(result.authState).toBe('missing')
    expect(result.authReason).toContain('ACP-only transport posture')
  })
})

describe('buildProviderAuthStatusV2 — schema invariants', () => {
  it('never returns the legacy "unknown" authState for any provider', () => {
    const providers = ['gemini', 'codex', 'claude', 'kimi', 'grok', 'cursor', 'ollama'] as const
    for (const provider of providers) {
      const presentAndUnknown = buildProviderAuthStatusV2({
        provider,
        available: true,
        rawAuthState: 'unknown'
      })
      expect(presentAndUnknown.authState).not.toBe('unknown')
      const absent = buildProviderAuthStatusV2({ provider, available: false })
      expect(absent.authState).not.toBe('unknown')
    }
  })

  it('omits deprecated appServer/accountStatus aliases from the V2 fields', () => {
    const result = buildProviderAuthStatusV2({
      provider: 'codex',
      available: true,
      codexClientStarted: true
    })
    expect(Object.prototype.hasOwnProperty.call(result, 'appServer')).toBe(false)
    expect(Object.prototype.hasOwnProperty.call(result, 'accountStatus')).toBe(false)
  })
})
