import { readFileSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'
import {
  isMistralMcpUnavailableWarning,
  mistralAcpMcpSelectionForTransport,
  redactMistralMcpTransportSecrets,
  selectMistralMcpTransport,
  startMistralHttpMcpTransport,
  type MistralHttpMcpServer
} from './MistralMcpTransport'

const httpServer = {
  name: 'TaskWraith',
  type: 'http',
  url: 'http://127.0.0.1:41234/mcp',
  headers: [{ name: 'Authorization', value: 'Bearer private-http-token' }]
} satisfies MistralHttpMcpServer

const stdioServer = {
  name: 'TaskWraith',
  command: '/Applications/TaskWraith.app/Contents/MacOS/TaskWraith',
  args: ['--taskwraith-gemini-mcp-bridge', '--token', 'private-stdio-token'],
  env: []
}

describe('selectMistralMcpTransport', () => {
  it('uses HTTP when the ACP runtime explicitly advertises it', async () => {
    await expect(
      selectMistralMcpTransport({
        initializeResult: {
          agentCapabilities: { mcpCapabilities: { http: true } },
          agentInfo: { name: 'unknown-agent', version: '0.1.0' }
        },
        httpServer,
        stdioServer
      })
    ).resolves.toEqual({ transport: 'http', servers: [httpServer], reason: 'advertised-http' })
  })

  it('honours an explicit HTTP false and retains a genuinely available stdio route', async () => {
    await expect(
      selectMistralMcpTransport({
        initializeResult: {
          agentCapabilities: { mcpCapabilities: { http: false } },
          agentInfo: { name: '@mistralai/mistral-vibe', version: '2.25.0' }
        },
        httpServer,
        stdioServer
      })
    ).resolves.toEqual({
      transport: 'stdio',
      servers: [stdioServer],
      reason: 'explicit-http-disabled'
    })
  })

  it('uses the measured HTTP compatibility floor only when the capability is omitted', async () => {
    await expect(
      selectMistralMcpTransport({
        initializeResult: {
          agentCapabilities: {},
          agentInfo: { name: '@mistralai/mistral-vibe', version: '2.22.0' }
        },
        httpServer,
        stdioServer
      })
    ).resolves.toEqual({ transport: 'http', servers: [httpServer], reason: 'known-vibe-http' })
  })

  it.each([
    [{ agentInfo: { name: '@mistralai/mistral-vibe', version: '2.21.9' } }, 'older'],
    [{ agentInfo: { name: 'another-agent', version: '9.0.0' } }, 'unknown'],
    [{}, 'unidentified']
  ])(
    'keeps stdio for an unadvertised runtime rather than guessing HTTP ($1)',
    async (initializeResult, _label) => {
      await expect(
        selectMistralMcpTransport({ initializeResult, httpServer, stdioServer })
      ).resolves.toMatchObject({
        transport: 'stdio',
        servers: [stdioServer]
      })
    }
  )

  it('returns no server when HTTP is explicitly unavailable and stdio is unsafe', async () => {
    await expect(
      selectMistralMcpTransport({
        initializeResult: {
          agentCapabilities: { mcpCapabilities: { http: false } },
          agentInfo: { name: '@mistralai/mistral-vibe', version: '2.25.0' }
        },
        httpServer
      })
    ).resolves.toEqual({ transport: 'none', servers: [], reason: 'explicit-http-disabled' })
  })

  it('awaits the legacy stdio setup only after HTTP is ruled out', async () => {
    const getStdioServer = vi.fn(async () => stdioServer)
    await expect(
      selectMistralMcpTransport({
        initializeResult: { agentCapabilities: { mcpCapabilities: { http: false } } },
        httpServer,
        getStdioServer
      })
    ).resolves.toMatchObject({ transport: 'stdio', servers: [stdioServer] })
    expect(getStdioServer).toHaveBeenCalledOnce()
  })
})

describe('redactMistralMcpTransportSecrets', () => {
  it('redacts HTTP authorization, stdio token argv, and broker env without mutating input', () => {
    const input = {
      params: {
        mcpServers: [
          httpServer,
          {
            ...stdioServer,
            env: [{ name: 'TASKWRAITH_MCP_BROKER_TOKEN', value: 'private-env-token' }]
          }
        ]
      }
    }
    const redacted = redactMistralMcpTransportSecrets(input)
    const serialized = JSON.stringify(redacted)

    expect(serialized).not.toContain('private-http-token')
    expect(serialized).not.toContain('private-stdio-token')
    expect(serialized).not.toContain('private-env-token')
    expect(serialized).toContain('[redacted-token]')
    expect(JSON.stringify(input)).toContain('private-http-token')
  })

  it('redacts map-style Authorization headers and embedded Bearer text', () => {
    const redacted = redactMistralMcpTransportSecrets({
      headers: { Authorization: 'Bearer private-map-token', 'X-Trace': 'keep-me' },
      error: { data: 'bridge refused Bearer private-echo-token while connecting' }
    })
    const serialized = JSON.stringify(redacted)

    expect(serialized).not.toContain('private-map-token')
    expect(serialized).not.toContain('private-echo-token')
    expect(serialized).toContain('keep-me')
    expect(serialized).toContain('bridge refused Bearer [redacted-token] while connecting')
  })
})

describe('mistralAcpMcpSelectionForTransport', () => {
  it('repairs the provider prompt and emits a visible warning for no safe transport', () => {
    const sanitizePrompt = vi.fn(() => 'sanitized prompt')
    expect(
      mistralAcpMcpSelectionForTransport({
        selection: { transport: 'none', servers: [], reason: 'explicit-http-disabled' },
        prompt: 'prompt with MCP claims',
        sanitizePrompt,
        httpTransportSetupFailed: true
      })
    ).toMatchObject({
      servers: [],
      prompt: 'sanitized prompt',
      warning:
        'Mistral MCP bridge unavailable: the ACP runtime did not accept the per-run HTTP transport and no safe stdio bridge was available for this launch. Continuing without TaskWraith MCP tools. The HTTP listener could not be prepared.'
    })
    expect(sanitizePrompt).toHaveBeenCalledExactlyOnceWith('prompt with MCP claims')
    expect(
      isMistralMcpUnavailableWarning(
        'Mistral MCP bridge unavailable: no safe transport is available.'
      )
    ).toBe(true)
    expect(isMistralMcpUnavailableWarning('ACP session/new failed: invalid request')).toBe(false)
  })

  it('keeps the unavailable notice on the structured provider-warning projection', () => {
    const main = readFileSync(new URL('../index.ts', import.meta.url), 'utf8')
    const start = main.indexOf('if (isMistralMcpUnavailableWarning(warningText))')
    const branch = main.slice(start, start + 700)
    expect(start).toBeGreaterThanOrEqual(0)
    expect(branch).toContain("type: 'provider_warning'")
    expect(branch).toContain("title: 'Mistral MCP bridge unavailable'")
    expect(branch.indexOf('return')).toBeLessThan(branch.indexOf('sendAgentCompatError'))
  })

  it('returns an accepted transport unchanged without touching the prompt', () => {
    const sanitizePrompt = vi.fn()
    expect(
      mistralAcpMcpSelectionForTransport({
        selection: { transport: 'http', servers: [httpServer], reason: 'advertised-http' },
        prompt: 'keep me',
        sanitizePrompt
      })
    ).toEqual([httpServer])
    expect(sanitizePrompt).not.toHaveBeenCalled()
  })
})

describe('startMistralHttpMcpTransport', () => {
  it('closes its listener exactly once across repeated terminal cleanup', async () => {
    const close = vi.fn(async () => {})
    const transport = await startMistralHttpMcpTransport({
      serverName: 'TaskWraith',
      dispatch: async () => null,
      startBridge: async () =>
        ({
          url: 'http://127.0.0.1:41234/mcp',
          headerName: 'Authorization',
          headerValue: 'Bearer private-token',
          close
        }) as never
    })

    await transport.close()
    await transport.close()
    expect(close).toHaveBeenCalledOnce()
  })
})
