import { tmpdir } from 'os'
import { join } from 'path'
import { describe, expect, it, vi } from 'vitest'
import { handleMcpJsonRpcMessage, McpBridgeRuntime } from './McpBridgeRuntime'

const SOCKET_PATH = join(tmpdir(), 'taskwraith-steer-delivery.sock')
const INSTANCE_EPOCH = 'd'.repeat(32)
const SETTLEMENT_CONTROL = 'taskwraith/settle-steer-delivery'

function brokerToolRequest(): Record<string, unknown> {
  return {
    token: 'token-1',
    instanceEpoch: INSTANCE_EPOCH,
    tool: 'read_file',
    arguments: { path: 'README.md' },
    parentProvider: 'cursor',
    appRunId: 'run-1',
    appChatId: 'chat-1'
  }
}

describe('MCP broker steering delivery receipts', () => {
  it('does not commit a reservation until the authenticated child acknowledges its write', async () => {
    const commit = vi.fn()
    const rollback = vi.fn()
    const ambiguous = vi.fn()
    const runtime = new McpBridgeRuntime({
      getGeminiMcpBrokerToken: () => 'token-1',
      getInstanceEpoch: () => INSTANCE_EPOCH,
      executeGeminiMcpTool: vi.fn(async () => ({ text: 'tool result' })),
      reservePendingSteerText: vi.fn(() => ({
        text: 'Focus on the regression test.',
        commit,
        rollback,
        ambiguous
      }))
    } as never)

    const result = (await runtime.handleGeminiMcpBrokerRequest(brokerToolRequest())) as Record<
      string,
      unknown
    >
    const receiptId = String(result.taskwraithSteerReceiptId || '')

    expect(receiptId).toMatch(/^[a-f0-9]{48}$/)
    expect(JSON.stringify(result.content)).toContain('Focus on the regression test.')
    expect(JSON.stringify(result.content)).toContain('tool result')
    expect(commit).not.toHaveBeenCalled()
    expect(rollback).not.toHaveBeenCalled()
    expect(ambiguous).not.toHaveBeenCalled()

    await expect(
      runtime.handleGeminiMcpBrokerRequest({
        token: 'token-1',
        instanceEpoch: INSTANCE_EPOCH,
        control: SETTLEMENT_CONTROL,
        appRunId: 'foreign-run',
        steerReceiptId: receiptId,
        settlement: 'commit'
      })
    ).resolves.toEqual({ ok: false })
    expect(commit).not.toHaveBeenCalled()

    await expect(
      runtime.handleGeminiMcpBrokerRequest({
        token: 'token-1',
        instanceEpoch: INSTANCE_EPOCH,
        control: SETTLEMENT_CONTROL,
        appRunId: 'run-1',
        steerReceiptId: receiptId,
        settlement: 'commit'
      })
    ).resolves.toEqual({ ok: true })
    expect(commit).toHaveBeenCalledOnce()
    expect(rollback).not.toHaveBeenCalled()
    expect(ambiguous).not.toHaveBeenCalled()
  })

  it.each([
    ['rollback', 'rollback'],
    ['ambiguous', 'ambiguous']
  ] as const)('settles an exact child %s receipt once', async (settlement, expectedHook) => {
    const hooks = {
      commit: vi.fn(),
      rollback: vi.fn(),
      ambiguous: vi.fn()
    }
    const runtime = new McpBridgeRuntime({
      getGeminiMcpBrokerToken: () => 'token-1',
      getInstanceEpoch: () => INSTANCE_EPOCH,
      executeGeminiMcpTool: vi.fn(async () => ({ text: 'tool result' })),
      reservePendingSteerText: vi.fn(() => ({
        text: 'Steer once.',
        ...hooks
      }))
    } as never)
    const result = (await runtime.handleGeminiMcpBrokerRequest(brokerToolRequest())) as Record<
      string,
      unknown
    >
    const request = {
      token: 'token-1',
      instanceEpoch: INSTANCE_EPOCH,
      control: SETTLEMENT_CONTROL,
      appRunId: 'run-1',
      steerReceiptId: result.taskwraithSteerReceiptId,
      settlement
    }

    await expect(runtime.handleGeminiMcpBrokerRequest(request)).resolves.toEqual({ ok: true })
    await expect(runtime.handleGeminiMcpBrokerRequest(request)).resolves.toEqual({ ok: false })

    expect(hooks[expectedHook]).toHaveBeenCalledOnce()
    for (const [name, hook] of Object.entries(hooks)) {
      if (name !== expectedHook) expect(hook).not.toHaveBeenCalled()
    }
  })

  it('marks every open receipt ambiguous when the broker closes', async () => {
    const ambiguous = vi.fn()
    const runtime = new McpBridgeRuntime({
      getGeminiMcpBrokerToken: () => 'token-1',
      getInstanceEpoch: () => INSTANCE_EPOCH,
      executeGeminiMcpTool: vi.fn(async () => ({ text: 'tool result' })),
      reservePendingSteerText: vi.fn(() => ({
        text: 'Steer before close.',
        commit: vi.fn(),
        rollback: vi.fn(),
        ambiguous
      }))
    } as never)

    await runtime.handleGeminiMcpBrokerRequest(brokerToolRequest())
    runtime.closeGeminiMcpBroker()

    expect(ambiguous).toHaveBeenCalledOnce()
    expect(ambiguous).toHaveBeenCalledWith(expect.stringContaining('broker closed'))
  })

  it('does not accept a steering receipt property from a tool executor', async () => {
    const runtime = new McpBridgeRuntime({
      getGeminiMcpBrokerToken: () => 'token-1',
      getInstanceEpoch: () => INSTANCE_EPOCH,
      executeGeminiMcpTool: vi.fn(async () => ({
        text: 'tool result',
        taskwraithSteerReceiptId: 'forged-receipt'
      }))
    } as never)

    const result = (await runtime.handleGeminiMcpBrokerRequest(brokerToolRequest())) as Record<
      string,
      unknown
    >

    expect(result.taskwraithSteerReceiptId).toBeUndefined()
  })

  it('injects at a completed failed-tool boundary without committing before child evidence', async () => {
    const commit = vi.fn()
    const runtime = new McpBridgeRuntime({
      getGeminiMcpBrokerToken: () => 'token-1',
      getInstanceEpoch: () => INSTANCE_EPOCH,
      executeGeminiMcpTool: vi.fn(async () => ({
        text: 'tool failed',
        isError: true,
        content: [{ type: 'text', text: 'tool failed' }]
      })),
      reservePendingSteerText: vi.fn(() => ({
        text: 'Adjust after this failed tool.',
        commit,
        rollback: vi.fn(),
        ambiguous: vi.fn()
      }))
    } as never)

    const result = (await runtime.handleGeminiMcpBrokerRequest(brokerToolRequest())) as Record<
      string,
      any
    >

    expect(result.ok).toBe(false)
    expect(result.isError).toBe(true)
    expect(result.content[0].text).toContain('Adjust after this failed tool.')
    expect(result.taskwraithSteerReceiptId).toMatch(/^[a-f0-9]{48}$/)
    expect(commit).not.toHaveBeenCalled()
  })
})

function bridgeProcessDeps(input: {
  brokerRequest: ReturnType<typeof vi.fn>
  stdout: Record<string, unknown>
}): any {
  return {
    getDefaultSocketPath: () => SOCKET_PATH,
    getAppVersion: () => '1.0.0',
    getMcpToolDefinitions: () => [],
    brokerRequest: input.brokerRequest,
    stdout: input.stdout,
    cwd: () => '/repo',
    env: {
      TASKWRAITH_RUN_ID: 'run-1',
      TASKWRAITH_CHAT_ID: 'chat-1',
      TASKWRAITH_PARENT_PROVIDER: 'cursor',
      TASKWRAITH_WORKSPACE_PATH: '/repo'
    }
  }
}

async function flushBrokerSettlement(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve))
  await new Promise((resolve) => setImmediate(resolve))
}

function dispatchChildToolCall(
  brokerRequest: ReturnType<typeof vi.fn>,
  stdout: Record<string, unknown>
): void {
  handleMcpJsonRpcMessage(
    bridgeProcessDeps({ brokerRequest, stdout }),
    SOCKET_PATH,
    'token-1',
    {
      jsonrpc: '2.0',
      id: 7,
      method: 'tools/call',
      params: { name: 'read_file', arguments: { path: 'README.md' } }
    },
    'line',
    INSTANCE_EPOCH
  )
}

describe('MCP provider-child steering write evidence', () => {
  function brokerWithReceipt(): ReturnType<typeof vi.fn> {
    return vi.fn(async (_socketPath: string, request: Record<string, unknown>) => {
      if (request.control === SETTLEMENT_CONTROL) return { ok: true }
      return {
        ok: true,
        text: 'tool result',
        content: [
          {
            type: 'text',
            text: '[TaskWraith Steering] neutral envelope\n\nSteer now.\n\n--- end steering ---'
          },
          { type: 'text', text: 'tool result' }
        ],
        taskwraithSteerReceiptId: 'receipt-1'
      }
    })
  }

  it('commits only after the provider response write callback succeeds', async () => {
    const brokerRequest = brokerWithReceipt()
    const chunks: string[] = []
    const stdout = {
      write: vi.fn((chunk: string, callback?: (error?: Error | null) => void) => {
        chunks.push(chunk)
        callback?.()
      })
    }

    dispatchChildToolCall(brokerRequest, stdout)
    await flushBrokerSettlement()

    expect(brokerRequest).toHaveBeenCalledTimes(2)
    expect(brokerRequest.mock.calls[1]?.[1]).toMatchObject({
      control: SETTLEMENT_CONTROL,
      appRunId: 'run-1',
      steerReceiptId: 'receipt-1',
      settlement: 'commit'
    })
    expect(chunks.join('')).toContain('Steer now.')
    expect(chunks.join('')).toContain('tool result')
    expect(chunks.join('')).not.toContain('taskwraithSteerReceiptId')
  })

  it('rolls back when the provider stream is closed before write', async () => {
    const brokerRequest = brokerWithReceipt()
    const stdout = { destroyed: true, write: vi.fn() }

    dispatchChildToolCall(brokerRequest, stdout)
    await flushBrokerSettlement()

    expect(stdout.write).not.toHaveBeenCalled()
    expect(brokerRequest.mock.calls[1]?.[1]).toMatchObject({
      steerReceiptId: 'receipt-1',
      settlement: 'rollback'
    })
  })

  it('marks delivery ambiguous when an attempted provider write reports failure', async () => {
    const brokerRequest = brokerWithReceipt()
    const stdout = {
      write: vi.fn((_chunk: string, callback?: (error?: Error | null) => void) => {
        callback?.(new Error('provider pipe failed'))
      })
    }

    dispatchChildToolCall(brokerRequest, stdout)
    await flushBrokerSettlement()

    expect(brokerRequest.mock.calls[1]?.[1]).toMatchObject({
      steerReceiptId: 'receipt-1',
      settlement: 'ambiguous'
    })
  })

  it('commits a steer carried by a failed-tool response after its child write succeeds', async () => {
    const brokerRequest = vi.fn(async (_socketPath: string, request: Record<string, unknown>) => {
      if (request.control === SETTLEMENT_CONTROL) return { ok: true }
      return {
        ok: false,
        isError: true,
        text: 'tool failed',
        content: [{ type: 'text', text: '[TaskWraith Steering] Steer after failure.' }],
        taskwraithSteerReceiptId: 'receipt-failed-tool'
      }
    })
    const chunks: string[] = []
    const stdout = {
      write: vi.fn((chunk: string, callback?: (error?: Error | null) => void) => {
        chunks.push(chunk)
        callback?.()
      })
    }

    dispatchChildToolCall(brokerRequest, stdout)
    await flushBrokerSettlement()

    expect(chunks.join('')).toContain('"isError":true')
    expect(brokerRequest.mock.calls[1]?.[1]).toMatchObject({
      steerReceiptId: 'receipt-failed-tool',
      settlement: 'commit'
    })
  })
})
