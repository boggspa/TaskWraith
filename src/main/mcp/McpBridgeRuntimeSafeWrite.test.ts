import { describe, expect, it, vi } from 'vitest'
import {
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
})
