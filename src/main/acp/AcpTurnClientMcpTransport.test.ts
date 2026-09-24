import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { describe, expect, it, vi } from 'vitest'
import { runAcpTurn, type AcpChildProcess } from './AcpTurnClient'

interface FakeChild {
  child: AcpChildProcess
  requests: Array<Record<string, unknown>>
  respond: (message: Record<string, unknown>) => void
}

function fakeChild(): FakeChild {
  const events = new EventEmitter()
  const stdin = new PassThrough()
  const stdout = new PassThrough()
  const stderr = new PassThrough()
  const requests: Array<Record<string, unknown>> = []
  let carry = ''
  stdin.on('data', (chunk) => {
    carry += chunk.toString()
    const lines = carry.split('\n')
    carry = lines.pop() || ''
    for (const line of lines) {
      if (line.trim()) requests.push(JSON.parse(line) as Record<string, unknown>)
    }
  })
  const child = events as unknown as AcpChildProcess
  Object.assign(child, {
    stdin,
    stdout,
    stderr,
    kill: vi.fn(() => queueMicrotask(() => events.emit('close', 0)))
  })
  return {
    child,
    requests,
    respond: (message) => stdout.write(`${JSON.stringify(message)}\n`)
  }
}

describe('AcpTurnClient initialize-selected MCP transport', () => {
  it('selects the session MCP servers from the actual initialize response', async () => {
    const fake = fakeChild()
    const configured = [{ name: 'TaskWraith', command: '/safe/stdio', args: [], env: [] }]
    const selected = [
      {
        name: 'TaskWraith',
        type: 'http',
        url: 'http://127.0.0.1:41234/mcp',
        headers: [{ name: 'Authorization', value: 'Bearer test-token' }]
      }
    ]
    const selectMcpServers = vi.fn(() => selected)
    const handle = runAcpTurn({
      prompt: 'Inspect the workspace.',
      cwdLifetime: 'run',
      cwd: '/workspace',
      spawnProcess: () => fake.child,
      initializeParams: { protocolVersion: 1, clientCapabilities: {} },
      mcpServers: configured,
      selectMcpServers,
      onEvent: () => {}
    })

    await vi.waitFor(() => expect(fake.requests.some((request) => request.id === 1)).toBe(true))
    const initializeResult = {
      protocolVersion: 1,
      agentCapabilities: { mcpCapabilities: { http: true } },
      agentInfo: { name: '@mistralai/mistral-vibe', version: '2.25.0' }
    }
    fake.respond({ jsonrpc: '2.0', id: 1, result: initializeResult })

    await vi.waitFor(() =>
      expect(fake.requests.some((request) => request.method === 'session/new')).toBe(true)
    )
    expect(selectMcpServers).toHaveBeenCalledExactlyOnceWith(
      initializeResult,
      configured,
      'Inspect the workspace.'
    )
    expect(fake.requests.find((request) => request.method === 'session/new')?.params).toMatchObject(
      {
        mcpServers: selected
      }
    )

    handle.cancel()
    await handle.closed
  })

  it('keeps the configured MCP servers byte-for-byte when no selector is supplied', async () => {
    const fake = fakeChild()
    const configured = [{ name: 'TaskWraith', command: '/safe/stdio', args: [], env: [] }]
    const handle = runAcpTurn({
      prompt: 'Inspect the workspace.',
      cwdLifetime: 'run',
      cwd: '/workspace',
      spawnProcess: () => fake.child,
      initializeParams: { protocolVersion: 1, clientCapabilities: {} },
      mcpServers: configured,
      onEvent: () => {}
    })

    await vi.waitFor(() => expect(fake.requests.some((request) => request.id === 1)).toBe(true))
    fake.respond({ jsonrpc: '2.0', id: 1, result: { protocolVersion: 1 } })
    await vi.waitFor(() =>
      expect(fake.requests.some((request) => request.method === 'session/new')).toBe(true)
    )
    expect(fake.requests.find((request) => request.method === 'session/new')?.params).toMatchObject(
      {
        mcpServers: configured
      }
    )

    handle.cancel()
    await handle.closed
  })

  it('uses the initialize-selected servers for a native session/resume', async () => {
    const fake = fakeChild()
    const configured = [{ name: 'TaskWraith', command: '/old/stdio', args: [], env: [] }]
    const selected = [
      {
        name: 'TaskWraith',
        type: 'http',
        url: 'http://127.0.0.1:41234/mcp',
        headers: [{ name: 'Authorization', value: 'Bearer fresh-token' }]
      }
    ]
    const handle = runAcpTurn({
      prompt: 'Resume safely.',
      resumeSessionId: 'native-session',
      cwdLifetime: 'session',
      cwd: '/workspace',
      spawnProcess: () => fake.child,
      initializeParams: { protocolVersion: 1, clientCapabilities: {} },
      mcpServers: configured,
      selectMcpServers: () => selected,
      onEvent: () => {}
    })

    await vi.waitFor(() => expect(fake.requests.some((request) => request.id === 1)).toBe(true))
    fake.respond({
      jsonrpc: '2.0',
      id: 1,
      result: {
        protocolVersion: 1,
        agentCapabilities: { sessionCapabilities: { resume: {} } }
      }
    })
    await vi.waitFor(() =>
      expect(fake.requests.some((request) => request.method === 'session/resume')).toBe(true)
    )
    expect(
      fake.requests.find((request) => request.method === 'session/resume')?.params
    ).toMatchObject({
      sessionId: 'native-session',
      mcpServers: selected
    })

    handle.cancel()
    await handle.closed
  })

  it('reapplies the selected prompt transform when native resume falls back to session/new', async () => {
    const fake = fakeChild()
    const handle = runAcpTurn({
      prompt: 'initial MCP claim',
      resumeSessionId: 'native-session',
      resumeFallbackPrompt: 'fallback MCP claim',
      cwdLifetime: 'session',
      cwd: '/workspace',
      spawnProcess: () => fake.child,
      initializeParams: { protocolVersion: 1, clientCapabilities: {} },
      selectMcpServers: () => ({
        servers: [],
        transformPrompt: (prompt) => `sanitized: ${prompt}`
      }),
      onEvent: () => {}
    })

    await vi.waitFor(() => expect(fake.requests.some((request) => request.id === 1)).toBe(true))
    fake.respond({
      jsonrpc: '2.0',
      id: 1,
      result: {
        protocolVersion: 1,
        agentCapabilities: { sessionCapabilities: { resume: {} } }
      }
    })
    await vi.waitFor(() =>
      expect(fake.requests.some((request) => request.method === 'session/resume')).toBe(true)
    )
    fake.respond({
      jsonrpc: '2.0',
      id: 4,
      error: { code: -32000, message: 'native session unavailable' }
    })
    await vi.waitFor(() =>
      expect(fake.requests.some((request) => request.method === 'session/new')).toBe(true)
    )
    fake.respond({ jsonrpc: '2.0', id: 2, result: { sessionId: 'fresh-session' } })
    await vi.waitFor(() =>
      expect(fake.requests.some((request) => request.method === 'session/prompt')).toBe(true)
    )
    const prompt = fake.requests.find((request) => request.method === 'session/prompt')?.params as {
      prompt?: Array<{ text?: string }>
    }
    expect(prompt.prompt?.[0]?.text).toBe('sanitized: fallback MCP claim')

    handle.cancel()
    await handle.closed
  })

  it('uses the selected current servers when a legacy loadSession peer opens a fresh session', async () => {
    const fake = fakeChild()
    const selected = [
      {
        name: 'TaskWraith',
        type: 'http',
        url: 'http://127.0.0.1:41234/mcp',
        headers: [{ name: 'Authorization', value: 'Bearer current-token' }]
      }
    ]
    const handle = runAcpTurn({
      prompt: 'Use a current endpoint.',
      resumeSessionId: 'legacy-session',
      cwdLifetime: 'session',
      cwd: '/workspace',
      spawnProcess: () => fake.child,
      initializeParams: { protocolVersion: 1, clientCapabilities: {} },
      mcpServers: [{ name: 'TaskWraith', command: '/expired/stdio', args: [], env: [] }],
      selectMcpServers: () => selected,
      onEvent: () => {}
    })

    await vi.waitFor(() => expect(fake.requests.some((request) => request.id === 1)).toBe(true))
    fake.respond({
      jsonrpc: '2.0',
      id: 1,
      result: { protocolVersion: 1, agentCapabilities: { loadSession: true } }
    })
    await vi.waitFor(() =>
      expect(fake.requests.some((request) => request.method === 'session/new')).toBe(true)
    )
    expect(fake.requests.some((request) => request.method === 'session/load')).toBe(false)
    expect(fake.requests.find((request) => request.method === 'session/new')?.params).toMatchObject(
      {
        mcpServers: selected
      }
    )

    handle.cancel()
    await handle.closed
  })

  it('applies a toolless selection notice and prompt repair before session/prompt', async () => {
    const fake = fakeChild()
    const events: Array<{ type: string; text?: string }> = []
    const handle = runAcpTurn({
      prompt: 'TaskWraith MCP tools are available. Use them now.',
      cwdLifetime: 'run',
      cwd: '/workspace',
      spawnProcess: () => fake.child,
      initializeParams: { protocolVersion: 1, clientCapabilities: {} },
      mcpServers: [{ name: 'TaskWraith', command: '/expired/stdio', args: [], env: [] }],
      selectMcpServers: async () => ({
        servers: [],
        prompt: 'Continue without TaskWraith MCP claims.',
        warning: 'No safe MCP transport is available for this runtime.'
      }),
      onEvent: (event) => events.push(event)
    })

    await vi.waitFor(() => expect(fake.requests.some((request) => request.id === 1)).toBe(true))
    fake.respond({ jsonrpc: '2.0', id: 1, result: { protocolVersion: 1 } })
    await vi.waitFor(() =>
      expect(fake.requests.some((request) => request.method === 'session/new')).toBe(true)
    )
    expect(fake.requests.find((request) => request.method === 'session/new')?.params).toMatchObject(
      {
        mcpServers: []
      }
    )
    fake.respond({ jsonrpc: '2.0', id: 2, result: { sessionId: 'session-1' } })
    await vi.waitFor(() =>
      expect(fake.requests.some((request) => request.method === 'session/prompt')).toBe(true)
    )
    const prompt = fake.requests.find((request) => request.method === 'session/prompt')?.params as {
      prompt?: Array<{ text?: string }>
    }
    expect(prompt.prompt?.[0]?.text).toBe('Continue without TaskWraith MCP claims.')
    expect(events).toContainEqual({
      type: 'provider_warning',
      text: 'No safe MCP transport is available for this runtime.'
    })

    handle.cancel()
    await handle.closed
  })
})
