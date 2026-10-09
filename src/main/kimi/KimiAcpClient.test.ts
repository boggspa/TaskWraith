import { describe, expect, it, vi } from 'vitest'
import { formatKimiProcessError, runKimiAcpTurn } from './KimiAcpClient'
import type { AcpChildProcess } from '../acp/AcpTurnClient'
import type { AcpPermissionRequest, AcpRunEvent } from '../acp/AcpProtocol'
import { createKimiGatewayReadiness } from './KimiGatewayReadiness'
import type { KimiHttpMcpBridgeHandle } from './KimiHttpMcpBridge'
import type { KimiRunCapabilityReceipt } from './KimiRunCapabilities'
import {
  createProviderTransportCloseOperation,
  ProviderOperationRegistry,
  waitForProviderOperationSettlement
} from '../run/ProviderOperationRegistry'

class FakeChild implements AcpChildProcess {
  writes: string[] = []
  killed = false
  autoCloseOnEnd = true
  private dataListeners: Array<(chunk: string) => void> = []
  private closeListener?: (code: number | null) => void
  stdin = {
    write: (data: string): void => {
      this.writes.push(data)
    },
    on: (): void => {},
    end: (): void => {
      this.killed = true
      if (this.autoCloseOnEnd) this.closeListener?.(0)
    }
  }
  stdout = {
    on: (_event: 'data', listener: (chunk: string) => void): void => {
      this.dataListeners.push(listener)
    }
  }
  stderr = { on: (): void => {} }
  on(event: 'error' | 'close', listener: (arg: never) => void): void {
    if (event === 'close') this.closeListener = listener as (code: number | null) => void
  }
  kill(): void {
    this.killed = true
    this.closeListener?.(0)
  }
  emit(message: unknown): void {
    const line = `${JSON.stringify(message)}\n`
    this.dataListeners.forEach((listener) => listener(line))
  }
  finish(code: number | null): void {
    this.closeListener?.(code)
  }
  sent(): Array<Record<string, unknown>> {
    return this.writes.map((write) => JSON.parse(write.trim()) as Record<string, unknown>)
  }
}

describe('runKimiAcpTurn', () => {
  it('bounds native refusals without asking a human and joins blocked handoff through cleanup', async () => {
    const child = new FakeChild()
    const readiness = createKimiGatewayReadiness()
    const receipts: KimiRunCapabilityReceipt[] = []
    const events: AcpRunEvent[] = []
    const humanMediator = vi.fn(async () => 'allow' as const)
    let releaseCleanup!: () => void
    const cleanup = new Promise<void>((resolve) => {
      releaseCleanup = resolve
    })
    const closed = vi.fn(async () => {
      await cleanup
    })
    const handle = runKimiAcpTurn({
      prompt: 'Repair only the assigned file',
      cwdLifetime: 'session',
      cwd: '/private/runtime',
      spawnProcess: () => child,
      onEvent: (event) => events.push(event),
      onPermissionRequest: humanMediator,
      onClose: closed,
      recovery: {
        context: {
          runId: 'kimi-run',
          chatId: 'chat',
          workspacePath: '/workspace',
          assignedScope: {
            kind: 'lane',
            intent: 'write',
            paths: [{ kind: 'path', path: 'src/owned.ts' }]
          }
        },
        gateway: { readiness } as KimiHttpMcpBridgeHandle,
        onReceipt: (receipt) => receipts.push(receipt),
        timeoutMs: 1
      },
      onRawFrame: (direction, raw) => {
        const frame = raw as { method?: string }
        if (direction === 'out' && frame.method === 'session/new') {
          const generation = readiness.snapshot().generation
          readiness.responseServed(generation, 'initialize', {
            result: { protocolVersion: '2025-03-26' }
          })
          readiness.responseServed(generation, 'tools/list', {
            result: { tools: [{ name: 'read_file' }, { name: 'replace' }] }
          })
        }
      }
    })
    child.emit({ jsonrpc: '2.0', id: 1, result: {} })
    child.emit({ jsonrpc: '2.0', id: 2, result: { sessionId: 'session' } })
    await vi.waitFor(() =>
      expect(child.sent().some((frame) => frame.method === 'session/prompt')).toBe(true)
    )
    const emitUpdate = (update: Record<string, unknown>) =>
      child.emit({
        jsonrpc: '2.0',
        method: 'session/update',
        params: { sessionId: 'session', update }
      })
    emitUpdate({
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text: 'Design: retain capacity until provider completion.' }
    })
    const refuse = async (id: number) => {
      const toolCall = {
        toolCallId: `edit-${id}`,
        title: 'Edit',
        kind: 'edit',
        status: 'pending',
        rawInput: { file_path: '/workspace/src/owned.ts' }
      }
      emitUpdate({ sessionUpdate: 'tool_call', ...toolCall })
      child.emit({
        jsonrpc: '2.0',
        id: 100 + id,
        method: 'session/request_permission',
        params: {
          sessionId: 'session',
          toolCall,
          options: [{ optionId: 'reject', name: 'Reject', kind: 'reject_once' }]
        }
      })
      await vi.waitFor(() => expect(child.sent().some((frame) => frame.id === 100 + id)).toBe(true))
      emitUpdate({
        sessionUpdate: 'tool_call_update',
        toolCallId: `edit-${id}`,
        status: 'failed',
        content: [
          {
            type: 'content',
            content: {
              type: 'text',
              text: 'Tool "Edit" was not run because the user rejected the approval request.'
            }
          }
        ]
      })
    }
    await refuse(1)
    expect(child.killed).toBe(false)
    child.emit({ jsonrpc: '2.0', id: 3, result: { stopReason: 'cancelled' } })
    expect(child.sent().filter((frame) => frame.method === 'session/prompt')).toHaveLength(2)
    await refuse(2)
    expect(humanMediator).not.toHaveBeenCalled()
    expect(closed).toHaveBeenCalledWith(0, true, 'taskwraith_blocked')
    expect(receipts.at(-1)).toMatchObject({ outcome: 'blocked', lifecycleSettled: false })
    let settled = false
    void handle.closed.then(() => {
      settled = true
    })
    await Promise.resolve()
    expect(settled).toBe(false)
    releaseCleanup()
    await handle.closed
    expect(receipts.at(-1)).toMatchObject({ outcome: 'blocked', lifecycleSettled: true })
    const text = events
      .filter((event) => event.type === 'content')
      .map((event) => event.text)
      .join('')
    expect(text).toContain('Design: retain capacity until provider completion.')
    expect(text).toContain('TaskWraith lane blocked')
    expect(child.sent().filter((frame) => frame.method === 'session/prompt')).toHaveLength(2)
  })

  it('lets a human-selected native Full Access run reach the mediator for native tools and records no refusal', async () => {
    const child = new FakeChild()
    const readiness = createKimiGatewayReadiness()
    const receipts: KimiRunCapabilityReceipt[] = []
    const mediator = vi.fn(async (_request: AcpPermissionRequest) => 'allow' as const)
    const handle = runKimiAcpTurn({
      prompt: 'Run the native shell',
      cwdLifetime: 'session',
      cwd: '/private/runtime',
      spawnProcess: () => child,
      onEvent: () => {},
      onPermissionRequest: mediator,
      nativeToolPolicy: 'native-full-access',
      recovery: {
        context: {
          runId: 'kimi-full-access',
          chatId: 'chat',
          workspacePath: '/workspace',
          permissions: {
            presetId: 'full_access',
            readOnly: false,
            agenticServices: { shellCommands: 'allow', fileChanges: 'allow' }
          } as unknown as NonNullable<
            Parameters<typeof runKimiAcpTurn>[0]['recovery']
          >['context']['permissions'],
          assignedScope: { kind: 'workspace', intent: 'write', paths: [] }
        },
        gateway: { readiness } as KimiHttpMcpBridgeHandle,
        onReceipt: (receipt) => receipts.push(receipt),
        timeoutMs: 1
      },
      onRawFrame: (direction, raw) => {
        const frame = raw as { method?: string }
        if (direction === 'out' && frame.method === 'session/new') {
          const generation = readiness.snapshot().generation
          readiness.responseServed(generation, 'initialize', {
            result: { protocolVersion: '2025-03-26' }
          })
          readiness.responseServed(generation, 'tools/list', {
            result: {
              tools: [{ name: 'read_file' }, { name: 'replace' }, { name: 'run_shell_command' }]
            }
          })
        }
      }
    })
    child.emit({ jsonrpc: '2.0', id: 1, result: {} })
    child.emit({ jsonrpc: '2.0', id: 2, result: { sessionId: 'session' } })
    await vi.waitFor(() =>
      expect(child.sent().some((frame) => frame.method === 'session/prompt')).toBe(true)
    )
    expect(receipts.at(-1)?.nativeTools.intendedDenied).toEqual([])
    const toolCall = {
      toolCallId: 'bash-1',
      title: 'Bash',
      kind: 'execute',
      status: 'pending',
      rawInput: { command: 'ls -la' }
    }
    child.emit({
      jsonrpc: '2.0',
      method: 'session/update',
      params: { sessionId: 'session', update: { sessionUpdate: 'tool_call', ...toolCall } }
    })
    child.emit({
      jsonrpc: '2.0',
      id: 101,
      method: 'session/request_permission',
      params: {
        sessionId: 'session',
        toolCall,
        options: [
          { optionId: 'allow', name: 'Allow', kind: 'allow_once' },
          { optionId: 'reject', name: 'Reject', kind: 'reject_once' }
        ]
      }
    })
    await vi.waitFor(() => expect(child.sent().some((frame) => frame.id === 101)).toBe(true))
    expect(mediator).toHaveBeenCalledTimes(1)
    expect(mediator.mock.calls[0][0]).toMatchObject({ toolName: 'Bash' })
    const response = child.sent().find((frame) => frame.id === 101) as {
      result?: { outcome?: { outcome?: string; optionId?: string } }
    }
    expect(response.result?.outcome).toEqual({ outcome: 'selected', optionId: 'allow' })
    expect(receipts.at(-1)?.refusals).toEqual([])
    expect(receipts.at(-1)?.outcome).toBe('running')
    child.emit({ jsonrpc: '2.0', id: 3, result: { stopReason: 'end_turn' } })
    await handle.closed
    expect(receipts.at(-1)?.refusals).toEqual([])
    expect(receipts.at(-1)?.outcome).not.toBe('blocked')
  })

  it('keeps the pre-callback native deny for an omitted policy', async () => {
    const child = new FakeChild()
    const readiness = createKimiGatewayReadiness()
    const receipts: KimiRunCapabilityReceipt[] = []
    const mediator = vi.fn(async () => 'allow' as const)
    runKimiAcpTurn({
      prompt: 'Run the native shell',
      cwdLifetime: 'session',
      cwd: '/private/runtime',
      spawnProcess: () => child,
      onEvent: () => {},
      onPermissionRequest: mediator,
      recovery: {
        context: {
          runId: 'kimi-contained',
          chatId: 'chat',
          workspacePath: '/workspace',
          assignedScope: { kind: 'workspace', intent: 'write', paths: [] }
        },
        gateway: { readiness } as KimiHttpMcpBridgeHandle,
        onReceipt: (receipt) => receipts.push(receipt),
        timeoutMs: 1
      },
      onRawFrame: (direction, raw) => {
        const frame = raw as { method?: string }
        if (direction === 'out' && frame.method === 'session/new') {
          const generation = readiness.snapshot().generation
          readiness.responseServed(generation, 'initialize', {
            result: { protocolVersion: '2025-03-26' }
          })
          readiness.responseServed(generation, 'tools/list', {
            result: { tools: [{ name: 'read_file' }, { name: 'replace' }] }
          })
        }
      }
    })
    child.emit({ jsonrpc: '2.0', id: 1, result: {} })
    child.emit({ jsonrpc: '2.0', id: 2, result: { sessionId: 'session' } })
    await vi.waitFor(() =>
      expect(child.sent().some((frame) => frame.method === 'session/prompt')).toBe(true)
    )
    child.emit({
      jsonrpc: '2.0',
      id: 101,
      method: 'session/request_permission',
      params: {
        sessionId: 'session',
        toolCall: { toolCallId: 'bash-1', title: 'Bash', kind: 'execute', status: 'pending' },
        options: [
          { optionId: 'allow', name: 'Allow', kind: 'allow_once' },
          { optionId: 'reject', name: 'Reject', kind: 'reject_once' }
        ]
      }
    })
    await vi.waitFor(() => expect(child.sent().some((frame) => frame.id === 101)).toBe(true))
    expect(mediator).not.toHaveBeenCalled()
    const response = child.sent().find((frame) => frame.id === 101) as {
      result?: { outcome?: { outcome?: string; optionId?: string } }
    }
    expect(response.result?.outcome).toEqual({ outcome: 'selected', optionId: 'reject' })
    expect(receipts.at(-1)?.refusals).toHaveLength(1)
    expect(receipts.at(-1)?.refusals[0]).toMatchObject({ toolName: 'Bash', userAsked: false })
    child.kill()
  })

  it('holds a deletion join through cancel, exact child close, and async cleanup', async () => {
    const registry = new ProviderOperationRegistry()
    const transportClose = createProviderTransportCloseOperation()
    const transportOperation = registry.track('kimi-run', transportClose.operation)
    const child = new FakeChild()
    child.autoCloseOnEnd = false
    let releaseCleanup!: () => void
    let cleanupStarted = false
    const cleanup = new Promise<void>((resolve) => {
      releaseCleanup = resolve
    })
    const handle = runKimiAcpTurn({
      prompt: 'hi',
      cwdLifetime: 'run',
      cwd: '/private/empty',
      spawnProcess: () => child,
      onEvent: () => {},
      onClose: async () => {
        cleanupStarted = true
        await cleanup
      }
    })
    void handle.closed.then(() => transportClose.markTransportClosed())

    let deletionSettled = false
    const deletionJoin = waitForProviderOperationSettlement(transportOperation, 1_000).then(
      (settled) => {
        deletionSettled = settled
        return settled
      }
    )

    handle.cancel()
    await Promise.resolve()
    expect(child.killed).toBe(true)
    expect(cleanupStarted).toBe(false)
    expect(deletionSettled).toBe(false)

    child.finish(0)
    await Promise.resolve()
    await Promise.resolve()
    expect(cleanupStarted).toBe(true)
    expect(deletionSettled).toBe(false)

    releaseCleanup()
    await handle.closed
    await expect(deletionJoin).resolves.toBe(true)
    expect(registry.get('kimi-run')).toBeUndefined()
  })

  it('advertises no path-based client fs capability', () => {
    const child = new FakeChild()
    runKimiAcpTurn({
      prompt: 'hi',
      cwdLifetime: 'run',
      cwd: '/private/empty',
      spawnProcess: () => child,
      onEvent: () => {}
    })

    expect(child.sent()[0]).toEqual({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: 1,
        clientCapabilities: {},
        clientInfo: { name: 'taskwraith', version: '1.0.6' }
      }
    })
  })

  it('does not answer an unsolicited fs request', () => {
    const child = new FakeChild()
    runKimiAcpTurn({
      prompt: 'hi',
      cwdLifetime: 'run',
      cwd: '/private/empty',
      spawnProcess: () => child,
      onEvent: () => {}
    })
    child.emit({ jsonrpc: '2.0', id: 1, result: {} })
    child.emit({ jsonrpc: '2.0', id: 2, result: { sessionId: 'session_1' } })
    child.emit({
      jsonrpc: '2.0',
      id: 30,
      method: 'fs/read_text_file',
      params: { path: '/workspace/secret' }
    })

    expect(child.sent().find((message) => message.id === 30)).toMatchObject({
      id: 30,
      error: { code: -32601 }
    })
  })
})

describe('formatKimiProcessError', () => {
  it('explains ENOENT as missing Kimi Code setup', () => {
    const error = Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' })
    expect(formatKimiProcessError(error)).toContain('Kimi Code could not be started')
    expect(formatKimiProcessError(error)).toContain('kimi login')
  })

  it('passes through non-ENOENT errors verbatim', () => {
    expect(formatKimiProcessError(new Error('boom'))).toBe('boom')
  })
})
