import { describe, it, expect } from 'vitest'
import { runAcpTurn, type AcpChildProcess, type AcpTurnOptions } from './AcpTurnClient'
import type { AcpRunEvent } from './AcpProtocol'

class FakeAcpChild implements AcpChildProcess {
  writes: string[] = []
  killed = false
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
  stderr = { on: (_event: 'data', _listener: (chunk: string) => void): void => {} }

  on(event: 'error' | 'close', listener: (arg: never) => void): void {
    if (event === 'close') this.closeListener = listener as (code: number | null) => void
    else this.errorListener = listener as (err: Error) => void
  }
  kill(_signal?: string): void {
    this.killed = true
    this.closeListener?.(0)
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
}

const baseOptions = (
  child: FakeAcpChild,
  overrides: Partial<AcpTurnOptions> = {}
): { events: AcpRunEvent[]; handle: ReturnType<typeof runAcpTurn> } => {
  const events: AcpRunEvent[] = []
  const handle = runAcpTurn({
    prompt: 'hi',
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
  it('sends the caller-supplied initialize capabilities verbatim', () => {
    const child = new FakeAcpChild()
    baseOptions(child)
    expect(child.sent()[0]).toMatchObject({
      id: 1,
      method: 'initialize',
      params: { clientCapabilities: { fs: { readTextFile: true, writeTextFile: true } } }
    })
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
    const { events } = baseOptions(child, { endProcess: (c) => c.stdin?.end?.() })
    void events
    // session/new returns a JSON-RPC error → the turn must fail-close by
    // terminating the process the provider's way, so a Kimi child (ignores
    // SIGINT) still exits and onClose runs.
    child.emit({ jsonrpc: '2.0', id: 1, result: { protocolVersion: 1 } })
    child.emit({ jsonrpc: '2.0', id: 2, error: { code: -32602, message: 'bad params' } })
    await new Promise((r) => setTimeout(r, 20))
    expect(child.stdinEnded).toBe(true)
    expect(child.killed).toBe(false)
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
})
