import { describe, expect, it } from 'vitest'
import { summariseCodexStatus, summariseProviderApiKeyStatus } from './providerAuthSummary'

describe('summariseProviderApiKeyStatus — Kimi', () => {
  it('recognises an admitted OAuth-only runtime', () => {
    expect(
      summariseProviderApiKeyStatus(
        {
          available: true,
          authState: 'oauth',
          apiKeyConfigured: false,
          encryptionAvailable: true,
          binaryPath: '/opt/kimi',
          transportSupported: true
        },
        'Kimi'
      )
    ).toMatchObject({ variant: 'signed-in', statusText: 'Signed in' })
  })

  it('does not project an unknown credential state as signed in', () => {
    expect(
      summariseProviderApiKeyStatus(
        {
          available: true,
          authState: 'unknown',
          apiKeyConfigured: false,
          encryptionAvailable: true,
          binaryPath: '/opt/kimi',
          transportSupported: true
        },
        'Kimi'
      )
    ).toMatchObject({ variant: 'partial', statusText: 'Credential state not observed' })
  })

  it('does not treat the TaskWraith usage key as managed ACP authentication', () => {
    const summary = summariseProviderApiKeyStatus(
      {
        available: true,
        authState: 'unknown',
        apiKeyConfigured: true,
        encryptionAvailable: true,
        binaryPath: '/opt/kimi',
        transportSupported: true
      },
      'Kimi'
    )

    expect(summary).toMatchObject({
      variant: 'partial',
      statusText: 'Credential state not observed'
    })
    expect(summary.statusText).not.toContain('API key saved')
    expect(summary.hint).toContain('Settings key is usage-only')
  })

  it('distinguishes a present but unqualified runtime from a missing CLI', () => {
    const summary = summariseProviderApiKeyStatus(
      {
        available: false,
        authState: 'oauth',
        apiKeyConfigured: false,
        encryptionAvailable: true,
        version: 'Kimi inventory does not advertise the qualified ACP-only transport posture.',
        binaryPath: '/opt/kimi',
        cliFlavour: 'unsupported',
        transportSupported: false
      },
      'Kimi'
    )
    expect(summary).toMatchObject({
      variant: 'not-available',
      statusText: 'Managed runtime unavailable'
    })
    expect(summary.hint).toContain('does not bypass admission')
    expect(summary.hint).not.toContain('/opt/kimi')
  })
})

describe('summariseCodexStatus', () => {
  it('makes the private-home app-server auth state authoritative over usage telemetry', () => {
    expect(
      summariseCodexStatus({
        available: true,
        authState: 'missing',
        requiresOpenaiAuth: true,
        codexUsage: { planType: 'plus', userId: 'legacy-usage-user' }
      })
    ).toMatchObject({
      variant: 'not-signed-in',
      statusText: 'TaskWraith Codex sign-in required'
    })
  })

  it('recognises an account observed in the private home', () => {
    expect(
      summariseCodexStatus({
        available: true,
        authState: 'chatgpt',
        account: { type: 'chatgpt', planType: 'pro' },
        planType: 'pro'
      })
    ).toMatchObject({
      variant: 'signed-in',
      statusText: 'Signed in (pro)'
    })
  })

  it('keeps a usage-only import distinct from runtime authentication', () => {
    expect(
      summariseCodexStatus({
        available: true,
        authState: 'unknown',
        codexUsage: { planType: 'plus', userId: 'usage-user' }
      })
    ).toMatchObject({
      variant: 'partial',
      statusText: 'Usage session available'
    })
  })
})
