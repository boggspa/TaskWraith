import { describe, expect, it } from 'vitest'
import type { AcpPermissionRequest, NormalizedGrokRunEvent } from '../grok/GrokAcpProtocol'
import type { EffectiveRunPermissions } from '../store/types'
import {
  DEVIN_TOOL_FAILURE_CONTINUITY_PROMPT,
  buildDevinInitializeParams,
  createDevinTurnAbortController,
  devinTaskWraithBrokerToolRequested,
  formatDevinProcessError,
  formatDevinSteerPrompt,
  runDevinAcpTurn,
  shouldAdvertiseTaskWraithMcpToDevin,
  type AcpChildProcess,
  type DevinAcpRunOptions
} from './DevinAcpClient'

describe('buildDevinInitializeParams', () => {
  it('reports protocol 1, the taskwraith client identity, and no client-fs capability', () => {
    // fs/* is never serviced (onInboundRequest is not wired), so advertising it
    // would promise a capability answered with -32601.
    expect(buildDevinInitializeParams('1.2.3')).toEqual({
      protocolVersion: 1,
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } },
      clientInfo: { name: 'taskwraith', version: '1.2.3' }
    })
  })

  it('trims the version', () => {
    expect(buildDevinInitializeParams('  1.2.3  ')).toMatchObject({
      clientInfo: { name: 'taskwraith', version: '1.2.3' }
    })
  })

  it('throws on a blank version instead of sending an empty clientInfo.version', () => {
    expect(() => buildDevinInitializeParams('')).toThrow(/clientInfo\.version/)
    expect(() => buildDevinInitializeParams('   ')).toThrow(/clientInfo\.version/)
  })
})

describe('formatDevinProcessError', () => {
  it('turns ENOENT into install + sign-in guidance naming the devin binary', () => {
    const copy = formatDevinProcessError(new Error('spawn devin ENOENT'))
    expect(copy).toContain('`devin` binary was not found on PATH')
    expect(copy).toContain('curl -fsSL https://cli.devin.ai/install.sh | bash')
    expect(copy).toContain('`devin auth login`')
    expect(copy).toContain('WINDSURF_API_KEY')
  })

  it('prefixes any other process error with the provider name', () => {
    expect(formatDevinProcessError(new Error('boom'))).toBe('Devin process error: boom')
  })
})

describe('formatDevinSteerPrompt', () => {
  it('frames already-delivered output as non-authoritative continuation context', () => {
    const prompt = formatDevinSteerPrompt({
      steerText: 'continue at D178 and mark every fifth line',
      interruptedAssistantText: 'D176. Visible sentence.\nD177. Visible sentence.',
      interruptedAssistantTextWasTruncated: true,
      interruptedPromptText: 'emit D001 through D300'
    })

    expect(prompt).toContain('truncated assistant-output tail was already shown')
    expect(prompt).toContain(JSON.stringify('D176. Visible sentence.\nD177. Visible sentence.'))
    expect(prompt).toContain(JSON.stringify('continue at D178 and mark every fifth line'))
    expect(prompt).toContain('do not repeat it')
    expect(prompt).toContain('Follow the authoritative user steering instruction')
  })

  it('omits the truncation marker when the tail was complete', () => {
    const prompt = formatDevinSteerPrompt({
      steerText: 'change course',
      interruptedAssistantText: 'Partial answer.',
      interruptedAssistantTextWasTruncated: false,
      interruptedPromptText: 'starting prompt'
    })
    expect(prompt).toContain('The following assistant-output tail was already shown')
    expect(prompt).not.toContain('truncated')
  })

  it('keeps a steer verbatim when no assistant output preceded it', () => {
    expect(
      formatDevinSteerPrompt({
        steerText: 'change course',
        interruptedAssistantText: '   ',
        interruptedAssistantTextWasTruncated: false,
        interruptedPromptText: 'starting prompt'
      })
    ).toBe('change course')
  })
})

describe('shouldAdvertiseTaskWraithMcpToDevin', () => {
  it('lets signed UltraTask consent opt into the broker even with both flags off', () => {
    expect(
      shouldAdvertiseTaskWraithMcpToDevin({
        taskWraithMcpAdvertised: false,
        advertiseEnabled: false,
        effectivePermissions: {
          subThreadDelegationAutoAllowSource: 'ultratask'
        } as EffectiveRunPermissions
      })
    ).toBe(true)
  })

  it('requires both the run advertise flag and the environment gate otherwise', () => {
    expect(
      shouldAdvertiseTaskWraithMcpToDevin({
        taskWraithMcpAdvertised: false,
        advertiseEnabled: false
      })
    ).toBe(false)
    expect(
      shouldAdvertiseTaskWraithMcpToDevin({ taskWraithMcpAdvertised: true, advertiseEnabled: true })
    ).toBe(true)
    expect(
      shouldAdvertiseTaskWraithMcpToDevin({
        taskWraithMcpAdvertised: true,
        advertiseEnabled: false
      })
    ).toBe(false)
    expect(
      shouldAdvertiseTaskWraithMcpToDevin({
        taskWraithMcpAdvertised: false,
        advertiseEnabled: true
      })
    ).toBe(false)
  })
})

function permissionRequest(rawToolCall: Record<string, unknown>): AcpPermissionRequest {
  return {
    rpcId: 9,
    sessionId: 'session-1',
    toolName: 'human display title',
    toolKind: '',
    options: [
      { optionId: 'allow', name: 'Allow', kind: 'allow_once' },
      { optionId: 'reject', name: 'Reject', kind: 'reject_once' }
    ],
    rawToolCall
  }
}

describe('devinTaskWraithBrokerToolRequested', () => {
  it('admits the broker namespace from the structured rawInput identity', () => {
    expect(
      devinTaskWraithBrokerToolRequested(
        permissionRequest({
          toolCallId: 'write-1',
          title: 'an unrelated human label',
          kind: 'other',
          rawInput: {
            tool_name: 'TaskWraith__write_file',
            path: 'taskwraith-provider-accept-edits-qa.txt',
            content: 'DEVIN_ACCEPT_EDITS_QA_OK'
          }
        })
      )
    ).toBe(true)
  })

  it('never treats the human title as TaskWraith broker provenance', () => {
    expect(
      devinTaskWraithBrokerToolRequested(
        permissionRequest({
          toolCallId: 'title-only',
          title: 'TaskWraith_write_file',
          kind: 'other',
          rawInput: { path: 'taskwraith-provider-accept-edits-qa.txt', content: 'UNTRUSTED' }
        })
      )
    ).toBe(false)
  })

  it('does not canonicalize a Vibe-style _meta-only identity (no Devin build has emitted one)', () => {
    // MistralAcpClient rewrites `_meta.tool_name` alias spellings; Devin goes
    // straight to the strict resolver, which reads only the transport's stable
    // machine identities. Pinned so a future rewrite is a deliberate change.
    expect(
      devinTaskWraithBrokerToolRequested(
        permissionRequest({
          toolCallId: 'meta-only',
          title: 'Write file',
          kind: 'other',
          rawInput: { path: 'notes.md', content: 'x' },
          _meta: { tool_name: 'TaskWraith_write_file', effect_kind: 'tool' }
        })
      )
    ).toBe(false)
  })

  it('leaves native tools and conflicting identities on the non-broker path', () => {
    expect(
      devinTaskWraithBrokerToolRequested(
        permissionRequest({
          toolCallId: 'bash-1',
          title: 'bash',
          kind: 'execute',
          rawInput: { command: 'touch /tmp/outside.txt' }
        })
      )
    ).toBe(false)
    expect(
      devinTaskWraithBrokerToolRequested(
        permissionRequest({
          toolCallId: 'conflict-1',
          title: 'TaskWraith__write_file',
          kind: 'other',
          toolName: 'TaskWraith__write_file',
          rawInput: { tool_name: 'OtherBroker__write_file', path: 'x.txt', content: 'UNTRUSTED' }
        })
      )
    ).toBe(false)
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

interface CloseInfo {
  code: number | null
  turnComplete: boolean
  terminalStatus?: string
}

const run = (
  child: FakeAcpChild,
  overrides: Partial<DevinAcpRunOptions> = {}
): {
  events: NormalizedGrokRunEvent[]
  closeInfos: CloseInfo[]
  handle: ReturnType<typeof runDevinAcpTurn>
} => {
  const events: NormalizedGrokRunEvent[] = []
  const closeInfos: CloseInfo[] = []
  const handle = runDevinAcpTurn({
    prompt: 'inspect the workspace',
    cwd: '/tmp/workspace',
    appVersion: '1.9.7-test',
    spawnProcess: () => child,
    onEvent: (event) => events.push(event),
    onClose: (code, turnComplete, terminalStatus) => {
      closeInfos.push({ code, turnComplete, terminalStatus })
    },
    ...overrides
  })
  return { events, closeInfos, handle }
}

const tick = (ms = 0): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

const promptText = (frame: Record<string, unknown> | undefined): string | undefined =>
  (frame?.params as { prompt?: Array<{ text?: string }> } | undefined)?.prompt?.[0]?.text

const sessionReady = (child: FakeAcpChild): void => {
  child.emit({ jsonrpc: '2.0', id: 1, result: { protocolVersion: 1 } })
  child.emit({ jsonrpc: '2.0', id: 2, result: { sessionId: 'session-1' } })
}

describe('runDevinAcpTurn session wiring', () => {
  it('sends the Devin initialize params, then session/new with mcpServers forwarded untagged', async () => {
    const child = new FakeAcpChild()
    // The ACP McpServer enum is UNTAGGED: a stray `type: 'stdio'` matches no
    // variant and produces a -32602 that hangs the turn. The object handed in
    // must reach the wire byte-identical, with no discriminator added.
    const mcpServers = [
      {
        name: 'taskwraith-devin',
        command: '/usr/local/bin/node',
        args: ['bridge.js', '--run', 'run-1'],
        env: [{ name: 'TASKWRAITH_RUN_ID', value: 'run-1' }]
      }
    ]
    const { handle } = run(child, { mcpServers })

    const initialize = child.sent().find((message) => message.method === 'initialize')
    expect(initialize).toMatchObject({ jsonrpc: '2.0', id: 1 })
    expect(initialize?.params).toEqual(buildDevinInitializeParams('1.9.7-test'))
    expect(child.sent().some((message) => message.method === 'session/new')).toBe(false)

    child.emit({ jsonrpc: '2.0', id: 1, result: { protocolVersion: 1 } })

    const sessionNew = child.sent().find((message) => message.method === 'session/new')
    expect(sessionNew).toMatchObject({ jsonrpc: '2.0', id: 2 })
    const params = sessionNew?.params as { cwd?: string; mcpServers?: Record<string, unknown>[] }
    expect(params.cwd).toBe('/tmp/workspace')
    expect(JSON.stringify(params.mcpServers)).toBe(JSON.stringify(mcpServers))
    expect(params.mcpServers).toHaveLength(1)
    expect(Object.keys(params.mcpServers?.[0] ?? {})).toEqual(['name', 'command', 'args', 'env'])
    expect(params.mcpServers?.[0]).not.toHaveProperty('type')

    handle.cancel()
    await handle.closed
  })

  it('advertises an empty mcpServers list when none is attached', async () => {
    const child = new FakeAcpChild()
    const { handle } = run(child)
    child.emit({ jsonrpc: '2.0', id: 1, result: { protocolVersion: 1 } })

    const sessionNew = child.sent().find((message) => message.method === 'session/new')
    expect(sessionNew?.params).toEqual({ cwd: '/tmp/workspace', mcpServers: [] })

    handle.cancel()
    await handle.closed
  })

  it('sends the prompt verbatim once the session is ready', async () => {
    const child = new FakeAcpChild()
    const { handle } = run(child, { prompt: 'emit D001 through D300' })
    sessionReady(child)

    const prompts = child.sent().filter((message) => message.method === 'session/prompt')
    expect(prompts).toHaveLength(1)
    expect(prompts[0]).toMatchObject({ id: 3, params: { sessionId: 'session-1' } })
    expect(promptText(prompts[0])).toBe('emit D001 through D300')

    handle.cancel()
    await handle.closed
  })
})

describe('runDevinAcpTurn live steering continuity', () => {
  it('re-prompts Devin with the already-delivered assistant tail and user steer', async () => {
    const child = new FakeAcpChild()
    const { handle } = run(child, { prompt: 'emit D001 through D300' })
    sessionReady(child)
    child.emit({
      jsonrpc: '2.0',
      method: 'session/update',
      params: {
        sessionId: 'session-1',
        update: {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: 'D176. Visible. D177. Visible.' }
        }
      }
    })

    expect(handle.steer('continue at D178')).toBe(true)
    expect(child.sent().some((message) => message.method === 'session/cancel')).toBe(true)
    child.emit({ jsonrpc: '2.0', id: 3, result: { stopReason: 'cancelled' } })

    const prompts = child.sent().filter((message) => message.method === 'session/prompt')
    expect(prompts).toHaveLength(2)
    expect(prompts[1]).toMatchObject({ params: { sessionId: 'session-1' } })
    const followUp = promptText(prompts[1])
    expect(followUp).toContain(JSON.stringify('D176. Visible. D177. Visible.'))
    expect(followUp).toContain(JSON.stringify('continue at D178'))
    expect(followUp).toContain('do not repeat it')
    expect(child.killed).toBe(false)

    handle.cancel()
    await handle.closed
  })
})

describe('runDevinAcpTurn permission mediation', () => {
  it('denies every permission request when no mediator is attached, never selecting allow', async () => {
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

    // With no reject option to select, the answer is a cancelled outcome, and
    // still never the allow option.
    child.emit({
      jsonrpc: '2.0',
      id: 10,
      method: 'session/request_permission',
      params: {
        sessionId: 'session-1',
        toolCall: { toolCallId: 'native-2', title: 'bash', kind: 'execute' },
        options: [{ optionId: 'allow', name: 'Allow', kind: 'allow_once' }]
      }
    })
    await tick()

    expect(child.sent().find((message) => message.id === 10)).toEqual({
      jsonrpc: '2.0',
      id: 10,
      result: { outcome: { outcome: 'cancelled' } }
    })
    expect(
      events.filter(
        (event) =>
          event.type === 'provider_warning' &&
          (event.text || '').includes('no TaskWraith permission mediator was attached')
      )
    ).toHaveLength(2)

    handle.cancel()
    await handle.closed
  })

  it('writes back the mediator decision when one is attached', async () => {
    const child = new FakeAcpChild()
    const seen: AcpPermissionRequest[] = []
    const { handle } = run(child, {
      onPermissionRequest: (request) => {
        seen.push(request)
        return devinTaskWraithBrokerToolRequested(request) ? 'allow' : 'deny'
      }
    })
    sessionReady(child)

    child.emit({
      jsonrpc: '2.0',
      id: 9,
      method: 'session/request_permission',
      params: {
        sessionId: 'session-1',
        toolCall: {
          toolCallId: 'broker-1',
          title: 'Write file',
          kind: 'other',
          rawInput: { tool_name: 'TaskWraith__write_file', path: 'notes.md', content: 'x' }
        },
        options: [
          { optionId: 'allow', name: 'Allow', kind: 'allow_once' },
          { optionId: 'reject', name: 'Reject', kind: 'reject_once' }
        ]
      }
    })
    await tick()

    expect(seen).toHaveLength(1)
    expect(seen[0]?.toolName).toBe('Write file')
    expect(child.sent().find((message) => message.id === 9)).toMatchObject({
      result: { outcome: { outcome: 'selected', optionId: 'allow' } }
    })

    handle.cancel()
    await handle.closed
  })
})

describe('runDevinAcpTurn denied-tool recovery', () => {
  it('continues once with the generic continuity prompt after a failed tool ends the turn', async () => {
    const child = new FakeAcpChild()
    const { events, closeInfos, handle } = run(child)
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
          kind: 'execute',
          rawInput: { command: 'npm test' }
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
    // Terminal with NO assistant text: the seat converted the failure into a
    // cancelled turn instead of reporting.
    child.emit({ jsonrpc: '2.0', id: 3, result: { stopReason: 'cancelled' } })
    await tick(40)

    const prompts = child.sent().filter((message) => message.method === 'session/prompt')
    expect(prompts).toHaveLength(2)
    expect(prompts[1]).toMatchObject({ id: 5, params: { sessionId: 'session-1' } })
    const followUp = promptText(prompts[1])
    expect(followUp).toBe(DEVIN_TOOL_FAILURE_CONTINUITY_PROMPT)
    expect(followUp).toContain('Do not end or cancel the participant turn')
    expect(followUp).not.toContain('declined the previous tool request')
    const warnings = events.filter(
      (event) => event.type === 'provider_warning' && (event.text || '').includes('continuing once')
    )
    expect(warnings).toHaveLength(1)
    expect(warnings[0]?.text).toContain('Devin stopped after a rejected or failed tool')
    expect(child.killed).toBe(false)
    expect(closeInfos).toEqual([])

    child.emit({
      jsonrpc: '2.0',
      method: 'session/update',
      params: {
        sessionId: 'session-1',
        update: {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: 'Finished from existing evidence.' }
        }
      }
    })
    child.emit({ jsonrpc: '2.0', id: 5, result: { stopReason: 'end_turn' } })
    await handle.closed
    expect(closeInfos).toEqual([{ code: 0, turnComplete: true, terminalStatus: 'end_turn' }])
  })

  it('uses the user-declined continuity prompt when the tool output records a decline', async () => {
    const child = new FakeAcpChild()
    const { events, handle } = run(child)
    sessionReady(child)
    child.emit({
      jsonrpc: '2.0',
      method: 'session/update',
      params: {
        sessionId: 'session-1',
        update: {
          sessionUpdate: 'tool_call',
          toolCallId: 'broker-1',
          title: 'TaskWraith__write_file',
          kind: 'other',
          rawInput: { path: 'notes.md', content: 'x' }
        }
      }
    })
    child.emit({
      jsonrpc: '2.0',
      method: 'session/update',
      params: {
        sessionId: 'session-1',
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
    await tick(40)

    const prompts = child.sent().filter((message) => message.method === 'session/prompt')
    expect(prompts).toHaveLength(2)
    const followUp = promptText(prompts[1])
    expect(followUp).toContain('declined the previous tool request')
    expect(followUp).toContain('Respect that decision')
    expect(followUp).not.toContain('Do not end or cancel the participant turn')
    expect(
      events.some(
        (event) =>
          event.type === 'provider_warning' && (event.text || '').includes('continuing once')
      )
    ).toBe(true)

    handle.cancel()
    await handle.closed
  })

  it('does not spend the recovery when assistant text already reached the user', async () => {
    const child = new FakeAcpChild()
    const { events, closeInfos, handle } = run(child)
    sessionReady(child)
    child.emit({
      jsonrpc: '2.0',
      method: 'session/update',
      params: {
        sessionId: 'session-1',
        update: {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: 'Here is what I found before the tool failed.' }
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
    await handle.closed

    expect(child.sent().filter((message) => message.method === 'session/prompt')).toHaveLength(1)
    expect(
      events.some(
        (event) =>
          event.type === 'provider_warning' && (event.text || '').includes('continuing once')
      )
    ).toBe(false)
    expect(closeInfos).toEqual([{ code: 0, turnComplete: true, terminalStatus: 'cancelled' }])
  })
})

describe('runDevinAcpTurn cancellation', () => {
  it('resolves closed after cancel() sends session/cancel and terminates the child', async () => {
    const child = new FakeAcpChild()
    const { closeInfos, handle } = run(child)
    sessionReady(child)

    handle.cancel()
    expect(child.sent().some((message) => message.method === 'session/cancel')).toBe(true)
    expect(child.killed).toBe(true)
    expect(child.killSignals).toEqual(['SIGINT'])
    await handle.closed
    expect(closeInfos).toEqual([{ code: 0, turnComplete: false, terminalStatus: undefined }])
  })

  it('routes an abort signal through the ACP handle before any raw process kill', async () => {
    const child = new FakeAcpChild()
    const { handle } = run(child)
    sessionReady(child)

    createDevinTurnAbortController(handle).abort()
    expect(child.sent().some((message) => message.method === 'session/cancel')).toBe(true)
    expect(child.killed).toBe(true)
    await handle.closed
  })
})

describe('devinTaskWraithBrokerToolRequested scoped read-only server', () => {
  it('admits the taskwraith-devin scoped server a read-only seat is handed in session/new', () => {
    // A plan/read-only seat receives DEVIN_SCOPED_MCP_SERVER_NAME rather than
    // the full server, so its brokered calls arrive under this namespace. If
    // the strict resolver does not know the name, every brokered read on a
    // read-only Devin seat is denied as if it were a native tool.
    expect(
      devinTaskWraithBrokerToolRequested(
        permissionRequest({
          toolCallId: 'read-1',
          title: 'Read README',
          kind: 'other',
          rawInput: { tool_name: 'taskwraith-devin__read_file', path: 'README.md' }
        })
      )
    ).toBe(true)
  })
})
