import { describe, expect, it } from 'vitest'
import {
  isOllamaAccountSignedIn,
  summariseCodexStatus,
  summariseMistralVibeStatus,
  summariseMuseCodeStatus,
  summariseOllamaStatus,
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

describe('summariseOllamaStatus', () => {
  it('waits for a status snapshot instead of guessing', () => {
    expect(summariseOllamaStatus(null)).toMatchObject({
      variant: 'not-signed-in',
      statusText: 'Not checked yet'
    })
  })

  it('never reports the retired amber setup-optional state', () => {
    for (const status of [
      null,
      { available: false, localAvailable: false },
      { available: true, localAvailable: true, cloud: { enabled: true, authenticated: false } },
      { available: true, localAvailable: true, cloud: { enabled: false, authenticated: false } },
      { available: true, localAvailable: true, cloud: { enabled: true, authenticated: true } }
    ]) {
      const summary = summariseOllamaStatus(status)
      expect(summary.variant).not.toBe('partial')
      expect(summary.statusText.toLowerCase()).not.toContain('optional')
    }
  })

  it('keeps a runtime with neither server nor account neutral, never a red failure', () => {
    expect(summariseOllamaStatus({ available: false, localAvailable: false })).toMatchObject({
      variant: 'not-signed-in',
      statusText: 'Ollama not running'
    })
  })

  it('is ready once the server runs, whether or not an account is attached', () => {
    expect(
      summariseOllamaStatus({
        available: true,
        localAvailable: true,
        cloud: { supported: true, enabled: true, authenticated: false }
      })
    ).toMatchObject({
      variant: 'signed-in',
      statusText: 'Running · not signed in'
    })
  })

  it('names the plan when the remembered ollama.com account is signed in', () => {
    expect(
      summariseOllamaStatus({
        available: true,
        localAvailable: true,
        cloud: { supported: true, enabled: true, authenticated: true, plan: 'pro' }
      })
    ).toMatchObject({
      variant: 'signed-in',
      statusText: 'Signed in (pro)'
    })
  })

  it('reports the direct-API key route separately from a daemon sign-in', () => {
    expect(
      summariseOllamaStatus({
        available: true,
        localAvailable: false,
        cloud: { supported: true, enabled: true, authenticated: true, apiKeyConfigured: true }
      })
    ).toMatchObject({
      variant: 'signed-in',
      statusText: 'Cloud API key saved'
    })
  })

  it('checks runnability before the account so a remembered sign-in cannot paint a dead runtime green', () => {
    expect(
      summariseOllamaStatus({
        available: false,
        localAvailable: false,
        // The remembered-sign-in repair writes this even while the daemon is down.
        cloud: {
          supported: true,
          enabled: true,
          authenticated: true,
          authenticatedFromMemory: true
        }
      })
    ).toMatchObject({ variant: 'not-signed-in', statusText: 'Ollama not running' })
  })

  it('says there is no sign-in to finish when the daemon disables Cloud', () => {
    const summary = summariseOllamaStatus({
      available: true,
      localAvailable: true,
      cloud: { supported: true, enabled: false, authenticated: false }
    })
    expect(summary.variant).toBe('signed-in')
    expect(summary.hint).toContain('Cloud features disabled')
  })
})

describe('isOllamaAccountSignedIn', () => {
  it('separates the account axis from the green runnable dot', () => {
    // Running, no account — green from summariseOllamaStatus, but no sign-out
    // action should be offered.
    const running = {
      available: true,
      localAvailable: true,
      cloud: { supported: true, enabled: true, authenticated: false }
    }
    expect(summariseOllamaStatus(running).variant).toBe('signed-in')
    expect(isOllamaAccountSignedIn(running)).toBe(false)
  })

  it('counts both the remembered CLI sign-in and the direct API key', () => {
    expect(isOllamaAccountSignedIn({ cloud: { authenticated: true } })).toBe(true)
    expect(isOllamaAccountSignedIn({ cloud: { apiKeyConfigured: true } })).toBe(true)
  })

  it('never guesses from a missing or unanswered status', () => {
    expect(isOllamaAccountSignedIn(null)).toBe(false)
    expect(isOllamaAccountSignedIn({ available: true })).toBe(false)
    expect(isOllamaAccountSignedIn({ cloud: { authenticated: null } })).toBe(false)
  })
})
