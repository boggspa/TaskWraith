import { describe, expect, it } from 'vitest'
import {
  summariseCodexStatus,
  summariseMistralVibeStatus,
  summariseMuseCodeStatus,
  summariseProviderApiKeyStatus
} from './providerAuthSummary'

describe('summariseMuseCodeStatus', () => {
  it('stays not-checked when Settings has never received a Muse status snapshot', () => {
    expect(summariseMuseCodeStatus(null)).toMatchObject({
      variant: 'not-signed-in',
      statusText: 'Muse setup not checked yet'
    })
  })

  it('treats credentialPresent as configured without inventing Meta secrets', () => {
    expect(
      summariseMuseCodeStatus({
        available: true,
        authState: 'unknown',
        credentialPresent: true
      })
    ).toMatchObject({
      variant: 'signed-in',
      statusText: 'Muse Code configured'
    })
  })

  it('keeps binary-only readiness as setup-unverified', () => {
    expect(
      summariseMuseCodeStatus({
        available: true,
        authState: 'unknown',
        credentialPresent: false
      })
    ).toMatchObject({
      variant: 'partial',
      statusText: 'Muse CLI ready · setup unverified'
    })
  })
})

describe('summariseMistralVibeStatus', () => {
  it('keeps a binary-only result distinct from verified sign-in', () => {
    expect(summariseMistralVibeStatus({ available: true, authState: 'unknown' })).toEqual({
      variant: 'partial',
      statusText: 'Vibe CLI ready · sign-in status unavailable',
      hint: expect.stringContaining('credential-opaque auth status')
    })
  })

  it('distinguishes a missing Vibe CLI from credential setup', () => {
    expect(summariseMistralVibeStatus({ available: false })).toMatchObject({
      variant: 'not-available',
      statusText: 'Mistral Vibe CLI not found'
    })
  })

  it("renders Vibe's credential-opaque authenticated result as signed in", () => {
    expect(
      summariseMistralVibeStatus({
        available: true,
        authState: 'authenticated',
        credentialPresent: true,
        authSource: 'os_keyring'
      })
    ).toEqual({
      variant: 'signed-in',
      statusText: 'Mistral Vibe signed in',
      hint: expect.stringContaining('did not read or store the credential')
    })
  })

  it('renders an explicit Vibe signed-out result instead of calling it unverified', () => {
    expect(
      summariseMistralVibeStatus({
        available: true,
        authState: 'missing',
        credentialPresent: false
      })
    ).toMatchObject({
      variant: 'not-signed-in',
      statusText: 'Mistral Vibe not signed in'
    })
  })

  it('honours an explicit legacy authentication observation', () => {
    expect(summariseMistralVibeStatus({ available: true, authState: 'oauth' })).toMatchObject({
      variant: 'signed-in',
      statusText: 'Mistral Vibe signed in'
    })
  })
})

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
    expect(summary.hint).toContain('stable identity')
    expect(summary.hint).toContain('bounded startup')
    expect(summary.hint).toContain('Structural ACP admission is always enabled')
    expect(summary.hint).toContain('credentials do not bypass these checks')
    expect(summary.hint).toContain('unattested-development')
    expect(summary.hint).not.toContain('reviewed tuple')
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
