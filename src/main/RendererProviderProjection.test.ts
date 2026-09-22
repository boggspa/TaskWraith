import { describe, expect, it } from 'vitest'
import {
  rendererSafeProviderMcpStatus,
  rendererSafeProviderStatus
} from './RendererProviderProjection'

describe('RendererProviderProjection', () => {
  it('keeps secondary provider availability while removing account, quota, path, and errors', () => {
    const result = rendererSafeProviderStatus({
      provider: 'codex',
      label: 'Codex',
      available: true,
      version: '1.2.3',
      appServer: 'started',
      authState: 'chatgpt',
      binaryPath: '/Users/private/.local/bin/codex',
      binarySource: 'path',
      account: { email: 'private@example.test' },
      rateLimits: { primary: { usedPercent: 42 } },
      codexUsage: { accountId: 'private-account' },
      error: 'failed at /Users/private/.local/bin/codex'
    })

    expect(result).toEqual({
      provider: 'codex',
      label: 'Codex',
      version: '1.2.3',
      appServer: 'started',
      authState: 'chatgpt',
      available: true
    })
    expect(JSON.stringify(result)).not.toContain('private')
    expect(JSON.stringify(result)).not.toContain('rateLimits')
  })

  it('projects the Ollama account state as booleans and nothing else', () => {
    const result = rendererSafeProviderStatus({
      provider: 'ollama',
      available: true,
      cloud: {
        supported: true,
        enabled: true,
        authenticated: true,
        plan: 'pro',
        source: 'account',
        accountProbe: 'answered',
        authenticatedFromMemory: true,
        apiKeyConfigured: false,
        models: [{ model: 'minimax-m3:cloud', description: 'private-description' }]
      }
    })

    expect(result.cloud).toEqual({
      supported: true,
      enabled: true,
      apiKeyConfigured: false,
      authenticatedFromMemory: true,
      authenticated: true
    })
    expect(JSON.stringify(result)).not.toContain('private-description')
    expect(JSON.stringify(result)).not.toContain('account')
    // Unknown stays unknown, and a status without an account half gains none.
    expect(
      rendererSafeProviderStatus({
        cloud: { supported: false, enabled: true, authenticated: null, models: [] }
      }).cloud
    ).toEqual({ supported: false, enabled: true, authenticated: null })
    expect(rendererSafeProviderStatus({ provider: 'codex', available: true })).not.toHaveProperty(
      'cloud'
    )
  })

  it('reduces raw MCP server inventories to non-sensitive counts', () => {
    const result = rendererSafeProviderMcpStatus({
      provider: 'codex',
      available: true,
      data: [
        {
          name: 'private-server',
          command: '/Users/private/bin/server',
          auth: { token: 'secret' },
          tools: [{ name: 'read_file' }, { name: 'write_file' }]
        }
      ]
    })

    expect(result).toEqual({
      provider: 'codex',
      available: true,
      serverCount: 1,
      toolCount: 2
    })
  })
})
