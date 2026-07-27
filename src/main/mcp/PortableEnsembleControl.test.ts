import { describe, expect, it, vi } from 'vitest'
import { createTaskWraithMcpToolDefinitions } from '../McpToolCatalog'
import { handleMcpJsonRpcMessage } from './McpBridgeRuntime'

const SOCKET = '/tmp/taskwraith-portable-ensemble-control.sock'
const TOKEN = 'portable-control-test-token'

async function invoke(input: {
  env: Record<string, string>
  method: 'tools/list' | 'tools/call'
  params?: Record<string, unknown>
}) {
  const brokerRequest = vi.fn(async () => ({ ok: true, text: 'ok' }))
  const responses: Array<Record<string, unknown>> = []
  const stdout = {
    write: vi.fn((chunk: string, callback?: (error?: Error | null) => void) => {
      for (const line of String(chunk).split('\n')) {
        const trimmed = line.trim()
        if (!trimmed) continue
        responses.push(JSON.parse(trimmed) as Record<string, unknown>)
      }
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
    TOKEN,
    {
      jsonrpc: '2.0',
      id: 1,
      method: input.method,
      ...(input.params ? { params: input.params } : {})
    },
    'line'
  )
  await new Promise((resolve) => setImmediate(resolve))
  return { brokerRequest, responses }
}

describe('portable Ensemble control MCP fence', () => {
  it('is visible only to fresh profile bridge children', async () => {
    const legacy = await invoke({
      env: { TASKWRAITH_MCP_GATEWAY_SUBSET: '1' },
      method: 'tools/list'
    })
    const fresh = await invoke({
      env: {
        TASKWRAITH_MCP_GATEWAY_SUBSET: '1',
        TASKWRAITH_MCP_PORTABLE_ENSEMBLE_CONTROL: '1'
      },
      method: 'tools/list'
    })
    const toolNames = (result: Record<string, unknown>) =>
      ((result.result as { tools?: Array<{ name?: string }> } | undefined)?.tools || []).map(
        (tool) => tool.name
      )

    expect(toolNames(legacy.responses[0])).not.toContain('ensemble_control')
    expect(toolNames(legacy.responses[0])).toContain('ensemble_bossman_control')
    expect(toolNames(fresh.responses[0])).toContain('ensemble_control')
    expect(toolNames(fresh.responses[0])).not.toContain('ensemble_bossman_control')
  })

  it('preserves the legacy authority executor and rejects an unadvertised alias', async () => {
    const params = {
      name: 'ensemble_control',
      arguments: { action: 'set_round_plan', params: { goal: 'Review.' } }
    }
    const legacy = await invoke({
      env: { TASKWRAITH_MCP_GATEWAY_SUBSET: '1' },
      method: 'tools/call',
      params
    })
    expect(legacy.brokerRequest).not.toHaveBeenCalled()
    expect(legacy.responses[0]?.error).toMatchObject({ code: -32601 })

    const fresh = await invoke({
      env: {
        TASKWRAITH_MCP_GATEWAY_SUBSET: '1',
        TASKWRAITH_MCP_PORTABLE_ENSEMBLE_CONTROL: '1'
      },
      method: 'tools/call',
      params
    })
    expect(fresh.brokerRequest).toHaveBeenCalledWith(
      SOCKET,
      expect.objectContaining({
        tool: 'ensemble_bossman_control',
        arguments: { action: 'set_round_plan', goal: 'Review.' }
      })
    )

    const legacyNameOnFreshProfile = await invoke({
      env: {
        TASKWRAITH_MCP_GATEWAY_SUBSET: '1',
        TASKWRAITH_MCP_PORTABLE_ENSEMBLE_CONTROL: '1'
      },
      method: 'tools/call',
      params: { name: 'ensemble_bossman_control', arguments: { action: 'set_round_plan' } }
    })
    expect(legacyNameOnFreshProfile.brokerRequest).not.toHaveBeenCalled()
    expect(legacyNameOnFreshProfile.responses[0]?.error).toMatchObject({ code: -32601 })
  })
})
