import { describe, expect, it } from 'vitest'
import { summariseProviderApiKeyStatus } from './providerAuthSummary'

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
        version: 'Kimi binary SHA/platform/architecture is not in the embedded reviewed roster.',
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
