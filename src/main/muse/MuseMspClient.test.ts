import { describe, expect, it, vi } from 'vitest'
import type { AcpChildProcess } from '../acp/AcpTurnClient'
import { runMuseMspTurn, selectMuseMspApprovalChoice } from './MuseMspClient'
import type { MuseExecNormalizedEvent } from './MuseExecJson'
import type { MuseMspApprovalChoice } from './MuseMspProtocol'

/** The ACP suites' fake child, reused verbatim — the client takes the same
 * injected `spawnProcess` seam precisely so this harness is shared. */
class FakeMspChild implements AcpChildProcess {
  writes: string[] = []
  killed: string[] = []
  autoCloseOnKill = true
  private dataListeners: ((chunk: string) => void)[] = []
  private closeListener?: (code: number | null) => void
  private errorListener?: (err: Error) => void

  stdin = {
    write: (data: string, cb?: (err?: Error | null) => void): void => {
      this.writes.push(data)
      cb?.(null)
    },
    on: (): void => {},
    end: (): void => {}
  }
  stdout = {
    on: (_event: 'data', listener: (chunk: string) => void): void => {
      this.dataListeners.push(listener)
    }
  }
  stderr = { on: (): void => {} }

  on(event: 'error' | 'close', listener: (arg: never) => void): void {
    if (event === 'close') this.closeListener = listener as (code: number | null) => void
    else this.errorListener = listener as (err: Error) => void
  }
  kill(signal?: string): void {
    this.killed.push(signal || 'SIGTERM')
    if (this.autoCloseOnKill) this.closeListener?.(0)
  }
  emit(message: unknown): void {
    const line = `${JSON.stringify(message)}\n`
    this.dataListeners.forEach((cb) => cb(line))
  }
  sent(): Record<string, any>[] {
    return this.writes.map((w) => JSON.parse(w.trim()))
  }
  sentMethod(method: string): Record<string, any> | undefined {
    return this.sent().find((frame) => frame.method === method)
  }
  fail(err: Error): void {
    this.errorListener?.(err)
  }
  finish(code: number | null): void {
    this.closeListener?.(code)
  }
}

const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))
const bytes = (size: number): Uint8Array => Uint8Array.from({ length: size }, (_, i) => i)

function start(overrides: Record<string, unknown> = {}): {
  child: FakeMspChild
  events: MuseExecNormalizedEvent[]
  handle: ReturnType<typeof runMuseMspTurn>
} {
  const child = new FakeMspChild()
  const events: MuseExecNormalizedEvent[] = []
  const handle = runMuseMspTurn({
    spawnProcess: () => child,
    clientVersion: '1.9.7',
    workspaceRoot: '/ws',
    input: [{ type: 'text', text: 'hello' }],
    providerId: 'meta',
    modelId: 'muse-spark-1.3',
    onEvent: (event) => events.push(event),
    now: () => 1_700_000_000_000,
    randomBytes: bytes,
    endProcessGraceMs: 20,
    ...overrides
  } as never)
  return { child, events, handle }
}

/** Drive the handshake to an accepted turn. */
async function driveToTurn(child: FakeMspChild, sessionId = 'sess-1'): Promise<void> {
  await flush()
  child.emit({ jsonrpc: '2.0', id: 1, result: { serverInfo: { name: 'muse', version: '1.0.3' } } })
  await flush()
  child.emit({
    jsonrpc: '2.0',
    id: 2,
    result: { session: { sessionId, turnCount: 0, workspaceRoot: '/ws', modelId: 'm' } }
  })
  await flush()
  child.emit({ jsonrpc: '2.0', id: 3, result: { turnId: 'turn-1', status: 'accepted' } })
  await flush()
}

describe('runMuseMspTurn — handshake', () => {
  it('initializes with a MACHINE client name and the app version', async () => {
    const { child } = start()
    await flush()
    const init = child.sentMethod('initialize')
    // `taskwraith-spike` is rejected -32602 by the real host; the name must
    // match ^[a-z0-9_]+$.
    expect(init?.params.clientInfo).toEqual({ name: 'taskwraith', version: '1.9.7' })
    expect(init?.params.clientInfo.name).toMatch(/^[a-z0-9_]+$/)
  })

  it('closes the handshake with the initialized NOTIFICATION (no id)', async () => {
    const { child } = start()
    await flush()
    child.emit({ jsonrpc: '2.0', id: 1, result: {} })
    await flush()
    const initialized = child.sentMethod('initialized')
    expect(initialized).toBeDefined()
    expect(initialized).not.toHaveProperty('id')
  })

  it('starts a session with the workspace, provider, model and approval mode', async () => {
    const { child } = start({ approvalMode: 'promptUnmatched' })
    await flush()
    child.emit({ jsonrpc: '2.0', id: 1, result: {} })
    await flush()
    expect(child.sentMethod('session/start')?.params).toMatchObject({
      workspaceRoot: '/ws',
      providerId: 'meta',
      modelId: 'muse-spark-1.3',
      approvalMode: 'promptUnmatched'
    })
  })

  it('mints a UUIDv7 commandId on EVERY command — the server never mints one', async () => {
    const { child } = start()
    await driveToTurn(child)
    const commands = child.sent().filter((f) => f.id !== undefined && f.method !== 'initialize')
    expect(commands.length).toBeGreaterThan(0)
    for (const command of commands) {
      expect(String(command.params?.commandId)).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
      )
    }
  })

  it('sends the turn input parts verbatim, including image parts', async () => {
    const { child } = start({
      input: [
        { type: 'text', text: 'what colour?' },
        { type: 'image', mediaType: 'image/png', base64Data: 'AAAB', width: 64, height: 64 }
      ]
    })
    await driveToTurn(child)
    expect(child.sentMethod('turn/start')?.params.input).toEqual([
      { type: 'text', text: 'what colour?' },
      { type: 'image', mediaType: 'image/png', base64Data: 'AAAB', width: 64, height: 64 }
    ])
  })
})

describe('runMuseMspTurn — session resume', () => {
  it('resumes the stored session instead of starting a new one', async () => {
    const { child } = start({ resumeSessionId: 'stored-1' })
    await flush()
    child.emit({ jsonrpc: '2.0', id: 1, result: {} })
    await flush()
    expect(child.sentMethod('session/resume')?.params).toMatchObject({ sessionId: 'stored-1' })
    expect(child.sentMethod('session/start')).toBeUndefined()
  })

  it('degrades to a fresh session when the stored one cannot be resumed', async () => {
    // A stored id is a hint, not a contract: a pruned or foreign session must
    // not fault the turn.
    const { child, events } = start({ resumeSessionId: 'gone' })
    await flush()
    child.emit({ jsonrpc: '2.0', id: 1, result: {} })
    await flush()
    child.emit({
      jsonrpc: '2.0',
      id: 2,
      error: { code: -32020, message: 'not found', data: { kind: 'sessionNotFound' } }
    })
    await flush()
    expect(child.sentMethod('session/start')).toBeDefined()
    expect(events.some((e) => String(e.text).includes('could not resume'))).toBe(true)
  })

  it('reports resumed-ness and turn count to the caller', async () => {
    const onSessionReady = vi.fn()
    const { child } = start({ resumeSessionId: 'stored-1', onSessionReady })
    await flush()
    child.emit({ jsonrpc: '2.0', id: 1, result: {} })
    await flush()
    child.emit({
      jsonrpc: '2.0',
      id: 2,
      result: {
        session: { sessionId: 'stored-1', turnCount: 4, workspaceRoot: '/ws', modelId: 'm' }
      }
    })
    await flush()
    expect(onSessionReady).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: 'stored-1', resumed: true, turnCount: 4 })
    )
  })
})

describe('runMuseMspTurn — transcript projection', () => {
  it('streams agentMessage text deltas as content', async () => {
    const { child, events } = start()
    await driveToTurn(child)
    child.emit({
      jsonrpc: '2.0',
      method: 'item/delta',
      params: { sessionId: 'sess-1', itemId: 'i1', field: 'text', delta: 'Orange' }
    })
    expect(events.filter((e) => e.type === 'content').map((e) => e.text)).toEqual(['Orange'])
  })

  it('ignores a delta on a non-text field', async () => {
    const { child, events } = start()
    await driveToTurn(child)
    child.emit({
      jsonrpc: '2.0',
      method: 'item/delta',
      params: { sessionId: 'sess-1', itemId: 'i1', field: 'summary', delta: 'partial thought' }
    })
    expect(events.filter((e) => e.type === 'content')).toHaveLength(0)
  })

  it('does NOT re-emit a completed agentMessage that already streamed', async () => {
    // The completed item repeats the accumulated text; emitting both doubles
    // the answer in the transcript.
    const { child, events } = start()
    await driveToTurn(child)
    child.emit({
      jsonrpc: '2.0',
      method: 'item/delta',
      params: { sessionId: 'sess-1', itemId: 'i1', field: 'text', delta: 'Orange' }
    })
    child.emit({
      jsonrpc: '2.0',
      method: 'item/completed',
      params: {
        sessionId: 'sess-1',
        item: {
          itemId: 'i1',
          kind: 'agentMessage',
          revision: 2,
          status: 'completed',
          text: 'Orange'
        }
      }
    })
    expect(events.filter((e) => e.type === 'content')).toHaveLength(1)
  })

  it('projects a completed reasoning summary as thinking, never a partial one', async () => {
    const { child, events } = start()
    await driveToTurn(child)
    child.emit({
      jsonrpc: '2.0',
      method: 'item/started',
      params: {
        sessionId: 'sess-1',
        item: {
          itemId: 'r1',
          kind: 'reasoning',
          revision: 1,
          status: 'inProgress',
          summary: ['half']
        }
      }
    })
    expect(events.filter((e) => e.type === 'thinking')).toHaveLength(0)
    child.emit({
      jsonrpc: '2.0',
      method: 'item/completed',
      params: {
        sessionId: 'sess-1',
        item: {
          itemId: 'r1',
          kind: 'reasoning',
          revision: 2,
          status: 'completed',
          summary: ['first', 'second']
        }
      }
    })
    const thinking = events.find((e) => e.type === 'thinking')
    expect(thinking?.text).toBe('first\nsecond')
    expect(thinking?.thinkingId).toBe('r1')
  })

  it('pairs a tool call with its result using the provider call id', async () => {
    const { child, events } = start()
    await driveToTurn(child)
    child.emit({
      jsonrpc: '2.0',
      method: 'item/started',
      params: {
        sessionId: 'sess-1',
        item: {
          itemId: 't1',
          kind: 'toolCall',
          revision: 1,
          status: 'inProgress',
          tool: 'write_file',
          callId: 'call_9',
          args: '{"path":"a.txt"}'
        }
      }
    })
    child.emit({
      jsonrpc: '2.0',
      method: 'item/completed',
      params: {
        sessionId: 'sess-1',
        item: {
          itemId: 't1',
          kind: 'toolCall',
          revision: 2,
          status: 'completed',
          tool: 'write_file',
          callId: 'call_9',
          visibleOutput: 'wrote 5 bytes'
        }
      }
    })
    const use = events.find((e) => e.type === 'tool_use')
    const result = events.find((e) => e.type === 'tool_result')
    expect(use).toMatchObject({
      toolId: 'call_9',
      toolName: 'write_file',
      toolInput: { path: 'a.txt' }
    })
    expect(result).toMatchObject({
      toolId: 'call_9',
      toolStatus: 'success',
      toolOutput: 'wrote 5 bytes'
    })
  })

  it('marks a failed tool call as an error result', async () => {
    const { child, events } = start()
    await driveToTurn(child)
    child.emit({
      jsonrpc: '2.0',
      method: 'item/completed',
      params: {
        sessionId: 'sess-1',
        item: {
          itemId: 't2',
          kind: 'toolCall',
          revision: 2,
          status: 'failed',
          tool: 'run_shell_command',
          callId: 'call_x',
          failureReason: 'denied'
        }
      }
    })
    expect(events.find((e) => e.type === 'tool_result')).toMatchObject({
      toolStatus: 'error',
      toolOutput: 'denied'
    })
  })

  it('treats every non-completed terminal status as an error result', async () => {
    // ItemStatus is an OPEN enum (inProgress|completed|failed|cancelled|
    // rejected|timedOut, plus future members). An earlier version of this
    // client also accepted a guessed `succeeded`, which is not in the schema.
    const { child, events } = start()
    await driveToTurn(child)
    const statuses = ['failed', 'cancelled', 'rejected', 'timedOut', 'somethingNew']
    for (const status of statuses) {
      child.emit({
        jsonrpc: '2.0',
        method: 'item/completed',
        params: {
          sessionId: 'sess-1',
          item: {
            itemId: `t-${status}`,
            kind: 'toolCall',
            revision: 2,
            status,
            tool: 'x',
            callId: `c-${status}`
          }
        }
      })
    }
    const results = events.filter((e) => e.type === 'tool_result')
    // Pin the count first so the every() below cannot pass vacuously.
    expect(results).toHaveLength(statuses.length)
    expect(results.every((e) => e.toolStatus === 'error')).toBe(true)
  })

  it('cancels using the session alone when the turn id was never captured', async () => {
    // turnId is OPTIONAL on turn/cancel. A lost turn/start response must not
    // cost the cancel — that leaves muse billing a turn nobody is watching.
    const child = new FakeMspChild()
    const handle = runMuseMspTurn({
      spawnProcess: () => child,
      clientVersion: '1.9.7',
      workspaceRoot: '/ws',
      input: [{ type: 'text', text: 'hi' }],
      onEvent: () => {},
      randomBytes: bytes,
      endProcessGraceMs: 20
    })
    await flush()
    child.emit({ jsonrpc: '2.0', id: 1, result: {} })
    await flush()
    child.emit({ jsonrpc: '2.0', id: 2, result: { session: { sessionId: 'sess-9' } } })
    await flush()
    handle.cancel()
    const cancel = child.sentMethod('turn/cancel')
    expect(cancel?.params).toMatchObject({ sessionId: 'sess-9' })
    expect(cancel?.params).not.toHaveProperty('turnId')
    await handle.closed
  })

  it('keeps unparsable tool args instead of dropping the call', async () => {
    const { child, events } = start()
    await driveToTurn(child)
    child.emit({
      jsonrpc: '2.0',
      method: 'item/started',
      params: {
        sessionId: 'sess-1',
        item: {
          itemId: 't3',
          kind: 'toolCall',
          revision: 1,
          status: 'inProgress',
          tool: 'x',
          args: 'not json'
        }
      }
    })
    expect(events.find((e) => e.type === 'tool_use')?.toolInput).toEqual({ raw: 'not json' })
  })

  it('emits the turn terminal and terminates the host', async () => {
    const { child, events } = start()
    await driveToTurn(child)
    child.emit({
      jsonrpc: '2.0',
      method: 'turn/completed',
      params: { sessionId: 'sess-1', turnId: 'turn-1', terminal: 'completed', durationMs: 12 }
    })
    expect(events.find((e) => e.type === 'terminal')).toMatchObject({ terminal: 'completed' })
    expect(child.killed.length).toBeGreaterThan(0)
  })

  it('warns when the host reports a dropped-event gap', async () => {
    const { child, events } = start()
    await driveToTurn(child)
    child.emit({ jsonrpc: '2.0', method: 'view/gap', params: { after: 1, next: 9 } })
    expect(events.some((e) => String(e.text).includes('dropped pushed session events'))).toBe(true)
  })
})

describe('runMuseMspTurn — live usage and context', () => {
  it('forwards cumulative token usage', async () => {
    const onUsage = vi.fn()
    const { child } = start({ onUsage })
    await driveToTurn(child)
    child.emit({
      jsonrpc: '2.0',
      method: 'session/tokenUsage',
      params: {
        sessionId: 'sess-1',
        cumulative: { promptTokens: 19252, outputTokens: 23, totalTokens: 19275 },
        usage: { cachedTokens: 10, reasoningTokens: 4 }
      }
    })
    expect(onUsage).toHaveBeenCalledWith(
      expect.objectContaining({ inputTokens: 19252, outputTokens: 23, totalTokens: 19275 })
    )
  })

  it('forwards the provider-reported context window, which no static table can know', async () => {
    const onContextUsage = vi.fn()
    const { child } = start({ onContextUsage })
    await driveToTurn(child)
    child.emit({
      jsonrpc: '2.0',
      method: 'session/contextUsage',
      params: { sessionId: 'sess-1', usedTokens: 19275, windowTokens: 1007997, pressure: 'normal' }
    })
    expect(onContextUsage).toHaveBeenCalledWith({
      usedTokens: 19275,
      windowTokens: 1007997,
      pressure: 'normal'
    })
  })

  it('ignores a context frame with no usedTokens rather than reporting zero', async () => {
    const onContextUsage = vi.fn()
    const { child } = start({ onContextUsage })
    await driveToTurn(child)
    child.emit({ jsonrpc: '2.0', method: 'session/contextUsage', params: { sessionId: 'sess-1' } })
    expect(onContextUsage).not.toHaveBeenCalled()
  })
})

describe('selectMuseMspApprovalChoice — select, never create', () => {
  const choice = (
    choiceId: string,
    decision: string,
    scope: MuseMspApprovalChoice['scope']
  ): MuseMspApprovalChoice => ({ choiceId, decision, label: choiceId, scope })

  it('takes the narrowest approval for allow', () => {
    const picked = selectMuseMspApprovalChoice(
      [choice('s', 'approvedForSession', 'session'), choice('o', 'approved', 'once')],
      'allow'
    )
    expect(picked?.choiceId).toBe('o')
  })

  it('DENIES rather than widening when no once-scoped approval is offered', () => {
    // approvedForSession outlives the single call TaskWraith approved. A
    // per-call allow must never silently become a session grant.
    const picked = selectMuseMspApprovalChoice(
      [choice('s', 'approvedForSession', 'session'), choice('d', 'denied', 'once')],
      'allow'
    )
    expect(picked?.decision).toBe('denied')
  })

  it('falls back to abort when no denial is offered', () => {
    const picked = selectMuseMspApprovalChoice([choice('a', 'abort', 'once')], 'deny')
    expect(picked?.decision).toBe('abort')
  })

  it('returns null when nothing safe is offered', () => {
    expect(
      selectMuseMspApprovalChoice([choice('s', 'approvedForSession', 'session')], 'deny')
    ).toBeNull()
  })
})

describe('runMuseMspTurn — approvals', () => {
  const approvalFrame = (overrides: Record<string, unknown> = {}) => ({
    jsonrpc: '2.0',
    method: 'approval/requested',
    params: {
      approvalId: 'ap-1',
      sessionId: 'sess-1',
      turnId: 'turn-1',
      toolName: 'run_shell_command',
      rawArgs: '{"command":"rm -rf /"}',
      subject: { kind: 'shell', command: 'rm -rf /' },
      currentRequirementId: { approvalId: 'ap-1', sourceIndex: 0 },
      availableChoices: [
        { choiceId: 'yes', decision: 'approved', label: 'Allow once', scope: 'once' },
        { choiceId: 'no', decision: 'denied', label: 'Deny', scope: 'once' }
      ],
      ...overrides
    }
  })

  it('answers an approval with the chosen choice id and the CAS requirement', async () => {
    const onApprovalRequest = vi.fn().mockResolvedValue('allow')
    const { child } = start({ onApprovalRequest })
    await driveToTurn(child)
    child.emit(approvalFrame())
    await flush()
    expect(onApprovalRequest).toHaveBeenCalledWith(
      expect.objectContaining({ toolName: 'run_shell_command' })
    )
    expect(child.sentMethod('approval/decide')?.params).toMatchObject({
      approvalId: 'ap-1',
      choiceId: 'yes',
      requirementId: { approvalId: 'ap-1', sourceIndex: 0 }
    })
  })

  it('echoes the requirement id an approval/updated moved to', async () => {
    // A stale requirement id is rejected `approvalRequirementStale`, which
    // leaves the tool call hanging.
    const onApprovalRequest = vi.fn().mockResolvedValue('allow')
    const { child } = start({ onApprovalRequest })
    await driveToTurn(child)
    child.emit(approvalFrame())
    child.emit({
      jsonrpc: '2.0',
      method: 'approval/updated',
      params: { approvalId: 'ap-1', currentRequirementId: { approvalId: 'ap-1', sourceIndex: 3 } }
    })
    await flush()
    expect(child.sentMethod('approval/decide')?.params.requirementId).toEqual({
      approvalId: 'ap-1',
      sourceIndex: 3
    })
  })

  it('DENIES when no approval handler is attached, and says so', async () => {
    const { child, events } = start()
    await driveToTurn(child)
    child.emit(approvalFrame())
    await flush()
    expect(child.sentMethod('approval/decide')?.params.choiceId).toBe('no')
    expect(events.some((e) => String(e.text).includes('no TaskWraith approval handler'))).toBe(true)
  })

  it('DENIES when the handler throws', async () => {
    const onApprovalRequest = vi.fn().mockRejectedValue(new Error('ledger down'))
    const { child } = start({ onApprovalRequest })
    await driveToTurn(child)
    child.emit(approvalFrame())
    await flush()
    expect(child.sentMethod('approval/decide')?.params.choiceId).toBe('no')
  })

  it('DENIES when the handler returns anything that is not a literal allow', async () => {
    const onApprovalRequest = vi.fn().mockResolvedValue('maybe')
    const { child } = start({ onApprovalRequest })
    await driveToTurn(child)
    child.emit(approvalFrame())
    await flush()
    expect(child.sentMethod('approval/decide')?.params.choiceId).toBe('no')
  })

  it('cancels the turn rather than guessing when no usable choice is offered', async () => {
    const onApprovalRequest = vi.fn().mockResolvedValue('deny')
    const { child, events } = start({ onApprovalRequest })
    await driveToTurn(child)
    child.emit(approvalFrame({ availableChoices: [] }))
    await flush()
    expect(child.sentMethod('approval/decide')).toBeUndefined()
    expect(child.sentMethod('turn/cancel')).toBeDefined()
    expect(events.some((e) => String(e.text).includes('no usable choice'))).toBe(true)
  })
})

describe('runMuseMspTurn — steering and teardown', () => {
  it('steers the running turn with the expectedTurnId race guard', async () => {
    const { child, handle } = start()
    await driveToTurn(child)
    expect(handle.steer([{ type: 'text', text: 'also check the tests' }])).toBe(true)
    expect(child.sentMethod('turn/steer')?.params).toMatchObject({
      sessionId: 'sess-1',
      expectedTurnId: 'turn-1'
    })
  })

  it('refuses to steer once the turn has completed', async () => {
    const { child, handle } = start()
    await driveToTurn(child)
    child.emit({
      jsonrpc: '2.0',
      method: 'turn/completed',
      params: { sessionId: 'sess-1', turnId: 'turn-1', terminal: 'completed' }
    })
    expect(handle.steer([{ type: 'text', text: 'too late' }])).toBe(false)
  })

  it('refuses to steer with empty input', async () => {
    const { child, handle } = start()
    await driveToTurn(child)
    expect(handle.steer([])).toBe(false)
  })

  it('cancels the turn before terminating the host', async () => {
    const { child, handle } = start()
    await driveToTurn(child)
    handle.cancel()
    expect(child.sentMethod('turn/cancel')?.params).toMatchObject({
      sessionId: 'sess-1',
      turnId: 'turn-1'
    })
    expect(child.killed.length).toBeGreaterThan(0)
  })

  it('answers an unknown inbound REQUEST so the peer cannot wedge', async () => {
    const { child } = start()
    await driveToTurn(child)
    child.emit({ jsonrpc: '2.0', id: 'srv-1', method: 'someday/newThing', params: {} })
    const reply = child.sent().find((f) => f.id === 'srv-1' && f.error)
    expect(reply?.error.code).toBe(-32601)
  })

  it('resolves closed only after onClose has settled', async () => {
    const order: string[] = []
    const { child, handle } = start({
      onClose: async () => {
        await flush()
        order.push('onClose')
      }
    })
    await driveToTurn(child)
    void handle.closed.then(() => order.push('closed'))
    child.finish(0)
    await handle.closed
    expect(order).toEqual(['onClose', 'closed'])
  })

  it('reports the observed terminal to onClose', async () => {
    const onClose = vi.fn()
    const { child } = start({ onClose })
    await driveToTurn(child)
    child.emit({
      jsonrpc: '2.0',
      method: 'turn/completed',
      params: { sessionId: 'sess-1', turnId: 'turn-1', terminal: 'failed' }
    })
    await flush()
    expect(onClose).toHaveBeenCalledWith(0, 'failed')
  })

  it('SIGKILLs a host that ignores the graceful terminator', async () => {
    const { child, handle } = start()
    child.autoCloseOnKill = false
    await driveToTurn(child)
    handle.cancel()
    expect(child.killed).toEqual(['SIGTERM'])
    await new Promise((resolve) => setTimeout(resolve, 40))
    expect(child.killed).toContain('SIGKILL')
    child.autoCloseOnKill = true
    child.finish(null)
    await handle.closed
  })

  it('rejects in-flight calls when the host exits mid-handshake', async () => {
    const { child, events, handle } = start()
    await flush()
    child.finish(1)
    await handle.closed
    expect(events.some((e) => String(e.text).includes('did not complete'))).toBe(true)
  })
})
