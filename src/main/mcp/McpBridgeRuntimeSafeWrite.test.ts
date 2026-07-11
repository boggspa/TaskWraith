import { describe, expect, it, vi } from 'vitest'
import {
  applyMcpBridgeProfileArgvToEnv,
  GEMINI_MCP_CORE_SUBSET_ARG,
  GEMINI_MCP_GATEWAY_SUBSET_ARG,
  McpBridgeRuntime,
  handleMcpJsonRpcMessage,
  safeMcpStreamWrite,
  writeMcpFrame,
  writeMcpPayload
} from './McpBridgeRuntime'

describe('MCP bridge stream writes', () => {
  it('swallows terminal EPIPE writes', () => {
    const stream = {
      write: vi.fn(() => {
        throw Object.assign(new Error('write EPIPE'), { code: 'EPIPE' })
      })
    }

    expect(() => safeMcpStreamWrite(stream, '{"ok":true}\n')).not.toThrow()
    expect(stream.write).toHaveBeenCalledOnce()
  })

  it('does not write to already closed streams', () => {
    const stream = {
      destroyed: true,
      write: vi.fn()
    }

    safeMcpStreamWrite(stream, '{"ok":true}\n')

    expect(stream.write).not.toHaveBeenCalled()
  })

  it('uses safe writes for line and framed MCP responses', () => {
    const stream = {
      write: vi.fn(() => {
        throw Object.assign(new Error('write EPIPE'), { code: 'EPIPE' })
      })
    }

    expect(() => writeMcpPayload({ ok: true }, 'line', stream as never)).not.toThrow()
    expect(() => writeMcpFrame({ ok: true }, stream as never)).not.toThrow()
    expect(stream.write).toHaveBeenCalledTimes(2)
  })

  it('stamps caller route and workspace metadata onto brokered tool calls', async () => {
    const brokerRequest = vi.fn(async () => ({ ok: true, text: 'ok' }))
    const stream = {
      write: vi.fn((_chunk: string, callback?: (error?: Error | null) => void) => callback?.())
    }

    handleMcpJsonRpcMessage(
      {
        getDefaultSocketPath: () => '/tmp/taskwraith.sock',
        getAppVersion: () => '1.0.0',
        getMcpToolDefinitions: () => [],
        brokerRequest,
        env: {
          TASKWRAITH_RUN_ID: 'run-1',
          TASKWRAITH_CHAT_ID: 'chat-1',
          TASKWRAITH_PARENT_PROVIDER: 'grok',
          TASKWRAITH_WORKSPACE_PATH: '/repo'
        },
        cwd: () => '/repo/subdir',
        stdout: stream as never
      },
      '/tmp/taskwraith.sock',
      'token-1',
      {
        jsonrpc: '2.0',
        id: 7,
        method: 'tools/call',
        params: { name: 'read_file', arguments: { path: 'README.md' } }
      },
      'line'
    )
    await new Promise((resolve) => setImmediate(resolve))

    expect(brokerRequest).toHaveBeenCalledWith(
      '/tmp/taskwraith.sock',
      expect.objectContaining({
        id: 7,
        token: 'token-1',
        tool: 'read_file',
        appRunId: 'run-1',
        appChatId: 'chat-1',
        parentProvider: 'grok',
        callerCwd: '/repo/subdir',
        callerWorkspacePath: '/repo'
      })
    )
  })

  it('canonicalizes AskUserQuestion aliases before brokered tool calls', async () => {
    const brokerRequest = vi.fn(async () => ({ ok: true, text: 'ok' }))
    const stream = {
      write: vi.fn((_chunk: string, callback?: (error?: Error | null) => void) => callback?.())
    }

    handleMcpJsonRpcMessage(
      {
        getDefaultSocketPath: () => '/tmp/taskwraith.sock',
        getAppVersion: () => '1.0.0',
        getMcpToolDefinitions: () => [],
        brokerRequest,
        env: {
          TASKWRAITH_MCP_SAFE_SUBSET: '1',
          TASKWRAITH_PARENT_PROVIDER: 'claude'
        },
        cwd: () => '/repo',
        stdout: stream as never
      },
      '/tmp/taskwraith.sock',
      'token-1',
      {
        jsonrpc: '2.0',
        id: 8,
        method: 'tools/call',
        params: { name: 'ASkUserQuestion', arguments: { question: 'Continue?' } }
      },
      'line'
    )
    await new Promise((resolve) => setImmediate(resolve))

    expect(brokerRequest).toHaveBeenCalledWith(
      '/tmp/taskwraith.sock',
      expect.objectContaining({
        tool: 'ask_user_question',
        parentProvider: 'claude'
      })
    )
  })

  it('passes broker caller context into the main MCP executor', async () => {
    const executeGeminiMcpTool = vi.fn(async () => ({ text: 'ok' }))
    const runtime = new McpBridgeRuntime({
      getGeminiMcpBrokerToken: () => 'token-1',
      executeGeminiMcpTool
    } as never)

    await runtime.handleGeminiMcpBrokerRequest({
      token: 'token-1',
      tool: 'read_file',
      arguments: { path: 'README.md' },
      parentProvider: 'grok',
      appRunId: 'run-1',
      appChatId: 'chat-1',
      callerCwd: '/repo/subdir',
      callerWorkspacePath: '/repo'
    })

    expect(executeGeminiMcpTool).toHaveBeenCalledWith(
      'read_file',
      { path: 'README.md' },
      { appRunId: 'run-1', appChatId: 'chat-1' },
      'grok',
      { callerCwd: '/repo/subdir', callerWorkspacePath: '/repo' }
    )
  })

  it('canonicalizes AskUserQuestion aliases before main MCP execution', async () => {
    const executeGeminiMcpTool = vi.fn(async () => ({ text: 'ok' }))
    const runtime = new McpBridgeRuntime({
      getGeminiMcpBrokerToken: () => 'token-1',
      executeGeminiMcpTool
    } as never)

    await runtime.handleGeminiMcpBrokerRequest({
      token: 'token-1',
      tool: 'mcp__TaskWraith__AskUserQuestion',
      arguments: { question: 'Continue?' },
      parentProvider: 'claude',
      appRunId: 'run-1',
      appChatId: 'chat-1'
    })

    expect(executeGeminiMcpTool).toHaveBeenCalledWith(
      'ask_user_question',
      { question: 'Continue?' },
      { appRunId: 'run-1', appChatId: 'chat-1' },
      'claude',
      {}
    )
  })

  it('preserves gateway calls for main-side target resolution and approval', async () => {
    const executeGeminiMcpTool = vi.fn(async () => ({ text: 'ok' }))
    const runtime = new McpBridgeRuntime({
      getGeminiMcpBrokerToken: () => 'token-1',
      executeGeminiMcpTool
    } as never)
    const args = { name: 'video_encode_clip', arguments: { path: 'clip.mp4' } }

    await runtime.handleGeminiMcpBrokerRequest({
      token: 'token-1',
      tool: 'capability_invoke',
      arguments: args,
      parentProvider: 'codex',
      appRunId: 'run-1',
      appChatId: 'chat-1'
    })

    expect(executeGeminiMcpTool).toHaveBeenCalledWith(
      'capability_invoke',
      args,
      { appRunId: 'run-1', appChatId: 'chat-1' },
      'codex',
      {}
    )
  })

  it('advertises only the explicit core profile to tool-constrained models', () => {
    const chunks: string[] = []
    const stream = {
      write: vi.fn((chunk: string) => {
        chunks.push(chunk)
        return true
      })
    }

    handleMcpJsonRpcMessage(
      {
        getDefaultSocketPath: () => '/tmp/taskwraith.sock',
        getAppVersion: () => '1.0.0',
        getMcpToolDefinitions: () => [
          { name: 'read_file' },
          { name: 'apply_patch' },
          { name: 'canvas_eval' }
        ],
        env: { TASKWRAITH_MCP_CORE_SUBSET: '1' },
        stdout: stream as never
      },
      '/tmp/taskwraith.sock',
      'token-1',
      { jsonrpc: '2.0', id: 9, method: 'tools/list' },
      'line'
    )

    const response = JSON.parse(chunks.join('').trim()) as {
      result: { tools: Array<{ name: string }> }
    }
    expect(response.result.tools.map((tool) => tool.name)).toEqual(['read_file', 'apply_patch'])
  })

  it('advertises only the gateway direct set plus gateway and audit tools', () => {
    const chunks: string[] = []
    const stream = {
      write: vi.fn((chunk: string) => {
        chunks.push(chunk)
        return true
      })
    }

    handleMcpJsonRpcMessage(
      {
        getDefaultSocketPath: () => '/tmp/taskwraith.sock',
        getAppVersion: () => '1.0.0',
        getMcpToolDefinitions: () => [
          { name: 'read_file' },
          { name: 'tw_introspection_read' },
          { name: 'video_encode_clip' }
        ],
        env: {
          TASKWRAITH_MCP_GATEWAY_SUBSET: '1',
          TASKWRAITH_MCP_AUDIT: '1'
        },
        stdout: stream as never
      },
      '/tmp/taskwraith.sock',
      'token-1',
      { jsonrpc: '2.0', id: 16, method: 'tools/list' },
      'line'
    )

    const response = JSON.parse(chunks.join('').trim()) as {
      result: { tools: Array<{ name: string }> }
    }
    expect(response.result.tools.map((tool) => tool.name)).toEqual([
      'read_file',
      'capability_search',
      'capability_invoke',
      'audit_set_profile',
      'audit_record_finding',
      'audit_record_verdict'
    ])
  })

  it('allows a hidden read-only target through capability_invoke without unwrapping it', async () => {
    const brokerRequest = vi.fn(async () => ({ ok: true, text: 'found' }))
    const chunks: string[] = []
    const stream = {
      write: vi.fn((chunk: string) => {
        chunks.push(chunk)
        return true
      })
    }

    handleMcpJsonRpcMessage(
      {
        getDefaultSocketPath: () => '/tmp/taskwraith.sock',
        getAppVersion: () => '1.0.0',
        getMcpToolDefinitions: () => [],
        brokerRequest,
        env: {
          TASKWRAITH_MCP_GATEWAY_SUBSET: '1',
          TASKWRAITH_MCP_SAFE_SUBSET: '1'
        },
        stdout: stream as never
      },
      '/tmp/taskwraith.sock',
      'token-1',
      {
        jsonrpc: '2.0',
        id: 17,
        method: 'tools/call',
        params: {
          name: 'capability_invoke',
          arguments: { name: 'tw_introspection_read', arguments: { packId: 'pack-1' } }
        }
      },
      'line'
    )
    await new Promise((resolve) => setImmediate(resolve))

    expect(brokerRequest).toHaveBeenCalledWith(
      '/tmp/taskwraith.sock',
      expect.objectContaining({
        tool: 'capability_invoke',
        arguments: {
          name: 'tw_introspection_read',
          arguments: { packId: 'pack-1' }
        }
      })
    )
  })

  it('allows capability_search in a read-only gateway seat', async () => {
    const brokerRequest = vi.fn(async () => ({ ok: true, text: 'matches' }))
    const stream = {
      write: vi.fn((_chunk: string, callback?: (error?: Error | null) => void) => callback?.())
    }

    handleMcpJsonRpcMessage(
      {
        getDefaultSocketPath: () => '/tmp/taskwraith.sock',
        getAppVersion: () => '1.0.0',
        getMcpToolDefinitions: () => [],
        brokerRequest,
        env: {
          TASKWRAITH_MCP_GATEWAY_SUBSET: '1',
          TASKWRAITH_MCP_SAFE_SUBSET: '1'
        },
        stdout: stream as never
      },
      '/tmp/taskwraith.sock',
      'token-1',
      {
        jsonrpc: '2.0',
        id: 20,
        method: 'tools/call',
        params: { name: 'capability_search', arguments: { query: 'edit video' } }
      },
      'line'
    )
    await new Promise((resolve) => setImmediate(resolve))

    expect(brokerRequest).toHaveBeenCalledWith(
      '/tmp/taskwraith.sock',
      expect.objectContaining({ tool: 'capability_search' })
    )
  })

  it('rejects a hidden mutating target wrapped by a read-only gateway call', async () => {
    const brokerRequest = vi.fn(async () => ({ ok: true, text: 'unexpected' }))
    const chunks: string[] = []
    const stream = {
      write: vi.fn((chunk: string) => {
        chunks.push(chunk)
        return true
      })
    }

    handleMcpJsonRpcMessage(
      {
        getDefaultSocketPath: () => '/tmp/taskwraith.sock',
        getAppVersion: () => '1.0.0',
        getMcpToolDefinitions: () => [],
        brokerRequest,
        env: {
          TASKWRAITH_MCP_GATEWAY_SUBSET: '1',
          TASKWRAITH_MCP_SAFE_SUBSET: '1'
        },
        stdout: stream as never
      },
      '/tmp/taskwraith.sock',
      'token-1',
      {
        jsonrpc: '2.0',
        id: 18,
        method: 'tools/call',
        params: {
          name: 'capability_invoke',
          arguments: { name: 'video_encode_clip', arguments: { path: 'clip.mp4' } }
        }
      },
      'line'
    )
    await new Promise((resolve) => setImmediate(resolve))

    expect(brokerRequest).not.toHaveBeenCalled()
    const response = JSON.parse(chunks.join('').trim()) as { error: { code: number } }
    expect(response.error.code).toBe(-32601)
  })

  it.each(['missing_capability', 'capability_invoke', 'capability_search'])(
    'rejects invalid capability_invoke target %s before broker dispatch',
    async (target) => {
      const brokerRequest = vi.fn(async () => ({ ok: true, text: 'unexpected' }))
      const chunks: string[] = []
      const stream = {
        write: vi.fn((chunk: string) => {
          chunks.push(chunk)
          return true
        })
      }

      handleMcpJsonRpcMessage(
        {
          getDefaultSocketPath: () => '/tmp/taskwraith.sock',
          getAppVersion: () => '1.0.0',
          getMcpToolDefinitions: () => [],
          brokerRequest,
          env: { TASKWRAITH_MCP_GATEWAY_SUBSET: '1' },
          stdout: stream as never
        },
        '/tmp/taskwraith.sock',
        'token-1',
        {
          jsonrpc: '2.0',
          id: 19,
          method: 'tools/call',
          params: {
            name: 'capability_invoke',
            arguments: { name: target, arguments: {} }
          }
        },
        'line'
      )
      await new Promise((resolve) => setImmediate(resolve))

      expect(brokerRequest).not.toHaveBeenCalled()
      const response = JSON.parse(chunks.join('').trim()) as { error: { code: number } }
      expect(response.error.code).toBe(-32602)
    }
  )

  it('intersects the core profile with the existing read-only safety scope', () => {
    const chunks: string[] = []
    const stream = {
      write: vi.fn((chunk: string) => {
        chunks.push(chunk)
        return true
      })
    }

    handleMcpJsonRpcMessage(
      {
        getDefaultSocketPath: () => '/tmp/taskwraith.sock',
        getAppVersion: () => '1.0.0',
        getMcpToolDefinitions: () => [
          { name: 'read_file' },
          { name: 'prompt_task_normalize' },
          { name: 'write_file' }
        ],
        env: {
          TASKWRAITH_MCP_SAFE_SUBSET: '1',
          TASKWRAITH_MCP_CORE_SUBSET: '1'
        },
        stdout: stream as never
      },
      '/tmp/taskwraith.sock',
      'token-1',
      { jsonrpc: '2.0', id: 11, method: 'tools/list' },
      'line'
    )

    const response = JSON.parse(chunks.join('').trim()) as {
      result: { tools: Array<{ name: string }> }
    }
    // prompt_task_normalize is safe but not core; write_file is core but not
    // read-only. Only tools present in both profiles may be advertised.
    expect(response.result.tools.map((tool) => tool.name)).toEqual(['read_file'])
  })

  it('keeps core as a hard ceiling over plan instruments', async () => {
    const brokerRequest = vi.fn(async () => ({ ok: true, text: 'approved' }))
    const chunks: string[] = []
    const stream = {
      write: vi.fn((chunk: string) => {
        chunks.push(chunk)
        return true
      })
    }
    const deps = {
      getDefaultSocketPath: () => '/tmp/taskwraith.sock',
      getAppVersion: () => '1.0.0',
      getMcpToolDefinitions: () => [
        { name: 'read_file' },
        { name: 'canvas_click' },
        { name: 'video_probe' },
        { name: 'write_file' }
      ],
      brokerRequest,
      env: {
        TASKWRAITH_MCP_SAFE_SUBSET: '1',
        TASKWRAITH_MCP_PLAN_SUBSET: '1',
        TASKWRAITH_MCP_CORE_SUBSET: '1'
      },
      stdout: stream as never
    }

    handleMcpJsonRpcMessage(
      deps,
      '/tmp/taskwraith.sock',
      'token-1',
      { jsonrpc: '2.0', id: 14, method: 'tools/list' },
      'line'
    )
    const listResponse = JSON.parse(chunks.join('').trim()) as {
      result: { tools: Array<{ name: string }> }
    }
    expect(listResponse.result.tools.map((tool) => tool.name)).toEqual(['read_file'])

    chunks.length = 0
    handleMcpJsonRpcMessage(
      deps,
      '/tmp/taskwraith.sock',
      'token-1',
      {
        jsonrpc: '2.0',
        id: 15,
        method: 'tools/call',
        params: { name: 'canvas_click', arguments: { ref: 'e1' } }
      },
      'line'
    )
    await new Promise((resolve) => setImmediate(resolve))

    expect(brokerRequest).not.toHaveBeenCalled()
    const callResponse = JSON.parse(chunks.join('').trim()) as {
      error: { code: number; message: string }
    }
    expect(callResponse.error.code).toBe(-32601)
    expect(callResponse.error.message).toContain('core MCP profile')
  })

  it('rejects a stale direct call outside the advertised core profile', async () => {
    const brokerRequest = vi.fn(async () => ({ ok: true, text: 'unexpected' }))
    const chunks: string[] = []
    const stream = {
      write: vi.fn((chunk: string) => {
        chunks.push(chunk)
        return true
      })
    }

    handleMcpJsonRpcMessage(
      {
        getDefaultSocketPath: () => '/tmp/taskwraith.sock',
        getAppVersion: () => '1.0.0',
        getMcpToolDefinitions: () => [],
        brokerRequest,
        env: { TASKWRAITH_MCP_CORE_SUBSET: '1' },
        stdout: stream as never
      },
      '/tmp/taskwraith.sock',
      'token-1',
      {
        jsonrpc: '2.0',
        id: 10,
        method: 'tools/call',
        params: { name: 'canvas_eval', arguments: { expression: '1 + 1' } }
      },
      'line'
    )
    await new Promise((resolve) => setImmediate(resolve))

    expect(brokerRequest).not.toHaveBeenCalled()
    const response = JSON.parse(chunks.join('').trim()) as { error: { code: number; message: string } }
    expect(response.error.code).toBe(-32601)
    expect(response.error.message).toContain('core MCP profile')
  })

  it('rejects a hidden direct call outside the advertised gateway profile', async () => {
    const brokerRequest = vi.fn(async () => ({ ok: true, text: 'unexpected' }))
    const chunks: string[] = []
    const stream = {
      write: vi.fn((chunk: string) => {
        chunks.push(chunk)
        return true
      })
    }

    handleMcpJsonRpcMessage(
      {
        getDefaultSocketPath: () => '/tmp/taskwraith.sock',
        getAppVersion: () => '1.0.0',
        getMcpToolDefinitions: () => [],
        brokerRequest,
        env: { TASKWRAITH_MCP_GATEWAY_SUBSET: '1' },
        stdout: stream as never
      },
      '/tmp/taskwraith.sock',
      'token-1',
      {
        jsonrpc: '2.0',
        id: 21,
        method: 'tools/call',
        params: {
          name: 'video_encode_clip',
          arguments: { inputPath: 'clip.mp4', outputPath: 'trimmed.mp4' }
        }
      },
      'line'
    )
    await new Promise((resolve) => setImmediate(resolve))

    expect(brokerRequest).not.toHaveBeenCalled()
    const response = JSON.parse(chunks.join('').trim()) as { error: { code: number; message: string } }
    expect(response.error.code).toBe(-32601)
    expect(response.error.message).toContain('gateway MCP profile')
    expect(response.error.message).toContain('capability_search and capability_invoke')
  })

  it('keeps run-scoped audit tools callable when the core profile is active', async () => {
    const brokerRequest = vi.fn(async () => ({ ok: true, text: 'recorded' }))
    const chunks: string[] = []
    const stream = {
      write: vi.fn((chunk: string) => {
        chunks.push(chunk)
        return true
      })
    }
    const deps = {
      getDefaultSocketPath: () => '/tmp/taskwraith.sock',
      getAppVersion: () => '1.0.0',
      getMcpToolDefinitions: () => [{ name: 'read_file' }],
      brokerRequest,
      env: {
        TASKWRAITH_MCP_CORE_SUBSET: '1',
        TASKWRAITH_MCP_AUDIT: '1'
      },
      stdout: stream as never
    }

    handleMcpJsonRpcMessage(
      deps,
      '/tmp/taskwraith.sock',
      'token-1',
      { jsonrpc: '2.0', id: 12, method: 'tools/list' },
      'line'
    )
    const listResponse = JSON.parse(chunks.join('').trim()) as {
      result: { tools: Array<{ name: string }> }
    }
    expect(listResponse.result.tools.map((tool) => tool.name)).toEqual([
      'read_file',
      'audit_set_profile',
      'audit_record_finding',
      'audit_record_verdict'
    ])

    chunks.length = 0
    handleMcpJsonRpcMessage(
      deps,
      '/tmp/taskwraith.sock',
      'token-1',
      {
        jsonrpc: '2.0',
        id: 13,
        method: 'tools/call',
        params: { name: 'audit_record_finding', arguments: { claim: 'Finding' } }
      },
      'line'
    )
    await new Promise((resolve) => setImmediate(resolve))

    expect(brokerRequest).toHaveBeenCalledWith(
      '/tmp/taskwraith.sock',
      expect.objectContaining({ tool: 'audit_record_finding' })
    )
  })

  it('routes run-scoped audit tools through the main executor', async () => {
    const executeGeminiMcpTool = vi.fn(async () => ({ text: 'recorded' }))
    const runtime = new McpBridgeRuntime({
      getGeminiMcpBrokerToken: () => 'token-1',
      executeGeminiMcpTool
    } as never)

    await runtime.handleGeminiMcpBrokerRequest({
      token: 'token-1',
      tool: 'audit_record_finding',
      arguments: { claim: 'Finding' },
      parentProvider: 'grok',
      appRunId: 'run-audit-1',
      appChatId: 'chat-1'
    })

    expect(executeGeminiMcpTool).toHaveBeenCalledWith(
      'audit_record_finding',
      { claim: 'Finding' },
      { appRunId: 'run-audit-1', appChatId: 'chat-1' },
      'grok',
      {}
    )
  })

  it('carries the core profile atomically in bridge argv', () => {
    const runtime = new McpBridgeRuntime({
      getGeminiMcpSocketPath: () => '/tmp/taskwraith.sock',
      getGeminiMcpBrokerToken: () => 'token-1',
      isDev: () => false
    } as never)

    const args = runtime.taskwraithMcpBridgeArgs('/tmp/taskwraith.sock', false, false, true)

    expect(args).toContain(GEMINI_MCP_CORE_SUBSET_ARG)
    expect(args[args.length - 1]).toBe(GEMINI_MCP_CORE_SUBSET_ARG)
  })

  it('carries the gateway profile atomically in bridge argv', () => {
    const runtime = new McpBridgeRuntime({
      getGeminiMcpSocketPath: () => '/tmp/taskwraith.sock',
      getGeminiMcpBrokerToken: () => 'token-1',
      isDev: () => false
    } as never)

    const args = runtime.taskwraithMcpBridgeArgs(
      '/tmp/taskwraith.sock',
      false,
      false,
      false,
      true
    )

    expect(args).toContain(GEMINI_MCP_GATEWAY_SUBSET_ARG)
    expect(args[args.length - 1]).toBe(GEMINI_MCP_GATEWAY_SUBSET_ARG)
  })

  it('translates the gateway argv receipt into the child catalogue guard', () => {
    const gatewayEnv: Record<string, string | undefined> = {}
    applyMcpBridgeProfileArgvToEnv(
      ['taskwraith', GEMINI_MCP_GATEWAY_SUBSET_ARG],
      gatewayEnv
    )
    expect(gatewayEnv).toEqual({ TASKWRAITH_MCP_GATEWAY_SUBSET: '1' })

    const fullEnv: Record<string, string | undefined> = {}
    applyMcpBridgeProfileArgvToEnv(['taskwraith'], fullEnv)
    expect(fullEnv).toEqual({})
  })

  it('registers Kimi global MCP on the gateway profile', async () => {
    const captureProcessOutput = vi.fn(
      async (_command: string, _args: string[]) => ({
        stdout: '',
        stderr: '',
        code: 0,
        timedOut: false
      })
    )
    const runtime = new McpBridgeRuntime({
      getGeminiMcpBrokerToken: () => 'token-1',
      isDev: () => false,
      getProcessExecPath: () => '/Applications/TaskWraith.app/TaskWraith',
      captureProcessOutput
    } as never)

    await runtime.addKimiMcpBridgeRegistration('/usr/local/bin/kimi', '/tmp/taskwraith.sock')

    expect(captureProcessOutput).toHaveBeenCalledOnce()
    const addArgs = captureProcessOutput.mock.calls[0][1]
    expect(addArgs).toContain(GEMINI_MCP_GATEWAY_SUBSET_ARG)
    expect(addArgs[addArgs.length - 1]).toBe(GEMINI_MCP_GATEWAY_SUBSET_ARG)
  })

  it('reports whether Kimi actually attached the TaskWraith gateway', async () => {
    const sendAgentCompatLine = vi.fn()
    const runtime = new McpBridgeRuntime({
      getSettings: () => ({ geminiMcpBridgeEnabled: true }),
      sendAgentCompatLine
    } as never)
    vi.spyOn(runtime, 'startGeminiMcpBroker').mockResolvedValue()
    vi.spyOn(runtime, 'repairKimiMcpBridge').mockResolvedValue()

    await expect(runtime.prepareKimiMcpBridgeForRun({} as never)).resolves.toBe(true)
    expect(sendAgentCompatLine).not.toHaveBeenCalled()

    vi.spyOn(runtime, 'startGeminiMcpBroker').mockRejectedValueOnce(new Error('socket down'))
    await expect(runtime.prepareKimiMcpBridgeForRun({} as never)).resolves.toBe(false)
    expect(sendAgentCompatLine).toHaveBeenCalledWith(
      {},
      'kimi',
      expect.objectContaining({ title: 'Kimi MCP bridge registration failed' })
    )
  })

  it('reports Kimi gateway unavailable when the bridge setting is disabled', async () => {
    const runtime = new McpBridgeRuntime({
      getSettings: () => ({ geminiMcpBridgeEnabled: false })
    } as never)
    await expect(runtime.prepareKimiMcpBridgeForRun({} as never)).resolves.toBe(false)
  })
})
