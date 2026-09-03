import { describe, expect, it } from 'vitest'
import type { AcpPermissionRequest, AcpRunEvent } from '../acp/AcpProtocol'
import type { AcpChildProcess } from '../acp/AcpTurnClient'
import {
  ANTIGRAVITY_ACP_AUTH_METHODS,
  ANTIGRAVITY_ACP_PREFERRED_AUTH_METHOD,
  ANTIGRAVITY_ACP_TOOL_FAILURE_CONTINUITY_PROMPT,
  buildAntigravityAcpInitializeParams,
  createAntigravityAcpClient,
  createAntigravityAcpTurnAbortController,
  formatAntigravityAcpProcessError,
  formatAntigravityAcpSteerPrompt,
  runAntigravityAcpTurn,
  type AntigravityAcpRunOptions
} from './AntigravityAcpClient'

describe('buildAntigravityAcpInitializeParams', () => {
  it('reports protocol 1, the taskwraith client identity, and no client-fs capability', () => {
    expect(buildAntigravityAcpInitializeParams('1.2.3')).toEqual({
      protocolVersion: 1,
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } },
      clientInfo: { name: 'taskwraith', version: '1.2.3' }
    })
  })

  it('trims the version and throws on a blank clientInfo.version', () => {
    expect(buildAntigravityAcpInitializeParams('  1.2.3  ')).toMatchObject({
      clientInfo: { name: 'taskwraith', version: '1.2.3' }
    })
    expect(() => buildAntigravityAcpInitializeParams('')).toThrow(/clientInfo\.version/)
    expect(() => buildAntigravityAcpInitializeParams('   ')).toThrow(/clientInfo\.version/)
  })
})

describe('Antigravity ACP auth advertisement', () => {
  it('prefers oauth-personal and lists the registry methods without inventing others', () => {
    expect(ANTIGRAVITY_ACP_PREFERRED_AUTH_METHOD).toBe('oauth-personal')
    expect(ANTIGRAVITY_ACP_AUTH_METHODS[0]).toBe('oauth-personal')
    expect([...ANTIGRAVITY_ACP_AUTH_METHODS]).toEqual([
      'oauth-personal',
      'oauth-business',
      'gemini-api-key',
      'agent-platform'
    ])
  })
})

describe('formatAntigravityAcpProcessError', () => {
  it('turns ENOENT into install + Settings guidance naming the official ACP binary', () => {
    const copy = formatAntigravityAcpProcessError(new Error('spawn agy_acp_server.par ENOENT'))
    expect(copy).toContain('agy_acp_server.par')
    expect(copy).toContain('agy_acp_server.exe')
    expect(copy).toContain('Settings -> Providers')
  })

  it('prefixes any other process error with the provider name', () => {
    expect(formatAntigravityAcpProcessError(new Error('boom'))).toBe(
      'Antigravity ACP process error: boom'
    )
  })
})

describe('formatAntigravityAcpSteerPrompt', () => {
  it('frames already-delivered output as non-authoritative continuation context', () => {
    const prompt = formatAntigravityAcpSteerPrompt({
      steerText: 'continue at D178 and mark every fifth line',
      interruptedAssistantText: 'D176. Visible sentence.\nD177. Visible sentence.',
      interruptedAssistantTextWasTruncated: true,
      interruptedPromptText: 'emit D001 through D300'
    })
    expect(prompt).toContain('truncated assistant-output tail was already shown')
    expect(prompt).toContain(JSON.stringify('D176. Visible sentence.\nD177. Visible sentence.'))
    expect(prompt).toContain(JSON.stringify('continue at D178 and mark every fifth line'))
    expect(prompt).toContain('do not repeat it')
  })

  it('keeps a steer verbatim when no assistant output preceded it', () => {
    expect(
      formatAntigravityAcpSteerPrompt({
        steerText: 'change course',
        interruptedAssistantText: '   ',
        interruptedAssistantTextWasTruncated: false,
        interruptedPromptText: 'starting prompt'
      })
    ).toBe('change course')
  })
})

class FakeAcpChild implements AcpChildProcess {
  killed = false
  killSignals: string[] = []
  private readonly writes: string[] = []
  private readonly dataListeners: Array<(chunk: string) => void> = []
  private closeListener?: (code: number | null) => void

  stdin = {
    write: (data: string, callback?: (error?: Error | null) => void): void => {
      this.writes.push(data)
      callback?.(null)
    },
    on: (_event: 'error', _listener: (error: Error) => void): void => {}
  }

  stdout = {
    on: (_event: 'data', listener: (chunk: string) => void): void => {
      this.dataListeners.push(listener)
    }
  }

  stderr = {
    on: (_event: 'data', _listener: (chunk: string) => void): void => {}
  }

  on(event: 'error' | 'close', listener: (argument: never) => void): void {
    if (event === 'close') this.closeListener = listener as (code: number | null) => void
  }

  kill(signal?: string): void {
    this.killed = true
    this.killSignals.push(signal || '')
    this.closeListener?.(0)
  }

  emit(message: unknown): void {
    const line = `${JSON.stringify(message)}\n`
    this.dataListeners.forEach((listener) => listener(line))
  }

  sent(): Record<string, unknown>[] {
    return this.writes.map((write) => JSON.parse(write.trim()) as Record<string, unknown>)
  }
}

const run = (
  child: FakeAcpChild,
  overrides: Partial<AntigravityAcpRunOptions> = {}
): {
  events: AcpRunEvent[]
  handle: ReturnType<typeof runAntigravityAcpTurn>
} => {
  const events: AcpRunEvent[] = []
  const handle = runAntigravityAcpTurn({
    prompt: 'inspect the workspace',
    cwd: '/tmp/workspace',
    appVersion: '1.9.7-test',
    spawnProcess: () => child,
    onEvent: (event) => events.push(event),
    ...overrides
  })
  return { events, handle }
}

const tick = (ms = 0): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

const promptText = (frame: Record<string, unknown> | undefined): string | undefined =>
  (frame?.params as { prompt?: Array<{ text?: string }> } | undefined)?.prompt?.[0]?.text

const sessionReady = (child: FakeAcpChild): void => {
  child.emit({ jsonrpc: '2.0', id: 1, result: { protocolVersion: 1 } })
  child.emit({ jsonrpc: '2.0', id: 2, result: { sessionId: 'session-1' } })
}

describe('runAntigravityAcpTurn', () => {
  it('sends initialize params, then session/new with untagged mcpServers', async () => {
    const child = new FakeAcpChild()
    const mcpServers = [
      {
        name: 'taskwraith-antigravity',
        command: '/usr/local/bin/node',
        args: ['bridge.js', '--run', 'run-1'],
        env: [{ name: 'TASKWRAITH_RUN_ID', value: 'run-1' }]
      }
    ]
    const { handle } = run(child, { mcpServers })
    const initialize = child.sent().find((message) => message.method === 'initialize')
    expect(initialize?.params).toEqual(buildAntigravityAcpInitializeParams('1.9.7-test'))
    expect(initialize?.params).not.toHaveProperty('authenticate')

    child.emit({ jsonrpc: '2.0', id: 1, result: { protocolVersion: 1 } })
    const sessionNew = child.sent().find((message) => message.method === 'session/new')
    const params = sessionNew?.params as {
      cwd?: string
      mcpServers?: Record<string, unknown>[]
    }
    expect(params.cwd).toBe('/tmp/workspace')
    expect(JSON.stringify(params.mcpServers)).toBe(JSON.stringify(mcpServers))
    expect(params.mcpServers?.[0]).not.toHaveProperty('type')

    handle.cancel()
    await handle.closed
  })

  it('denies permission requests when no mediator is attached', async () => {
    const child = new FakeAcpChild()
    const { events, handle } = run(child)
    sessionReady(child)
    child.emit({
      jsonrpc: '2.0',
      id: 9,
      method: 'session/request_permission',
      params: {
        sessionId: 'session-1',
        toolCall: {
          toolCallId: 'native-1',
          title: 'write_file',
          kind: 'edit',
          rawInput: { path: 'notes.md', content: 'x' }
        },
        options: [
          { optionId: 'allow', name: 'Allow', kind: 'allow_once' },
          { optionId: 'reject', name: 'Reject', kind: 'reject_once' }
        ]
      }
    })
    await tick()
    expect(child.sent().find((message) => message.id === 9)).toEqual({
      jsonrpc: '2.0',
      id: 9,
      result: { outcome: { outcome: 'selected', optionId: 'reject' } }
    })
    expect(
      events.some(
        (event) =>
          event.type === 'provider_warning' &&
          (event.text || '').includes('no TaskWraith permission mediator was attached')
      )
    ).toBe(true)
    handle.cancel()
    await handle.closed
  })

  it('re-prompts with the tool-failure continuity prompt after a failed tool ends the turn', async () => {
    const child = new FakeAcpChild()
    const { handle } = run(child)
    sessionReady(child)
    child.emit({
      jsonrpc: '2.0',
      method: 'session/update',
      params: {
        sessionId: 'session-1',
        update: {
          sessionUpdate: 'tool_call',
          toolCallId: 'shell-1',
          title: 'run_terminal_command',
          kind: 'execute'
        }
      }
    })
    child.emit({
      jsonrpc: '2.0',
      method: 'session/update',
      params: {
        sessionId: 'session-1',
        update: { sessionUpdate: 'tool_call_update', toolCallId: 'shell-1', status: 'failed' }
      }
    })
    child.emit({ jsonrpc: '2.0', id: 3, result: { stopReason: 'cancelled' } })
    await tick(40)
    const prompts = child.sent().filter((message) => message.method === 'session/prompt')
    expect(prompts).toHaveLength(2)
    expect(promptText(prompts[1])).toBe(ANTIGRAVITY_ACP_TOOL_FAILURE_CONTINUITY_PROMPT)
    handle.cancel()
    await handle.closed
  })

  it('routes abort through the ACP handle', async () => {
    const child = new FakeAcpChild()
    const { handle } = run(child)
    sessionReady(child)
    createAntigravityAcpTurnAbortController(handle).abort()
    expect(child.sent().some((message) => message.method === 'session/cancel')).toBe(true)
    expect(child.killed).toBe(true)
    await handle.closed
  })
})

describe('createAntigravityAcpClient', () => {
  it('returns a factory that binds deps and advertises oauth-personal without self-registering', async () => {
    const child = new FakeAcpChild()
    const client = createAntigravityAcpClient({
      appVersion: '9.9.9',
      spawnProcess: () => child
    })
    expect(client.preferredAuthMethod).toBe('oauth-personal')
    const handle = client.runTurn({
      prompt: 'hello',
      cwd: '/tmp/workspace',
      onEvent: () => {}
    })
    expect(child.sent().find((message) => message.method === 'initialize')?.params).toEqual(
      buildAntigravityAcpInitializeParams('9.9.9')
    )
    handle.cancel()
    await handle.closed
  })
})

describe('permission mediator wiring', () => {
  it('writes back an attached mediator decision', async () => {
    const child = new FakeAcpChild()
    const seen: AcpPermissionRequest[] = []
    const { handle } = run(child, {
      onPermissionRequest: (request) => {
        seen.push(request)
        return 'deny'
      }
    })
    sessionReady(child)
    child.emit({
      jsonrpc: '2.0',
      id: 9,
      method: 'session/request_permission',
      params: {
        sessionId: 'session-1',
        toolCall: { toolCallId: 'native-1', title: 'bash', kind: 'execute' },
        options: [
          { optionId: 'allow', name: 'Allow', kind: 'allow_once' },
          { optionId: 'reject', name: 'Reject', kind: 'reject_once' }
        ]
      }
    })
    await tick()
    expect(seen).toHaveLength(1)
    expect(child.sent().find((message) => message.id === 9)).toMatchObject({
      result: { outcome: { outcome: 'selected', optionId: 'reject' } }
    })
    handle.cancel()
    await handle.closed
  })
})
