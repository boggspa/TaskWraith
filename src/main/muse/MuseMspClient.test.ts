import { describe, expect, it, vi } from 'vitest'
import type { AcpChildProcess } from '../acp/AcpTurnClient'
import { runMuseMspTurn, selectMuseMspApprovalChoice } from './MuseMspClient'
import type { MuseExecNormalizedEvent } from './MuseExecJson'
import { MUSE_MSP_SCHEMA_FINGERPRINT, type MuseMspApprovalChoice } from './MuseMspProtocol'

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
  warnings: string[]
  handle: ReturnType<typeof runMuseMspTurn>
} {
  const child = new FakeMspChild()
  const events: MuseExecNormalizedEvent[] = []
  const warnings: string[] = []
  const handle = runMuseMspTurn({
    onWarning: (message: string) => warnings.push(message),
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
  return { child, events, warnings, handle }
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
    const { child, warnings } = start({ resumeSessionId: 'gone' })
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
    expect(warnings.some((w) => w.includes('could not resume'))).toBe(true)
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
    const { child, warnings } = start()
    await driveToTurn(child)
    child.emit({ jsonrpc: '2.0', method: 'view/gap', params: { after: 1, next: 9 } })
    expect(warnings.some((w) => w.includes('dropped pushed session events'))).toBe(true)
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

  it('does not author a durable policy rule when denying', () => {
    // localPersistent choices carry a rulePreview: picking one writes a
    // standing rule the user never asked for. Narrowest scope first.
    const picked = selectMuseMspApprovalChoice(
      [choice('p', 'denied', 'localPersistent'), choice('s', 'denied', 'session')],
      'deny'
    )
    expect(picked?.scope).toBe('session')
  })

  it('tolerates a missing or non-array choice list', () => {
    expect(selectMuseMspApprovalChoice(undefined, 'deny')).toBeNull()
    expect(selectMuseMspApprovalChoice(null, 'allow')).toBeNull()
    expect(selectMuseMspApprovalChoice('nope' as never, 'deny')).toBeNull()
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
    const { child, warnings } = start()
    await driveToTurn(child)
    child.emit(approvalFrame())
    await flush()
    expect(child.sentMethod('approval/decide')?.params.choiceId).toBe('no')
    expect(warnings.some((w) => w.includes('no TaskWraith approval handler'))).toBe(true)
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
    const { child, warnings } = start({ onApprovalRequest })
    await driveToTurn(child)
    child.emit(approvalFrame({ availableChoices: [] }))
    await flush()
    expect(child.sentMethod('approval/decide')).toBeUndefined()
    expect(child.sentMethod('turn/cancel')).toBeDefined()
    expect(warnings.some((w) => w.includes('no usable choice'))).toBe(true)
  })
})

describe('runMuseMspTurn — schema-fidelity regressions', () => {
  it('treats an ABSENT delta field as text — the schema default', async () => {
    // `field` is not required and "absent means text". Dropping those deltas
    // while also suppressing the completed agentMessage lost the entire answer.
    const { child, events } = start()
    await driveToTurn(child)
    child.emit({
      jsonrpc: '2.0',
      method: 'item/delta',
      params: { sessionId: 'sess-1', itemId: 'i1', delta: 'Orange' }
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
    expect(events.filter((e) => e.type === 'content').map((e) => e.text)).toEqual(['Orange'])
  })

  it('renders an unhandled item kind generically from fallbackText', async () => {
    // Open enum: the schema requires unknown kinds to render generically
    // rather than vanish, and five KNOWN kinds reach the same arm.
    const { child, events } = start()
    await driveToTurn(child)
    child.emit({
      jsonrpc: '2.0',
      method: 'item/completed',
      params: {
        sessionId: 'sess-1',
        item: {
          itemId: 'sa1',
          kind: 'subagent',
          revision: 2,
          status: 'completed',
          fallbackText: 'reviewer finished in 12s'
        }
      }
    })
    expect(events.find((e) => String(e.text).includes('reviewer finished'))?.text).toBe(
      'subagent: reviewer finished in 12s'
    )
  })

  it('terminates on turn/unqueued, which is never followed by turn/completed', async () => {
    const { child, events } = start()
    await driveToTurn(child)
    child.emit({
      jsonrpc: '2.0',
      method: 'turn/unqueued',
      params: { sessionId: 'sess-1', turnId: 'turn-1', commandId: 'c1' }
    })
    expect(events.find((e) => e.type === 'terminal')).toMatchObject({ terminal: 'cancelled' })
    expect(child.killed.length).toBeGreaterThan(0)
  })

  it('carries the TurnError, not the display-only reason, to onClose', async () => {
    const onClose = vi.fn()
    const { child } = start({ onClose })
    await driveToTurn(child)
    child.emit({
      jsonrpc: '2.0',
      method: 'turn/completed',
      params: {
        sessionId: 'sess-1',
        turnId: 'turn-1',
        terminal: 'failed',
        reason: 'something went wrong',
        error: { kind: 'modelError', message: 'upstream 503', retryable: true }
      }
    })
    await flush()
    expect(onClose).toHaveBeenCalledWith(0, 'failed', {
      kind: 'modelError',
      message: 'upstream 503',
      retryable: true
    })
  })

  it('keeps per-call cache/reasoning counters out of the session totals', async () => {
    const onUsage = vi.fn()
    const { child } = start({ onUsage })
    await driveToTurn(child)
    child.emit({
      jsonrpc: '2.0',
      method: 'session/tokenUsage',
      params: {
        sessionId: 'sess-1',
        cumulative: { promptTokens: 100, outputTokens: 20, totalTokens: 120 },
        usage: { cachedTokens: 7, reasoningTokens: 3 }
      }
    })
    expect(onUsage).toHaveBeenCalledWith({
      inputTokens: 100,
      outputTokens: 20,
      totalTokens: 120,
      lastCallCachedTokens: 7,
      lastCallReasoningTokens: 3
    })
  })

  it('asks the host to exclude history on resume', async () => {
    const { child } = start({ resumeSessionId: 'stored-1' })
    await flush()
    child.emit({ jsonrpc: '2.0', id: 1, result: {} })
    await flush()
    expect(child.sentMethod('session/resume')?.params.excludeItems).toBe(true)
  })

  it('warns when the host serves a different MSP schema fingerprint', async () => {
    const { child, warnings } = start()
    await flush()
    child.emit({
      jsonrpc: '2.0',
      id: 1,
      result: { schema: { version: 1, fingerprint: 'sha256:deadbeef' } }
    })
    await flush()
    expect(warnings.some((w) => w.includes('sha256:deadbeef'))).toBe(true)
  })

  it('does NOT warn when the fingerprint matches', async () => {
    const { child, warnings } = start()
    await flush()
    child.emit({
      jsonrpc: '2.0',
      id: 1,
      result: { schema: { version: 1, fingerprint: MUSE_MSP_SCHEMA_FINGERPRINT } }
    })
    await flush()
    expect(warnings.some((w) => w.includes('MSP schema'))).toBe(false)
  })
})

describe('runMuseMspTurn — resume failures that are NOT "gone"', () => {
  const resumeError = (kind: string, code = -32031) => ({
    jsonrpc: '2.0',
    id: 2,
    error: { code, message: kind, data: { kind } }
  })

  it('does not fork the conversation when the session is held by another host', async () => {
    // Starting fresh here would silently abandon the user's Muse history.
    const { child } = start({ resumeSessionId: 'stored-1' })
    await flush()
    child.emit({ jsonrpc: '2.0', id: 1, result: {} })
    await flush()
    child.emit(resumeError('sessionInUse', -32021))
    await flush()
    expect(child.sentMethod('session/start')).toBeUndefined()
  })

  it('does not reset history on a RETRYABLE resume failure', async () => {
    for (const kind of ['overloaded', 'backpressured']) {
      const { child } = start({ resumeSessionId: 'stored-1' })
      await flush()
      child.emit({ jsonrpc: '2.0', id: 1, result: {} })
      await flush()
      child.emit(resumeError(kind))
      await flush()
      expect(child.sentMethod('session/start'), kind).toBeUndefined()
    }
  })

  it('still degrades to a fresh session when the stored one is genuinely gone', async () => {
    const { child } = start({ resumeSessionId: 'gone' })
    await flush()
    child.emit({ jsonrpc: '2.0', id: 1, result: {} })
    await flush()
    child.emit(resumeError('sessionNotFound', -32020))
    await flush()
    expect(child.sentMethod('session/start')).toBeDefined()
  })
})

describe('runMuseMspTurn — lifecycle hardening (review findings)', () => {
  it('settles when the host dies mid-resume, instead of hanging forever', async () => {
    // The close handler drains `pending` ONCE. start() issues session/start
    // after a failed resume, so a call registered post-drain never settled:
    // start() suspended, settleStartup never ran, onClose never fired and
    // `closed` never resolved — a wedged run on the default config.
    const onClose = vi.fn()
    const { child, handle } = start({ resumeSessionId: 'stored-1', onClose })
    await flush()
    child.emit({ jsonrpc: '2.0', id: 1, result: {} })
    await flush()
    child.finish(1)
    await handle.closed
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('delivers onClose exactly once even when the terminator re-emits close', async () => {
    // The fake child closes on kill, so start()'s failure path -> endProcess()
    // -> kill() -> close re-entry delivered onClose twice. A host maps onClose
    // to sendAgentCompatExit, so a double delivery double-seals the run.
    const onClose = vi.fn()
    const { child, handle } = start({ onClose })
    await flush()
    child.emit({
      jsonrpc: '2.0',
      id: 1,
      error: { code: -32603, message: 'boom', data: { kind: 'internal' } }
    })
    await handle.closed
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('reports a failed steer once the transport is gone', async () => {
    const { child, handle } = start()
    await driveToTurn(child)
    child.finish(1)
    await handle.closed
    expect(handle.steer([{ type: 'text', text: 'too late' }])).toBe(false)
  })

  it('ignores a foreign turn terminal rather than tearing down our host', async () => {
    // A resumed session can carry a still-running prior turn.
    const { child, events } = start()
    await driveToTurn(child)
    child.emit({
      jsonrpc: '2.0',
      method: 'turn/completed',
      params: { sessionId: 'sess-1', turnId: 'someone-elses-turn', terminal: 'completed' }
    })
    expect(events.filter((e) => e.type === 'terminal')).toHaveLength(0)
    expect(child.killed).toHaveLength(0)
  })
})

describe('runMuseMspTurn — approvals that arrive malformed or get rejected', () => {
  const base = {
    approvalId: 'ap-2',
    sessionId: 'sess-1',
    turnId: 'turn-1',
    toolName: 'run_shell_command',
    rawArgs: '{}',
    subject: { kind: 'shell' },
    currentRequirementId: { approvalId: 'ap-2', sourceIndex: 0 }
  }

  it('cancels rather than throwing when availableChoices is missing or not an array', async () => {
    // This used to throw inside a bare `void decideApproval(...)`, becoming an
    // unhandled rejection: no decision, no cancel, no warning.
    for (const availableChoices of [undefined, null, 'nope', {}]) {
      const { child, warnings } = start({ onApprovalRequest: vi.fn().mockResolvedValue('deny') })
      await driveToTurn(child)
      child.emit({
        jsonrpc: '2.0',
        method: 'approval/requested',
        params: { ...base, availableChoices }
      })
      await flush()
      expect(child.sentMethod('turn/cancel'), String(availableChoices)).toBeDefined()
      expect(warnings.some((w) => w.includes('no usable choice'))).toBe(true)
    }
  })

  it('retries ONCE with the refreshed CAS token when the requirement went stale', async () => {
    const { child } = start({ onApprovalRequest: vi.fn().mockResolvedValue('deny') })
    await driveToTurn(child)
    child.emit({
      jsonrpc: '2.0',
      method: 'approval/requested',
      params: {
        ...base,
        availableChoices: [{ choiceId: 'no', decision: 'denied', label: 'Deny', scope: 'once' }]
      }
    })
    await flush()
    child.emit({
      jsonrpc: '2.0',
      method: 'approval/updated',
      params: { approvalId: 'ap-2', currentRequirementId: { approvalId: 'ap-2', sourceIndex: 5 } }
    })
    const first = child.sent().find((f) => f.method === 'approval/decide')
    child.emit({
      jsonrpc: '2.0',
      id: first!.id,
      error: { code: -32053, message: 'stale', data: { kind: 'approvalRequirementStale' } }
    })
    await flush()
    const decides = child.sent().filter((f) => f.method === 'approval/decide')
    expect(decides).toHaveLength(2)
    expect(decides[1].params.requirementId).toEqual({ approvalId: 'ap-2', sourceIndex: 5 })
    expect(child.sentMethod('turn/cancel')).toBeUndefined()
  })

  it('cancels the turn when a decision is rejected for any other reason', async () => {
    // A REJECTED decide is not a sent decision; leaving it there gates the
    // tool call forever.
    const { child, warnings } = start({ onApprovalRequest: vi.fn().mockResolvedValue('deny') })
    await driveToTurn(child)
    child.emit({
      jsonrpc: '2.0',
      method: 'approval/requested',
      params: {
        ...base,
        availableChoices: [{ choiceId: 'no', decision: 'denied', label: 'Deny', scope: 'once' }]
      }
    })
    await flush()
    const decide = child.sent().find((f) => f.method === 'approval/decide')
    child.emit({
      jsonrpc: '2.0',
      id: decide!.id,
      error: { code: -32052, message: 'bad choice', data: { kind: 'approvalChoiceInvalid' } }
    })
    await flush()
    expect(child.sentMethod('turn/cancel')).toBeDefined()
    expect(warnings.some((w) => w.includes('cancelling the turn'))).toBe(true)
  })

  it('treats an already-resolved approval as settled, not as a failure', async () => {
    const { child } = start({ onApprovalRequest: vi.fn().mockResolvedValue('deny') })
    await driveToTurn(child)
    child.emit({
      jsonrpc: '2.0',
      method: 'approval/requested',
      params: {
        ...base,
        availableChoices: [{ choiceId: 'no', decision: 'denied', label: 'Deny', scope: 'once' }]
      }
    })
    await flush()
    const decide = child.sent().find((f) => f.method === 'approval/decide')
    child.emit({
      jsonrpc: '2.0',
      id: decide!.id,
      error: { code: -32051, message: 'gone', data: { kind: 'approvalAlreadyResolved' } }
    })
    await flush()
    expect(child.sentMethod('turn/cancel')).toBeUndefined()
  })
})

describe('runMuseMspTurn — userInput prompts', () => {
  const userInputFrame = (asRequest = false) => ({
    jsonrpc: '2.0',
    ...(asRequest ? { id: 'srv-ui' } : {}),
    method: asRequest ? 'userInput/request' : 'userInput/requested',
    params: {
      userInputId: 'ui-1',
      sessionId: 'sess-1',
      turnId: 'turn-1',
      itemId: 'i9',
      toolCallId: 'call_1',
      toolName: 'ask_user',
      questions: [{ questionId: 'q1', prompt: 'which file?' }]
    }
  })

  it('CANCELS an unanswered prompt instead of letting the turn hang', async () => {
    // autoResolutionMs is optional, so with no handler and no cancel the gated
    // tool call blocks and turn/completed never arrives.
    const { child, warnings } = start()
    await driveToTurn(child)
    child.emit(userInputFrame())
    await flush()
    expect(child.sentMethod('userInput/cancel')?.params).toMatchObject({
      sessionId: 'sess-1',
      userInputId: 'ui-1'
    })
    expect(warnings.some((w) => w.includes('no handler attached'))).toBe(true)
  })

  it('settles a prompt delivered as a server-to-client REQUEST', async () => {
    const { child } = start()
    await driveToTurn(child)
    child.emit(userInputFrame(true))
    await flush()
    expect(child.sent().find((f) => f.id === 'srv-ui')?.result).toEqual({})
    expect(child.sentMethod('userInput/cancel')).toBeDefined()
  })

  it('cancels exactly once even if the prompt is redelivered', async () => {
    const { child } = start()
    await driveToTurn(child)
    child.emit(userInputFrame())
    child.emit(userInputFrame())
    await flush()
    expect(child.sent().filter((f) => f.method === 'userInput/cancel')).toHaveLength(1)
  })
})

describe('runMuseMspTurn — approvals re-issued after resume', () => {
  it('decides an approval delivered as a server-to-client REQUEST', async () => {
    // After session/resume the host re-issues pending approvals as REQUESTS.
    // Answering -32601 left them undecided and hung the resumed turn.
    const onApprovalRequest = vi.fn().mockResolvedValue('deny')
    const { child } = start({ onApprovalRequest })
    await driveToTurn(child)
    child.emit({
      jsonrpc: '2.0',
      id: 'srv-ap',
      method: 'approval/request',
      params: {
        approvalId: 'ap-9',
        sessionId: 'sess-1',
        turnId: 'turn-1',
        toolName: 'write_file',
        rawArgs: '{}',
        subject: { kind: 'fileAccess' },
        currentRequirementId: { approvalId: 'ap-9', sourceIndex: 0 },
        availableChoices: [{ choiceId: 'no', decision: 'denied', label: 'Deny', scope: 'once' }]
      }
    })
    await flush()
    expect(child.sent().find((f) => f.id === 'srv-ap')?.result).toEqual({})
    expect(child.sentMethod('approval/decide')?.params).toMatchObject({ approvalId: 'ap-9' })
  })

  it('prunes the requirement map when an approval resolves elsewhere', async () => {
    // Policy, the LLM judge, or another client can settle it; the CAS entry
    // must not leak, or a later decide echoes a dead requirement.
    const onApprovalRequest = vi.fn().mockResolvedValue('deny')
    const { child } = start({ onApprovalRequest })
    await driveToTurn(child)
    child.emit({
      jsonrpc: '2.0',
      method: 'approval/resolved',
      params: { approvalId: 'ap-1', sessionId: 'sess-1', decision: 'approved' }
    })
    await flush()
    expect(child.sentMethod('approval/decide')).toBeUndefined()
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

  it('acknowledges an unknown inbound REQUEST so the peer cannot wedge', async () => {
    const { child } = start()
    await driveToTurn(child)
    child.emit({ jsonrpc: '2.0', id: 'srv-1', method: 'someday/newThing', params: {} })
    const reply = child.sent().find((f) => f.id === 'srv-1')
    expect(reply).toBeDefined()
    expect(reply?.result).toEqual({})
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
    expect(onClose).toHaveBeenCalledTimes(1)
    expect(onClose).toHaveBeenCalledWith(0, 'failed', null)
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
    const { child, warnings, handle } = start()
    await flush()
    child.finish(1)
    await handle.closed
    expect(warnings.some((w) => w.includes('did not complete'))).toBe(true)
  })
})
