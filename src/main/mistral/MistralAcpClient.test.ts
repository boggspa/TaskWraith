import { afterAll, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { preflightNativeWorkspaceTool } from '../native-tools/NativeWorkspaceToolGate'
import { resolveStructuredTaskWraithToolRequest } from '../grok/GrokMcpAdvertise'
import type { AcpPermissionRequest } from '../grok/GrokAcpProtocol'
import {
  MISTRAL_TOOL_FAILURE_CONTINUITY_PROMPT,
  MISTRAL_USER_DECLINED_TOOL_CONTINUITY_PROMPT,
  MISTRAL_UNATTRIBUTED_REFUSAL_CONTINUITY_PROMPT,
  formatMistralSteerPrompt,
  mistralTaskWraithBrokerToolRequested,
  normalizeMistralVibePermissionRequest,
  runMistralAcpTurn,
  shouldAdvertiseTaskWraithMcpToMistral,
  type AcpChildProcess
} from './MistralAcpClient'
import type { EffectiveRunPermissions } from '../store/types'
import type { NormalizedGrokRunEvent } from '../grok/GrokAcpProtocol'

const MISTRAL_NAMESPACES = ['taskwraith-mistral', 'TaskWraith'] as const
const NATIVE_IDENTITY_ROOT = mkdtempSync(join(tmpdir(), 'taskwraith-vibe-native-identity-'))
const NATIVE_IDENTITY_WORKSPACE = join(NATIVE_IDENTITY_ROOT, 'workspace')
mkdirSync(NATIVE_IDENTITY_WORKSPACE)
writeFileSync(join(NATIVE_IDENTITY_WORKSPACE, 'probe.txt'), 'verified read fixture')
writeFileSync(join(NATIVE_IDENTITY_ROOT, 'outside.txt'), 'outside the workspace')
afterAll(() => rmSync(NATIVE_IDENTITY_ROOT, { recursive: true, force: true }))

describe('formatMistralSteerPrompt', () => {
  it('frames already-delivered output as non-authoritative continuation context', () => {
    const prompt = formatMistralSteerPrompt({
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

  it('keeps a steer verbatim when no assistant output preceded it', () => {
    expect(
      formatMistralSteerPrompt({
        steerText: 'change course',
        interruptedAssistantText: '',
        interruptedAssistantTextWasTruncated: false,
        interruptedPromptText: 'starting prompt'
      })
    ).toBe('change course')
  })
})

class FakeAcpChild implements AcpChildProcess {
  killed = false
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

  kill(_signal?: string): void {
    this.killed = true
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

describe('normalizeMistralVibePermissionRequest', () => {
  function nativeReadRequest(path: string): AcpPermissionRequest {
    return {
      ...permissionRequest({
        toolCallId: 'native-read',
        title: `Reading ${path}`,
        kind: 'read',
        _meta: { tool_name: 'read_file', effect_kind: 'file_read' },
        rawInput: { filePath: path }
      }),
      toolName: 'tool',
      toolKind: ''
    }
  }

  function preflight(request: AcpPermissionRequest) {
    return preflightNativeWorkspaceTool({
      provider: 'mistral',
      toolName: request.toolName,
      toolKind: request.toolKind,
      rawToolCall: request.rawToolCall,
      workspacePath: NATIVE_IDENTITY_WORKSPACE,
      runtimeSandboxed: false
    })
  }

  it('repairs placeholder identity after correlation so an in-workspace native read is allowed', () => {
    const request = nativeReadRequest(join(NATIVE_IDENTITY_WORKSPACE, 'probe.txt'))
    const normalized = normalizeMistralVibePermissionRequest(request)
    expect(preflight(normalized)).toMatchObject({
      kind: 'allow',
      canonicalTool: 'read_file',
      access: 'read'
    })
    expect(normalized).toMatchObject({ toolName: 'read_file', toolKind: 'read' })
    expect(normalized.rawToolCall).toBe(request.rawToolCall)
    expect(request.toolName).toBe('tool')
    expect(mistralTaskWraithBrokerToolRequested(normalized)).toBe(false)
  })

  it('still applies workspace boundaries after repairing native identity', () => {
    const normalized = normalizeMistralVibePermissionRequest(
      nativeReadRequest(join(NATIVE_IDENTITY_ROOT, 'outside.txt'))
    )
    expect(normalized.toolName).toBe('read_file')
    expect(preflight(normalized)).toMatchObject({ kind: 'deny', canonicalTool: 'read_file' })
  })

  it('uses agreeing machine metadata rather than a human display title', () => {
    const request = {
      ...nativeReadRequest(join(NATIVE_IDENTITY_WORKSPACE, 'probe.txt')),
      toolName: 'Reading the requested file'
    }
    const normalized = normalizeMistralVibePermissionRequest(request)
    expect(normalized).toMatchObject({ toolName: 'read_file', toolKind: 'read' })
    expect(preflight(normalized).kind).toBe('allow')
  })

  it.each([
    { kind: 'edit', effect_kind: 'file_read', tool_name: 'read_file' },
    { kind: 'read', effect_kind: 'tool', tool_name: 'read_file' },
    { kind: 'read', effect_kind: 'file_read', tool_name: 'TaskWraith_write_file' }
  ])('does not repair conflicting or broker-shaped native identity: %j', (identity) => {
    const request = nativeReadRequest(join(NATIVE_IDENTITY_WORKSPACE, 'probe.txt'))
    request.rawToolCall = {
      ...request.rawToolCall,
      kind: identity.kind,
      _meta: { tool_name: identity.tool_name, effect_kind: identity.effect_kind }
    }
    expect(normalizeMistralVibePermissionRequest(request)).toBe(request)
  })

  it('does not overwrite an explicit conflicting permission identity', () => {
    const request = {
      ...nativeReadRequest(join(NATIVE_IDENTITY_WORKSPACE, 'probe.txt')),
      toolName: 'bash',
      toolKind: 'execute'
    }
    expect(normalizeMistralVibePermissionRequest(request)).toBe(request)
  })

  it.each([
    { name: 'bash', kind: 'execute', effect: 'shell', input: { command: 'rm -rf /tmp/example' } },
    {
      name: 'write_file',
      kind: 'edit',
      effect: 'file_write',
      input: { filePath: '/tmp/outside.txt', content: 'x' }
    },
    {
      name: 'edit',
      kind: 'edit',
      effect: 'file_edit',
      input: { filePath: '/tmp/outside.txt', oldString: 'x', newString: 'y' }
    }
  ])(
    'restores native $name identity without granting the broker fast path',
    ({ name, kind, effect, input }) => {
      const request = {
        ...permissionRequest({
          kind,
          _meta: { tool_name: name, effect_kind: effect },
          rawInput: input
        }),
        toolName: 'tool'
      }
      const normalized = normalizeMistralVibePermissionRequest(request)
      expect(normalized).toMatchObject({ toolName: name, toolKind: kind })
      expect(mistralTaskWraithBrokerToolRequested(normalized)).toBe(false)
      expect(preflight(normalized).kind).toBe('deny')
    }
  )

  it('admits every exact UltraTask delegation route into the host-gated broker', () => {
    for (const toolName of ['delegate_wave', 'ultra_task', 'delegate_to_subthread']) {
      expect(
        mistralTaskWraithBrokerToolRequested(
          permissionRequest({
            toolCallId: `delegation-${toolName}`,
            title: 'Delegation request',
            kind: 'other',
            rawInput: {},
            _meta: { tool_name: `TaskWraith_${toolName}`, effect_kind: 'tool' }
          })
        ),
        toolName
      ).toBe(true)
    }
  })

  it('translates Vibe structured MCP metadata into the strict TaskWraith spelling', () => {
    const request = permissionRequest({
      toolCallId: 'write-1',
      title: 'an unrelated human label',
      kind: 'other',
      rawInput: {
        path: 'taskwraith-provider-accept-edits-qa.txt',
        content: 'MISTRAL_ACCEPT_EDITS_QA_OK'
      },
      _meta: { tool_name: 'TaskWraith_write_file', effect_kind: 'tool' }
    })

    const normalized = normalizeMistralVibePermissionRequest(request)

    expect(normalized).not.toBe(request)
    expect(normalized.rawToolCall?.rawInput).toEqual({
      path: 'taskwraith-provider-accept-edits-qa.txt',
      content: 'MISTRAL_ACCEPT_EDITS_QA_OK',
      tool_name: 'TaskWraith__write_file'
    })
    expect(request.rawToolCall?.rawInput).not.toHaveProperty('tool_name')
    expect(resolveStructuredTaskWraithToolRequest(normalized, MISTRAL_NAMESPACES)).toMatchObject({
      toolName: 'write_file',
      effectiveToolName: 'write_file',
      mutation: 'workspace'
    })
  })

  it('translates the read-only scoped server alias without widening its namespace', () => {
    const request = permissionRequest({
      toolCallId: 'read-1',
      title: 'Read README',
      kind: 'other',
      rawInput: { path: 'README.md' },
      _meta: { tool_name: 'taskwraith-mistral_read_file', effect_kind: 'tool' }
    })

    const normalized = normalizeMistralVibePermissionRequest(request)

    expect(normalized.rawToolCall?.rawInput).toEqual({
      path: 'README.md',
      tool_name: 'taskwraith-mistral__read_file'
    })
    expect(resolveStructuredTaskWraithToolRequest(normalized, MISTRAL_NAMESPACES)).toMatchObject({
      toolName: 'read_file',
      effectiveToolName: 'read_file',
      mutation: 'none'
    })
  })

  it('canonicalizes scoped GLM variants and case/format drift into strict TaskWraith form', () => {
    const request = permissionRequest({
      toolCallId: 'glm-1',
      title: 'Legacy GLM write',
      kind: 'other',
      rawInput: {
        path: 'taskwraith-provider-accept-edits-qa.txt',
        content: 'MISTRAL_ACCEPT_EDITS_QA_OK'
      },
      _meta: { tool_name: 'taskwraith-zai-glm__write_file', effect_kind: 'tool' }
    })
    const normalized = normalizeMistralVibePermissionRequest(request)

    expect(normalized).not.toBe(request)
    expect(normalized.rawToolCall?.rawInput).toEqual({
      path: 'taskwraith-provider-accept-edits-qa.txt',
      content: 'MISTRAL_ACCEPT_EDITS_QA_OK',
      tool_name: 'taskwraith-mistral__write_file'
    })
    expect(resolveStructuredTaskWraithToolRequest(normalized, MISTRAL_NAMESPACES)).toMatchObject({
      toolName: 'write_file',
      effectiveToolName: 'write_file',
      mutation: 'workspace'
    })
  })

  it('normalizes top-level and input-identity drift together before resolving', () => {
    const request = permissionRequest({
      toolCallId: 'drift-1',
      title: 'Top-level alias',
      kind: 'other',
      toolName: 'TASKWRIGHT__write_file',
      rawInput: {
        path: 'taskwraith-provider-accept-edits-qa.txt',
        content: 'TASKWRIGHT_WRITE_FILE'
      },
      _meta: { tool_name: 'TASKWRIGHT__write_file', effect_kind: 'tool' }
    })

    const normalized = normalizeMistralVibePermissionRequest(request)

    expect(normalized).not.toBe(request)
    expect(normalized.rawToolCall?.toolName).toBe('TaskWraith__write_file')
    expect(normalized.rawToolCall?.rawInput).toEqual({
      path: 'taskwraith-provider-accept-edits-qa.txt',
      content: 'TASKWRIGHT_WRITE_FILE',
      tool_name: 'TaskWraith__write_file'
    })
    expect(resolveStructuredTaskWraithToolRequest(normalized, MISTRAL_NAMESPACES)).toMatchObject({
      toolName: 'write_file',
      effectiveToolName: 'write_file',
      mutation: 'workspace'
    })
  })

  it('never treats the human title as TaskWraith broker provenance', () => {
    const request = permissionRequest({
      toolCallId: 'title-only',
      title: 'TaskWraith_write_file',
      kind: 'other',
      rawInput: {
        path: 'taskwraith-provider-accept-edits-qa.txt',
        content: 'UNTRUSTED'
      }
    })

    expect(normalizeMistralVibePermissionRequest(request)).toBe(request)
    expect(resolveStructuredTaskWraithToolRequest(request, MISTRAL_NAMESPACES)).toBeNull()
  })

  it.each([
    {
      label: 'native write_file',
      rawToolCall: {
        title: 'write_file',
        kind: 'edit',
        rawInput: { file_path: '/tmp/outside.txt', content: 'UNTRUSTED' },
        _meta: { tool_name: 'write_file', effect_kind: 'file_write' }
      }
    },
    {
      label: 'native bash',
      rawToolCall: {
        title: 'bash',
        kind: 'execute',
        rawInput: { command: 'touch /tmp/outside.txt' },
        _meta: { tool_name: 'bash', effect_kind: 'shell' }
      }
    },
    {
      label: 'spoofed MCP metadata on a native edit',
      rawToolCall: {
        title: 'TaskWraith_write_file',
        kind: 'edit',
        rawInput: { path: '../outside.txt', content: 'UNTRUSTED' },
        _meta: { tool_name: 'TaskWraith_write_file', effect_kind: 'tool' }
      }
    },
    {
      label: 'conflicting structured identity',
      rawToolCall: {
        title: 'TaskWraith_write_file',
        kind: 'other',
        rawInput: {
          tool_name: 'OtherBroker__write_file',
          path: '../outside.txt',
          content: 'UNTRUSTED'
        },
        _meta: { tool_name: 'TaskWraith_write_file', effect_kind: 'tool' }
      }
    }
  ])('leaves $label on the non-broker permission path', ({ rawToolCall }) => {
    const request = permissionRequest(rawToolCall)
    const normalized = normalizeMistralVibePermissionRequest(request)

    expect(normalized.rawToolCall).toBe(request.rawToolCall)
    expect(resolveStructuredTaskWraithToolRequest(normalized, MISTRAL_NAMESPACES)).toBeNull()
  })
})

describe('shouldAdvertiseTaskWraithMcpToMistral', () => {
  it('lets signed UltraTask consent opt into the broker without changing ordinary runs', () => {
    expect(
      shouldAdvertiseTaskWraithMcpToMistral({
        taskWraithMcpAdvertised: false,
        advertiseEnabled: false,
        effectivePermissions: {
          subThreadDelegationAutoAllowSource: 'ultratask'
        } as EffectiveRunPermissions
      })
    ).toBe(true)
    expect(
      shouldAdvertiseTaskWraithMcpToMistral({
        taskWraithMcpAdvertised: false,
        advertiseEnabled: false
      })
    ).toBe(false)
    expect(
      shouldAdvertiseTaskWraithMcpToMistral({
        taskWraithMcpAdvertised: true,
        advertiseEnabled: true
      })
    ).toBe(true)
  })
})

describe('runMistralAcpTurn live steering continuity', () => {
  it('re-prompts Vibe with the already-delivered assistant tail and user steer', async () => {
    const child = new FakeAcpChild()
    const handle = runMistralAcpTurn({
      skipIntroduction: true,
      prompt: 'emit D001 through D300',
      cwd: '/tmp/workspace',
      appVersion: '1.9.6-test',
      spawnProcess: () => child,
      onEvent: () => {}
    })
    child.emit({ jsonrpc: '2.0', id: 1, result: { protocolVersion: 1 } })
    child.emit({ jsonrpc: '2.0', id: 2, result: { sessionId: 'session-1' } })
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
    child.emit({ jsonrpc: '2.0', id: 3, result: { stopReason: 'cancelled' } })

    const prompts = child.sent().filter((message) => message.method === 'session/prompt')
    expect(prompts).toHaveLength(2)
    const followUp = (prompts[1]?.params as { prompt?: Array<{ text?: string }> })?.prompt?.[0]
      ?.text
    expect(followUp).toContain(JSON.stringify('D176. Visible. D177. Visible.'))
    expect(followUp).toContain(JSON.stringify('continue at D178'))
    expect(followUp).toContain('do not repeat it')

    handle.cancel()
    await handle.closed
  })
})

describe('runMistralAcpTurn permission normalization', () => {
  it('correlates Vibe metadata-only progress before the Mistral permission handler runs', async () => {
    const child = new FakeAcpChild()
    const seen: AcpPermissionRequest[] = []
    const handle = runMistralAcpTurn({
      skipIntroduction: true,
      prompt: 'write the marker',
      cwd: '/tmp/workspace',
      appVersion: '1.9.2-test',
      spawnProcess: () => child,
      onEvent: () => {},
      onPermissionRequest: (request) => {
        seen.push(request)
        return resolveStructuredTaskWraithToolRequest(request, MISTRAL_NAMESPACES)
          ? 'allow'
          : 'deny'
      }
    })

    child.emit({ jsonrpc: '2.0', id: 1, result: { protocolVersion: 1 } })
    child.emit({ jsonrpc: '2.0', id: 2, result: { sessionId: 'session-1' } })
    child.emit({
      jsonrpc: '2.0',
      method: 'session/update',
      params: {
        sessionId: 'session-1',
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
        sessionId: 'session-1',
        toolCall: { toolCallId: 'vibe-write-1' },
        options: [
          { optionId: 'allow', name: 'Allow', kind: 'allow_once' },
          { optionId: 'reject', name: 'Reject', kind: 'reject_once' }
        ]
      }
    })
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(seen).toHaveLength(1)
    expect(seen[0]?.rawToolCall?.rawInput).toEqual({
      tool_name: 'TaskWraith__write_file'
    })
    expect(child.sent().find((message) => message.id === 9)).toMatchObject({
      result: { outcome: { outcome: 'selected', optionId: 'allow' } }
    })

    handle.cancel()
    await handle.closed
  })
})

/**
 * The seat's denied-tool recovery had NO test coverage at all until now, which
 * is how `9e70e36df` shipped a predicate that could not fire on the turns it
 * was written for and stayed green all the way to master. The two cases below
 * are the discriminating pair: together they make any future change to
 * `shouldRecover` impossible to land silently.
 */
const tick = (ms = 0): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

const promptFrames = (child: FakeAcpChild): Record<string, unknown>[] =>
  child.sent().filter((message) => message.method === 'session/prompt')

const promptText = (frame: Record<string, unknown> | undefined): string | undefined =>
  (frame?.params as { prompt?: Array<{ text?: string }> } | undefined)?.prompt?.[0]?.text

function runMistral(child: FakeAcpChild): {
  events: NormalizedGrokRunEvent[]
  handle: ReturnType<typeof runMistralAcpTurn>
} {
  const events: NormalizedGrokRunEvent[] = []
  const handle = runMistralAcpTurn({
    skipIntroduction: true,
    prompt: 'inspect the workspace',
    cwd: '/tmp/workspace',
    appVersion: '1.9.7-test',
    spawnProcess: () => child,
    onEvent: (event) => events.push(event)
  })
  return { events, handle }
}

const sessionReady = (child: FakeAcpChild): void => {
  child.emit({ jsonrpc: '2.0', id: 1, result: { protocolVersion: 1 } })
  child.emit({ jsonrpc: '2.0', id: 2, result: { sessionId: 'session-1' } })
}

describe('Mistral opening-to-work adapter', () => {
  it('keeps model selection and the working MCP route while the private terminal stays private', async () => {
    const children: FakeAcpChild[] = []
    const events: NormalizedGrokRunEvent[] = []
    const onClose = vi.fn()
    const servers = [{ name: 'TaskWraith', command: 'fixture', args: [], env: [] }]
    const handle = runMistralAcpTurn({
      prompt: 'Inspect and fix pricing.py, then verify it.',
      cwd: '/tmp/workspace',
      appVersion: '1.9.7-test',
      mcpServers: servers,
      sessionConfigOptions: [
        { configId: 'mode', value: 'ask' },
        { configId: 'model', value: 'glm-5-2' },
        { configId: 'thinking', value: 'high' }
      ],
      spawnProcess: () => {
        const child = new FakeAcpChild()
        children.push(child)
        return child
      },
      onEvent: (event) => events.push(event),
      onClose
    })
    const driveToPrompt = async (child: FakeAcpChild, sessionId: string) => {
      const seen = new Set<unknown>()
      const values: Record<string, string> = {
        mode: 'ask',
        model: 'mistral-medium-3.5',
        thinking: 'off'
      }
      const choices: Record<string, string[]> = {
        mode: ['ask', 'plan'],
        model: ['mistral-medium-3.5', 'glm-5-2'],
        thinking: ['off', 'high']
      }
      const configOptions = () =>
        Object.keys(values).map((id) => ({
          id,
          currentValue: values[id],
          options: choices[id].map((value) => ({ value }))
        }))
      for (let round = 0; round < 15; round += 1) {
        for (const frame of child.sent()) {
          if (frame.method === 'session/prompt') return frame
          if (frame.id === undefined || seen.has(frame.id)) continue
          seen.add(frame.id)
          const params = frame.params as Record<string, string>
          const result =
            frame.method === 'initialize'
              ? { protocolVersion: 1 }
              : frame.method === 'session/new'
                ? { sessionId, configOptions: configOptions() }
                : ((values[params.configId] = params.value), { configOptions: configOptions() })
          child.emit({ jsonrpc: '2.0', id: frame.id, result })
        }
        await tick()
      }
      throw new Error('No working prompt was submitted')
    }
    const emitText = (child: FakeAcpChild, sessionId: string, text: string, thinking = false) =>
      child.emit({
        jsonrpc: '2.0',
        method: 'session/update',
        params: {
          sessionId,
          update: {
            sessionUpdate: thinking ? 'agent_thought_chunk' : 'agent_message_chunk',
            content: { type: 'text', text }
          }
        }
      })
    try {
      const intro = children[0]
      const introPrompt = await driveToPrompt(intro, 'intro-session')
      expect(promptText(introPrompt)).toContain('separate working phase')
      expect(intro.sent().find((f) => f.method === 'session/new')?.params).toMatchObject({
        mcpServers: []
      })
      emitText(intro, 'intro-session', 'private introduction reasoning', true)
      emitText(
        intro,
        'intro-session',
        JSON.stringify({ opening: 'I will inspect pricing.py and verify the fix.' })
      )
      intro.emit({ jsonrpc: '2.0', id: introPrompt.id, result: { stopReason: 'end_turn' } })
      await vi.waitFor(() => expect(children).toHaveLength(2), { interval: 5, timeout: 1_000 })
      expect(onClose).not.toHaveBeenCalled()
      const work = children[1]
      const workPrompt = await driveToPrompt(work, 'work-session')
      expect(promptText(workPrompt)).toContain('Begin the actual work now')
      expect(promptText(workPrompt)).toContain('Inspect and fix pricing.py, then verify it.')
      expect(work.sent().find((f) => f.method === 'session/new')?.params).toMatchObject({
        mcpServers: servers
      })
      expect(
        work
          .sent()
          .filter((f) => f.method === 'session/set_config_option')
          .map((f) => f.params)
      ).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ configId: 'model', value: 'glm-5-2' }),
          expect.objectContaining({ configId: 'thinking', value: 'high' })
        ])
      )
      expect(events.some((event) => event.type === 'thinking')).toBe(false)
      expect(events[0]).toMatchObject({
        type: 'content',
        text: 'I will inspect pricing.py and verify the fix.\n\n'
      })
      emitText(work, 'work-session', 'working reasoning', true)
      emitText(work, 'work-session', 'Verified the fix.')
      work.emit({ jsonrpc: '2.0', id: workPrompt.id, result: { stopReason: 'end_turn' } })
      await handle.closed
      expect(onClose).toHaveBeenCalledExactlyOnceWith(0, true, 'end_turn')
      expect(
        events.filter((event) => event.type === 'thinking').map((event) => event.text)
      ).toEqual(['working reasoning'])
    } finally {
      handle.cancel()
      await handle.closed
    }
  })
})

const toolCall = (child: FakeAcpChild, toolCallId: string, title: string, kind: string): void => {
  child.emit({
    jsonrpc: '2.0',
    method: 'session/update',
    params: {
      sessionId: 'session-1',
      update: { sessionUpdate: 'tool_call', toolCallId, title, kind, rawInput: {} }
    }
  })
}

const toolResult = (
  child: FakeAcpChild,
  toolCallId: string,
  status: 'completed' | 'failed',
  output?: string
): void => {
  child.emit({
    jsonrpc: '2.0',
    method: 'session/update',
    params: {
      sessionId: 'session-1',
      update: {
        sessionUpdate: 'tool_call_update',
        toolCallId,
        status,
        // Real Vibe carries the outcome as an ACP content block, which is what
        // `acpToolContentToText` reads to populate `lastFailedToolOutput`.
        // Provider-authored rejection wording does not establish who decided.
        ...(output
          ? { content: [{ type: 'content', content: { type: 'text', text: output } }] }
          : {})
      }
    }
  })
}

const failedTool = (child: FakeAcpChild, output?: string): void => {
  toolCall(child, 'shell-1', 'execute', 'execute')
  toolResult(child, 'shell-1', 'failed', output)
}

const succeededTool = (child: FakeAcpChild, toolCallId: string): void => {
  toolCall(child, toolCallId, 'read_file', 'read')
  toolResult(child, toolCallId, 'completed', '100 lines')
}

/**
 * Maps to a `thinking` event, never `content` — so interposing these must NOT
 * satisfy `!assistantTextSeen`. Real failing runs carry several between the
 * rejected tool and the terminal.
 */
const thought = (child: FakeAcpChild, text: string): void => {
  child.emit({
    jsonrpc: '2.0',
    method: 'session/update',
    params: {
      sessionId: 'session-1',
      update: { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text } }
    }
  })
}

describe('runMistralAcpTurn denied-tool recovery', () => {
  it('continues once after a failed tool ends the turn with no assistant text', async () => {
    // THE case the revert says was silently dropped: tool failure + NO
    // assistant text + a clean `end_turn`. Measured against real runs, Vibe
    // terminates `end_turn` here — not `cancelled` — so a predicate gated on
    // the terminal status cannot fire, which is why this shape is the one that
    // has to be pinned.
    const child = new FakeAcpChild()
    const { events, handle } = runMistral(child)
    sessionReady(child)
    failedTool(child)
    // The failure is NOT adjacent to the terminal in a real run: Vibe keeps
    // working after it. Interposing successful tools and thought segments is
    // what makes `toolFailureSeen` stickiness load-bearing rather than an
    // accident of ordering.
    succeededTool(child, 'read-1')
    thought(child, 'The command failed, so I will read the files directly.')
    succeededTool(child, 'read-2')
    child.emit({ jsonrpc: '2.0', id: 3, result: { stopReason: 'end_turn' } })
    await tick(40)

    const prompts = promptFrames(child)
    expect(prompts).toHaveLength(2)
    expect(prompts[1]).toMatchObject({ id: 5, params: { sessionId: 'session-1' } })
    expect(promptText(prompts[1])).toBe(MISTRAL_TOOL_FAILURE_CONTINUITY_PROMPT)

    // Count pinned BEFORE reading the text, so a typo in the warning cannot
    // pass as an absence.
    const warnings = events.filter((event) => event.type === 'provider_warning')
    expect(warnings).toHaveLength(1)
    expect(warnings[0]?.text).toContain('Mistral stopped after a rejected or failed tool')
    expect(child.killed).toBe(false)

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
  })

  it('does not promote Vibe rejection wording into a human decision', async () => {
    const child = new FakeAcpChild()
    const { events, handle } = runMistral(child)
    sessionReady(child)
    failedTool(child, 'User rejected the tool call; provide an alternative plan')
    thought(child, 'Permission was refused; work from what is already readable.')
    succeededTool(child, 'read-1')
    child.emit({ jsonrpc: '2.0', id: 3, result: { stopReason: 'end_turn' } })
    await tick(40)

    const prompts = promptFrames(child)
    expect(prompts).toHaveLength(2)
    const recovery = promptText(prompts[1])
    expect(recovery).toBe(MISTRAL_UNATTRIBUTED_REFUSAL_CONTINUITY_PROMPT)
    expect(recovery).not.toBe(MISTRAL_USER_DECLINED_TOOL_CONTINUITY_PROMPT)
    // Both directions: the two prompts are different strings, so pinning only
    // one of them cannot show which branch ran.
    expect(recovery).not.toBe(MISTRAL_TOOL_FAILURE_CONTINUITY_PROMPT)
    expect(events.filter((event) => event.type === 'provider_warning')).toHaveLength(1)

    child.emit({ jsonrpc: '2.0', id: 5, result: { stopReason: 'end_turn' } })
    await handle.closed
  })

  it.each(['host-containment', 'host-policy', 'human'] as const)(
    'uses the exact %s decision receipt instead of Vibe wording',
    async (origin) => {
      const child = new FakeAcpChild()
      const events: NormalizedGrokRunEvent[] = []
      const onPermissionRefusal = vi.fn()
      const handle = runMistralAcpTurn({
        skipIntroduction: true,
        prompt: 'work',
        cwd: '/tmp/workspace',
        appVersion: 'test',
        spawnProcess: () => child,
        onEvent: (event) => events.push(event),
        onPermissionRequest: () => ({ decision: 'deny', origin, reason: 'Exact refusal reason.' }),
        onPermissionRefusal
      })
      sessionReady(child)
      toolCall(child, 'shell-1', 'bash', 'execute')
      child.emit({
        jsonrpc: '2.0',
        id: 9,
        method: 'session/request_permission',
        params: {
          sessionId: 'session-1',
          toolCall: { toolCallId: 'shell-1', title: 'bash', kind: 'execute' },
          options: permissionRequest({}).options
        }
      })
      await tick()
      toolResult(
        child,
        'shell-1',
        'failed',
        'User rejected the tool call; provide an alternative plan'
      )
      child.emit({ jsonrpc: '2.0', id: 3, result: { stopReason: 'end_turn' } })
      await tick(40)
      const recovery = promptText(promptFrames(child)[1])!
      expect(child.sent().find((frame) => frame.id === 9)).toMatchObject({
        result: { outcome: { optionId: 'reject' } }
      })
      expect(onPermissionRefusal).toHaveBeenCalledOnce()
      expect(events.find((event) => event.type === 'tool_result')?.toolOutput).toContain(
        'TaskWraith refusal receipt:'
      )
      if (origin === 'human') {
        expect(recovery).toBe(MISTRAL_USER_DECLINED_TOOL_CONTINUITY_PROMPT)
      } else {
        expect(recovery).toContain('no human was asked')
        expect(recovery).toContain('Exact refusal reason.')
        expect(recovery.includes('once through')).toBe(origin === 'host-containment')
      }
      // A reused id in the recovery prompt has no authority from the old call.
      failedTool(child, 'User rejected the tool call; provide an alternative plan')
      expect(onPermissionRefusal).toHaveBeenCalledOnce()
      expect(
        events.filter((event) => event.type === 'tool_result').at(-1)?.toolOutput
      ).not.toContain('TaskWraith refusal receipt:')
      child.emit({ jsonrpc: '2.0', id: 5, result: { stopReason: 'end_turn' } })
      await handle.closed
      expect(promptFrames(child)).toHaveLength(2)
    }
  )

  it('does not use an earlier native refusal to explain a later broker refusal', async () => {
    const child = new FakeAcpChild()
    const handle = runMistralAcpTurn({
      skipIntroduction: true,
      prompt: 'work',
      cwd: '/tmp/workspace',
      appVersion: 'test',
      spawnProcess: () => child,
      onEvent: () => {},
      onPermissionRequest: () => ({
        decision: 'deny',
        origin: 'host-containment',
        reason: 'Native shell is contained.'
      })
    })
    sessionReady(child)
    toolCall(child, 'shell-1', 'bash', 'execute')
    child.emit({
      jsonrpc: '2.0',
      id: 9,
      method: 'session/request_permission',
      params: {
        sessionId: 'session-1',
        toolCall: { toolCallId: 'shell-1' },
        options: permissionRequest({}).options
      }
    })
    await tick()
    toolResult(child, 'shell-1', 'failed', 'User rejected the tool call')
    toolCall(child, 'broker-2', 'TaskWraith_run_shell_command', 'other')
    toolResult(child, 'broker-2', 'failed', 'User rejected the tool call')
    child.emit({ jsonrpc: '2.0', id: 3, result: { stopReason: 'end_turn' } })
    await tick(40)
    expect(promptText(promptFrames(child)[1])).toContain('different tool calls')
    expect(promptText(promptFrames(child)[1])).toContain('Do not retry either side effect')
    child.emit({ jsonrpc: '2.0', id: 5, result: { stopReason: 'end_turn' } })
    await handle.closed
  })

  it('keeps the host origin when Vibe cancels without a tool result and audit projection fails', async () => {
    const child = new FakeAcpChild()
    const onPermissionRefusal = vi.fn(() => {
      throw new Error('projection failed')
    })
    const handle = runMistralAcpTurn({
      skipIntroduction: true,
      prompt: 'work',
      cwd: '/tmp/workspace',
      appVersion: 'test',
      spawnProcess: () => child,
      onEvent: () => {},
      onPermissionRefusal,
      onPermissionRequest: () => ({
        decision: 'deny',
        origin: 'host-containment',
        reason: 'No native sandbox.'
      })
    })
    sessionReady(child)
    toolCall(child, 'shell-1', 'bash', 'execute')
    child.emit({
      jsonrpc: '2.0',
      id: 9,
      method: 'session/request_permission',
      params: {
        sessionId: 'session-1',
        toolCall: { toolCallId: 'shell-1' },
        options: permissionRequest({}).options
      }
    })
    await tick()
    child.emit({ jsonrpc: '2.0', id: 3, result: { stopReason: 'cancelled' } })
    await tick(40)
    expect(onPermissionRefusal).toHaveBeenCalledOnce()
    expect(promptText(promptFrames(child)[1])).toContain('no human was asked')
    child.emit({ jsonrpc: '2.0', id: 5, result: { stopReason: 'end_turn' } })
    await handle.closed
  })

  it.each(['host-policy', 'human'] as const)(
    'keeps a later %s denial separate from an earlier containment failure without a second result',
    async (origin) => {
      const child = new FakeAcpChild()
      const onPermissionRefusal = vi.fn()
      const handle = runMistralAcpTurn({
        skipIntroduction: true,
        prompt: 'work',
        cwd: '/tmp/workspace',
        appVersion: 'test',
        spawnProcess: () => child,
        onEvent: () => {},
        onPermissionRefusal,
        onPermissionRequest: (request) => ({
          decision: 'deny',
          origin: request.rpcId === 9 ? 'host-containment' : origin,
          reason:
            request.rpcId === 9 ? 'A: no native sandbox.' : 'B: outside workspace or declined.'
        })
      })
      sessionReady(child)
      for (const [id, toolId] of [
        [9, 'a'],
        [10, 'b']
      ] as const) {
        toolCall(child, toolId, 'bash', 'execute')
        child.emit({
          jsonrpc: '2.0',
          id,
          method: 'session/request_permission',
          params: {
            sessionId: 'session-1',
            toolCall: { toolCallId: toolId },
            options: permissionRequest({}).options
          }
        })
        await tick()
        if (id === 9) toolResult(child, toolId, 'failed', 'User rejected the tool call')
      }
      child.emit({ jsonrpc: '2.0', id: 3, result: { stopReason: 'cancelled' } })
      await tick(40)
      const prompt = promptText(promptFrames(child)[1])!
      expect(prompt).toContain('different tool calls')
      expect(prompt).toContain('B: outside workspace or declined.')
      expect(prompt).toContain('Do not retry either side effect')
      expect(prompt).not.toContain('once through')
      expect(onPermissionRefusal.mock.calls.map(([request]) => request.rpcId)).toEqual([9, 10])
      child.emit({ jsonrpc: '2.0', id: 5, result: { stopReason: 'end_turn' } })
      await handle.closed
    }
  )

  it('audits a second transmitted denial even after the one-shot recovery is spent', async () => {
    const child = new FakeAcpChild()
    const onPermissionRefusal = vi.fn()
    const handle = runMistralAcpTurn({
      skipIntroduction: true,
      prompt: 'work',
      cwd: '/tmp/workspace',
      appVersion: 'test',
      spawnProcess: () => child,
      onEvent: () => {},
      onPermissionRefusal,
      onPermissionRequest: () => ({
        decision: 'deny',
        origin: 'host-policy',
        reason: 'Outside workspace.'
      })
    })
    sessionReady(child)
    for (const [id, promptId] of [
      [9, 3],
      [10, 5]
    ] as const) {
      toolCall(child, `call-${id}`, 'bash', 'execute')
      child.emit({
        jsonrpc: '2.0',
        id,
        method: 'session/request_permission',
        params: {
          sessionId: 'session-1',
          toolCall: { toolCallId: `call-${id}` },
          options: permissionRequest({}).options
        }
      })
      await tick()
      child.emit({ jsonrpc: '2.0', id: promptId, result: { stopReason: 'cancelled' } })
      await tick(40)
    }
    await handle.closed
    expect(onPermissionRefusal.mock.calls.map(([request]) => request.rpcId)).toEqual([9, 10])
    expect(promptFrames(child)).toHaveLength(2)
  })

  it('does not spend the recovery when nothing actually failed', async () => {
    // A turn that only made SUCCESSFUL tool calls and stopped without prose is
    // silent, not broken. Recovery here would re-prompt a model that had no
    // failure to recover from, and would do it on every such turn.
    const child = new FakeAcpChild()
    const { events, handle } = runMistral(child)
    sessionReady(child)
    child.emit({
      jsonrpc: '2.0',
      method: 'session/update',
      params: {
        sessionId: 'session-1',
        update: {
          sessionUpdate: 'tool_call',
          toolCallId: 'read-1',
          title: 'read_file',
          kind: 'read',
          rawInput: { path: 'src/main/thing.ts' }
        }
      }
    })
    child.emit({
      jsonrpc: '2.0',
      method: 'session/update',
      params: {
        sessionId: 'session-1',
        update: { sessionUpdate: 'tool_call_update', toolCallId: 'read-1', status: 'completed' }
      }
    })
    child.emit({ jsonrpc: '2.0', id: 3, result: { stopReason: 'end_turn' } })
    await handle.closed

    expect(promptFrames(child)).toHaveLength(1)
    expect(events.filter((event) => event.type === 'provider_warning')).toHaveLength(0)
  })

  it('does not spend the recovery when the answer already reached the user', async () => {
    // The mirror. Vibe narrates before it acts, so a turn that produced
    // assistant text has already reported to the user and must not be
    // re-prompted — this is the half `9e70e36df` would have started firing on.
    const child = new FakeAcpChild()
    const { events, handle } = runMistral(child)
    sessionReady(child)
    failedTool(child)
    child.emit({
      jsonrpc: '2.0',
      method: 'session/update',
      params: {
        sessionId: 'session-1',
        update: {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: 'The test command failed; here is what I found.' }
        }
      }
    })
    child.emit({ jsonrpc: '2.0', id: 3, result: { stopReason: 'end_turn' } })
    await handle.closed

    expect(promptFrames(child)).toHaveLength(1)
    expect(events.filter((event) => event.type === 'provider_warning')).toHaveLength(0)
  })
})
