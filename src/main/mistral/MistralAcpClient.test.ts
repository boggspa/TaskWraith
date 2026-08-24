import { describe, expect, it } from 'vitest'
import { resolveStructuredTaskWraithToolRequest } from '../grok/GrokMcpAdvertise'
import type { AcpPermissionRequest } from '../grok/GrokAcpProtocol'
import {
  formatMistralSteerPrompt,
  mistralTaskWraithBrokerToolRequested,
  normalizeMistralVibePermissionRequest,
  runMistralAcpTurn,
  shouldAdvertiseTaskWraithMcpToMistral,
  type AcpChildProcess
} from './MistralAcpClient'
import type { EffectiveRunPermissions } from '../store/types'

const MISTRAL_NAMESPACES = ['taskwraith-mistral', 'TaskWraith'] as const

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

    expect(normalized).toBe(request)
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
