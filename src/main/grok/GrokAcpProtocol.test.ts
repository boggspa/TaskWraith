import { describe, it, expect } from 'vitest'
import {
  encodeAcpFrame,
  parseAcpStreamChunk,
  acpMessageToRunEvents,
  isAcpPermissionRequest,
  parseAcpPermissionRequest,
  selectAcpPermissionOption,
  buildAcpPermissionResponse,
  grokToolKindToService,
  type AcpPermissionOption
} from './GrokAcpProtocol'

describe('encodeAcpFrame', () => {
  it('serializes a JSON-RPC request as one NDJSON line', () => {
    const frame = encodeAcpFrame({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} })
    expect(frame.endsWith('\n')).toBe(true)
    expect(JSON.parse(frame.trim())).toEqual({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {}
    })
  })
})

describe('parseAcpStreamChunk', () => {
  it('parses NDJSON messages and carries a partial trailing line', () => {
    const first = parseAcpStreamChunk('{"jsonrpc":"2.0","id":1,"result":{}}\n{"jsonrpc":"2.', '')
    expect(first.messages).toHaveLength(1)
    expect(first.messages[0]).toEqual({ jsonrpc: '2.0', id: 1, result: {} })
    expect(first.carry).toBe('{"jsonrpc":"2.')
    const second = parseAcpStreamChunk('0","method":"session/update","params":{}}\n', first.carry)
    expect(second.messages[0]).toEqual({
      jsonrpc: '2.0',
      method: 'session/update',
      params: {}
    })
    expect(second.carry).toBe('')
  })

  it('skips non-JSON noise lines', () => {
    const { messages } = parseAcpStreamChunk('not json\n{"jsonrpc":"2.0","id":9,"result":{}}\n', '')
    expect(messages).toEqual([{ jsonrpc: '2.0', id: 9, result: {} }])
  })
})

describe('acpMessageToRunEvents', () => {
  it('maps an agent_message_chunk to a content event', () => {
    const events = acpMessageToRunEvents({
      jsonrpc: '2.0',
      method: 'session/update',
      params: {
        sessionId: 's1',
        update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Hi' } }
      }
    })
    expect(events).toEqual([{ type: 'content', text: 'Hi', raw: expect.anything() }])
  })

  it('maps an agent_thought_chunk to a thinking event', () => {
    const events = acpMessageToRunEvents({
      jsonrpc: '2.0',
      method: 'session/update',
      params: {
        sessionId: 's1',
        update: { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'Hmm.' } }
      }
    })
    expect(events).toEqual([{ type: 'thinking', text: 'Hmm.', raw: expect.anything() }])
  })

  it('ignores command/model update notifications', () => {
    expect(
      acpMessageToRunEvents({
        jsonrpc: '2.0',
        method: 'session/update',
        params: { sessionId: 's1', update: { sessionUpdate: 'available_commands_update' } }
      })
    ).toEqual([])
  })

  it('captures the session id from a session/new result', () => {
    const events = acpMessageToRunEvents({
      jsonrpc: '2.0',
      id: 2,
      result: {
        sessionId: '019e70a1-3763-7c93-a1b4-f02d31596701',
        models: { currentModelId: 'grok-build' }
      }
    })
    expect(events).toEqual([
      { type: 'init', sessionId: '019e70a1-3763-7c93-a1b4-f02d31596701', raw: expect.anything() }
    ])
  })

  it('maps the session/prompt result (stopReason in _meta) to a result event', () => {
    const events = acpMessageToRunEvents({
      jsonrpc: '2.0',
      id: 3,
      result: {
        stopReason: 'end_turn',
        _meta: { sessionId: 's1', requestId: 'r1', promptId: 'p1' }
      }
    })
    expect(events).toEqual([
      { type: 'init', sessionId: 's1', raw: expect.anything() },
      { type: 'result', status: 'end_turn', sessionId: 's1', raw: expect.anything() }
    ])
  })

  it('maps the _x.ai prompt_complete notification to a result event', () => {
    const events = acpMessageToRunEvents({
      jsonrpc: '2.0',
      method: '_x.ai/session/prompt_complete',
      params: { sessionId: 's1', stopReason: 'end_turn', agentResult: null }
    })
    expect(events).toEqual([{ type: 'result', status: 'end_turn', raw: expect.anything() }])
  })

  it('maps a JSON-RPC error to a provider_warning', () => {
    const events = acpMessageToRunEvents({
      jsonrpc: '2.0',
      id: 3,
      error: { code: -32000, message: 'boom' }
    })
    expect(events[0].type).toBe('provider_warning')
    expect(events[0].text).toBe('boom')
  })

  it('reconstructs the assistant answer from a real ACP update stream', () => {
    // Shape captured from grok 0.2.8 `agent stdio` (G1 spike).
    const stream = [
      {
        method: 'session/update',
        params: {
          update: {
            sessionUpdate: 'agent_thought_chunk',
            content: { type: 'text', text: 'Greeting.' }
          }
        }
      },
      {
        method: 'session/update',
        params: {
          update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Hi' } }
        }
      },
      {
        method: 'session/update',
        params: {
          update: {
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'text', text: '! How can I help?' }
          }
        }
      },
      { method: '_x.ai/session/prompt_complete', params: { stopReason: 'end_turn' } }
    ]
    const answer = stream
      .flatMap((m) => acpMessageToRunEvents(m as Record<string, unknown>))
      .filter((evt) => evt.type === 'content')
      .map((evt) => evt.text)
      .join('')
    expect(answer).toBe('Hi! How can I help?')
  })
})

describe('G4c — ACP tool_call / tool_call_update → tool-card run events', () => {
  const toolUpdate = (update: Record<string, unknown>) => ({
    jsonrpc: '2.0',
    method: 'session/update',
    params: { sessionId: 's1', update }
  })

  it('maps a pending tool_call to a tool_use activity (card opens)', () => {
    expect(
      acpMessageToRunEvents(
        toolUpdate({
          sessionUpdate: 'tool_call',
          toolCallId: 'call_1',
          title: 'Write file x.swift',
          kind: 'edit',
          status: 'pending',
          rawInput: { path: 'x.swift' }
        })
      )
    ).toEqual([
      {
        type: 'tool_use',
        toolId: 'call_1',
        toolName: 'Write file x.swift',
        toolKind: 'edit',
        toolInput: { path: 'x.swift' },
        raw: expect.anything()
      }
    ])
  })

  it('maps a tool_call that arrives already-completed to use + result', () => {
    const events = acpMessageToRunEvents(
      toolUpdate({
        sessionUpdate: 'tool_call',
        toolCallId: 'call_2',
        kind: 'read',
        status: 'completed',
        content: [{ type: 'content', content: { type: 'text', text: 'file body' } }]
      })
    )
    expect(events).toEqual([
      {
        type: 'tool_use',
        toolId: 'call_2',
        toolName: 'read',
        toolKind: 'read',
        toolInput: {},
        raw: expect.anything()
      },
      {
        type: 'tool_result',
        toolId: 'call_2',
        toolStatus: 'success',
        toolOutput: 'file body',
        raw: expect.anything()
      }
    ])
  })

  it('maps a completed tool_call_update to a tool_result (card closes)', () => {
    expect(
      acpMessageToRunEvents(
        toolUpdate({
          sessionUpdate: 'tool_call_update',
          toolCallId: 'call_1',
          status: 'completed',
          content: [{ type: 'content', content: { type: 'text', text: 'ok' } }]
        })
      )
    ).toEqual([
      {
        type: 'tool_result',
        toolId: 'call_1',
        toolStatus: 'success',
        toolOutput: 'ok',
        raw: expect.anything()
      }
    ])
  })

  it('flags a failed tool_call_update as an errored result', () => {
    const events = acpMessageToRunEvents(
      toolUpdate({ sessionUpdate: 'tool_call_update', toolCallId: 'call_3', status: 'failed' })
    )
    expect(events).toEqual([
      {
        type: 'tool_result',
        toolId: 'call_3',
        toolStatus: 'error',
        toolOutput: '',
        raw: expect.anything()
      }
    ])
  })

  it('emits nothing for a non-terminal tool_call_update (in_progress)', () => {
    expect(
      acpMessageToRunEvents(
        toolUpdate({
          sessionUpdate: 'tool_call_update',
          toolCallId: 'call_1',
          status: 'in_progress'
        })
      )
    ).toEqual([])
  })

  /**
   * ACP carries file edits in a `{type:'diff', path, oldText, newText}` content
   * block as well as in `rawInput` — and an agent may send ONLY the block.
   * Mistral Vibe does exactly that when it omits rawInput (see the retained
   * tool-call merge in AcpTurnClient). The block used to be flattened to the
   * literal string "(diff path)" and thrown away, so those edits reached the
   * transcript with no `+N -N` pill and no file target at all.
   */
  describe('file-edit diff content blocks', () => {
    it('recovers path and edit text when the agent sends no rawInput', () => {
      const [use] = acpMessageToRunEvents(
        toolUpdate({
          sessionUpdate: 'tool_call',
          toolCallId: 'call_d1',
          title: 'Edit main.py',
          kind: 'edit',
          status: 'pending',
          content: [{ type: 'diff', path: '/ws/src/main.py', oldText: 'a\nb', newText: 'a\nb\nc' }]
        })
      )

      expect(use).toMatchObject({
        type: 'tool_use',
        toolId: 'call_d1',
        toolKind: 'edit',
        // Canonical snake_case: the names every downstream diff parser reads.
        toolInput: {
          file_path: '/ws/src/main.py',
          old_string: 'a\nb',
          new_string: 'a\nb\nc'
        }
      })
    })

    it('maps a create-shaped block (no prior text) to whole-file content', () => {
      const [use] = acpMessageToRunEvents(
        toolUpdate({
          sessionUpdate: 'tool_call',
          toolCallId: 'call_d2',
          title: 'Write notes.md',
          kind: 'edit',
          status: 'pending',
          content: [{ type: 'diff', path: 'notes.md', oldText: null, newText: 'one\ntwo' }]
        })
      )

      // Additions-only is the honest reading: the block states no prior text.
      expect(use.toolInput).toEqual({ file_path: 'notes.md', content: 'one\ntwo' })
    })

    it('never overwrites arguments the agent did send', () => {
      const [use] = acpMessageToRunEvents(
        toolUpdate({
          sessionUpdate: 'tool_call',
          toolCallId: 'call_d3',
          kind: 'edit',
          status: 'pending',
          rawInput: { file_path: 'real.py', old_string: 'keep', new_string: 'kept' },
          content: [{ type: 'diff', path: 'other.py', oldText: 'x', newText: 'y' }]
        })
      )

      expect(use.toolInput).toEqual({
        file_path: 'real.py',
        old_string: 'keep',
        new_string: 'kept'
      })
    })

    it('accepts snake_case block fields and leaves non-diff calls untouched', () => {
      const [snake] = acpMessageToRunEvents(
        toolUpdate({
          sessionUpdate: 'tool_call',
          toolCallId: 'call_d4',
          kind: 'edit',
          status: 'pending',
          content: [{ type: 'diff', path: 'a.ts', old_text: 'p', new_text: 'p\nq' }]
        })
      )
      expect(snake.toolInput).toEqual({ file_path: 'a.ts', old_string: 'p', new_string: 'p\nq' })

      const [plain] = acpMessageToRunEvents(
        toolUpdate({
          sessionUpdate: 'tool_call',
          toolCallId: 'call_d5',
          kind: 'execute',
          status: 'pending',
          content: [{ type: 'content', content: { type: 'text', text: 'hello' } }]
        })
      )
      expect(plain.toolInput).toEqual({})
    })
  })
})

describe('G5 — session/request_permission (client-mediated approvals)', () => {
  const permissionRequest = (id: number | string = 7) => ({
    jsonrpc: '2.0',
    id,
    method: 'session/request_permission',
    params: {
      sessionId: 'sess_1',
      toolCall: { toolCallId: 'tc_1', title: 'Write file src/x.ts', kind: 'edit' },
      options: [
        { optionId: 'opt_allow_once', name: 'Allow once', kind: 'allow_once' },
        { optionId: 'opt_allow_always', name: 'Always allow', kind: 'allow_always' },
        { optionId: 'opt_reject_once', name: 'Reject', kind: 'reject_once' }
      ]
    }
  })

  it('detects an inbound permission request (and nothing else)', () => {
    expect(isAcpPermissionRequest(permissionRequest())).toBe(true)
    // A streaming notification / response is not a permission request.
    expect(isAcpPermissionRequest({ method: 'session/update', params: {} })).toBe(false)
    expect(isAcpPermissionRequest({ id: 2, result: {} })).toBe(false)
    // Must carry a usable JSON-RPC id to be answerable.
    expect(isAcpPermissionRequest({ method: 'session/request_permission' })).toBe(false)
  })

  it('parses the request into a structured descriptor', () => {
    const parsed = parseAcpPermissionRequest(permissionRequest('req-9'))
    expect(parsed).toMatchObject({
      rpcId: 'req-9',
      sessionId: 'sess_1',
      toolName: 'Write file src/x.ts',
      toolKind: 'edit'
    })
    expect(parsed?.options.map((o) => o.kind)).toEqual([
      'allow_once',
      'allow_always',
      'reject_once'
    ])
  })

  it('returns null for non-permission messages + tolerates missing options', () => {
    expect(parseAcpPermissionRequest({ method: 'session/update' })).toBeNull()
    const noOptions = parseAcpPermissionRequest({
      jsonrpc: '2.0',
      id: 1,
      method: 'session/request_permission',
      params: { sessionId: 's' }
    })
    expect(noOptions?.options).toEqual([])
    expect(noOptions?.toolName).toBe('tool')
  })

  it('selects allow_once for allow, reject_once for deny, null otherwise', () => {
    const opts: AcpPermissionOption[] = [
      { optionId: 'a1', name: 'Allow once', kind: 'allow_once' },
      { optionId: 'a2', name: 'Always', kind: 'allow_always' },
      { optionId: 'r1', name: 'Reject', kind: 'reject_once' }
    ]
    expect(selectAcpPermissionOption(opts, 'allow')).toBe('a1')
    expect(selectAcpPermissionOption(opts, 'deny')).toBe('r1')
    expect(selectAcpPermissionOption(opts, 'cancel')).toBeNull()
    // Falls back to any allow* / reject* when the one-shot variant is absent.
    expect(selectAcpPermissionOption([opts[1]], 'allow')).toBe('a2')
    // No matching option → null (the builder turns this into 'cancelled').
    expect(selectAcpPermissionOption([opts[2]], 'allow')).toBeNull()
  })

  it('maps ACP tool kinds to the right approval-ledger service (unknown → strictest)', () => {
    expect(grokToolKindToService('execute')).toBe('shellCommands')
    expect(grokToolKindToService('edit')).toBe('fileChanges')
    expect(grokToolKindToService('write')).toBe('fileChanges')
    expect(grokToolKindToService('delete')).toBe('fileChanges')
    expect(grokToolKindToService('move')).toBe('fileChanges')
    expect(grokToolKindToService('fetch')).toBe('mcpTools')
    expect(grokToolKindToService('search')).toBe('mcpTools')
    // Unknown / read-ish / empty → shellCommands (the strictest 'ask' bucket),
    // never a free pass.
    expect(grokToolKindToService('read')).toBe('shellCommands')
    expect(grokToolKindToService('think')).toBe('shellCommands')
    expect(grokToolKindToService('other')).toBe('shellCommands')
    expect(grokToolKindToService('')).toBe('shellCommands')
    expect(grokToolKindToService(undefined)).toBe('shellCommands')
  })

  it('builds a selected response for allow, cancelled for deny/cancel/no-match', () => {
    const { options } = parseAcpPermissionRequest(permissionRequest(7))!
    expect(buildAcpPermissionResponse(7, options, 'allow')).toEqual({
      jsonrpc: '2.0',
      id: 7,
      result: { outcome: { outcome: 'selected', optionId: 'opt_allow_once' } }
    })
    // Deny SELECTS the reject option (that's how ACP signals a denial back to
    // the agent) — distinct from cancel, which sends no decision.
    expect(buildAcpPermissionResponse(7, options, 'deny')).toEqual({
      jsonrpc: '2.0',
      id: 7,
      result: { outcome: { outcome: 'selected', optionId: 'opt_reject_once' } }
    })
    expect(buildAcpPermissionResponse(7, options, 'cancel')).toEqual({
      jsonrpc: '2.0',
      id: 7,
      result: { outcome: { outcome: 'cancelled' } }
    })
    // SAFETY: an allow decision with NO allow option available can never
    // resolve to a selected/allow — it cancels instead of silently approving.
    const rejectOnly: AcpPermissionOption[] = [
      { optionId: 'r1', name: 'Reject', kind: 'reject_once' }
    ]
    expect(buildAcpPermissionResponse(7, rejectOnly, 'allow')).toEqual({
      jsonrpc: '2.0',
      id: 7,
      result: { outcome: { outcome: 'cancelled' } }
    })
  })
})
