import { describe, expect, it, vi } from 'vitest'
import { createTaskWraithMcpToolDefinitions } from '../McpToolCatalog'
import { handleMcpJsonRpcMessage, McpBridgeRuntime } from './McpBridgeRuntime'

// One envelope convention at EVERY dispatch boundary, on BOTH control tool
// names. Before this suite the broker path unwrapped `params` only for the
// literal string `ensemble_control`, and it REPLACED the arguments rather than
// merging them — so `ensemble_bossman_control` silently dropped every enveloped
// field, and an envelope that did not repeat `action` dropped the action.

const BROKER_TOKEN = 'taskwraith-envelope-broker-token'
const INSTANCE_EPOCH = 'e'.repeat(32)
const SOCKET = '/tmp/taskwraith-envelope-convention.sock'

const CONTROL_TOOL_NAMES = ['ensemble_control', 'ensemble_bossman_control'] as const

function brokerHarness() {
  const executeGeminiMcpTool = vi.fn(async (_toolName: string, _arguments?: unknown) => ({
    isError: false,
    text: 'ok'
  }))
  const runtime = new McpBridgeRuntime({
    getGeminiMcpSocketPath: () => SOCKET,
    getGeminiMcpBrokerToken: () => BROKER_TOKEN,
    getInstanceEpoch: () => INSTANCE_EPOCH,
    executeGeminiMcpTool
  } as never)
  return { runtime, executeGeminiMcpTool }
}

async function callBroker(tool: string, args: unknown) {
  const { runtime, executeGeminiMcpTool } = brokerHarness()
  const response = await runtime.handleGeminiMcpBrokerRequest({
    token: BROKER_TOKEN,
    instanceEpoch: INSTANCE_EPOCH,
    tool,
    arguments: args,
    appRunId: 'run-envelope',
    appChatId: 'chat-envelope'
  })
  return {
    response,
    dispatchedTool: executeGeminiMcpTool.mock.calls[0]?.[0] as unknown,
    dispatchedArguments: executeGeminiMcpTool.mock.calls[0]?.[1] as Record<string, unknown>
  }
}

async function callStdio(input: {
  env: Record<string, string>
  name: string
  args: Record<string, unknown>
}) {
  const brokerRequest = vi.fn(async () => ({ ok: true, text: 'ok' }))
  const stdout = {
    write: vi.fn((_chunk: string, callback?: (error?: Error | null) => void) => {
      callback?.()
      return true
    })
  }
  handleMcpJsonRpcMessage(
    {
      getDefaultSocketPath: () => SOCKET,
      getAppVersion: () => 'test',
      getMcpToolDefinitions: createTaskWraithMcpToolDefinitions,
      brokerRequest,
      env: input.env,
      cwd: () => '/repo',
      stdout: stdout as never
    },
    SOCKET,
    'stdio-envelope-token',
    {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: input.name, arguments: input.args }
    },
    'line'
  )
  await new Promise((resolve) => setImmediate(resolve))
  return brokerRequest
}

describe('Ensemble control envelope convention — broker dispatch path', () => {
  it('delivers planSummary for BOTH names in BOTH shapes (live acceptance matrix)', async () => {
    for (const tool of CONTROL_TOOL_NAMES) {
      const flat = await callBroker(tool, {
        action: 'set_round_plan',
        planSummary: 'Review the implementation.'
      })
      expect(flat.dispatchedTool).toBe('ensemble_bossman_control')
      expect(flat.dispatchedArguments).toMatchObject({
        action: 'set_round_plan',
        planSummary: 'Review the implementation.'
      })

      const enveloped = await callBroker(tool, {
        action: 'set_round_plan',
        params: { action: 'set_round_plan', planSummary: 'Review the implementation.' }
      })
      expect(enveloped.dispatchedTool).toBe('ensemble_bossman_control')
      expect(enveloped.dispatchedArguments).toMatchObject({
        action: 'set_round_plan',
        planSummary: 'Review the implementation.'
      })
      expect(enveloped.dispatchedArguments.params).toBeUndefined()
    }
  })

  it('preserves the outer action when the envelope does not repeat it', async () => {
    for (const tool of CONTROL_TOOL_NAMES) {
      const { dispatchedArguments } = await callBroker(tool, {
        action: 'set_round_plan',
        params: { planSummary: 'Envelope omits the action.' }
      })
      expect(dispatchedArguments).toMatchObject({
        action: 'set_round_plan',
        planSummary: 'Envelope omits the action.'
      })
    }
  })

  it('folds snake_case aliases for sibling Ensemble tools', async () => {
    const { dispatchedArguments } = await callBroker('ensemble_fanout', {
      prompt: 'go',
      write_scopes: { Work4: ['src/main/index.ts'] },
      target_stage: 'workers'
    })
    expect(dispatchedArguments).toMatchObject({
      writeScopes: { Work4: ['src/main/index.ts'] },
      targetStage: 'workers'
    })
  })

  it('does not treat a stray top-level params as arguments for a non-control tool', async () => {
    const { runtime, executeGeminiMcpTool } = brokerHarness()
    await runtime.handleGeminiMcpBrokerRequest({
      token: BROKER_TOKEN,
      instanceEpoch: INSTANCE_EPOCH,
      tool: 'read_file',
      params: { path: 'should-not-be-adopted.ts' },
      appRunId: 'run-envelope',
      appChatId: 'chat-envelope'
    })
    expect(executeGeminiMcpTool.mock.calls[0]?.[1]).toBeUndefined()
  })

  it('still rejects an unauthenticated broker request', async () => {
    const { runtime, executeGeminiMcpTool } = brokerHarness()
    const response = await runtime.handleGeminiMcpBrokerRequest({
      token: 'wrong-token',
      instanceEpoch: INSTANCE_EPOCH,
      tool: 'ensemble_bossman_control',
      arguments: { action: 'set_round_plan', params: { planSummary: 'nope' } }
    })
    expect(response).toMatchObject({ ok: false })
    expect(executeGeminiMcpTool).not.toHaveBeenCalled()
  })
})

describe('Ensemble control envelope convention — stdio tools/call path', () => {
  it('unwraps the envelope for the canonical name on a legacy profile', async () => {
    const brokerRequest = await callStdio({
      env: { TASKWRAITH_MCP_GATEWAY_SUBSET: '1' },
      name: 'ensemble_bossman_control',
      args: { action: 'set_round_plan', params: { planSummary: 'Review the implementation.' } }
    })
    expect(brokerRequest).toHaveBeenCalledWith(
      SOCKET,
      expect.objectContaining({
        tool: 'ensemble_bossman_control',
        arguments: { action: 'set_round_plan', planSummary: 'Review the implementation.' }
      })
    )
  })

  it('unwraps the envelope for the portable name on a fresh profile', async () => {
    const brokerRequest = await callStdio({
      env: {
        TASKWRAITH_MCP_GATEWAY_SUBSET: '1',
        TASKWRAITH_MCP_PORTABLE_ENSEMBLE_CONTROL: '1'
      },
      name: 'ensemble_control',
      args: { action: 'set_round_plan', params: { planSummary: 'Review the implementation.' } }
    })
    expect(brokerRequest).toHaveBeenCalledWith(
      SOCKET,
      expect.objectContaining({
        tool: 'ensemble_bossman_control',
        arguments: { action: 'set_round_plan', planSummary: 'Review the implementation.' }
      })
    )
  })

  it('keeps the legacy-profile fence closed for the unadvertised portable alias', async () => {
    const brokerRequest = await callStdio({
      env: { TASKWRAITH_MCP_GATEWAY_SUBSET: '1' },
      name: 'ensemble_control',
      args: { action: 'set_round_plan', params: { planSummary: 'fenced' } }
    })
    expect(brokerRequest).not.toHaveBeenCalled()
  })
})
