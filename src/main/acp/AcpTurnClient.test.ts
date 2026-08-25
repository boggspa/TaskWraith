import { describe, it, expect, vi } from 'vitest'
import { runAcpTurn, type AcpChildProcess, type AcpTurnOptions } from './AcpTurnClient'
import type { AcpPermissionRequest, AcpRunEvent } from './AcpProtocol'

class FakeAcpChild implements AcpChildProcess {
  writes: string[] = []
  killed = false
  autoCloseOnKill = true
  private dataListeners: ((chunk: string) => void)[] = []
  private closeListener?: (code: number | null) => void
  private errorListener?: (err: Error) => void

  stdinEnded = false
  stdin = {
    write: (data: string, cb?: (err?: Error | null) => void): void => {
      this.writes.push(data)
      cb?.(null)
    },
    on: (_event: 'error', _listener: (err: Error) => void): void => {},
    // A Kimi-style server exits on stdin EOF (NOT on SIGINT); model that.
    end: (): void => {
      this.stdinEnded = true
      this.closeListener?.(0)
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

  /** Emit on the provider's stderr channel (its tracing log, not tool stdout). */
  errorOutput(text: string): void {
    this.stderrListeners.forEach((cb) => cb(text))
  }

  on(event: 'error' | 'close', listener: (arg: never) => void): void {
    if (event === 'close') this.closeListener = listener as (code: number | null) => void
    else this.errorListener = listener as (err: Error) => void
  }
  kill(_signal?: string): void {
    this.killed = true
    if (this.autoCloseOnKill) this.closeListener?.(0)
  }
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
  finish(code: number | null): void {
    this.closeListener?.(code)
  }
}

const baseOptions = (
  child: FakeAcpChild,
  overrides: Partial<AcpTurnOptions> = {}
): { events: AcpRunEvent[]; handle: ReturnType<typeof runAcpTurn> } => {
  const events: AcpRunEvent[] = []
  const handle = runAcpTurn({
    prompt: 'hi',
    cwdLifetime: overrides.cwdLifetime ?? (overrides.resumeSessionId ? 'session' : 'run'),
    cwd: '/tmp/ws',
    spawnProcess: () => child,
    initializeParams: {
      protocolVersion: 1,
      clientCapabilities: { fs: { readTextFile: true, writeTextFile: true } }
    },
    onEvent: (e) => events.push(e),
    ...overrides
  })
  return { events, handle }
}

describe('runAcpTurn — neutral core', () => {
  it('keeps closed pending through real child close and async terminal cleanup', async () => {
    const child = new FakeAcpChild()
    child.autoCloseOnKill = false
    let releaseCleanup!: () => void
    let cleanupStarted = false
    const cleanup = new Promise<void>((resolve) => {
      releaseCleanup = resolve
    })
    const { handle } = baseOptions(child, {
      onClose: async () => {
        cleanupStarted = true
        await cleanup
      }
    })
    let closeSettled = false
    void handle.closed.then(() => {
      closeSettled = true
    })

    handle.cancel()
    await Promise.resolve()
    expect(child.killed).toBe(true)
    expect(cleanupStarted).toBe(false)
    expect(closeSettled).toBe(false)

    child.finish(0)
    await Promise.resolve()
    await Promise.resolve()
    expect(cleanupStarted).toBe(true)
    expect(closeSettled).toBe(false)

    releaseCleanup()
    await handle.closed
    expect(closeSettled).toBe(true)
  })

  it('sends the caller-supplied initialize capabilities verbatim', () => {
    const child = new FakeAcpChild()
    baseOptions(child)
    expect(child.sent()[0]).toMatchObject({
      id: 1,
      method: 'initialize',
      params: { clientCapabilities: { fs: { readTextFile: true, writeTextFile: true } } }
    })
  })

  it('waits for async spawn authority before sending initialize', async () => {
    const child = new FakeAcpChild()
    let releaseAuthority: (() => void) | undefined
    baseOptions(child, {
      beforeInitialize: () =>
        new Promise<void>((resolve) => {
          releaseAuthority = resolve
        })
    })

    expect(child.sent()).toEqual([])
    releaseAuthority?.()
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(child.sent()).toHaveLength(1)
    expect(child.sent()[0]).toMatchObject({ id: 1, method: 'initialize' })
  })

  it('keeps closed pending when cancellation overtakes beforeInitialize', async () => {
    const child = new FakeAcpChild()
    child.autoCloseOnKill = false
    let releaseStartup!: () => void
    const startup = new Promise<void>((resolve) => {
      releaseStartup = resolve
    })
    const closes: Array<number | null> = []
    const { handle } = baseOptions(child, {
      beforeInitialize: () => startup,
      onClose: (code) => {
        closes.push(code)
      }
    })
    let closeSettled = false
    void handle.closed.then(() => {
      closeSettled = true
    })

    handle.cancel()
    child.finish(0)
    await Promise.resolve()
    await Promise.resolve()
    expect(child.killed).toBe(true)
    expect(closes).toEqual([])
    expect(closeSettled).toBe(false)

    releaseStartup()
    await handle.closed
    expect(closes).toEqual([0])
    expect(closeSettled).toBe(true)
    expect(child.sent()).toEqual([])
  })

  it('contains a throwing onProcess hook and waits for explicit child close', async () => {
    const child = new FakeAcpChild()
    child.autoCloseOnKill = false
    const closes: Array<number | null> = []
    const { events, handle } = baseOptions(child, {
      onProcess: () => {
        throw new Error('injected host registration failure')
      },
      onClose: (code) => {
        closes.push(code)
      }
    })
    let closeSettled = false
    void handle.closed.then(() => {
      closeSettled = true
    })

    expect(child.killed).toBe(true)
    expect(child.sent()).toEqual([])
    expect(closes).toEqual([])
    expect(closeSettled).toBe(false)
    expect(events).toContainEqual({
      type: 'provider_warning',
      text: 'ACP provider process registration failed; the process was stopped before initialization.'
    })

    child.finish(0)
    await handle.closed
    expect(closes).toEqual([1])
    expect(closeSettled).toBe(true)
  })

  it('stops the provider without initializing when async spawn authority fails', async () => {
    const child = new FakeAcpChild()
    const closes: Array<number | null> = []
    const { events } = baseOptions(child, {
      beforeInitialize: async () => {
        throw new Error('private authority failure')
      },
      endProcess: (providerChild) => providerChild.stdin?.end?.(),
      onClose: (code) => {
        closes.push(code)
      }
    })

    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(child.sent()).toEqual([])
    expect(child.stdinEnded).toBe(true)
    expect(closes).toEqual([0])
    expect(events).toContainEqual({
      type: 'provider_warning',
      text: 'ACP provider startup authority could not be committed; the process was stopped.'
    })
    expect(JSON.stringify(events)).not.toContain('private authority failure')
  })

  it('rejects native resume before spawn when the provider cwd is run-scoped', () => {
    const child = new FakeAcpChild()
    expect(() =>
      baseOptions(child, {
        resumeSessionId: 'session-existing',
        cwdLifetime: 'run'
      })
    ).toThrow('session/resume requires a session-scoped cwd')
    expect(child.sent()).toEqual([])
  })

  it('resumes an advertised native session before sending the prompt', () => {
    const child = new FakeAcpChild()
    const ready: Array<{ sessionId: string; resumed: boolean; fallbackFromResume: boolean }> = []
    baseOptions(child, {
      prompt: 'slim follow-up',
      resumeSessionId: 'session-existing',
      resumeFallbackPrompt: 'full cold-start context',
      onSessionReady: (session) => ready.push(session)
    })
    child.emit({
      jsonrpc: '2.0',
      id: 1,
      result: {
        protocolVersion: 1,
        agentCapabilities: { sessionCapabilities: { resume: {} } }
      }
    })
    expect(child.sent()[1]).toMatchObject({
      id: 4,
      method: 'session/resume',
      params: { sessionId: 'session-existing', cwd: '/tmp/ws', mcpServers: [] }
    })
    child.emit({ jsonrpc: '2.0', id: 4, result: {} })
    expect(child.sent()[2]).toMatchObject({
      id: 3,
      method: 'session/prompt',
      params: { sessionId: 'session-existing', prompt: [{ type: 'text', text: 'slim follow-up' }] }
    })
    expect(ready).toEqual([
      { sessionId: 'session-existing', resumed: true, fallbackFromResume: false }
    ])
  })

  it('falls back to a fresh session when the resumed session fails surface confirmation', async () => {
    // Observed live (ChipTown chat 75d1d780, Kimi 0.29.2): a natively resumed
    // session can come up without the per-run gateway MCP tools while every
    // native tool is deny-walled — a seat with zero usable tools. When the
    // caller's surface check says the resumed session is dark, mint a fresh
    // session with the cold-start prompt instead of prompting into it.
    const child = new FakeAcpChild()
    const ready: Array<{ sessionId: string; resumed: boolean; fallbackFromResume: boolean }> = []
    const { events } = baseOptions(child, {
      prompt: 'slim follow-up',
      resumeSessionId: 'session-existing',
      resumeFallbackPrompt: 'full cold-start context',
      confirmResumedSession: async () => false,
      onSessionReady: (session) => ready.push(session)
    })
    child.emit({
      jsonrpc: '2.0',
      id: 1,
      result: { agentCapabilities: { sessionCapabilities: { resume: {} } } }
    })
    child.emit({ jsonrpc: '2.0', id: 4, result: {} })
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(child.sent()[2]).toMatchObject({ id: 2, method: 'session/new' })
    child.emit({ jsonrpc: '2.0', id: 2, result: { sessionId: 'session-fresh' } })
    expect(child.sent()[3]).toMatchObject({
      id: 3,
      method: 'session/prompt',
      params: {
        sessionId: 'session-fresh',
        prompt: [{ type: 'text', text: 'full cold-start context' }]
      }
    })
    expect(ready).toEqual([
      { sessionId: 'session-fresh', resumed: false, fallbackFromResume: true }
    ])
    expect(events).toContainEqual({
      type: 'provider_warning',
      text: 'ACP resumed session did not confirm its tool surface; starting a fresh session with the cold-start prompt.'
    })
  })

  it('keeps a resumed session when surface confirmation passes', async () => {
    const child = new FakeAcpChild()
    const ready: Array<{ sessionId: string; resumed: boolean; fallbackFromResume: boolean }> = []
    baseOptions(child, {
      prompt: 'slim follow-up',
      resumeSessionId: 'session-existing',
      resumeFallbackPrompt: 'full cold-start context',
      confirmResumedSession: async () => true,
      onSessionReady: (session) => ready.push(session)
    })
    child.emit({
      jsonrpc: '2.0',
      id: 1,
      result: { agentCapabilities: { sessionCapabilities: { resume: {} } } }
    })
    child.emit({ jsonrpc: '2.0', id: 4, result: {} })
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(child.sent()[2]).toMatchObject({
      id: 3,
      method: 'session/prompt',
      params: {
        sessionId: 'session-existing',
        prompt: [{ type: 'text', text: 'slim follow-up' }]
      }
    })
    expect(ready).toEqual([
      { sessionId: 'session-existing', resumed: true, fallbackFromResume: false }
    ])
  })

  it('keeps a resumed session when the surface confirmation itself fails', async () => {
    // Fail open: a broken probe must not cost a healthy session its history.
    const child = new FakeAcpChild()
    baseOptions(child, {
      prompt: 'slim follow-up',
      resumeSessionId: 'session-existing',
      resumeFallbackPrompt: 'full cold-start context',
      confirmResumedSession: async () => {
        throw new Error('probe died')
      }
    })
    child.emit({
      jsonrpc: '2.0',
      id: 1,
      result: { agentCapabilities: { sessionCapabilities: { resume: {} } } }
    })
    child.emit({ jsonrpc: '2.0', id: 4, result: {} })
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(child.sent()[2]).toMatchObject({
      id: 3,
      method: 'session/prompt',
      params: { sessionId: 'session-existing' }
    })
  })

  it('re-asserts advertised model and thinking selections before a resumed prompt', () => {
    const child = new FakeAcpChild()
    baseOptions(child, {
      prompt: 'continue',
      resumeSessionId: 'session-existing',
      resumeConfigOptions: [
        { configId: 'model', value: 'kimi-code/kimi-for-coding' },
        { configId: 'thinking', value: 'on' }
      ]
    })
    child.emit({
      jsonrpc: '2.0',
      id: 1,
      result: { agentCapabilities: { sessionCapabilities: { resume: {} } } }
    })
    child.emit({
      jsonrpc: '2.0',
      id: 4,
      result: {
        configOptions: [
          {
            id: 'model',
            currentValue: 'kimi-code/k3',
            options: [
              { value: 'kimi-code/kimi-for-coding' },
              { value: 'kimi-code/k3' }
            ]
          },
          {
            id: 'thinking',
            currentValue: 'off',
            options: [{ value: 'off' }, { value: 'on' }]
          }
        ]
      }
    })
    expect(child.sent()[2]).toMatchObject({
      id: 1000,
      method: 'session/set_config_option',
      params: {
        sessionId: 'session-existing',
        configId: 'model',
        value: 'kimi-code/kimi-for-coding'
      }
    })
    child.emit({
      jsonrpc: '2.0',
      id: 1000,
      result: {
        configOptions: [
          {
            id: 'model',
            currentValue: 'kimi-code/kimi-for-coding',
            options: [{ value: 'kimi-code/kimi-for-coding' }]
          },
          {
            id: 'thinking',
            currentValue: 'off',
            options: [{ value: 'off' }, { value: 'on' }]
          }
        ]
      }
    })
    expect(child.sent()[3]).toMatchObject({
      id: 1001,
      method: 'session/set_config_option',
      params: { configId: 'thinking', value: 'on' }
    })
    child.emit({
      jsonrpc: '2.0',
      id: 1001,
      result: {
        configOptions: [
          { id: 'thinking', currentValue: 'on', options: [{ value: 'on' }] }
        ]
      }
    })
    expect(child.sent()[4]).toMatchObject({
      id: 3,
      method: 'session/prompt',
      params: { prompt: [{ type: 'text', text: 'continue' }] }
    })
  })

  it('continues a resumed turn when an optional session config update rejects', () => {
    const child = new FakeAcpChild()
    const { events } = baseOptions(child, {
      prompt: 'continue',
      resumeSessionId: 'session-existing',
      resumeConfigOptions: [{ configId: 'thinking', value: 'on' }]
    })
    child.emit({
      jsonrpc: '2.0',
      id: 1,
      result: { agentCapabilities: { sessionCapabilities: { resume: {} } } }
    })
    child.emit({
      jsonrpc: '2.0',
      id: 4,
      result: {
        configOptions: [
          {
            id: 'thinking',
            currentValue: 'off',
            options: [{ value: 'off' }, { value: 'on' }]
          }
        ]
      }
    })
    child.emit({
      jsonrpc: '2.0',
      id: 1000,
      error: { code: -32602, message: 'thinking is locked' }
    })

    expect(child.sent().at(-1)).toMatchObject({ id: 3, method: 'session/prompt' })
    expect(events).toContainEqual({
      type: 'provider_warning',
      text: 'ACP session config "thinking" was not applied: thinking is locked'
    })
  })

  it('falls back to session/new with the full prompt when resume rejects', () => {
    const child = new FakeAcpChild()
    const ready: Array<{ sessionId: string; resumed: boolean; fallbackFromResume: boolean }> = []
    baseOptions(child, {
      prompt: 'slim follow-up',
      resumeSessionId: 'session-missing',
      resumeFallbackPrompt: 'full cold-start context',
      onSessionReady: (session) => ready.push(session)
    })
    child.emit({
      jsonrpc: '2.0',
      id: 1,
      result: { agentCapabilities: { sessionCapabilities: { resume: {} } } }
    })
    child.emit({
      jsonrpc: '2.0',
      id: 4,
      error: { code: -32000, message: 'session not found' }
    })
    expect(child.sent()[2]).toMatchObject({ id: 2, method: 'session/new' })
    child.emit({ jsonrpc: '2.0', id: 2, result: { sessionId: 'session-new' } })
    expect(child.sent()[3]).toMatchObject({
      method: 'session/prompt',
      params: { sessionId: 'session-new', prompt: [{ type: 'text', text: 'full cold-start context' }] }
    })
    expect(ready).toEqual([
      { sessionId: 'session-new', resumed: false, fallbackFromResume: true }
    ])
  })

  it('uses the cold-start prompt when initialize does not advertise resume', () => {
    const child = new FakeAcpChild()
    baseOptions(child, {
      prompt: 'slim follow-up',
      resumeSessionId: 'session-old-agent',
      resumeFallbackPrompt: 'full cold-start context'
    })
    child.emit({ jsonrpc: '2.0', id: 1, result: { agentCapabilities: {} } })
    expect(child.sent()[1]).toMatchObject({ id: 2, method: 'session/new' })
    child.emit({ jsonrpc: '2.0', id: 2, result: { sessionId: 'session-new' } })
    expect(child.sent()[2]).toMatchObject({
      method: 'session/prompt',
      params: { prompt: [{ type: 'text', text: 'full cold-start context' }] }
    })
  })

  it('fails a resume-only maintenance turn instead of opening a fresh session', async () => {
    const child = new FakeAcpChild()
    baseOptions(child, {
      prompt: '/compact',
      resumeSessionId: 'session-existing',
      allowResumeFallback: false,
      endProcess: (c) => c.stdin?.end?.()
    })
    child.emit({
      jsonrpc: '2.0',
      id: 1,
      result: { agentCapabilities: { sessionCapabilities: { resume: {} } } }
    })
    child.emit({ jsonrpc: '2.0', id: 4, error: { code: -32000, message: 'missing' } })
    await new Promise((r) => setTimeout(r, 20))
    expect(child.sent().some((message) => message.method === 'session/new')).toBe(false)
    expect(child.stdinEnded).toBe(true)
  })

  it('routes an inbound fs request to onInboundRequest and replies with its result', () => {
    const child = new FakeAcpChild()
    const seen: string[] = []
    baseOptions(child, {
      onInboundRequest: (message, reply) => {
        if (message.method === 'fs/read_text_file') {
          seen.push(String((message.params as { path?: string })?.path))
          reply.respondResult({ content: 'FILE-BODY' })
          return true
        }
        return false
      }
    })
    child.emit({ jsonrpc: '2.0', id: 1, result: {} })
    child.emit({ jsonrpc: '2.0', id: 2, result: { sessionId: 's-1' } })
    child.emit({
      jsonrpc: '2.0',
      id: 55,
      method: 'fs/read_text_file',
      params: { sessionId: 's-1', path: '/tmp/ws/a.txt' }
    })

    expect(seen).toEqual(['/tmp/ws/a.txt'])
    const response = child.sent().find((m) => m.id === 55)
    expect(response).toMatchObject({ id: 55, result: { content: 'FILE-BODY' } })
  })

  it('falls through to method-not-found when the hook declines (returns false)', () => {
    const child = new FakeAcpChild()
    baseOptions(child, { onInboundRequest: () => false })
    child.emit({ jsonrpc: '2.0', id: 1, result: {} })
    child.emit({ jsonrpc: '2.0', id: 2, result: { sessionId: 's-1' } })
    child.emit({ jsonrpc: '2.0', id: 77, method: 'terminal/create', params: {} })

    const response = child.sent().find((m) => m.id === 77)
    expect(response).toMatchObject({ id: 77, error: { code: -32601 } })
    expect(response && 'result' in response).toBe(false)
  })

  it('answers method-not-found when no hook is attached at all', () => {
    const child = new FakeAcpChild()
    baseOptions(child)
    child.emit({ jsonrpc: '2.0', id: 1, result: {} })
    child.emit({ jsonrpc: '2.0', id: 2, result: { sessionId: 's-1' } })
    child.emit({ jsonrpc: '2.0', id: 88, method: 'fs/read_text_file', params: {} })
    expect(child.sent().find((m) => m.id === 88)).toMatchObject({ error: { code: -32601 } })
  })

  it('default-denies a permission request with no handler (never allows)', async () => {
    const child = new FakeAcpChild()
    baseOptions(child)
    child.emit({ jsonrpc: '2.0', id: 1, result: {} })
    child.emit({ jsonrpc: '2.0', id: 2, result: { sessionId: 's-1' } })
    child.emit({
      jsonrpc: '2.0',
      id: 9,
      method: 'session/request_permission',
      params: {
        sessionId: 's-1',
        toolCall: { title: 'Write', kind: 'edit' },
        options: [
          { optionId: 'a', name: 'Allow', kind: 'allow_once' },
          { optionId: 'r', name: 'Reject', kind: 'reject_once' }
        ]
      }
    })
    await new Promise((r) => setTimeout(r, 0))
    expect(child.sent().find((m) => m.id === 9)).toMatchObject({
      result: { outcome: { outcome: 'selected', optionId: 'r' } }
    })
  })

  it('correlates exact ToolCall input into the matching permission request once', async () => {
    const child = new FakeAcpChild()
    const requests: AcpPermissionRequest[] = []
    baseOptions(child, {
      onPermissionRequest: (request) => {
        requests.push(request)
        return 'allow'
      }
    })
    child.emit({ jsonrpc: '2.0', id: 1, result: {} })
    child.emit({ jsonrpc: '2.0', id: 2, result: { sessionId: 's-1' } })
    child.emit({
      jsonrpc: '2.0',
      method: 'session/update',
      params: {
        sessionId: 's-1',
        update: {
          sessionUpdate: 'tool_call',
          toolCallId: 'mesh-call-1',
          title: 'mcp__taskwraith__mesh_topology_edit',
          kind: 'execute',
          rawInput: {
            sceneId: 'scene-a',
            expectedRevision: 2,
            operations: [{ operation: 'sculpt', mode: 'inflate', strength: 0.02 }]
          }
        }
      }
    })
    const permissionRequest = () => ({
      jsonrpc: '2.0',
      id: 9,
      method: 'session/request_permission',
      params: {
        sessionId: 's-1',
        toolCall: {
          toolCallId: 'mesh-call-1',
          title: 'mcp__taskwraith__mesh_topology_edit',
          kind: 'execute'
        },
        options: [{ optionId: 'a', name: 'Allow', kind: 'allow_once' }]
      }
    })
    child.emit(permissionRequest())
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(requests[0]?.rawToolCall).toMatchObject({
      toolCallId: 'mesh-call-1',
      rawInput: {
        sceneId: 'scene-a',
        expectedRevision: 2,
        operations: [{ operation: 'sculpt', mode: 'inflate', strength: 0.02 }]
      }
    })

    child.emit({ ...permissionRequest(), id: 10 })
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(requests[1]?.rawToolCall).not.toHaveProperty('rawInput')
  })

  it('correlates metadata-only tool_call_update evidence into a sparse permission request', async () => {
    const child = new FakeAcpChild()
    const requests: AcpPermissionRequest[] = []
    baseOptions(child, {
      onPermissionRequest: (request) => {
        requests.push(request)
        return 'deny'
      }
    })
    child.emit({ jsonrpc: '2.0', id: 1, result: {} })
    child.emit({ jsonrpc: '2.0', id: 2, result: { sessionId: 's-1' } })
    child.emit({
      jsonrpc: '2.0',
      method: 'session/update',
      params: {
        sessionId: 's-1',
        update: {
          sessionUpdate: 'tool_call_update',
          toolCallId: 'vibe-write-1',
          kind: 'other',
          status: 'in_progress',
          _meta: { tool_name: 'TaskWraith_write_file', effect_kind: 'tool' }
        }
      }
    })
    child.emit({
      jsonrpc: '2.0',
      id: 9,
      method: 'session/request_permission',
      params: {
        sessionId: 's-1',
        toolCall: { toolCallId: 'vibe-write-1' },
        options: [{ optionId: 'r', name: 'Reject', kind: 'reject_once' }]
      }
    })
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(requests).toHaveLength(1)
    expect(requests[0]?.rawToolCall).toMatchObject({
      toolCallId: 'vibe-write-1',
      kind: 'other',
      status: 'in_progress',
      _meta: { tool_name: 'TaskWraith_write_file', effect_kind: 'tool' }
    })
    expect(requests[0]?.rawToolCall).not.toHaveProperty('rawInput')
  })

  it('fails closed on conflicting metadata across updates or the permission fragment', async () => {
    const child = new FakeAcpChild()
    const requests: AcpPermissionRequest[] = []
    baseOptions(child, {
      onPermissionRequest: (request) => {
        requests.push(request)
        return 'deny'
      }
    })
    child.emit({ jsonrpc: '2.0', id: 1, result: {} })
    child.emit({ jsonrpc: '2.0', id: 2, result: { sessionId: 's-1' } })
    const toolUpdate = (toolCallId: string, toolName: string) => ({
      jsonrpc: '2.0',
      method: 'session/update',
      params: {
        sessionId: 's-1',
        update: {
          sessionUpdate: 'tool_call_update',
          toolCallId,
          kind: 'other',
          _meta: { tool_name: toolName, effect_kind: 'tool' }
        }
      }
    })
    const permissionRequest = (
      id: number,
      toolCallId: string,
      metadata?: Record<string, unknown>
    ) => ({
      jsonrpc: '2.0',
      id,
      method: 'session/request_permission',
      params: {
        sessionId: 's-1',
        toolCall: {
          toolCallId,
          ...(metadata ? { _meta: metadata } : {})
        },
        options: [{ optionId: 'r', name: 'Reject', kind: 'reject_once' }]
      }
    })

    child.emit(toolUpdate('update-conflict', 'TaskWraith_write_file'))
    child.emit(toolUpdate('update-conflict', 'OtherBroker_write_file'))
    child.emit(permissionRequest(9, 'update-conflict'))
    child.emit(toolUpdate('permission-conflict', 'TaskWraith_write_file'))
    child.emit(
      permissionRequest(10, 'permission-conflict', {
        tool_name: 'OtherBroker_write_file',
        effect_kind: 'tool'
      })
    )
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(requests).toHaveLength(2)
    expect(requests[0]?.rawToolCall).toEqual({ toolCallId: 'update-conflict' })
    expect(requests[1]?.rawToolCall).toEqual({
      toolCallId: 'permission-conflict',
      _meta: { tool_name: 'OtherBroker_write_file', effect_kind: 'tool' }
    })
  })

  it('does not correlate ToolCall input across a tool-call id or session boundary', async () => {
    const child = new FakeAcpChild()
    const rawToolCalls: Array<Record<string, unknown> | null> = []
    baseOptions(child, {
      onPermissionRequest: (request) => {
        rawToolCalls.push(request.rawToolCall)
        return 'deny'
      }
    })
    child.emit({ jsonrpc: '2.0', id: 1, result: {} })
    child.emit({ jsonrpc: '2.0', id: 2, result: { sessionId: 's-1' } })
    child.emit({
      jsonrpc: '2.0',
      method: 'session/update',
      params: {
        sessionId: 's-1',
        update: {
          sessionUpdate: 'tool_call',
          toolCallId: 'mesh-call-1',
          rawInput: { sceneId: 'scene-a' }
        }
      }
    })
    child.emit({
      jsonrpc: '2.0',
      id: 9,
      method: 'session/request_permission',
      params: {
        sessionId: 's-2',
        toolCall: { toolCallId: 'mesh-call-1', title: 'mesh_topology_edit' },
        options: [{ optionId: 'r', name: 'Reject', kind: 'reject_once' }]
      }
    })
    child.emit({
      jsonrpc: '2.0',
      id: 10,
      method: 'session/request_permission',
      params: {
        sessionId: 's-1',
        toolCall: { toolCallId: 'mesh-call-2', title: 'mesh_topology_edit' },
        options: [{ optionId: 'r', name: 'Reject', kind: 'reject_once' }]
      }
    })
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(rawToolCalls).toHaveLength(2)
    expect(rawToolCalls[0]).not.toHaveProperty('rawInput')
    expect(rawToolCalls[1]).not.toHaveProperty('rawInput')
  })

  it('skips denied-tool recovery when the hook is null (Kimi posture)', async () => {
    const child = new FakeAcpChild()
    const { events } = baseOptions(child, {
      deniedToolRecovery: null,
      onPermissionRequest: () => 'deny'
    })
    child.emit({ jsonrpc: '2.0', id: 1, result: {} })
    child.emit({ jsonrpc: '2.0', id: 2, result: { sessionId: 's-1' } })
    child.emit({
      jsonrpc: '2.0',
      id: 42,
      method: 'session/request_permission',
      params: {
        sessionId: 's-1',
        toolCall: { title: 'Bash', kind: 'execute' },
        options: [{ optionId: 'r', name: 'Reject', kind: 'reject_once' }]
      }
    })
    await new Promise((r) => setTimeout(r, 0))
    // A cancelled terminal must simply END the turn — no second prompt.
    child.emit({ jsonrpc: '2.0', id: 3, result: { stopReason: 'cancelled' } })
    await new Promise((r) => setTimeout(r, 40))
    expect(child.sent().filter((m) => m.method === 'session/prompt')).toHaveLength(1)
    expect(child.killed).toBe(true)
    expect(events.some((e) => e.type === 'result')).toBe(false)
  })

  it('recovers once from a failed tool terminal even without a permission request', async () => {
    const child = new FakeAcpChild()
    const contexts: Array<{ tool?: string | null; output?: string | null }> = []
    baseOptions(child, {
      deniedToolRecovery: {
        detect: () => false,
        shouldRecover: (context) => {
          contexts.push({
            tool: context.lastFailedToolName,
            output: context.lastFailedToolOutput
          })
          return context.toolFailureSeen && !context.assistantTextSeen
        },
        prompt: (context) => `Continue after ${context.lastFailedToolName || 'tool'} failed.`,
        warning: 'Continuing after a failed tool.'
      }
    })
    child.emit({ jsonrpc: '2.0', id: 1, result: {} })
    child.emit({ jsonrpc: '2.0', id: 2, result: { sessionId: 's-1' } })
    child.emit({
      jsonrpc: '2.0',
      method: 'session/update',
      params: {
        sessionId: 's-1',
        update: {
          sessionUpdate: 'tool_call',
          toolCallId: 'tool-1',
          title: 'read_file',
          kind: 'read'
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
          toolCallId: 'tool-1',
          status: 'failed',
          content: [{ type: 'content', content: { type: 'text', text: 'permission denied' } }]
        }
      }
    })
    child.emit({ jsonrpc: '2.0', id: 3, result: { stopReason: 'end_turn' } })
    await new Promise((resolve) => setTimeout(resolve, 40))

    expect(contexts).toEqual([{ tool: 'read_file', output: 'permission denied' }])
    const prompts = child.sent().filter((message) => message.method === 'session/prompt')
    expect(prompts).toHaveLength(2)
    expect(JSON.stringify(prompts[1])).toContain('Continue after read_file failed.')

    child.emit({ jsonrpc: '2.0', id: 5, result: { stopReason: 'end_turn' } })
    await new Promise((resolve) => setTimeout(resolve, 40))
    expect(child.killed).toBe(true)
  })

  it('terminates via the endProcess hook (stdin EOF) instead of SIGINT', async () => {
    const child = new FakeAcpChild()
    const { events } = baseOptions(child, {
      // Kimi terminator: close stdin, never SIGINT.
      endProcess: (c) => c.stdin?.end?.()
    })
    void events
    child.emit({ jsonrpc: '2.0', id: 1, result: {} })
    child.emit({ jsonrpc: '2.0', id: 2, result: { sessionId: 's-1' } })
    child.emit({ jsonrpc: '2.0', id: 3, result: { stopReason: 'end_turn' } })
    await new Promise((r) => setTimeout(r, 40))
    // Terminated by stdin EOF, and the process was NOT SIGINT-killed.
    expect(child.stdinEnded).toBe(true)
    expect(child.killed).toBe(false)
  })

  it('force-kills as a backstop when the terminator never produces a close', async () => {
    const child = new FakeAcpChild()
    // A server that ignores BOTH stdin end and the default kill (no close fires).
    child.stdin.end = (): void => {
      /* swallow: model a server that ignores stdin EOF */
    }
    const originalKill = child.kill.bind(child)
    let sigkilled = false
    child.kill = (signal?: string): void => {
      if (signal === 'SIGKILL') {
        sigkilled = true
        originalKill('SIGKILL')
      }
      // ignore non-SIGKILL signals (Kimi ignores SIGINT/SIGTERM)
    }
    baseOptions(child, { endProcess: (c) => c.stdin?.end?.(), endProcessGraceMs: 20 })
    child.emit({ jsonrpc: '2.0', id: 1, result: {} })
    child.emit({ jsonrpc: '2.0', id: 2, result: { sessionId: 's-1' } })
    child.emit({ jsonrpc: '2.0', id: 3, result: { stopReason: 'end_turn' } })
    await new Promise((r) => setTimeout(r, 80))
    expect(sigkilled).toBe(true)
  })

  it('terminates a lifecycle error via endProcess (stdin EOF), not a bare SIGINT', async () => {
    const child = new FakeAcpChild()
    const closes: Array<{
      code: number | null
      turnComplete: boolean
      terminalStatus?: string
    }> = []
    const { events } = baseOptions(child, {
      endProcess: (c) => c.stdin?.end?.(),
      onClose: (code, turnComplete, terminalStatus) => {
        closes.push({ code, turnComplete, terminalStatus })
      }
    })
    // session/new returns a JSON-RPC error → the turn must fail-close by
    // terminating the process the provider's way, so a Kimi child (ignores
    // SIGINT) still exits and onClose runs.
    child.emit({ jsonrpc: '2.0', id: 1, result: { protocolVersion: 1 } })
    child.emit({ jsonrpc: '2.0', id: 2, error: { code: -32602, message: 'bad params' } })
    await new Promise((r) => setTimeout(r, 20))
    expect(child.stdinEnded).toBe(true)
    expect(child.killed).toBe(false)
    expect(events).toContainEqual({
      type: 'provider_warning',
      text: 'ACP session/new failed: bad params'
    })
    expect(closes).toEqual([
      { code: 0, turnComplete: false, terminalStatus: 'rpc_error:session/new' }
    ])
  })

  it('retries a transient upstream prompt failure on the same session', async () => {
    const child = new FakeAcpChild()
    const closes: Array<{ turnComplete: boolean; terminalStatus?: string }> = []
    const { events } = baseOptions(child, {
      transientPromptRetryDelayMs: 0,
      onClose: (_code, turnComplete, terminalStatus) => {
        closes.push({ turnComplete, terminalStatus })
      }
    })
    child.emit({ jsonrpc: '2.0', id: 1, result: { protocolVersion: 1 } })
    child.emit({ jsonrpc: '2.0', id: 2, result: { sessionId: 's-1' } })
    // The exact shape xAI's 500 takes through grok's JSON-RPC error channel:
    // a generic "Internal error" whose data carries the real upstream status.
    child.emit({
      jsonrpc: '2.0',
      id: 3,
      error: {
        code: -32603,
        message: 'Internal error',
        data: '{"message":"API error (status 500 Internal Server Error): error: Service temporarily unavailable.","http_status":500}'
      }
    })
    await new Promise((r) => setTimeout(r, 5))

    // The agent process and its ACP session are healthy — only the upstream
    // call failed. Re-send the SAME prompt on a fresh rpc id, same session.
    expect(child.killed).toBe(false)
    const prompts = child.sent().filter((m) => m.method === 'session/prompt')
    expect(prompts).toHaveLength(2)
    expect(prompts[1].id).not.toBe(prompts[0].id)
    expect(prompts[1].params).toEqual({
      sessionId: 's-1',
      prompt: [{ type: 'text', text: 'hi' }]
    })
    expect(events.some((e) => e.type === 'provider_warning' && /retrying/i.test(e.text || ''))).toBe(
      true
    )

    child.emit({ jsonrpc: '2.0', id: prompts[1].id as number, result: { stopReason: 'end_turn' } })
    await new Promise((r) => setTimeout(r, 40))
    expect(closes).toEqual([{ turnComplete: true, terminalStatus: 'end_turn' }])
  })

  it('retries a bare "Internal error" whose 500 evidence only reached stderr', async () => {
    const child = new FakeAcpChild()
    baseOptions(child, { transientPromptRetryDelayMs: 0 })
    child.emit({ jsonrpc: '2.0', id: 1, result: { protocolVersion: 1 } })
    child.emit({ jsonrpc: '2.0', id: 2, result: { sessionId: 's-1' } })
    // Captured verbatim from run grok-1786115061135 (2026-08-07T15:11:24Z):
    // grok logs the upstream body to stderr 13ms BEFORE replying, and the
    // JSON-RPC error itself carries no data at all.
    child.errorOutput(
      'ERROR error=Internal error: {\n  "message": "API error (status 500 Internal Server Error): API error (status 500 Internal Server Error): error: Service temporarily unavailable.",\n  "http_status": 500\n}'
    )
    child.emit({ jsonrpc: '2.0', id: 3, error: { code: -32603, message: 'Internal error' } })
    await new Promise((r) => setTimeout(r, 5))

    expect(child.killed).toBe(false)
    expect(child.sent().filter((m) => m.method === 'session/prompt')).toHaveLength(2)
  })

  it('refuses to retry when recent stderr shows the real cause is auth', async () => {
    const child = new FakeAcpChild()
    const closes: Array<{ turnComplete: boolean; terminalStatus?: string }> = []
    baseOptions(child, {
      transientPromptRetryDelayMs: 0,
      onClose: (_code, turnComplete, terminalStatus) => {
        closes.push({ turnComplete, terminalStatus })
      }
    })
    child.emit({ jsonrpc: '2.0', id: 1, result: { protocolVersion: 1 } })
    child.emit({ jsonrpc: '2.0', id: 2, result: { sessionId: 's-1' } })
    // Same uninformative envelope — but the stderr channel says a retry is
    // pointless. Correlating the channels is what makes the refusal possible.
    child.errorOutput('ERROR worker quit with fatal: Transport channel closed, when Auth(AuthorizationRequired)')
    child.emit({ jsonrpc: '2.0', id: 3, error: { code: -32603, message: 'Internal error' } })
    await new Promise((r) => setTimeout(r, 20))

    expect(child.sent().filter((m) => m.method === 'session/prompt')).toHaveLength(1)
    expect(closes).toEqual([{ turnComplete: false, terminalStatus: 'rpc_error:session/prompt' }])
  })

  it('ignores stderr that predates the correlation window', async () => {
    const child = new FakeAcpChild()
    baseOptions(child, { transientPromptRetryDelayMs: 0, stderrCorrelationWindowMs: 5 })
    child.emit({ jsonrpc: '2.0', id: 1, result: { protocolVersion: 1 } })
    child.emit({ jsonrpc: '2.0', id: 2, result: { sessionId: 's-1' } })
    // A 500 from earlier in the run must not license a retry for an unrelated
    // failure that happens to follow it. Let the window genuinely lapse.
    child.errorOutput('API error (status 500 Internal Server Error)')
    await new Promise((r) => setTimeout(r, 25))
    child.emit({ jsonrpc: '2.0', id: 3, error: { code: -32000, message: 'Server error' } })
    await new Promise((r) => setTimeout(r, 20))
    expect(child.sent().filter((m) => m.method === 'session/prompt')).toHaveLength(1)
  })

  it('correlation can be switched off entirely with a zero window', async () => {
    const child = new FakeAcpChild()
    baseOptions(child, { transientPromptRetryDelayMs: 0, stderrCorrelationWindowMs: 0 })
    child.emit({ jsonrpc: '2.0', id: 1, result: { protocolVersion: 1 } })
    child.emit({ jsonrpc: '2.0', id: 2, result: { sessionId: 's-1' } })
    child.errorOutput('API error (status 500 Internal Server Error)')
    child.emit({ jsonrpc: '2.0', id: 3, error: { code: -32000, message: 'Server error' } })
    await new Promise((r) => setTimeout(r, 20))
    expect(child.sent().filter((m) => m.method === 'session/prompt')).toHaveLength(1)
  })

  it('terminalizes once the transient prompt retry budget is exhausted', async () => {
    const child = new FakeAcpChild()
    const closes: Array<{ turnComplete: boolean; terminalStatus?: string }> = []
    baseOptions(child, {
      transientPromptRetryDelayMs: 0,
      transientPromptRetryLimit: 1,
      onClose: (_code, turnComplete, terminalStatus) => {
        closes.push({ turnComplete, terminalStatus })
      }
    })
    child.emit({ jsonrpc: '2.0', id: 1, result: { protocolVersion: 1 } })
    child.emit({ jsonrpc: '2.0', id: 2, result: { sessionId: 's-1' } })
    const failPrompt = (id: number): void =>
      child.emit({
        jsonrpc: '2.0',
        id,
        error: { code: -32603, message: 'Internal error', data: { http_status: 503 } }
      })

    failPrompt(3)
    await new Promise((r) => setTimeout(r, 5))
    const prompts = child.sent().filter((m) => m.method === 'session/prompt')
    expect(prompts).toHaveLength(2)

    failPrompt(prompts[1].id as number)
    await new Promise((r) => setTimeout(r, 20))
    // Budget spent: no third attempt, and the real RPC failure survives to the
    // caller so adapters do not normalize it to an empty success.
    expect(child.sent().filter((m) => m.method === 'session/prompt')).toHaveLength(2)
    expect(child.killed).toBe(true)
    expect(closes).toEqual([{ turnComplete: false, terminalStatus: 'rpc_error:session/prompt' }])
  })

  it('never retries a prompt failure that is not transient', async () => {
    const child = new FakeAcpChild()
    const closes: Array<{ turnComplete: boolean; terminalStatus?: string }> = []
    baseOptions(child, {
      transientPromptRetryDelayMs: 0,
      onClose: (_code, turnComplete, terminalStatus) => {
        closes.push({ turnComplete, terminalStatus })
      }
    })
    child.emit({ jsonrpc: '2.0', id: 1, result: { protocolVersion: 1 } })
    child.emit({ jsonrpc: '2.0', id: 2, result: { sessionId: 's-1' } })
    // Re-authentication is not a wait-and-retry condition; burning the budget
    // on it only delays the actionable failure.
    child.emit({
      jsonrpc: '2.0',
      id: 3,
      error: { code: -32000, message: 'Transport channel closed, when Auth(AuthorizationRequired)' }
    })
    await new Promise((r) => setTimeout(r, 20))
    expect(child.sent().filter((m) => m.method === 'session/prompt')).toHaveLength(1)
    expect(child.killed).toBe(true)
    expect(closes).toEqual([{ turnComplete: false, terminalStatus: 'rpc_error:session/prompt' }])
  })

  it('abandons a scheduled transient retry when the turn is cancelled', async () => {
    const child = new FakeAcpChild()
    const { handle } = baseOptions(child, { transientPromptRetryDelayMs: 5 })
    child.emit({ jsonrpc: '2.0', id: 1, result: { protocolVersion: 1 } })
    child.emit({ jsonrpc: '2.0', id: 2, result: { sessionId: 's-1' } })
    child.emit({
      jsonrpc: '2.0',
      id: 3,
      error: { code: -32603, message: 'Internal error', data: { http_status: 500 } }
    })
    handle.cancel()
    await new Promise((r) => setTimeout(r, 30))
    expect(child.sent().filter((m) => m.method === 'session/prompt')).toHaveLength(1)
  })

  it('uses the provider formatProcessError for spawn failures', () => {
    const child = new FakeAcpChild()
    const { events } = baseOptions(child, {
      formatProcessError: (err) => `custom: ${err.message}`
    })
    child.fail(new Error('spawn boom'))
    expect(events.some((e) => e.type === 'provider_warning' && e.text === 'custom: spawn boom')).toBe(
      true
    )
  })

  it('terminates and joins process error even when warning projection throws', async () => {
    const child = new FakeAcpChild()
    child.autoCloseOnKill = false
    const closes: Array<number | null> = []
    const { handle } = baseOptions(child, {
      onEvent: () => {
        throw new Error('injected warning projection failure')
      },
      onClose: (code) => {
        closes.push(code)
      }
    })
    let closeSettled = false
    void handle.closed.then(() => {
      closeSettled = true
    })

    child.fail(new Error('provider transport failed'))
    expect(child.killed).toBe(true)
    expect(closes).toEqual([])
    expect(closeSettled).toBe(false)

    child.finish(null)
    await handle.closed
    expect(closes).toEqual([1])
    expect(closeSettled).toBe(true)
  })

  it('waits for process close and delivers one terminal callback after an error', () => {
    const child = new FakeAcpChild()
    child.autoCloseOnKill = false
    const closes: Array<number | null> = []
    baseOptions(child, {
      onClose: (code) => {
        closes.push(code)
      }
    })

    child.fail(new Error('spawn boom'))
    expect(child.killed).toBe(true)
    expect(closes).toEqual([])
    child.finish(null)
    child.finish(0)
    expect(closes).toEqual([1])
  })
})

describe('runAcpTurn — mid-turn steering (Strategy A: session/cancel + re-prompt)', () => {
  const driveToInFlightPrompt = (child: FakeAcpChild): void => {
    child.emit({ jsonrpc: '2.0', id: 1, result: { protocolVersion: 1, agentCapabilities: {} } })
    child.emit({ jsonrpc: '2.0', id: 2, result: { sessionId: 'session-1' } })
  }
  const promptsSent = (child: FakeAcpChild): Record<string, unknown>[] =>
    child.sent().filter((message) => message.method === 'session/prompt')

  it('refuses to steer before a prompt is in flight', () => {
    const child = new FakeAcpChild()
    const { handle } = baseOptions(child)
    expect(handle.steer('redirect')).toBe(false)
    expect(child.sent().some((message) => message.method === 'session/cancel')).toBe(false)
    handle.cancel()
  })

  it('interrupts the in-flight prompt and re-prompts the same session with the steer text', async () => {
    const child = new FakeAcpChild()
    const closes: Array<{ code: number | null; turnComplete: boolean }> = []
    const { handle } = baseOptions(child, {
      onClose: (code, turnComplete) => {
        closes.push({ code, turnComplete })
      }
    })
    driveToInFlightPrompt(child)
    expect(promptsSent(child)).toHaveLength(1)

    const onDelivered = vi.fn()
    expect(handle.steer('please also update the tests', { onDelivered })).toBe(true)
    expect(onDelivered).not.toHaveBeenCalled()
    // session/cancel rides as a notification against the live session.
    expect(child.sent().at(-1)).toEqual({
      jsonrpc: '2.0',
      method: 'session/cancel',
      params: { sessionId: 'session-1' }
    })

    // The provider closes the interrupted prompt; the client re-prompts.
    child.emit({ jsonrpc: '2.0', id: 3, result: { stopReason: 'cancelled' } })
    const prompts = promptsSent(child)
    expect(prompts).toHaveLength(2)
    expect(prompts[1]).toMatchObject({
      method: 'session/prompt',
      params: {
        sessionId: 'session-1',
        prompt: [{ type: 'text', text: 'please also update the tests' }]
      }
    })
    expect(onDelivered).toHaveBeenCalledTimes(1)
    // The turn is still alive: no completion, no kill, no close.
    expect(closes).toEqual([])
    expect(child.killed).toBe(false)

    // The follow-up prompt completes the turn normally.
    const followUpId = prompts[1].id as number
    child.emit({ jsonrpc: '2.0', id: followUpId, result: { stopReason: 'end_turn' } })
    await handle.closed
    expect(closes).toEqual([{ code: 0, turnComplete: true }])
  })

  it('lets an adapter frame bounded already-delivered assistant text into the steer prompt', () => {
    const child = new FakeAcpChild()
    const formatSteerPrompt = vi.fn(
      ({ steerText, interruptedAssistantText, interruptedAssistantTextWasTruncated }) =>
        `${interruptedAssistantTextWasTruncated ? 'tail' : 'full'}:${interruptedAssistantText}\nsteer:${steerText}`
    )
    const { handle } = baseOptions(child, { formatSteerPrompt })
    driveToInFlightPrompt(child)
    child.emit({
      jsonrpc: '2.0',
      method: 'session/update',
      params: {
        sessionId: 'session-1',
        update: {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: 'already visible' }
        }
      }
    })

    expect(handle.steer('continue from here')).toBe(true)
    child.emit({ jsonrpc: '2.0', id: 3, result: { stopReason: 'cancelled' } })

    const prompts = promptsSent(child)
    expect(prompts).toHaveLength(2)
    expect(prompts[1]).toMatchObject({
      params: {
        prompt: [{ type: 'text', text: 'full:already visible\nsteer:continue from here' }]
      }
    })
    expect(formatSteerPrompt).toHaveBeenCalledWith({
      steerText: 'continue from here',
      interruptedAssistantText: 'already visible',
      interruptedAssistantTextWasTruncated: false,
      interruptedPromptText: 'hi'
    })
    handle.cancel()
  })

  it('retains only a bounded tail for steer-continuation context', () => {
    const child = new FakeAcpChild()
    const formatSteerPrompt = vi.fn(({ steerText }) => steerText)
    const { handle } = baseOptions(child, { formatSteerPrompt })
    driveToInFlightPrompt(child)
    child.emit({
      jsonrpc: '2.0',
      method: 'session/update',
      params: {
        sessionId: 'session-1',
        update: {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: `${'x'.repeat(20_000)}VISIBLE_TAIL` }
        }
      }
    })

    expect(handle.steer('continue')).toBe(true)
    child.emit({ jsonrpc: '2.0', id: 3, result: { stopReason: 'cancelled' } })

    const context = formatSteerPrompt.mock.calls[0]?.[0]
    expect(context?.interruptedAssistantText).toHaveLength(16 * 1024)
    expect(context?.interruptedAssistantText).toMatch(/VISIBLE_TAIL$/)
    expect(context?.interruptedAssistantTextWasTruncated).toBe(true)
    handle.cancel()
  })

  it('refuses to steer after the turn completed', () => {
    const child = new FakeAcpChild()
    const { handle } = baseOptions(child)
    driveToInFlightPrompt(child)
    child.emit({ jsonrpc: '2.0', id: 3, result: { stopReason: 'end_turn' } })
    expect(handle.steer('too late')).toBe(false)
    expect(promptsSent(child)).toHaveLength(1)
  })

  it('cancelSteer abandons the queued follow-up without touching the turn', async () => {
    const child = new FakeAcpChild()
    const closes: Array<{ code: number | null; turnComplete: boolean }> = []
    const { handle } = baseOptions(child, {
      onClose: (code, turnComplete) => {
        closes.push({ code, turnComplete })
      }
    })
    driveToInFlightPrompt(child)

    expect(handle.steer('redirect')).toBe(true)
    handle.cancelSteer()
    // The interrupted prompt still closes, but no follow-up prompt is sent and
    // the turn ends normally — boundary delivery owns the text from here.
    child.emit({ jsonrpc: '2.0', id: 3, result: { stopReason: 'cancelled' } })
    expect(promptsSent(child)).toHaveLength(1)
    await handle.closed
    expect(closes).toEqual([{ code: 0, turnComplete: true }])
  })

  it('treats an RPC error on the interrupted prompt as the cancel acknowledgement', async () => {
    const child = new FakeAcpChild()
    const { handle } = baseOptions(child)
    driveToInFlightPrompt(child)

    expect(handle.steer('redirect after error')).toBe(true)
    child.emit({ jsonrpc: '2.0', id: 3, error: { code: -32800, message: 'request cancelled' } })
    const prompts = promptsSent(child)
    expect(prompts).toHaveLength(2)
    expect(prompts[1]).toMatchObject({
      method: 'session/prompt',
      params: {
        sessionId: 'session-1',
        prompt: [{ type: 'text', text: 'redirect after error' }]
      }
    })
    handle.cancel()
    await handle.closed
  })

  it('batches rapid steers into one follow-up and confirms every delivery', () => {
    const child = new FakeAcpChild()
    const { handle } = baseOptions(child)
    driveToInFlightPrompt(child)

    const firstDelivered = vi.fn()
    const secondDelivered = vi.fn()
    expect(handle.steer('first', { onDelivered: firstDelivered })).toBe(true)
    expect(handle.steer('second', { onDelivered: secondDelivered })).toBe(true)
    const cancels = child.sent().filter((message) => message.method === 'session/cancel')
    expect(cancels).toHaveLength(1)
    expect(firstDelivered).not.toHaveBeenCalled()
    expect(secondDelivered).not.toHaveBeenCalled()

    child.emit({ jsonrpc: '2.0', id: 3, result: { stopReason: 'cancelled' } })
    const prompts = promptsSent(child)
    expect(prompts).toHaveLength(2)
    const followUpText =
      (prompts[1].params as { prompt: Array<{ text: string }> }).prompt[0]?.text || ''
    expect(followUpText).toContain('first')
    expect(followUpText).toContain('second')
    expect(followUpText.indexOf('first')).toBeLessThan(followUpText.indexOf('second'))
    expect(firstDelivered).toHaveBeenCalledTimes(1)
    expect(secondDelivered).toHaveBeenCalledTimes(1)
    handle.cancel()
  })

  it('does not spend the denied-tool recovery prompt on a steering interrupt', () => {
    const child = new FakeAcpChild()
    const recoveryPrompts: string[] = []
    const { handle } = baseOptions(child, {
      deniedToolRecovery: {
        detect: (status) => status === 'cancelled',
        prompt: (context) => {
          recoveryPrompts.push(context.terminalStatus || '')
          return 'recovery follow-up'
        }
      }
    })
    driveToInFlightPrompt(child)

    expect(handle.steer('user steer')).toBe(true)
    child.emit({ jsonrpc: '2.0', id: 3, result: { stopReason: 'cancelled' } })
    // The follow-up is the steer text, not the recovery prompt.
    expect(recoveryPrompts).toEqual([])
    const prompts = promptsSent(child)
    expect(prompts).toHaveLength(2)
    expect(prompts[1]).toMatchObject({
      params: { prompt: [{ type: 'text', text: 'user steer' }] }
    })
    handle.cancel()
  })
})
