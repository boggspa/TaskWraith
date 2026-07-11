import { describe, expect, it, vi } from 'vitest'
import {
  GEMINI_MCP_CORE_SUBSET_ARG,
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
})
