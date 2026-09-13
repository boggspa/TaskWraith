import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AcpChildProcess } from '../acp/AcpTurnClient'
import type { McpBridgeProfileEnvironment } from '../mcp/McpBridgeRoute'
import { createInProcessMcpDispatch } from '../mcp/InProcessMcpDispatch'
import { runMistralAcpTurn } from './MistralAcpClient'
import { startMistralHttpMcpTransport } from './MistralMcpTransport'

const INSTANCE_EPOCH = 'a'.repeat(48)
const PROFILE: McpBridgeProfileEnvironment = {
  safeSubset: true,
  planSubset: false,
  coreSubset: false,
  gatewaySubset: true,
  soloSubset: false,
  portableEnsembleControl: false,
  meshDirect: false,
  meshTopologyDirect: false,
  sketchDirect: false,
  orchestrationDirect: false,
  permissionOpportunityDirect: false,
  auditSubset: false
}

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

async function post(
  url: string,
  authorization: string,
  body: Record<string, unknown>
): Promise<{ status: number; json: unknown }> {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: authorization },
    body: JSON.stringify(body)
  })
  const text = await response.text()
  return { status: response.status, json: text ? JSON.parse(text) : null }
}

const openTransports: Array<{ close: () => Promise<void> }> = []

afterEach(async () => {
  await Promise.all(openTransports.splice(0).map((transport) => transport.close()))
})

describe('Mistral guarded HTTP MCP transport', () => {
  it('carries a fake Vibe ACP session through real authenticated HTTP to the Mistral route', async () => {
    const dispatchBrokerRequest = vi.fn(async () => ({ ok: true, text: '{"ok":true}' }))
    const dispatch = createInProcessMcpDispatch({
      parentProvider: 'mistral',
      route: { appRunId: 'mistral-http-run', appChatId: 'mistral-http-chat' },
      profile: PROFILE,
      workspace: '/workspace',
      appVersion: '1.9.8',
      brokerToken: 'private-broker-token',
      instanceEpoch: INSTANCE_EPOCH,
      getMcpToolDefinitions: () => [{ name: 'read_file' }, { name: 'replace' }],
      dispatchBrokerRequest
    })
    const getStdioServer = vi.fn(() => ({
      name: 'TaskWraith',
      command:
        '/private/var/folders/test/T/AppTranslocation/UUID/d/TaskWraith.app/Contents/MacOS/TaskWraith',
      args: [],
      env: []
    }))
    const transport = await startMistralHttpMcpTransport({
      serverName: 'TaskWraith-Mistral',
      dispatch,
      getStdioServer
    })
    openTransports.push(transport)

    const fake = fakeChild()
    const handle = runMistralAcpTurn({
      skipIntroduction: true,
      prompt: '/inspect',
      cwd: '/workspace',
      appVersion: '1.9.8',
      spawnProcess: () => fake.child,
      mcpServers: [],
      selectMcpServers: async (initializeResult) =>
        (await transport.selectMcpTransport(initializeResult)).servers,
      onEvent: () => {}
    })

    await vi.waitFor(() => expect(fake.requests.some((request) => request.id === 1)).toBe(true))
    fake.respond({
      jsonrpc: '2.0',
      id: 1,
      result: {
        protocolVersion: 1,
        agentCapabilities: {},
        agentInfo: { name: '@mistralai/mistral-vibe', version: '2.22.0' }
      }
    })
    await vi.waitFor(() =>
      expect(fake.requests.some((request) => request.method === 'session/new')).toBe(true)
    )
    const sessionNew = fake.requests.find((request) => request.method === 'session/new')
    expect(sessionNew?.params).toMatchObject({ mcpServers: [transport.server] })
    expect(getStdioServer).not.toHaveBeenCalled()

    const unauthorized = await post(transport.server.url, 'Bearer wrong', {
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/list'
    })
    expect(unauthorized.status).toBe(401)

    const authorization = transport.server.headers[0].value
    const listed = await post(transport.server.url, authorization, {
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/list'
    })
    const listedNames = (
      (listed.json as { result?: { tools?: Array<{ name?: string }> } }).result?.tools || []
    ).map((tool) => tool.name)
    expect(listedNames).toContain('read_file')
    expect(listedNames).not.toContain('replace')

    await post(transport.server.url, authorization, {
      jsonrpc: '2.0',
      id: 4,
      method: 'tools/call',
      params: { name: 'read_file', arguments: { path: 'README.md' } }
    })
    expect(dispatchBrokerRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        parentProvider: 'mistral',
        appRunId: 'mistral-http-run',
        appChatId: 'mistral-http-chat',
        callerWorkspacePath: '/workspace',
        tool: 'read_file'
      })
    )

    handle.cancel()
    await handle.closed
    await transport.close()
    await expect(fetch(transport.server.url)).rejects.toThrow()
  })

  it('closes a partially started transport when setup fails', async () => {
    const close = vi.fn(async () => {})
    await expect(
      startMistralHttpMcpTransport({
        serverName: 'TaskWraith-Mistral',
        dispatch: async () => null,
        getStdioServer: () => null,
        startBridge: async () =>
          ({
            url: '',
            headerName: 'Authorization',
            headerValue: 'Bearer private-token',
            close
          }) as never
      })
    ).rejects.toThrow('valid loopback URL')
    expect(close).toHaveBeenCalledOnce()
  })
})
