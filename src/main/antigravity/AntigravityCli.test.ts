import { describe, expect, it, vi } from 'vitest'
import {
  AGY_READ_ONLY_PRINT_TIMEOUT,
  buildAgyModelDiscoveryArgs,
  buildAgyReadOnlyPrintArgs,
  createAgyCliEnv,
  isAgyCredentialEnvironmentKey,
  normalizeAgyReasoningEffort,
  parseAgyModels,
  probeAgyModels,
  resolveAgyCliBinary
} from './AntigravityCli'

describe('resolveAgyCliBinary', () => {
  it('prefers the user PATH before common local locations', async () => {
    const resolved = await resolveAgyCliBinary({
      env: { PATH: '/custom/bin:/usr/bin' },
      getSearchDirs: () => ['/custom/bin', '/Users/test/.local/bin'],
      getBinaryCandidates: () => ['agy'],
      fileExists: vi.fn(async (candidate: string) => candidate === '/custom/bin/agy')
    })

    expect(resolved).toEqual({ binaryPath: '/custom/bin/agy', source: 'path' })
  })

  it('finds a common local installation when PATH does not contain the binary', async () => {
    const resolved = await resolveAgyCliBinary({
      env: { PATH: '/usr/bin' },
      getSearchDirs: () => ['/usr/bin', '/Users/test/.local/bin'],
      getBinaryCandidates: () => ['agy'],
      fileExists: vi.fn(async (candidate: string) => candidate === '/Users/test/.local/bin/agy')
    })

    expect(resolved).toEqual({ binaryPath: '/Users/test/.local/bin/agy', source: 'common' })
  })

  it('fails with an actionable missing result rather than downloading or configuring a binary', async () => {
    const resolved = await resolveAgyCliBinary({
      env: { PATH: '/usr/bin' },
      getSearchDirs: () => ['/usr/bin'],
      getBinaryCandidates: () => ['agy'],
      fileExists: vi.fn(async () => false)
    })

    expect(resolved.binaryPath).toBeNull()
    expect(resolved.source).toBe('missing')
    expect(resolved.error).toContain('official Antigravity CLI')
  })
})

describe('createAgyCliEnv', () => {
  it('strips Google credential selectors after caller extras are merged', () => {
    const env = createAgyCliEnv(
      {
        PATH: '/usr/bin',
        GEMINI_API_KEY: 'do-not-pass',
        google_application_credentials: '/tmp/key.json',
        KEEP_ME: 'yes'
      },
      { GOOGLE_API_KEY: 'also-do-not-pass', NO_COLOR: '1' }
    )

    expect(env).toEqual({ PATH: '/usr/bin', KEEP_ME: 'yes', NO_COLOR: '1' })
    expect(isAgyCredentialEnvironmentKey('google_oauth_access_token')).toBe(true)
    expect(isAgyCredentialEnvironmentKey('KEEP_ME')).toBe(false)
  })
})

describe('Antigravity argv builders', () => {
  it('builds the supported model-discovery command only', () => {
    expect(buildAgyModelDiscoveryArgs()).toEqual(['models'])
  })

  it('builds sandboxed read-only print argv without a permission bypass', () => {
    const args = buildAgyReadOnlyPrintArgs({
      prompt: 'Inspect the repository and summarise findings.',
      conversationId: 'conv-123',
      model: 'Gemini 3.6 Flash (High)',
      reasoningEffort: 'high'
    })

    expect(args).toEqual([
      '--sandbox',
      '--mode',
      'plan',
      '--print-timeout',
      AGY_READ_ONLY_PRINT_TIMEOUT,
      '--conversation',
      'conv-123',
      '--model',
      'Gemini 3.6 Flash (High)',
      '--effort',
      'high',
      '-p',
      'Inspect the repository and summarise findings.'
    ])
    expect(args).not.toContain('--dangerously-skip-permissions')
    expect(args).not.toContain('--new-project')
  })

  it('omits malformed optional values and rejects a blank prompt', () => {
    expect(
      buildAgyReadOnlyPrintArgs({
        prompt: 'hello',
        model: 'model\u0000value',
        conversationId: '\n',
        reasoningEffort: 'turbo'
      })
    ).toEqual([
      '--sandbox',
      '--mode',
      'plan',
      '--print-timeout',
      AGY_READ_ONLY_PRINT_TIMEOUT,
      '-p',
      'hello'
    ])
    expect(normalizeAgyReasoningEffort(' MEDIUM ')).toBe('medium')
    expect(normalizeAgyReasoningEffort('turbo')).toBeNull()
    expect(() => buildAgyReadOnlyPrintArgs({ prompt: '   ' })).toThrow('prompt is required')
  })
})

describe('parseAgyModels', () => {
  it('parses structured model output without rewriting provider model values', () => {
    expect(
      parseAgyModels(
        JSON.stringify({
          models: [
            { id: 'gemini-3.6-flash-high', label: 'Gemini 3.6 Flash (High)' },
            { id: 'gemini-3.1-pro', displayName: 'Gemini 3.1 Pro' }
          ]
        })
      )
    ).toEqual([
      { id: 'gemini-3.6-flash-high', label: 'Gemini 3.6 Flash (High)' },
      { id: 'gemini-3.1-pro', label: 'Gemini 3.1 Pro' }
    ])
  })

  it('parses human-readable rows while rejecting account/error prose', () => {
    const output = [
      'Available models',
      'gemini-3.6-flash-high - Gemini 3.6 Flash (High)',
      'gemini-3.1-pro  Gemini 3.1 Pro',
      'Please log in to list models.',
      'Antigravity account is not authenticated.',
      'Authentication required to use Gemini models.',
      'Error: unavailable'
    ].join('\n')

    expect(parseAgyModels(output)).toEqual([
      { id: 'gemini-3.6-flash-high', label: 'Gemini 3.6 Flash (High)' },
      { id: 'gemini-3.1-pro', label: 'Gemini 3.1 Pro' }
    ])
  })
})

describe('probeAgyModels', () => {
  it('passes only sanitized env and the model discovery argv to an authorized caller-supplied capture', async () => {
    const capture = vi.fn(async () => ({
      stdout: 'gemini-3.6-flash-high - Gemini 3.6 Flash (High)',
      stderr: '',
      code: 0
    }))
    const result = await probeAgyModels({
      env: { GEMINI_API_KEY: 'secret', PATH: '/usr/bin' },
      resolveBinary: async () => ({ binaryPath: '/usr/local/bin/agy', source: 'common' }),
      capture
    })

    expect(result.models).toEqual([
      { id: 'gemini-3.6-flash-high', label: 'Gemini 3.6 Flash (High)' }
    ])
    expect(capture).toHaveBeenCalledWith(
      '/usr/local/bin/agy',
      ['models'],
      expect.objectContaining({
        env: { PATH: '/usr/bin', FORCE_COLOR: '0', NO_COLOR: '1' },
        timeoutMs: 8_000
      })
    )
  })

  it('does not capture when the user-installed CLI is absent', async () => {
    const capture = vi.fn()
    const result = await probeAgyModels({
      resolveBinary: async () => ({
        binaryPath: null,
        source: 'missing',
        error: 'not installed'
      }),
      capture
    })

    expect(result).toMatchObject({ models: [], error: 'not installed' })
    expect(capture).not.toHaveBeenCalled()
  })
})
