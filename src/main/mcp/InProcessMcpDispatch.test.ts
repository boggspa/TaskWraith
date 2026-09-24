import { afterEach, describe, expect, it, vi } from 'vitest'
import type { McpBridgeProfileEnvironment } from './McpBridgeRoute'
import { createInProcessMcpDispatch } from './InProcessMcpDispatch'

const INSTANCE_EPOCH = 'a'.repeat(48)

const SAFE_MISTRAL_PROFILE: McpBridgeProfileEnvironment = {
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

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('createInProcessMcpDispatch', () => {
  it('uses only the explicit Mistral parent, route, and profile under poisoned ambient state', async () => {
    for (const [key, value] of Object.entries({
      TASKWRAITH_MCP_SAFE_SUBSET: '0',
      TASKWRAITH_MCP_PLAN_SUBSET: '1',
      TASKWRAITH_MCP_CORE_SUBSET: '1',
      TASKWRAITH_MCP_GATEWAY_SUBSET: '0',
      TASKWRAITH_MCP_AUDIT: '1',
      TASKWRAITH_PARENT_PROVIDER: 'cursor',
      TASKWRAITH_RUN_ID: 'ambient-run',
      TASKWRAITH_CHAT_ID: 'ambient-chat',
      TASKWRAITH_WORKSPACE_PATH: '/ambient/workspace'
    })) {
      vi.stubEnv(key, value)
    }

    const dispatchBrokerRequest = vi.fn(async () => ({ ok: true, text: '{"ok":true}' }))
    const dispatch = createInProcessMcpDispatch({
      parentProvider: 'mistral',
      route: { appRunId: 'mistral-run', appChatId: 'mistral-chat' },
      profile: SAFE_MISTRAL_PROFILE,
      workspace: '/mistral/workspace',
      appVersion: '1.9.8',
      brokerToken: 'private-broker-token',
      instanceEpoch: INSTANCE_EPOCH,
      getMcpToolDefinitions: () => [{ name: 'read_file' }, { name: 'replace' }],
      dispatchBrokerRequest
    })

    const list = await dispatch({ jsonrpc: '2.0', id: 1, method: 'tools/list' })
    const names = (
      (list?.result as { tools?: Array<{ name?: string }> } | undefined)?.tools || []
    ).map((tool) => tool.name)
    expect(names).toContain('read_file')
    expect(names).not.toContain('replace')

    await expect(
      dispatch({
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: { name: 'read_file', arguments: { path: 'README.md' } }
      })
    ).resolves.toMatchObject({ result: { isError: false } })
    expect(dispatchBrokerRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        token: 'private-broker-token',
        parentProvider: 'mistral',
        appRunId: 'mistral-run',
        appChatId: 'mistral-chat',
        callerWorkspacePath: '/mistral/workspace',
        instanceEpoch: INSTANCE_EPOCH,
        tool: 'read_file'
      })
    )
  })

  it('redacts an unexpected broker rejection rather than exposing its message', async () => {
    const sentinel = 'private-token-that-must-not-escape'
    const dispatch = createInProcessMcpDispatch({
      parentProvider: 'mistral',
      route: { appRunId: 'mistral-run', appChatId: 'mistral-chat' },
      profile: { ...SAFE_MISTRAL_PROFILE, safeSubset: false },
      appVersion: '1.9.8',
      brokerToken: 'private-broker-token',
      instanceEpoch: INSTANCE_EPOCH,
      getMcpToolDefinitions: () => [{ name: 'read_file' }],
      dispatchBrokerRequest: async () => {
        throw new Error(sentinel)
      }
    })

    const response = await dispatch({
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: { name: 'read_file', arguments: { path: 'README.md' } }
    })
    expect(response).toMatchObject({
      result: {
        isError: true,
        content: [
          {
            type: 'text',
            text: 'TaskWraith MCP bridge encountered an unexpected internal error.'
          }
        ]
      }
    })
    expect(JSON.stringify(response)).not.toContain(sentinel)
  })

  it('carries the explicit plan and audit profile bits into tools/list', async () => {
    const dispatch = createInProcessMcpDispatch({
      parentProvider: 'mistral',
      route: { appRunId: 'mistral-audit-run', appChatId: 'mistral-audit-chat' },
      profile: {
        ...SAFE_MISTRAL_PROFILE,
        planSubset: true,
        gatewaySubset: false,
        auditSubset: true
      },
      appVersion: '1.9.8',
      brokerToken: 'private-broker-token',
      instanceEpoch: INSTANCE_EPOCH,
      getMcpToolDefinitions: () => [{ name: 'read_file' }, { name: 'canvas_click' }],
      dispatchBrokerRequest: vi.fn()
    })

    const response = await dispatch({ jsonrpc: '2.0', id: 4, method: 'tools/list' })
    const names = (
      (response?.result as { tools?: Array<{ name?: string }> } | undefined)?.tools || []
    ).map((tool) => tool.name)
    expect(names).toContain('read_file')
    expect(names).toContain('canvas_click')
    expect(names).toContain('audit_record_finding')
  })
})
