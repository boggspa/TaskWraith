import { describe, expect, it, vi } from 'vitest'
import {
  discoverAuthenticatedAgyModels,
  type AuthenticatedAgyModelDiscoveryDependencies
} from './AntigravityModelDiscovery'

const optedIn = { antigravityEnabled: true, antigravityOptInAcceptedAt: 1 }

function dependencies(
  result: {
    stdout?: string
    stderr?: string
    code?: number | null
    error?: string
    timedOut?: boolean
  }
): AuthenticatedAgyModelDiscoveryDependencies {
  return {
    resolveBinary: async () => ({ binaryPath: '/Users/test/.local/bin/agy', source: 'path' }),
    capture: vi.fn(async (_command, _args, options) => ({
      stdout: '',
      stderr: '',
      code: 0,
      ...result,
      ...(options.env.GEMINI_API_KEY ? { error: 'credential environment leaked' } : {})
    })),
    inheritedEnv: {
      PATH: '/Users/test/.local/bin',
      GEMINI_API_KEY: 'must-not-reach-agy',
      GOOGLE_APPLICATION_CREDENTIALS: '/tmp/never-read.json'
    }
  }
}

describe('discoverAuthenticatedAgyModels', () => {
  it('does not resolve or spawn before explicit informed consent', async () => {
    const resolveBinary = vi.fn(async () => ({ binaryPath: '/agy', source: 'path' as const }))
    const capture = vi.fn()

    await expect(
      discoverAuthenticatedAgyModels({}, { resolveBinary, capture })
    ).resolves.toEqual([])

    expect(resolveBinary).not.toHaveBeenCalled()
    expect(capture).not.toHaveBeenCalled()
  })

  it('accepts only a successful official models result and strips credential selectors', async () => {
    const deps = dependencies({ stdout: '[{"id":"gemini-3.5-pro","label":"Gemini 3.5 Pro"}]' })

    await expect(discoverAuthenticatedAgyModels(optedIn, deps)).resolves.toEqual([
      { id: 'gemini-3.5-pro', label: 'Gemini 3.5 Pro' }
    ])
    expect(deps.capture).toHaveBeenCalledWith(
      '/Users/test/.local/bin/agy',
      ['models'],
      expect.objectContaining({
        env: expect.not.objectContaining({
          GEMINI_API_KEY: expect.anything(),
          GOOGLE_APPLICATION_CREDENTIALS: expect.anything()
        })
      })
    )
  })

  it.each([
    { stdout: '[{"id":"gemini-3.5-pro"}]', code: 1 },
    { stderr: 'Not logged in', code: 1 },
    { stdout: '', code: 0 },
    { stdout: 'authentication required', code: 0 },
    { stdout: '[{"id":"gemini-3.5-pro"}]', code: 0, timedOut: true }
  ])('fails closed for an unusable official models result: %o', async (result) => {
    await expect(discoverAuthenticatedAgyModels(optedIn, dependencies(result))).resolves.toEqual([])
  })

  it('fails closed when the official binary resolution throws', async () => {
    await expect(
      discoverAuthenticatedAgyModels(optedIn, {
        resolveBinary: async () => Promise.reject(new Error('probe failed'))
      })
    ).resolves.toEqual([])
  })
})
