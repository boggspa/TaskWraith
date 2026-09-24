import { describe, expect, it, vi } from 'vitest'
import {
  GATEWAY_SOLO_V1_DEMOTED_TOOL_NAMES,
  GATEWAY_SOLO_V1_MCP_ADVERTISE_TOOLS,
  GATEWAY_SOLO_V1_MCP_DIRECT_TOOLS
} from '../mcp/McpToolProfiles'
import { createKimiMcpDispatch } from './KimiMcpDispatch'

const INSTANCE_EPOCH = 'a'.repeat(48)

describe('createKimiMcpDispatch', () => {
  it('routes Kimi tool calls directly to the in-process broker with the run identity', async () => {
    const dispatchBrokerRequest = vi.fn(async () => ({
      ok: true,
      text: '{"ok":true}',
      structuredContent: { ok: true }
    }))
    const dispatch = createKimiMcpDispatch({
      route: { appRunId: 'kimi-run-1', appChatId: 'chat-1' },
      workspace: '/workspace',
      appVersion: '1.8.4',
      brokerToken: 'broker-token',
      instanceEpoch: INSTANCE_EPOCH,
      getMcpToolDefinitions: () => [
        {
          name: 'list_ensemble_participants',
          inputSchema: { type: 'object', properties: {} }
        }
      ],
      dispatchBrokerRequest
    })

    const response = await dispatch({
      jsonrpc: '2.0',
      id: 7,
      method: 'tools/call',
      params: { name: 'list_ensemble_participants', arguments: {} }
    })

    expect(dispatchBrokerRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        token: 'broker-token',
        tool: 'list_ensemble_participants',
        appRunId: 'kimi-run-1',
        appChatId: 'chat-1',
        callerWorkspacePath: '/workspace',
        parentProvider: 'kimi',
        instanceEpoch: INSTANCE_EPOCH
      })
    )
    expect(response).toMatchObject({
      jsonrpc: '2.0',
      id: 7,
      result: {
        isError: false,
        structuredContent: { ok: true }
      }
    })
  })

  it('keeps the gateway catalogue guard while avoiding a broker call for discovery', async () => {
    const dispatchBrokerRequest = vi.fn()
    const dispatch = createKimiMcpDispatch({
      route: { appRunId: 'kimi-run-2', appChatId: 'chat-2' },
      appVersion: '1.8.4',
      brokerToken: 'broker-token',
      instanceEpoch: INSTANCE_EPOCH,
      getMcpToolDefinitions: () => [
        { name: 'list_ensemble_participants' },
        { name: 'raw_provider_events' }
      ],
      dispatchBrokerRequest
    })

    const response = await dispatch({ jsonrpc: '2.0', id: 8, method: 'tools/list' })
    const result = response?.result as { tools?: Array<{ name?: string }> } | undefined

    expect(result?.tools?.map((tool) => tool.name)).toContain('list_ensemble_participants')
    expect(result?.tools?.map((tool) => tool.name)).not.toContain('raw_provider_events')
    expect(dispatchBrokerRequest).not.toHaveBeenCalled()
  })

  it('exposes only the compact Ensemble control declaration for a fresh profile', async () => {
    const dispatch = createKimiMcpDispatch({
      route: { appRunId: 'kimi-run-compact', appChatId: 'chat-compact' },
      taskWraithMcpProfileId: 'taskwraith-gateway-v6',
      appVersion: '1.8.4',
      brokerToken: 'broker-token',
      instanceEpoch: INSTANCE_EPOCH,
      getMcpToolDefinitions: () => [
        { name: 'ensemble_control' },
        { name: 'ensemble_bossman_control' }
      ],
      dispatchBrokerRequest: vi.fn()
    })

    const response = await dispatch({ jsonrpc: '2.0', id: 88, method: 'tools/list' })
    const names = (
      (response?.result as { tools?: Array<{ name?: string }> } | undefined)?.tools || []
    ).map((tool) => tool.name)
    expect(names).toContain('ensemble_control')
    expect(names).not.toContain('ensemble_bossman_control')
  })

  it('exposes the exact lean solo catalogue while retaining async coordination', async () => {
    vi.stubEnv('TASKWRAITH_MCP_SOLO_SUBSET', '0')
    try {
      const dispatch = createKimiMcpDispatch({
        route: { appRunId: 'kimi-run-solo', appChatId: 'chat-solo' },
        taskWraithMcpProfileId: 'taskwraith-gateway-solo-v1',
        appVersion: '1.8.4',
        brokerToken: 'broker-token',
        instanceEpoch: INSTANCE_EPOCH,
        getMcpToolDefinitions: () =>
          [...GATEWAY_SOLO_V1_MCP_DIRECT_TOOLS, ...GATEWAY_SOLO_V1_DEMOTED_TOOL_NAMES].map(
            (name) => ({ name })
          ),
        dispatchBrokerRequest: vi.fn()
      })

      const response = await dispatch({ jsonrpc: '2.0', id: 881, method: 'tools/list' })
      const names = (
        (response?.result as { tools?: Array<{ name?: string }> } | undefined)?.tools || []
      ).map((tool) => tool.name)
      expect(GATEWAY_SOLO_V1_MCP_DIRECT_TOOLS).toHaveLength(29)
      expect(names).toEqual(GATEWAY_SOLO_V1_MCP_ADVERTISE_TOOLS)
      expect(names).toHaveLength(31)
      expect(names).toEqual(
        expect.arrayContaining(['ensemble_await', 'ensemble_lane_result', 'delegate_wave'])
      )
      for (const name of GATEWAY_SOLO_V1_DEMOTED_TOOL_NAMES) {
        expect(names).not.toContain(name)
      }
    } finally {
      vi.unstubAllEnvs()
    }
  })

  it('uses only the selected Kimi profile when ambient MCP selectors are poisoned', async () => {
    const poisonedSelectors = {
      TASKWRAITH_CORE_MCP_PROFILE: '1',
      TASKWRAITH_MCP_SAFE_SUBSET: '1',
      TASKWRAITH_MCP_PLAN_SUBSET: '1',
      TASKWRAITH_MCP_CORE_SUBSET: '1',
      TASKWRAITH_MCP_GATEWAY_SUBSET: '0',
      TASKWRAITH_MCP_SOLO_SUBSET: '1',
      TASKWRAITH_MCP_PORTABLE_ENSEMBLE_CONTROL: '1',
      TASKWRAITH_MCP_MESH_DIRECT: '1',
      TASKWRAITH_MCP_MESH_TOPOLOGY_DIRECT: '1',
      TASKWRAITH_MCP_SKETCH_DIRECT: '1',
      TASKWRAITH_MCP_ORCHESTRATION_DIRECT: '1',
      TASKWRAITH_MCP_AUDIT: '1',
      TASKWRAITH_PARENT_PROVIDER: 'cursor',
      TASKWRAITH_RUN_ID: 'ambient-run',
      TASKWRAITH_CHAT_ID: 'ambient-chat',
      TASKWRAITH_WORKSPACE_PATH: '/ambient/workspace',
      TASKWRAITH_MCP_SOCKET_PATH: '/ambient/socket',
      TASKWRAITH_MCP_BROKER_TOKEN: 'ambient-token',
      TASKWRAITH_MCP_INSTANCE_EPOCH: 'b'.repeat(48),
      TASKWRAITH_MCP_BRIDGE_LOG_EPOCH: '99',
      TASKWRAITH_MCP_ISOLATED_INSTANCE_ID: 'ambient-instance'
    }
    for (const [key, value] of Object.entries(poisonedSelectors)) vi.stubEnv(key, value)

    try {
      const dispatchBrokerRequest = vi.fn(async () => ({ ok: true, text: '{"ok":true}' }))
      const dispatch = createKimiMcpDispatch({
        route: { appRunId: 'kimi-profile-run', appChatId: 'kimi-profile-chat' },
        workspace: '/kimi/workspace',
        // v5 deliberately keeps the legacy Bossman declaration and does not
        // directly expose Mesh Canvas.
        taskWraithMcpProfileId: 'taskwraith-gateway-v5',
        appVersion: '1.8.4',
        brokerToken: 'broker-token',
        instanceEpoch: INSTANCE_EPOCH,
        getMcpToolDefinitions: () => [
          { name: 'write_file' },
          { name: 'ensemble_propose_goal_complete' },
          { name: 'ensemble_bossman_control' },
          { name: 'ensemble_control' },
          { name: 'mesh_scene_present' },
          { name: 'canvas_sketch_update' }
        ],
        dispatchBrokerRequest
      })

      const listResponse = await dispatch({ jsonrpc: '2.0', id: 90, method: 'tools/list' })
      const listedNames = (
        (listResponse?.result as { tools?: Array<{ name?: string }> } | undefined)?.tools || []
      ).map((tool) => tool.name)

      // Ambient safe/plan/core controls cannot shrink this selected gateway
      // profile, and ambient portable/mesh/audit controls cannot widen it.
      expect(listedNames).toEqual(
        expect.arrayContaining([
          'write_file',
          'ensemble_propose_goal_complete',
          'ensemble_bossman_control',
          'capability_search',
          'capability_invoke'
        ])
      )
      expect(listedNames).not.toContain('ensemble_control')
      expect(listedNames).not.toContain('mesh_scene_present')
      expect(listedNames).not.toContain('canvas_sketch_update')
      expect(listedNames).not.toContain('audit_record_finding')

      await expect(
        dispatch({
          jsonrpc: '2.0',
          id: 91,
          method: 'tools/call',
          params: { name: 'write_file', arguments: { path: 'selected.txt', content: 'selected' } }
        })
      ).resolves.toMatchObject({ result: { isError: false } })
      await expect(
        dispatch({
          jsonrpc: '2.0',
          id: 92,
          method: 'tools/call',
          params: { name: 'ensemble_propose_goal_complete', arguments: {} }
        })
      ).resolves.toMatchObject({ result: { isError: false } })
      expect(dispatchBrokerRequest).toHaveBeenCalledTimes(2)
      expect(dispatchBrokerRequest).toHaveBeenNthCalledWith(
        1,
        expect.objectContaining({
          appRunId: 'kimi-profile-run',
          appChatId: 'kimi-profile-chat',
          callerWorkspacePath: '/kimi/workspace',
          parentProvider: 'kimi',
          instanceEpoch: INSTANCE_EPOCH
        })
      )

      for (const [id, name] of [
        [93, 'ensemble_control'],
        [94, 'mesh_scene_present'],
        [95, 'canvas_sketch_update'],
        [96, 'audit_record_finding']
      ] as const) {
        await expect(
          dispatch({
            jsonrpc: '2.0',
            id,
            method: 'tools/call',
            params: { name, arguments: {} }
          })
        ).resolves.toMatchObject({ error: { code: -32601 } })
      }
      expect(dispatchBrokerRequest).toHaveBeenCalledTimes(2)
    } finally {
      vi.unstubAllEnvs()
    }
  })

  it('keeps Sketch direct for v8 and v9 Kimi seats without drifting a v7 receipt', async () => {
    const listFor = async (
      taskWraithMcpProfileId:
        | 'taskwraith-gateway-v7'
        | 'taskwraith-gateway-v8'
        | 'taskwraith-gateway-v9'
    ) => {
      const dispatch = createKimiMcpDispatch({
        route: { appRunId: 'kimi-run-sketch', appChatId: 'chat-sketch' },
        taskWraithMcpProfileId,
        appVersion: '1.8.4',
        brokerToken: 'broker-token',
        instanceEpoch: INSTANCE_EPOCH,
        getMcpToolDefinitions: () => [
          { name: 'read_file' },
          { name: 'canvas_sketch_open' },
          { name: 'canvas_sketch_get' },
          { name: 'canvas_sketch_update' }
        ],
        dispatchBrokerRequest: vi.fn()
      })
      const response = await dispatch({ jsonrpc: '2.0', id: 89, method: 'tools/list' })
      return (
        (response?.result as { tools?: Array<{ name?: string }> } | undefined)?.tools || []
      ).map((tool) => tool.name)
    }

    const v7 = await listFor('taskwraith-gateway-v7')
    const v8 = await listFor('taskwraith-gateway-v8')
    const v9 = await listFor('taskwraith-gateway-v9')
    for (const tool of ['canvas_sketch_open', 'canvas_sketch_get', 'canvas_sketch_update']) {
      expect(v7).not.toContain(tool)
      expect(v8).toContain(tool)
      expect(v9).toContain(tool)
    }
  })

  it('keeps topology hidden from v14-mesh and direct only for v15-mesh', async () => {
    const brokerV14 = vi.fn(async () => ({ ok: true, text: '{"ok":true}' }))
    const brokerV15 = vi.fn(async () => ({ ok: true, text: '{"ok":true}' }))
    const makeDispatch = (
      profile: 'taskwraith-gateway-v14-mesh' | 'taskwraith-gateway-v15-mesh',
      dispatchBrokerRequest: typeof brokerV14
    ) =>
      createKimiMcpDispatch({
        route: { appRunId: `kimi-${profile}`, appChatId: 'chat-mesh' },
        taskWraithMcpProfileId: profile,
        appVersion: '1.8.4',
        brokerToken: 'broker-token',
        instanceEpoch: INSTANCE_EPOCH,
        getMcpToolDefinitions: () => [
          { name: 'mesh_scene_present' },
          { name: 'mesh_topology_edit' }
        ],
        dispatchBrokerRequest
      })
    const v14 = makeDispatch('taskwraith-gateway-v14-mesh', brokerV14)
    const v15 = makeDispatch('taskwraith-gateway-v15-mesh', brokerV15)

    const names = async (dispatch: ReturnType<typeof makeDispatch>, id: number) => {
      const response = await dispatch({ jsonrpc: '2.0', id, method: 'tools/list' })
      return (
        (response?.result as { tools?: Array<{ name?: string }> } | undefined)?.tools || []
      ).map((tool) => tool.name)
    }
    expect(await names(v14, 101)).toContain('mesh_scene_present')
    expect(await names(v14, 102)).not.toContain('mesh_topology_edit')
    expect(await names(v15, 103)).toEqual(
      expect.arrayContaining(['mesh_scene_present', 'mesh_topology_edit'])
    )

    await expect(
      v14({
        jsonrpc: '2.0',
        id: 104,
        method: 'tools/call',
        params: { name: 'mesh_topology_edit', arguments: {} }
      })
    ).resolves.toMatchObject({ error: { code: -32601 } })
    await expect(
      v15({
        jsonrpc: '2.0',
        id: 105,
        method: 'tools/call',
        params: { name: 'mesh_topology_edit', arguments: {} }
      })
    ).resolves.toMatchObject({ result: { isError: false } })
    expect(brokerV14).not.toHaveBeenCalled()
    expect(brokerV15).toHaveBeenCalledOnce()
  })

  it('returns null for notifications without touching the broker', async () => {
    const dispatchBrokerRequest = vi.fn()
    const dispatch = createKimiMcpDispatch({
      route: {},
      appVersion: '1.8.4',
      brokerToken: 'broker-token',
      instanceEpoch: INSTANCE_EPOCH,
      getMcpToolDefinitions: () => [],
      dispatchBrokerRequest
    })

    await expect(
      dispatch({ jsonrpc: '2.0', method: 'notifications/initialized' })
    ).resolves.toBeNull()
    expect(dispatchBrokerRequest).not.toHaveBeenCalled()
  })

  it('redacts an unexpected synchronous dispatch failure', async () => {
    const sentinel = '/Users/operator/private/workspace/.secrets/token=host-secret'
    const dispatch = createKimiMcpDispatch({
      route: {},
      appVersion: '1.8.4',
      brokerToken: 'broker-token',
      instanceEpoch: INSTANCE_EPOCH,
      getMcpToolDefinitions: () => {
        throw new Error(sentinel)
      },
      dispatchBrokerRequest: vi.fn()
    })

    const response = await dispatch({ jsonrpc: '2.0', id: 81, method: 'tools/list' })

    expect(response).toEqual({
      jsonrpc: '2.0',
      id: 81,
      error: {
        code: -32603,
        message: 'TaskWraith MCP bridge encountered an unexpected internal error.'
      }
    })
    expect(JSON.stringify(response)).not.toContain(sentinel)
  })

  it('redacts an unexpected broker rejection from the shared gateway', async () => {
    const sentinel = '/Users/operator/private/workspace/.secrets/token=host-secret'
    const dispatch = createKimiMcpDispatch({
      route: {},
      appVersion: '1.8.4',
      brokerToken: 'broker-token',
      instanceEpoch: INSTANCE_EPOCH,
      getMcpToolDefinitions: () => [{ name: 'list_ensemble_participants' }],
      dispatchBrokerRequest: vi.fn(async () => {
        throw new Error(sentinel)
      })
    })

    const response = await dispatch({
      jsonrpc: '2.0',
      id: 82,
      method: 'tools/call',
      params: { name: 'list_ensemble_participants', arguments: {} }
    })

    expect(response).toMatchObject({
      jsonrpc: '2.0',
      id: 82,
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

  it('keeps an approval-backed call alive beyond the old 30 second cutoff', async () => {
    vi.useFakeTimers()
    try {
      let finishBroker: ((value: unknown) => void) | undefined
      const dispatchBrokerRequest = vi.fn(
        () =>
          new Promise<unknown>((resolve) => {
            finishBroker = resolve
          })
      )
      const dispatch = createKimiMcpDispatch({
        route: { appRunId: 'kimi-run-approval', appChatId: 'chat-approval' },
        appVersion: '1.8.4',
        brokerToken: 'broker-token',
        instanceEpoch: INSTANCE_EPOCH,
        getMcpToolDefinitions: () => [{ name: 'ensemble_roster_edit' }],
        dispatchBrokerRequest
      })

      let settled = false
      const responsePromise = dispatch({
        jsonrpc: '2.0',
        id: 9,
        method: 'tools/call',
        params: { name: 'ensemble_roster_edit', arguments: { action: 'import_preset' } }
      }).finally(() => {
        settled = true
      })

      await vi.advanceTimersByTimeAsync(30_001)
      expect(settled).toBe(false)

      finishBroker?.({ ok: true, text: '{"ok":true}' })
      await expect(responsePromise).resolves.toMatchObject({
        jsonrpc: '2.0',
        id: 9,
        result: { isError: false }
      })
    } finally {
      vi.useRealTimers()
    }
  })

  it('cancels the exact host operation before returning a broker timeout to Kimi', async () => {
    vi.useFakeTimers()
    try {
      const events: string[] = []
      let proveCancellationSettled!: () => void
      const cancellationSettled = new Promise<void>((resolve) => {
        proveCancellationSettled = resolve
      })
      const onDispatchTimeout = vi.fn(() => {
        events.push('cancel')
        return cancellationSettled
      })
      const dispatch = createKimiMcpDispatch({
        route: { appRunId: 'kimi-timeout-run', appChatId: 'chat-timeout' },
        workspace: '/workspace',
        appVersion: '1.8.4',
        brokerToken: 'broker-token',
        instanceEpoch: INSTANCE_EPOCH,
        timeoutMs: 25,
        getMcpToolDefinitions: () => [{ name: 'run_shell_command' }],
        dispatchBrokerRequest: () => new Promise(() => undefined),
        onDispatchTimeout
      })

      const response = dispatch({
        jsonrpc: '2.0',
        id: 759,
        method: 'tools/call',
        params: { name: 'run_shell_command', arguments: { command: 'long-command' } }
      }).then((value) => {
        events.push('response')
        return value
      })

      await vi.advanceTimersByTimeAsync(25)
      let responseSettled = false
      void response.then(() => {
        responseSettled = true
      })
      await Promise.resolve()
      expect(responseSettled).toBe(false)
      expect(events).toEqual(['cancel'])

      proveCancellationSettled()
      await expect(response).resolves.toMatchObject({
        id: 759,
        error: { message: 'TaskWraith MCP dispatch timed out.' }
      })
      expect(onDispatchTimeout).toHaveBeenCalledWith({
        appRunId: 'kimi-timeout-run',
        appChatId: 'chat-timeout',
        requestId: 759,
        toolName: 'run_shell_command'
      })
      expect(events).toEqual(['cancel', 'response'])
    } finally {
      vi.useRealTimers()
    }
  })
})
