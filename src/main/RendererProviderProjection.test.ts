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
