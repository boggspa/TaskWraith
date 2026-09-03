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
  antigravityAcpSessionConfigOptions,
  stripAntigravityAcpModelNamespace,
  antigravityAcpMcpAdvertiseEnabled,
  antigravityAcpWriteCapable,
  shouldAdvertiseTaskWraithMcpToAntigravityAcp,
  ANTIGRAVITY_ACP_BROKER_MCP_TOOL_NAMESPACE,
  ANTIGRAVITY_ACP_SCOPED_MCP_SERVER_NAME,
  ANTIGRAVITY_ACP_MODEL_CONFIG_ID,
  type AntigravityAcpRunOptions
} from './AntigravityAcpClient'
import { toAntigravityAcpModelId } from './AntigravityAcpStaticModels'

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

/**
 * S7 — model passthrough. The catalogue emits `antigravity-acp:<model>` so
 * dispatch can quarantine the row onto this binary, but that prefix is a
 * TaskWraith routing device the ACP server has never heard of. Before this,
 * runTurn accepted no model at all: every run silently used the server's own
 * default and the user's pick was discarded.
 */
describe('official-ACP model passthrough', () => {
  const PREFIXED = 'antigravity-acp:gemini-3.8-flash-high'
  const BARE = 'gemini-3.8-flash-high'

  const sessionReadyAdvertisingModel = (
    child: FakeAcpChild,
    currentValue = 'gemini-3.1-pro'
  ): void => {
    child.emit({ jsonrpc: '2.0', id: 1, result: { protocolVersion: 1 } })
    child.emit({
      jsonrpc: '2.0',
      id: 2,
      result: {
        sessionId: 'session-1',
        configOptions: [
          {
            id: ANTIGRAVITY_ACP_MODEL_CONFIG_ID,
            currentValue,
            options: [{ value: currentValue }, { value: BARE }]
          }
        ]
      }
    })
  }

  const configFrame = (child: FakeAcpChild): Record<string, unknown> | undefined =>
    child.sent().find((message) => message.method === 'session/set_config_option')

  it('strips the routing namespace and leaves a bare id untouched', () => {
    expect(stripAntigravityAcpModelNamespace(PREFIXED)).toBe(BARE)
    expect(stripAntigravityAcpModelNamespace(BARE)).toBe(BARE)
    // Round-trips exactly against the catalogue's projection.
    expect(stripAntigravityAcpModelNamespace(toAntigravityAcpModelId(BARE))).toBe(BARE)
    expect(stripAntigravityAcpModelNamespace('  ANTIGRAVITY-ACP:Gemini-3.8-Flash-High ')).toBe(
      'Gemini-3.8-Flash-High'
    )
    // Nothing survives the strip => "no model selected", never a blank value.
    expect(stripAntigravityAcpModelNamespace('antigravity-acp:')).toBe('')
    expect(stripAntigravityAcpModelNamespace('   ')).toBe('')
    expect(stripAntigravityAcpModelNamespace(undefined)).toBe('')
  })

  it('projects the model onto exactly one ACP config selection', () => {
    expect(antigravityAcpSessionConfigOptions(PREFIXED)).toEqual([
      { configId: 'model', value: BARE }
    ])
    expect(antigravityAcpSessionConfigOptions(BARE)).toEqual([{ configId: 'model', value: BARE }])
    // Absent/blank asserts nothing, leaving the server's own default alone.
    expect(antigravityAcpSessionConfigOptions(undefined)).toEqual([])
    expect(antigravityAcpSessionConfigOptions('antigravity-acp:')).toEqual([])
  })

  it('sends the BARE id to session/set_config_option and never leaks the namespace on the wire', async () => {
    const child = new FakeAcpChild()
    const { handle } = run(child, { model: PREFIXED })
    sessionReadyAdvertisingModel(child)
    await tick()

    expect(configFrame(child)).toMatchObject({
      method: 'session/set_config_option',
      params: { sessionId: 'session-1', configId: 'model', value: BARE }
    })
    // The decisive assertion: the routing prefix reaches no frame at all.
    expect(JSON.stringify(child.sent())).not.toContain('antigravity-acp')

    handle.cancel()
    await handle.closed
  })

  it('treats an already-bare model identically (idempotent at the wire)', async () => {
    const child = new FakeAcpChild()
    const { handle } = run(child, { model: BARE })
    sessionReadyAdvertisingModel(child)
    await tick()
    expect(configFrame(child)?.params).toMatchObject({ configId: 'model', value: BARE })
    handle.cancel()
    await handle.closed
  })

  it('still prompts after the model selection settles', async () => {
    const child = new FakeAcpChild()
    const { handle } = run(child, { model: PREFIXED })
    sessionReadyAdvertisingModel(child)
    await tick()
    const config = configFrame(child)
    expect(config).toBeDefined()
    // The server accepts the selection; the turn must then proceed to prompt.
    child.emit({ jsonrpc: '2.0', id: config!.id, result: {} })
    await tick()
    expect(child.sent().some((message) => message.method === 'session/prompt')).toBe(true)
    handle.cancel()
    await handle.closed
  })

  it('asserts no selection when no model is supplied, preserving prior behaviour', async () => {
    const child = new FakeAcpChild()
    const { handle } = run(child)
    sessionReadyAdvertisingModel(child)
    await tick()
    expect(configFrame(child)).toBeUndefined()
    expect(child.sent().some((message) => message.method === 'session/prompt')).toBe(true)
    handle.cancel()
    await handle.closed
  })
})

/**
 * S8 — the mediator contract. Before this the seat attached no handler at all,
 * so the ACP core declined EVERY tool call and the seat could talk but not
 * work. These tests pin both halves: an attached mediator is honoured, and the
 * core's default-DENY safety property survives every failure mode.
 */
/**
 * S9 — TaskWraith MCP broker attachment. Native mutators stay denied (house
 * invariant shared with Devin and Vibe), so brokered exact edits are the only
 * way this seat can change a file. These pin the attach gates and the posture
 * scoping that keeps a restricted seat from gaining writes.
 */
describe('official-ACP MCP broker attachment gates', () => {
  const ENV_KEY = 'TASKWRAITH_ANTIGRAVITY_MCP'
  const withEnv = <T>(value: string | undefined, run: () => T): T => {
    const previous = process.env[ENV_KEY]
    if (value === undefined) delete process.env[ENV_KEY]
    else process.env[ENV_KEY] = value
    try {
      return run()
    } finally {
      if (previous === undefined) delete process.env[ENV_KEY]
      else process.env[ENV_KEY] = previous
    }
  }

  // DEFAULT-ON by explicit user ruling (2026-09-03), shaped as an opt-OUT
  // mirroring mistralMcpAdvertiseEnabled rather than Devin's opt-IN. The
  // broker is this seat's only write path, so default-OFF meant a seat that
  // could not edit a file at all.
  it('defaults the advertise gate ON and disables only on an explicit opt-out value', () => {
    expect(withEnv(undefined, antigravityAcpMcpAdvertiseEnabled)).toBe(true)
    for (const value of ['0', 'false', 'no', 'off', 'FALSE', ' Off ', '  0  ']) {
      expect(withEnv(value, antigravityAcpMcpAdvertiseEnabled), JSON.stringify(value)).toBe(false)
    }
    for (const value of ['', '1', 'true', 'yes', 'random', 'on', 'enabled']) {
      expect(withEnv(value, antigravityAcpMcpAdvertiseEnabled), JSON.stringify(value)).toBe(true)
    }
  })

  // THE property that makes default-ON safe: advertising is orthogonal to
  // posture. "On by default" plus "posture ignored" would silently hand write
  // instruments to a review seat, so this pins that the posture input the
  // attach site scopes on (safeSubset) is unaffected by the advertise gate.
  it('does not widen posture when advertising is ON by default', () => {
    withEnv(undefined, () => {
      expect(antigravityAcpMcpAdvertiseEnabled()).toBe(true)
      // A plan/read-only seat stays read-only, which is what drives
      // safeSubset at the attach site.
      expect(antigravityAcpWriteCapable('plan')).toBe(false)
      expect(antigravityAcpWriteCapable(' plan ')).toBe(false)
      expect(antigravityAcpWriteCapable(undefined)).toBe(false)
      // And a write seat is still classified independently of the gate.
      expect(antigravityAcpWriteCapable('default')).toBe(true)
    })
    // The classification is identical with advertising explicitly OFF, proving
    // the two decisions are independent rather than coupled.
    withEnv('0', () => {
      expect(antigravityAcpMcpAdvertiseEnabled()).toBe(false)
      expect(antigravityAcpWriteCapable('plan')).toBe(false)
      expect(antigravityAcpWriteCapable('default')).toBe(true)
    })
  })

  it('requires BOTH attach gates — neither alone advertises the broker', () => {
    expect(
      shouldAdvertiseTaskWraithMcpToAntigravityAcp({
        taskWraithMcpAdvertised: true,
        advertiseEnabled: true
      })
    ).toBe(true)
    expect(
      shouldAdvertiseTaskWraithMcpToAntigravityAcp({
        taskWraithMcpAdvertised: true,
        advertiseEnabled: false
      })
    ).toBe(false)
    expect(
      shouldAdvertiseTaskWraithMcpToAntigravityAcp({
        taskWraithMcpAdvertised: false,
        advertiseEnabled: true
      })
    ).toBe(false)
  })

  // The posture input that decides safeSubset. A stray-whitespace 'plan ' must
  // still read READ-ONLY: without the trim it falls through to write-capable
  // and silently drops the posture (the trap Grok/Mistral/Devin all record).
  it('reads a plan seat as READ-ONLY, including with stray whitespace', () => {
    expect(antigravityAcpWriteCapable('plan')).toBe(false)
    expect(antigravityAcpWriteCapable(' plan ')).toBe(false)
    expect(antigravityAcpWriteCapable('')).toBe(false)
    expect(antigravityAcpWriteCapable('   ')).toBe(false)
    expect(antigravityAcpWriteCapable(undefined)).toBe(false)
    expect(antigravityAcpWriteCapable(null)).toBe(false)
    expect(antigravityAcpWriteCapable('default')).toBe(true)
    expect(antigravityAcpWriteCapable('acceptEdits')).toBe(true)
  })

  // A shared name would let one seat's scoped-subset qualifier vouch for
  // another seat's call during session/request_permission evaluation.
  it('uses a scoped broker name distinct from the shared and sibling brokers', () => {
    expect(ANTIGRAVITY_ACP_SCOPED_MCP_SERVER_NAME).toBe('taskwraith-antigravity')
    expect(ANTIGRAVITY_ACP_SCOPED_MCP_SERVER_NAME).not.toBe('taskwraith-broker')
    expect(ANTIGRAVITY_ACP_SCOPED_MCP_SERVER_NAME).not.toBe('taskwraith-devin')
    expect(ANTIGRAVITY_ACP_BROKER_MCP_TOOL_NAMESPACE).toBe('TaskWraith')
  })

  it('advertises NO mcpServers on session/new when none are attached', async () => {
    const child = new FakeAcpChild()
    const { handle } = run(child)
    child.emit({ jsonrpc: '2.0', id: 1, result: { protocolVersion: 1 } })
    const sessionNew = child.sent().find((message) => message.method === 'session/new')
    const params = sessionNew?.params as { mcpServers?: unknown[] } | undefined
    // Either absent or empty — never a fabricated server entry.
    expect(params?.mcpServers ?? []).toEqual([])
    handle.cancel()
    await handle.closed
  })

  it('forwards an attached broker entry untagged, with no `type` discriminator', async () => {
    const child = new FakeAcpChild()
    const brokerEntry = {
      name: ANTIGRAVITY_ACP_SCOPED_MCP_SERVER_NAME,
      command: '/usr/local/bin/node',
      args: ['bridge.js', '--safe-subset'],
      env: [{ name: 'TASKWRAITH_PARENT_PROVIDER', value: 'antigravity' }]
    }
    const { handle } = run(child, { mcpServers: [brokerEntry] })
    child.emit({ jsonrpc: '2.0', id: 1, result: { protocolVersion: 1 } })
    const sessionNew = child.sent().find((message) => message.method === 'session/new')
    const params = sessionNew?.params as { mcpServers?: Record<string, unknown>[] }
    expect(params.mcpServers).toHaveLength(1)
    expect(Object.keys(params.mcpServers![0]).sort()).toEqual(['args', 'command', 'env', 'name'])
    expect(params.mcpServers![0]).not.toHaveProperty('type')
    expect(params.mcpServers![0].name).toBe('taskwraith-antigravity')
    handle.cancel()
    await handle.closed
  })
})

describe('permission mediator safety contract', () => {
  const askPermission = (child: FakeAcpChild, id = 9): void => {
    child.emit({
      jsonrpc: '2.0',
      id,
      method: 'session/request_permission',
      params: {
        sessionId: 'session-1',
        toolCall: {
          toolCallId: 'native-1',
          title: 'view_file',
          kind: 'read',
          rawInput: { path: 'src/main/index.ts' }
        },
        options: [
          { optionId: 'allow', name: 'Allow', kind: 'allow_once' },
          { optionId: 'reject', name: 'Reject', kind: 'reject_once' }
        ]
      }
    })
  }

  const decisionFor = (child: FakeAcpChild, id = 9): string | undefined =>
    (
      child.sent().find((message) => message.id === id)?.result as
        | { outcome?: { outcome?: string; optionId?: string } }
        | undefined
    )?.outcome?.optionId

  it('forwards the exact request and honours an ALLOW decision', async () => {
    const child = new FakeAcpChild()
    const seen: AcpPermissionRequest[] = []
    const { handle } = run(child, {
      onPermissionRequest: (request) => {
        seen.push(request)
        return 'allow'
      }
    })
    sessionReady(child)
    askPermission(child)
    await tick()
    expect(seen).toHaveLength(1)
    // The mediator must receive the fields the native gate keys on.
    expect(seen[0]?.toolName).toBe('view_file')
    expect(decisionFor(child)).toBe('allow')
    handle.cancel()
    await handle.closed
  })

  it('honours a DENY decision', async () => {
    const child = new FakeAcpChild()
    const { handle } = run(child, { onPermissionRequest: () => 'deny' })
    sessionReady(child)
    askPermission(child)
    await tick()
    expect(decisionFor(child)).toBe('reject')
    handle.cancel()
    await handle.closed
  })

  it('still DENIES when the mediator throws synchronously', async () => {
    const child = new FakeAcpChild()
    const { handle } = run(child, {
      onPermissionRequest: () => {
        throw new Error('mediator exploded')
      }
    })
    sessionReady(child)
    askPermission(child)
    await tick()
    expect(decisionFor(child)).toBe('reject')
    expect(JSON.stringify(child.sent())).not.toContain('mediator exploded')
    handle.cancel()
    await handle.closed
  })

  it('still DENIES when the mediator returns a rejected promise', async () => {
    const child = new FakeAcpChild()
    const { handle } = run(child, {
      onPermissionRequest: () => Promise.reject(new Error('mediator rejected'))
    })
    sessionReady(child)
    askPermission(child)
    await tick()
    expect(decisionFor(child)).toBe('reject')
    handle.cancel()
    await handle.closed
  })

  // The regression guard that matters most: removing the wiring must never
  // silently become an allow.
  it('still DENIES when NO mediator is attached at all', async () => {
    const child = new FakeAcpChild()
    const { handle } = run(child)
    sessionReady(child)
    askPermission(child)
    await tick()
    expect(decisionFor(child)).toBe('reject')
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
