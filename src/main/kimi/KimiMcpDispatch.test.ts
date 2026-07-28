import { describe, expect, it, vi } from 'vitest'
import { createKimiMcpDispatch } from './KimiMcpDispatch'

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
        parentProvider: 'kimi'
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

  it('makes Sketch direct for v8 Kimi seats without drifting a v7 receipt', async () => {
    const listFor = async (
      taskWraithMcpProfileId: 'taskwraith-gateway-v7' | 'taskwraith-gateway-v8'
    ) => {
      const dispatch = createKimiMcpDispatch({
        route: { appRunId: 'kimi-run-sketch', appChatId: 'chat-sketch' },
        taskWraithMcpProfileId,
        appVersion: '1.8.4',
        brokerToken: 'broker-token',
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
    for (const tool of ['canvas_sketch_open', 'canvas_sketch_get', 'canvas_sketch_update']) {
      expect(v7).not.toContain(tool)
      expect(v8).toContain(tool)
    }
  })

  it('returns null for notifications without touching the broker', async () => {
    const dispatchBrokerRequest = vi.fn()
    const dispatch = createKimiMcpDispatch({
      route: {},
      appVersion: '1.8.4',
      brokerToken: 'broker-token',
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
})
