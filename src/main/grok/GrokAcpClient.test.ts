import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  createGrokTurnAbortController,
  grokToolRecoveryPrompt,
  runGrokAcpTurn,
  type AcpChildProcess,
  type GrokAcpRunOptions
} from './GrokAcpClient'
import type { NormalizedGrokRunEvent } from './GrokAcpProtocol'

class FakeAcpChild implements AcpChildProcess {
  writes: string[] = []
  killed = false
  autoCloseOnKill = true
  killSignals: string[] = []
  writeError: Error | null = null
  private dataListeners: ((chunk: string) => void)[] = []
  private closeListener?: (code: number | null) => void
  private errorListener?: (err: Error) => void
  private stdinErrorListener?: (err: Error) => void

  stdin = {
    write: (data: string, cb?: (err?: Error | null) => void): void => {
      this.writes.push(data)
      cb?.(this.writeError)
    },
    on: (_event: 'error', listener: (err: Error) => void): void => {
      this.stdinErrorListener = listener
    }
  }
  stdout = {
    on: (_event: 'data', listener: (chunk: string) => void): void => {
      this.dataListeners.push(listener)
    }
  }
  private stderrListeners: ((chunk: string) => void)[] = []
  stderr = {
    on: (_event: 'data', listener: (chunk: string) => void): void => {
      this.stderrListeners.push(listener)
    }
  }

  /** Emit on grok's stderr tracing channel. */
  errorOutput(text: string): void {
    this.stderrListeners.forEach((cb) => cb(text))
  }

  on(event: 'error' | 'close', listener: (arg: never) => void): void {
    if (event === 'close') this.closeListener = listener as (code: number | null) => void
    else this.errorListener = listener as (err: Error) => void
  }

  kill(signal?: string): void {
    this.killed = true
    this.killSignals.push(signal || '')
    if (this.autoCloseOnKill) this.closeListener?.(0)
  }

  /** Test helper: deliver an ACP message line to the client. */
  emit(message: unknown): void {
    const line = `${JSON.stringify(message)}\n`
    this.dataListeners.forEach((cb) => cb(line))
  }

  sent(): Record<string, unknown>[] {
    return this.writes.map((w) => JSON.parse(w.trim()))
  }

  fail(err: Error): void {
    this.errorListener?.(err)
  }

  failStdin(err: Error): void {
    this.stdinErrorListener?.(err)
  }

  finish(code: number | null): void {
    this.closeListener?.(code)
  }
}

const run = (
  child: FakeAcpChild,
  overrides: Partial<GrokAcpRunOptions> = {}
): {
  events: NormalizedGrokRunEvent[]
  closes: (number | null)[]
  closeInfos: { code: number | null; turnComplete: boolean; terminalStatus?: string }[]
  handle: ReturnType<typeof runGrokAcpTurn>
} => {
  const events: NormalizedGrokRunEvent[] = []
  const closes: (number | null)[] = []
  const closeInfos: { code: number | null; turnComplete: boolean; terminalStatus?: string }[] = []
  const handle = runGrokAcpTurn({
    prompt: 'hi',
    cwd: '/tmp/ws',
    spawnProcess: () => child,
    onEvent: (e) => events.push(e),
    onClose: (code, turnComplete, terminalStatus) => {
      closes.push(code)
      closeInfos.push({ code, turnComplete, terminalStatus })
    },
    ...overrides
  })
  return { events, closes, closeInfos, handle }
}

describe('runGrokAcpTurn', () => {
  it('routes a typed broker boundary to one visible permission request', () => {
    const prompt = grokToolRecoveryPrompt(
      {
        reason: 'failed-tool-terminal',
        terminalStatus: 'cancelled',
        deniedPermissionRequest: null,
        assistantTextSeen: false,
        toolFailureSeen: true,
        lastFailedToolName: 'TaskWraith__run_shell_command',
        lastFailedToolOutput:
          '{"ok":false,"permissionRetry":{"available":true,"tool":"capability_invoke"}}'
      },
      true
    )

    expect(prompt).toContain('request_tool_permission')
    expect(prompt).toContain('permissionRetry')
    expect(prompt).toContain('exact command and cwd')
    expect(prompt).not.toContain('do not retry the same call')
  })

  it('recognises a fresh opaque permission opportunity without reconstructing its target', () => {
    const prompt = grokToolRecoveryPrompt(
      {
        reason: 'failed-tool-terminal',
        terminalStatus: 'cancelled',
        deniedPermissionRequest: null,
        assistantTextSeen: false,
        toolFailureSeen: true,
        lastFailedToolName: 'TaskWraith__run_shell_command',
        lastFailedToolOutput:
          '{"ok":false,"permissionOpportunity":{"tool":"redeem_permission_opportunity","arguments":{"permissionOpportunityId":"[opaque]"}}}'
      },
      true
    )

    expect(prompt).toContain('redeem_permission_opportunity')
    expect(prompt).toContain('Never reconstruct or alter')
    expect(prompt).not.toContain('do not retry the same call')
  })

  afterEach(() => vi.useRealTimers())

  it('drives initialize → session/new → session/prompt and streams the answer', async () => {
    const child = new FakeAcpChild()
    const { events, closes } = run(child)

    // On construction it sends initialize.
    expect(child.sent()[0]).toMatchObject({ id: 1, method: 'initialize' })

    // initialize result → session/new (with cwd, empty mcpServers).
    child.emit({ jsonrpc: '2.0', id: 1, result: { protocolVersion: 1 } })
    expect(child.sent()[1]).toMatchObject({
      id: 2,
      method: 'session/new',
      params: { cwd: '/tmp/ws', mcpServers: [] }
    })

    // session/new result → capture sessionId (init event) + send the prompt.
    child.emit({ jsonrpc: '2.0', id: 2, result: { sessionId: 's-123' } })
    expect(events).toContainEqual({ type: 'init', sessionId: 's-123' })
    expect(child.sent()[2]).toMatchObject({
      id: 3,
      method: 'session/prompt',
      params: { sessionId: 's-123', prompt: [{ type: 'text', text: 'hi' }] }
    })

    // Stream updates: thought + answer chunks.
    const update = (sessionUpdate: string, text: string) => ({
      jsonrpc: '2.0',
      method: 'session/update',
      params: { sessionId: 's-123', update: { sessionUpdate, content: { type: 'text', text } } }
    })
    child.emit(update('agent_thought_chunk', 'Greeting.'))
    child.emit(update('agent_message_chunk', 'Hi'))
    child.emit(update('agent_message_chunk', '!'))

    const answer = events
      .filter((e) => e.type === 'content')
      .map((e) => e.text)
      .join('')
    expect(answer).toBe('Hi!')
    expect(events.some((e) => e.type === 'thinking' && e.text === 'Greeting.')).toBe(true)

    // Correlated prompt response → turn complete → process closed.
    child.emit({ jsonrpc: '2.0', id: 3, result: { stopReason: 'end_turn' } })
    // The ACP `result` is NOT forwarded as a sink event — caller synthesizes it.
    expect(events.some((e) => e.type === 'result')).toBe(false)

    await new Promise((r) => setTimeout(r, 40))
    expect(child.killed).toBe(true)
    expect(closes).toEqual([0])
  })

  it('forwards images when Grok reports its stale image capability as false', () => {
    const child = new FakeAcpChild()
    const image = Buffer.from('grok-vision-image')
    const { handle } = run(child, {
      prompt: 'what is in this screenshot?',
      imagePaths: ['/authorized/screenshot.png'],
      readImageFile: () => image
    })

    child.emit({
      jsonrpc: '2.0',
      id: 1,
      result: {
        protocolVersion: 1,
        agentCapabilities: { promptCapabilities: { image: false } }
      }
    })
    child.emit({ jsonrpc: '2.0', id: 2, result: { sessionId: 'grok-vision-session' } })

    expect(child.killed).toBe(false)
    expect(child.sent().find((message) => message.method === 'session/prompt')).toMatchObject({
      params: {
        sessionId: 'grok-vision-session',
        prompt: [
          { type: 'text', text: 'what is in this screenshot?' },
          { type: 'image', mimeType: 'image/png', data: image.toString('base64') }
        ]
      }
    })

    handle.cancel()
  })

  it('passes abnormal ACP terminal status to close-out without forwarding result events', async () => {
    const child = new FakeAcpChild()
    const { events, closeInfos } = run(child)
    child.emit({ jsonrpc: '2.0', id: 1, result: {} })
    child.emit({ jsonrpc: '2.0', id: 2, result: { sessionId: 's-1' } })

    child.emit({ jsonrpc: '2.0', id: 3, result: { stopReason: 'PermissionRejected' } })

    expect(events.some((e) => e.type === 'result')).toBe(false)
    await new Promise((r) => setTimeout(r, 40))
    expect(closeInfos).toEqual([
      { code: 0, turnComplete: true, terminalStatus: 'PermissionRejected' }
    ])
  })

  it('G5b — passes provided mcpServers to session/new', () => {
    const child = new FakeAcpChild()
    const scopedBridge = {
      name: 'taskwraith-grok',
      type: 'stdio',
      command: '/path/to/taskwraith',
      args: ['--taskwraith-gemini-mcp-bridge', '--socket', '/sock', '--safe-subset']
    }
    run(child, { mcpServers: [scopedBridge] })

    child.emit({ jsonrpc: '2.0', id: 1, result: { protocolVersion: 1 } })
    // The session/new carries the TaskWraith scoped bridge instead of an empty list.
    expect(child.sent()[1]).toMatchObject({
      id: 2,
      method: 'session/new',
      params: { cwd: '/tmp/ws', mcpServers: [scopedBridge] }
    })
  })

  it('does not crash when Grok closes stdin with EPIPE during an outbound write', () => {
    const child = new FakeAcpChild()
    child.writeError = Object.assign(new Error('write EPIPE'), { code: 'EPIPE' })
    const { events } = run(child)

    expect(child.sent()[0]).toMatchObject({ id: 1, method: 'initialize' })

    child.emit({ jsonrpc: '2.0', id: 1, result: { protocolVersion: 1 } })

    expect(child.sent()).toHaveLength(1)
    expect(events.some((event) => event.type === 'provider_warning')).toBe(false)
  })

  it('swallows stdin EPIPE error events from the Grok ACP child', () => {
    const child = new FakeAcpChild()
    const { events } = run(child)

    child.failStdin(Object.assign(new Error('write EPIPE'), { code: 'EPIPE' }))
    child.emit({ jsonrpc: '2.0', id: 1, result: { protocolVersion: 1 } })

    expect(child.sent()).toHaveLength(1)
    expect(events.some((event) => event.type === 'provider_warning')).toBe(false)
  })

  it('cancel() sends session/cancel then kills (only mid-turn)', () => {
    const child = new FakeAcpChild()
    const { handle } = run(child)
    child.emit({ jsonrpc: '2.0', id: 1, result: {} })
    child.emit({ jsonrpc: '2.0', id: 2, result: { sessionId: 's-9' } })

    handle.cancel()
    const cancelMsg = child.sent().find((m) => m.method === 'session/cancel')
    expect(cancelMsg).toMatchObject({ method: 'session/cancel', params: { sessionId: 's-9' } })
    expect(child.killed).toBe(true)
  })

  it('routes RunManager abort through the turn handle before raw process cleanup', () => {
    const child = new FakeAcpChild()
    const { handle } = run(child)
    child.emit({ jsonrpc: '2.0', id: 1, result: {} })
    child.emit({ jsonrpc: '2.0', id: 2, result: { sessionId: 's-9' } })

    const controller = createGrokTurnAbortController(handle)
    controller.abort()

    expect(child.sent().some((message) => message.method === 'session/cancel')).toBe(true)
    expect(child.killed).toBe(true)
  })

  it('G5 — answers session/request_permission with DENY by default (never hangs/allows)', async () => {
    const child = new FakeAcpChild()
    const { events } = run(child)
    child.emit({ jsonrpc: '2.0', id: 1, result: {} })
    child.emit({ jsonrpc: '2.0', id: 2, result: { sessionId: 's-1' } })

    child.emit({
      jsonrpc: '2.0',
      id: 42,
      method: 'session/request_permission',
      params: {
        sessionId: 's-1',
        toolCall: { title: 'Write file', kind: 'edit' },
        options: [
          { optionId: 'a', name: 'Allow', kind: 'allow_once' },
          { optionId: 'r', name: 'Reject', kind: 'reject_once' }
        ]
      }
    })
    await new Promise((r) => setTimeout(r, 0))

    const response = child.sent().find((m) => m.id === 42 && 'result' in m)
    // Default-deny → it SELECTS the reject option (a denial), never an allow.
    expect(response).toMatchObject({
      id: 42,
      result: { outcome: { outcome: 'selected', optionId: 'r' } }
    })
    // The decline is surfaced in the transcript so the user knows a tool was asked for.
    expect(
      events.some((e) => e.type === 'provider_warning' && /requested a tool/.test(e.text || ''))
    ).toBe(true)
  })

  it('G5 — routes the permission request through an injected handler (allow path)', async () => {
    const child = new FakeAcpChild()
    const seen: string[] = []
    run(child, {
      onPermissionRequest: (req) => {
        seen.push(req.toolName)
        return 'allow'
      }
    })
    child.emit({ jsonrpc: '2.0', id: 1, result: {} })
    child.emit({ jsonrpc: '2.0', id: 2, result: { sessionId: 's-1' } })
    child.emit({
      jsonrpc: '2.0',
      id: 99,
      method: 'session/request_permission',
      params: {
        sessionId: 's-1',
        toolCall: { title: 'Read file', kind: 'read' },
        options: [{ optionId: 'a', name: 'Allow', kind: 'allow_once' }]
      }
    })
    await new Promise((r) => setTimeout(r, 0))

    expect(seen).toEqual(['Read file'])
    const response = child.sent().find((m) => m.id === 99 && 'result' in m)
    expect(response).toMatchObject({
      id: 99,
      result: { outcome: { outcome: 'selected', optionId: 'a' } }
    })
  })

  it('drops a late allow decision after the transient turn is cancelled', async () => {
    const child = new FakeAcpChild()
    let resolveDecision!: (decision: 'allow' | 'deny') => void
    const decision = new Promise<'allow' | 'deny'>((resolve) => {
      resolveDecision = resolve
    })
    const { handle } = run(child, { onPermissionRequest: () => decision })
    child.emit({ jsonrpc: '2.0', id: 1, result: {} })
    child.emit({ jsonrpc: '2.0', id: 2, result: { sessionId: 's-1' } })
    child.emit({
      jsonrpc: '2.0',
      id: 100,
      method: 'session/request_permission',
      params: {
        sessionId: 's-1',
        toolCall: { title: 'run_terminal_command', kind: 'execute' },
        options: [
          { optionId: 'a', name: 'Allow', kind: 'allow_once' },
          { optionId: 'r', name: 'Reject', kind: 'reject_once' }
        ]
      }
    })

    handle.cancel()
    resolveDecision('allow')
    await new Promise((resolve) => setTimeout(resolve, 0))

    const lateReplies = child.sent().filter((message) => message.id === 100)
    expect(lateReplies.some((message) => JSON.stringify(message).includes('"optionId":"a"'))).toBe(
      false
    )
  })

  it('recovers once when a denied native tool makes Grok cancel the turn', async () => {
    const child = new FakeAcpChild()
    const { events, closeInfos } = run(child, {
      onPermissionRequest: () => 'deny',
      taskWraithShellToolAvailable: true
    })
    child.emit({ jsonrpc: '2.0', id: 1, result: {} })
    child.emit({ jsonrpc: '2.0', id: 2, result: { sessionId: 's-1' } })

    child.emit({
      jsonrpc: '2.0',
      id: 42,
      method: 'session/request_permission',
      params: {
        sessionId: 's-1',
        toolCall: {
          title: 'run_terminal_command',
          kind: 'execute',
          rawInput: { command: 'rm -rf build' }
        },
        options: [
          { optionId: 'a', name: 'Allow', kind: 'allow_once' },
          { optionId: 'r', name: 'Reject', kind: 'reject_once' }
        ]
      }
    })
    await new Promise((r) => setTimeout(r, 0))
    expect(child.sent().find((message) => message.id === 42)).toMatchObject({
      result: { outcome: { outcome: 'selected', optionId: 'r' } }
    })

    child.emit({ jsonrpc: '2.0', id: 3, result: { stopReason: 'cancelled' } })
    await new Promise((r) => setTimeout(r, 40))

    expect(child.killed).toBe(false)
    const prompts = child.sent().filter((message) => message.method === 'session/prompt')
    expect(prompts).toHaveLength(2)
    expect(prompts[1]).toMatchObject({
      id: 5,
      params: { sessionId: 's-1' }
    })
    expect(JSON.stringify(prompts[1])).toContain('native Bash/Shell/terminal refusal')
    expect(JSON.stringify(prompts[1])).toContain('TaskWraith__run_shell_command')
    expect(
      events.some(
        (event) =>
          event.type === 'provider_warning' &&
          (event.text || '').includes('clarified routing guidance')
      )
    ).toBe(true)

    // A delayed duplicate response and the uncorrelated extension notification
    // from prompt 3 cannot terminate the now-active prompt 5 (id 4 is reserved
    // for the optional session/resume lifecycle request).
    child.emit({ jsonrpc: '2.0', id: 3, result: { stopReason: 'cancelled' } })
    child.emit({
      jsonrpc: '2.0',
      method: '_x.ai/session/prompt_complete',
      params: { sessionId: 's-1', stopReason: 'cancelled' }
    })
    await new Promise((r) => setTimeout(r, 40))
    expect(child.killed).toBe(false)
    expect(closeInfos).toHaveLength(0)

    child.emit({
      jsonrpc: '2.0',
      method: 'session/update',
      params: {
        sessionId: 's-1',
        update: {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: 'Recovered answer.' }
        }
      }
    })
    child.emit({ jsonrpc: '2.0', id: 5, result: { stopReason: 'end_turn' } })
    await new Promise((r) => setTimeout(r, 40))

    expect(child.killed).toBe(true)
    expect(closeInfos).toEqual([{ code: 0, turnComplete: true, terminalStatus: 'end_turn' }])
  })

  it('preserves a prompt RPC failure as a non-success terminal status', async () => {
    const child = new FakeAcpChild()
    // A bare -32603 is now retried (the upstream 500 that produces it is
    // self-clearing), so exhaust the budget: what must survive is the
    // NON-SUCCESS terminal status, or an adapter downstream normalizes an
    // unfinished prompt to an empty success.
    const { events, closeInfos } = run(child, {
      transientPromptRetryLimit: 1,
      transientPromptRetryDelayMs: 0
    })
    child.emit({ jsonrpc: '2.0', id: 1, result: {} })
    child.emit({ jsonrpc: '2.0', id: 2, result: { sessionId: 's-1' } })

    child.emit({
      jsonrpc: '2.0',
      id: 3,
      error: { code: -32603, message: 'Internal error' }
    })
    await new Promise((r) => setTimeout(r, 10))
    const retried = child.sent().filter((m) => m.method === 'session/prompt')
    expect(retried).toHaveLength(2)
    child.emit({
      jsonrpc: '2.0',
      id: retried[1].id as number,
      error: { code: -32603, message: 'Internal error' }
    })
    await new Promise((r) => setTimeout(r, 40))

    expect(events).toContainEqual({
      type: 'provider_warning',
      text: 'ACP session/prompt failed: Internal error'
    })
    expect(child.killed).toBe(true)
    expect(closeInfos).toEqual([
      { code: 0, turnComplete: false, terminalStatus: 'rpc_error:session/prompt' }
    ])
  })

  it('recovers a Grok turn from a transient upstream 500 without losing it', async () => {
    const child = new FakeAcpChild()
    const { events, closeInfos } = run(child, { transientPromptRetryDelayMs: 0 })
    child.emit({ jsonrpc: '2.0', id: 1, result: {} })
    child.emit({ jsonrpc: '2.0', id: 2, result: { sessionId: 's-1' } })
    // End-to-end shape of the reported failure: stderr carries the 500, the
    // JSON-RPC error is a bare envelope.
    child.errorOutput(
      'ERROR error=Internal error: {"message":"API error (status 500 Internal Server Error): error: Service temporarily unavailable.","http_status":500}'
    )
    child.emit({ jsonrpc: '2.0', id: 3, error: { code: -32603, message: 'Internal error' } })
    await new Promise((r) => setTimeout(r, 10))

    const retried = child.sent().filter((m) => m.method === 'session/prompt')
    expect(retried).toHaveLength(2)
    child.emit({
      jsonrpc: '2.0',
      method: 'session/update',
      params: {
        sessionId: 's-1',
        update: {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: 'Answer after the blip.' }
        }
      }
    })
    child.emit({ jsonrpc: '2.0', id: retried[1].id as number, result: { stopReason: 'end_turn' } })
    await new Promise((r) => setTimeout(r, 40))

    // The turn the user would otherwise have lost entirely.
    expect(
      events.some((e) => e.type === 'content' && e.text === 'Answer after the blip.')
    ).toBe(true)
    expect(closeInfos).toEqual([{ code: 0, turnComplete: true, terminalStatus: 'end_turn' }])
  })

  it('reports the exact broker-unavailable blocker after a denied native tool', async () => {
    const child = new FakeAcpChild()
    run(child, { onPermissionRequest: () => 'deny' })
    child.emit({ jsonrpc: '2.0', id: 1, result: {} })
    child.emit({ jsonrpc: '2.0', id: 2, result: { sessionId: 's-1' } })
    child.emit({
      jsonrpc: '2.0',
      id: 42,
      method: 'session/request_permission',
      params: {
        sessionId: 's-1',
        toolCall: { title: 'run_terminal_command', kind: 'execute', rawInput: { command: 'pwd' } },
        options: [
          { optionId: 'a', name: 'Allow', kind: 'allow_once' },
          { optionId: 'r', name: 'Reject', kind: 'reject_once' }
        ]
      }
    })
    await new Promise((resolve) => setTimeout(resolve, 0))
    child.emit({ jsonrpc: '2.0', id: 3, result: { stopReason: 'cancelled' } })
    await new Promise((resolve) => setTimeout(resolve, 40))

    const prompts = child.sent().filter((message) => message.method === 'session/prompt')
    expect(prompts).toHaveLength(2)
    const recoveryPrompt = JSON.stringify(prompts[1])
    expect(recoveryPrompt).toContain('shell broker is unavailable for this turn')
    expect(recoveryPrompt).toContain('do not call, search for, or infer a replacement shell tool')
    expect(recoveryPrompt).not.toContain('TaskWraith__run_shell_command')
    expect(recoveryPrompt).not.toContain('taskwraith-grok__blackboard_post')
  })

  it('continues once after a declined broker tool without mislabelling it as native', async () => {
    const child = new FakeAcpChild()
    const { events, closeInfos } = run(child, { taskWraithShellToolAvailable: true })
    child.emit({ jsonrpc: '2.0', id: 1, result: {} })
    child.emit({ jsonrpc: '2.0', id: 2, result: { sessionId: 's-1' } })
    child.emit({
      jsonrpc: '2.0',
      method: 'session/update',
      params: {
        sessionId: 's-1',
        update: {
          sessionUpdate: 'tool_call',
          toolCallId: 'broker-1',
          title: 'TaskWraith__capability_invoke',
          kind: 'other',
          rawInput: { capability: 'evidence_pack_write' }
        }
      }
    })
    child.emit({
      jsonrpc: '2.0',
      method: 'session/update',
      params: {
        sessionId: 's-1',
        update: {
          sessionUpdate: 'tool_call_update',
          toolCallId: 'broker-1',
          // ACP may call the transport itself complete even though the
          // TaskWraith result is a typed user decline.
          status: 'completed',
          content: [{ type: 'content', content: { type: 'text', text: 'User declined.' } }]
        }
      }
    })
    child.emit({ jsonrpc: '2.0', id: 3, result: { stopReason: 'cancelled' } })
    await new Promise((resolve) => setTimeout(resolve, 40))

    const prompts = child.sent().filter((message) => message.method === 'session/prompt')
    expect(prompts).toHaveLength(2)
    const recoveryPrompt = JSON.stringify(prompts[1])
    expect(recoveryPrompt).toContain('Respect the user decision')
    expect(recoveryPrompt).toContain('not a reason to cancel the participant turn')
    expect(recoveryPrompt).not.toContain('native Bash/Shell/terminal refusal')
    expect(
      events.some(
        (event) =>
          event.type === 'provider_warning' &&
          (event.text || '').includes('declined or failed tool')
      )
    ).toBe(true)

    child.emit({
      jsonrpc: '2.0',
      method: 'session/update',
      params: {
        sessionId: 's-1',
        update: {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: 'Finished from existing evidence.' }
        }
      }
    })
    child.emit({ jsonrpc: '2.0', id: 5, result: { stopReason: 'end_turn' } })
    await new Promise((resolve) => setTimeout(resolve, 40))
    expect(closeInfos).toEqual([{ code: 0, turnComplete: true, terminalStatus: 'end_turn' }])
  })

  it('bounds denied-tool recovery to one follow-up prompt', async () => {
    const child = new FakeAcpChild()
    const { closeInfos } = run(child, { onPermissionRequest: () => 'deny' })
    child.emit({ jsonrpc: '2.0', id: 1, result: {} })
    child.emit({ jsonrpc: '2.0', id: 2, result: { sessionId: 's-1' } })

    const denyTool = async (rpcId: number, promptRpcId: number): Promise<void> => {
      child.emit({
        jsonrpc: '2.0',
        id: rpcId,
        method: 'session/request_permission',
        params: {
          sessionId: 's-1',
          toolCall: { title: 'run_terminal_command', kind: 'execute' },
          options: [{ optionId: 'r', name: 'Reject', kind: 'reject_once' }]
        }
      })
      await new Promise((r) => setTimeout(r, 0))
      child.emit({
        jsonrpc: '2.0',
        id: promptRpcId,
        result: { stopReason: 'PermissionRejected' }
      })
    }

    await denyTool(42, 3)
    await new Promise((r) => setTimeout(r, 40))
    expect(child.sent().filter((message) => message.method === 'session/prompt')).toHaveLength(2)
    expect(child.killed).toBe(false)

    await denyTool(43, 5)
    await new Promise((r) => setTimeout(r, 40))
    expect(child.sent().filter((message) => message.method === 'session/prompt')).toHaveLength(2)
    expect(child.killed).toBe(true)
    expect(closeInfos).toEqual([
      { code: 0, turnComplete: true, terminalStatus: 'PermissionRejected' }
    ])
  })

  it('cancel invalidates recovery before a late correlated terminal arrives', async () => {
    const child = new FakeAcpChild()
    const { handle } = run(child, { onPermissionRequest: () => 'deny' })
    child.emit({ jsonrpc: '2.0', id: 1, result: {} })
    child.emit({ jsonrpc: '2.0', id: 2, result: { sessionId: 's-1' } })
    child.emit({
      jsonrpc: '2.0',
      id: 42,
      method: 'session/request_permission',
      params: {
        sessionId: 's-1',
        toolCall: { title: 'run_terminal_command', kind: 'execute' },
        options: [{ optionId: 'r', name: 'Reject', kind: 'reject_once' }]
      }
    })
    await new Promise((r) => setTimeout(r, 0))

    handle.cancel()
    child.emit({ jsonrpc: '2.0', id: 3, result: { stopReason: 'PermissionRejected' } })
    await new Promise((r) => setTimeout(r, 40))

    expect(child.sent().filter((message) => message.method === 'session/prompt')).toHaveLength(1)
  })

  it('answers an unhandled inbound request with method-not-found (transport keep-alive)', () => {
    const child = new FakeAcpChild()
    run(child)
    child.emit({ jsonrpc: '2.0', id: 1, result: {} })
    child.emit({ jsonrpc: '2.0', id: 2, result: { sessionId: 's-1' } })
    // An inbound agent→client request we don't handle (e.g. an _x.ai extension).
    child.emit({ jsonrpc: '2.0', id: 77, method: '_x.ai/some_extension', params: {} })
    const response = child.sent().find((m) => m.id === 77)
    expect(response).toMatchObject({ id: 77, error: { code: -32601 } })
    // It is an ERROR reply, never an allow/result outcome.
    expect(response && 'result' in response).toBe(false)
  })

  it('does not reply to a notification (no id) — streams it instead', () => {
    const child = new FakeAcpChild()
    const { events } = run(child)
    child.emit({ jsonrpc: '2.0', id: 1, result: {} })
    child.emit({ jsonrpc: '2.0', id: 2, result: { sessionId: 's-1' } })
    child.emit({
      jsonrpc: '2.0',
      method: 'session/update',
      params: {
        sessionId: 's-1',
        update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'hello' } }
      }
    })
    const sentMethodNotFound = child
      .sent()
      .some((m) => m.error && (m.error as { code?: number }).code === -32601)
    expect(sentMethodNotFound).toBe(false)
    expect(events.some((e) => e.type === 'content' && e.text === 'hello')).toBe(true)
  })

  it('fails the turn (no hang) when session/new returns a JSON-RPC error', async () => {
    const child = new FakeAcpChild()
    const { events, closes } = run(child)
    child.emit({ jsonrpc: '2.0', id: 1, result: { protocolVersion: 1 } })
    // session/new rejected (e.g. a malformed mcpServers entry: -32602).
    child.emit({
      jsonrpc: '2.0',
      id: 2,
      error: { code: -32602, message: 'Invalid params', data: 'bad McpServer' }
    })
    // No sessionId arrives — the client must surface the error + close, NOT wait
    // forever for a result (the "Thinking…" hang).
    expect(
      events.some((e) => e.type === 'provider_warning' && /session\/new failed/.test(e.text || ''))
    ).toBe(true)
    expect(child.killed).toBe(true)
    // It never advanced to session/prompt.
    expect(child.sent().some((m) => m.method === 'session/prompt')).toBe(false)
    await new Promise((r) => setTimeout(r, 10))
    expect(closes.length).toBe(1)
  })

  it('surfaces a spawn/process error as a provider_warning + closes', () => {
    const child = new FakeAcpChild()
    const { events, closes } = run(child)
    child.fail(new Error('spawn failed'))
    expect(events.some((e) => e.type === 'provider_warning' && e.text === 'spawn failed')).toBe(
      true
    )
    expect(closes).toEqual([1])
  })

  it('explains ENOENT spawn errors as missing Grok CLI setup', () => {
    const child = new FakeAcpChild()
    const { events, closes } = run(child)
    const err = Object.assign(new Error('spawn /Users/dev/.grok/bin/grok ENOENT'), {
      code: 'ENOENT',
      path: '/Users/dev/.grok/bin/grok'
    })

    child.fail(err)

    const warning = events.find((e) => e.type === 'provider_warning')?.text || ''
    expect(warning).toContain('Grok CLI could not be started')
    expect(warning).toContain('/Users/dev/.grok/bin/grok')
    expect(warning).toContain('ENOENT')
    expect(warning).toContain('Settings -> Providers -> Grok')
    expect(closes).toEqual([1])
  })

  it('holds a provider-delete receipt until TERM, KILL backstop, and exact child close join', async () => {
    vi.useFakeTimers()
    const child = new FakeAcpChild()
    child.autoCloseOnKill = false
    const lifecycle: string[] = []
    const { handle } = run(child, {
      onClose: () => {
        lifecycle.push('onClose-cleanup')
      }
    })
    let joined = false
    const deletion = (async () => {
      handle.cancel()
      await handle.closed
      lifecycle.push('deletion-receipt')
      joined = true
    })()

    await Promise.resolve()
    expect(child.killSignals).toEqual(['SIGTERM'])
    expect(joined).toBe(false)
    expect(lifecycle).toEqual([])

    await vi.advanceTimersByTimeAsync(4_000)
    expect(child.killSignals).toEqual(['SIGTERM', 'SIGKILL'])
    expect(joined).toBe(false)
    expect(lifecycle).toEqual([])

    child.finish(null)
    await deletion
    expect(joined).toBe(true)
    expect(lifecycle).toEqual(['onClose-cleanup', 'deletion-receipt'])
  })
})
