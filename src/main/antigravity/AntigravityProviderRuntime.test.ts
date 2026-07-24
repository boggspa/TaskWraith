import { describe, expect, it, vi } from 'vitest'
import {
  getAntigravityProviderStatus,
  prepareAntigravityProviderLaunch
} from './AntigravityProviderRuntime'

const OPTED_IN = {
  antigravityEnabled: true,
  antigravityOptInAcceptedAt: 1_700_000_000_000
} as const

describe('prepareAntigravityProviderLaunch', () => {
  it('fails closed before resolving a binary when informed opt-in is absent', async () => {
    const resolveBinary = vi.fn()

    await expect(
      prepareAntigravityProviderLaunch(
        { settings: {}, prompt: 'Inspect the repository.', approvalMode: 'default' },
        { resolveBinary }
      )
    ).rejects.toThrow(/disabled until the user enables/i)

    expect(resolveBinary).not.toHaveBeenCalled()
  })

  it('prepares a sanitized sandboxed plan-mode argv for a read-only run', async () => {
    const launch = await prepareAntigravityProviderLaunch(
      {
        settings: OPTED_IN,
        prompt: 'Review the failing test.',
        model: 'cli-default',
        reasoningEffort: 'high',
        approvalMode: 'plan',
        inheritedEnv: { PATH: '/usr/bin', GOOGLE_API_KEY: 'must-not-pass', KEEP: 'yes' }
      },
      {
        resolveBinary: async () => ({ binaryPath: '/usr/local/bin/agy', source: 'common' })
      }
    )

    expect(launch.mode).toBe('plan')
    expect(launch.args).toEqual([
      '--sandbox',
      '--mode',
      'plan',
      '--print-timeout',
      '30m',
      '--effort',
      'high',
      '-p',
      'Review the failing test.'
    ])
    expect(launch.env).toEqual({ PATH: '/usr/bin', KEEP: 'yes' })
    expect(launch.args).not.toContain('--dangerously-skip-permissions')
    expect(launch.args).not.toContain('--new-project')
  })

  it('uses the ordinary sandboxed accept-edits mode only for a write-capable posture', async () => {
    const launch = await prepareAntigravityProviderLaunch(
      {
        settings: OPTED_IN,
        prompt: 'Apply the approved change.',
        model: 'Gemini 3.6 Flash (High)',
        approvalMode: 'default'
      },
      {
        resolveBinary: async () => ({ binaryPath: '/usr/local/bin/agy', source: 'path' })
      }
    )

    expect(launch.mode).toBe('accept-edits')
    expect(launch.args).toContain('--sandbox')
    expect(launch.args).toContain('accept-edits')
    expect(launch.args).toContain('Gemini 3.6 Flash (High)')
    expect(launch.args).not.toContain('--dangerously-skip-permissions')
  })

  it('keeps an explicitly read-only effective posture in plan mode', async () => {
    const launch = await prepareAntigravityProviderLaunch(
      {
        settings: OPTED_IN,
        prompt: 'Do not edit.',
        approvalMode: 'default',
        effectivePermissions: { readOnly: true }
      },
      {
        resolveBinary: async () => ({ binaryPath: '/usr/local/bin/agy', source: 'path' })
      }
    )

    expect(launch.mode).toBe('plan')
  })

  it('reports a missing official CLI without constructing an argv', async () => {
    await expect(
      prepareAntigravityProviderLaunch(
        { settings: OPTED_IN, prompt: 'hello', approvalMode: 'default' },
        {
          resolveBinary: async () => ({
            binaryPath: null,
            source: 'missing',
            error: 'official agy is missing'
          })
        }
      )
    ).rejects.toThrow('official agy is missing')
  })

  it('does not probe a binary or account state while the opt-in is disabled', async () => {
    const resolveBinary = vi.fn()
    const status = await getAntigravityProviderStatus({ settings: {} }, { resolveBinary })

    expect(status).toMatchObject({ available: false, authState: 'consent-required' })
    expect(resolveBinary).not.toHaveBeenCalled()
  })

  it('admits the key lane without opt-in and without any agy binary', async () => {
    // The SDK lane needs neither consent to the separate ban-risk CLI lane nor
    // the CLI itself. Reporting unavailable here was what blocked key-lane
    // runs at preflight after the picker had happily offered the models.
    const resolveBinary = vi.fn()
    const status = await getAntigravityProviderStatus(
      { settings: {} },
      { resolveBinary, isGeminiApiKeyConfigured: () => true }
    )

    expect(status).toMatchObject({
      available: true,
      setupRequired: false,
      authState: 'api-key',
      binaryPath: null,
      binarySource: 'gemini-api'
    })
    expect(status.error).toBeUndefined()
    expect(resolveBinary).not.toHaveBeenCalled()
  })

  it('keeps the provider available on the key lane when the consented agy binary is missing', async () => {
    const status = await getAntigravityProviderStatus(
      { settings: OPTED_IN },
      {
        resolveBinary: async () => ({
          binaryPath: null,
          source: 'missing',
          error: 'official agy is missing'
        }),
        isGeminiApiKeyConfigured: () => true
      }
    )

    expect(status).toMatchObject({ available: true, authState: 'api-key', binaryPath: null })
    expect(status.error).toBeUndefined()
  })

  it('fails closed when the key signal itself throws', async () => {
    const status = await getAntigravityProviderStatus(
      { settings: {} },
      {
        resolveBinary: vi.fn(),
        isGeminiApiKeyConfigured: () => {
          throw new Error('signal exploded')
        }
      }
    )

    expect(status).toMatchObject({ available: false, authState: 'consent-required' })
  })
})
