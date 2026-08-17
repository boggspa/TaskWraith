import { describe, expect, it } from 'vitest'
import {
  PiRpcTurnReducer,
  parsePiStreamChunk,
  piAbortCommand,
  piPromptCommand,
  piSteerCommand,
  piToolKind,
  piUsageToStats,
  type PiStreamLine
} from './PiRpc'

function jsonLine(value: Record<string, unknown>): PiStreamLine {
  return { json: value }
}

/**
 * Tool-call blocks are held until the burst ends so a forked, nameless block
 * can hand its arguments back. Any following line releases them; Pi always
 * sends one (message_end/tool_execution_start/turn_end/agent_settled) before
 * anything executes.
 */
function flushLine(): PiStreamLine {
  return jsonLine({ type: 'tool_execution_start' })
}

function toolCallEndLine(toolCall: Record<string, unknown>): PiStreamLine {
  return jsonLine({
    type: 'message_update',
    assistantMessageEvent: { type: 'toolcall_end', toolCall }
  })
}

describe('parsePiStreamChunk', () => {
  it('splits NDJSON and carries partial trailing lines across chunks', () => {
    const first = parsePiStreamChunk('{"type":"agent_start"}\n{"type":"turn_st', '')
    expect(first.lines).toHaveLength(1)
    expect(first.lines[0]?.json?.type).toBe('agent_start')
    expect(first.carry).toBe('{"type":"turn_st')

    const second = parsePiStreamChunk('art"}\n', first.carry)
    expect(second.lines).toHaveLength(1)
    expect(second.lines[0]?.json?.type).toBe('turn_start')
    expect(second.carry).toBe('')
  })

  it('passes through non-JSON noise without throwing', () => {
    const { lines } = parsePiStreamChunk('not json at all\n{"type":"agent_settled"}\n', '')
    expect(lines).toHaveLength(2)
    expect(lines[0]?.nonJson).toBe('not json at all')
    expect(lines[1]?.json?.type).toBe('agent_settled')
  })
})

describe('piToolKind', () => {
  it('maps built-ins to AD3 kinds and leaves unknowns undefined', () => {
    expect(piToolKind('read')).toBe('read')
    expect(piToolKind('bash')).toBe('execute')
    expect(piToolKind('edit')).toBe('edit')
    expect(piToolKind('grep')).toBe('search')
    expect(piToolKind('mystery')).toBeUndefined()
  })
})

describe('piUsageToStats', () => {
  it('preserves aggregate billing counters when no atomic invocation is available', () => {
    expect(
      piUsageToStats({
        inputTokens: 3000,
        outputTokens: 200,
        cacheReadTokens: 10,
        cacheWriteTokens: 2,
        costUsd: 0.03
      })
    ).toEqual({
      input_tokens: 3000,
      output_tokens: 200,
      cache_read_input_tokens: 10,
      cache_creation_input_tokens: 2,
      total_cost_usd: 0.03
    })
  })

  it('keeps aggregate spend separate from the final invocation context', () => {
    const stats = piUsageToStats(
      {
        inputTokens: 3000,
        outputTokens: 200,
        cacheReadTokens: 10,
        cacheWriteTokens: 4,
        costUsd: 0.03
      },
      {
        inputTokens: 2000,
        outputTokens: 150,
        cacheReadTokens: 5,
        cacheWriteTokens: 2,
        costUsd: 0.02
      }
    )

    expect(stats).toMatchObject({
      input_tokens: 3000,
      output_tokens: 200,
      cache_read_input_tokens: 10,
      cache_creation_input_tokens: 4,
      total_cost_usd: 0.03,
      _taskwraith_context_usage: {
        contextTokens: 2157,
        inputTokens: 2007,
        freshInputTokens: 2000,
        cacheReadInputTokens: 5,
        cacheCreationInputTokens: 2,
        outputTokens: 150,
        source: 'provider-last-invocation',
        precision: 'exact'
      }
    })
  })
})

describe('PiRpcTurnReducer', () => {
  it('streams text and thinking deltas as content/thinking events', () => {
    const reducer = new PiRpcTurnReducer()
    const thinking = reducer.ingest(
      jsonLine({
        type: 'message_update',
        assistantMessageEvent: { type: 'thinking_delta', delta: 'pondering' }
      })
    )
    expect(thinking).toEqual([expect.objectContaining({ type: 'thinking', text: 'pondering' })])

    const content = reducer.ingest(
      jsonLine({
        type: 'message_update',
        assistantMessageEvent: { type: 'text_delta', delta: 'Hello ' }
      })
    )
    expect(content).toEqual([expect.objectContaining({ type: 'content', text: 'Hello ' })])
  })

  it('parses JSON-string tool arguments instead of dropping the command', () => {
    // Mistral's OpenAI-shaped API sends `arguments` as a JSON STRING, not an
    // object. asRecord() rejected the string, so toolInput was omitted entirely
    // and run_shell_command arrived with no `command` — the harness then failed
    // closed on a call whose arguments we had silently discarded. Observed on a
    // Mistral GLM-5.2 seat, which read it as the command being "stripped".
    const reducer = new PiRpcTurnReducer()
    reducer.ingest(
      toolCallEndLine({
        id: 'call-str',
        name: 'run_shell_command',
        arguments: '{"command":"git status --porcelain"}'
      })
    )
    const use = reducer.ingest(flushLine())
    expect(use).toEqual([
      expect.objectContaining({
        type: 'tool_use',
        toolId: 'call-str',
        toolName: 'run_shell_command',
        toolInput: { command: 'git status --porcelain' }
      })
    ])
  })

  it('keeps a tool call usable when its string arguments are unparseable', () => {
    // Fail soft, not silent: an argument blob we cannot parse must still
    // announce the call so the seat sees a refusal it can act on, rather than a
    // call that looks argument-less.
    const reducer = new PiRpcTurnReducer()
    reducer.ingest(
      toolCallEndLine({ id: 'call-bad', name: 'run_shell_command', arguments: '{not json' })
    )
    const use = reducer.ingest(flushLine())
    expect(use).toEqual([
      expect.objectContaining({ type: 'tool_use', toolId: 'call-bad', toolName: 'run_shell_command' })
    ])
  })

  it('hands a forked nameless block its arguments back instead of announcing two calls', () => {
    // Pi's mistral-conversations accumulator keys on `${callId}:${index}`, and
    // Mistral's continuation deltas carry `id: "null"` / `name: ""` — a
    // different key, so the arguments fork into a second, nameless block while
    // the named one keeps `{}`. Captured verbatim from a Mistral GLM-5.2 run:
    // the named call was refused ("must have required properties command") and
    // the fork was refused as `Tool  not found`.
    const reducer = new PiRpcTurnReducer()
    reducer.ingest(
      toolCallEndLine({
        id: 'chatcmpl-tool-8c5da23850ab7ca1',
        name: 'run_shell_command',
        arguments: {}
      })
    )
    reducer.ingest(
      toolCallEndLine({ id: 'toolcall0', name: '', arguments: { command: 'echo hello world' } })
    )
    const use = reducer.ingest(flushLine())
    expect(use).toEqual([
      expect.objectContaining({
        type: 'tool_use',
        toolId: 'chatcmpl-tool-8c5da23850ab7ca1',
        toolName: 'run_shell_command',
        toolInput: { command: 'echo hello world' }
      })
    ])
  })

  it('drops the forked block without disturbing a call whose own arguments survived', () => {
    // The other half of the coin flip: the packet boundaries put the arguments
    // on the named block and the fork came through empty. The named call must
    // keep exactly what it had.
    const reducer = new PiRpcTurnReducer()
    reducer.ingest(
      toolCallEndLine({ id: 'call-ok', name: 'run_shell_command', arguments: { command: 'swift' } })
    )
    reducer.ingest(toolCallEndLine({ id: 'toolcall0', name: '', arguments: {} }))
    const use = reducer.ingest(flushLine())
    expect(use).toEqual([
      expect.objectContaining({
        type: 'tool_use',
        toolId: 'call-ok',
        toolName: 'run_shell_command',
        toolInput: { command: 'swift' }
      })
    ])
  })

  it('pairs each fork with its own call when several run in one turn', () => {
    const reducer = new PiRpcTurnReducer()
    reducer.ingest(toolCallEndLine({ id: 'call-a', name: 'read', arguments: {} }))
    reducer.ingest(toolCallEndLine({ id: 'call-b', name: 'grep', arguments: {} }))
    reducer.ingest(toolCallEndLine({ id: 'toolcall0', name: '', arguments: { path: 'a.ts' } }))
    reducer.ingest(toolCallEndLine({ id: 'toolcall1', name: '', arguments: { pattern: 'x' } }))
    const use = reducer.ingest(flushLine())
    // Each fork claims the earliest call still waiting, so the arguments
    // cannot be swapped between two parallel calls.
    expect(use).toEqual([
      expect.objectContaining({ toolId: 'call-a', toolName: 'read', toolInput: { path: 'a.ts' } }),
      expect.objectContaining({ toolId: 'call-b', toolName: 'grep', toolInput: { pattern: 'x' } })
    ])
  })

  it('suppresses the dead result of a fork it never announced', () => {
    // Without the managed extension Pi still dispatches the fork and answers
    // `Tool  not found`. That result has no row to attach to, so it must not
    // reach the transcript as an orphan failure.
    const reducer = new PiRpcTurnReducer()
    reducer.ingest(toolCallEndLine({ id: 'call-1', name: 'run_shell_command', arguments: {} }))
    reducer.ingest(toolCallEndLine({ id: 'toolcall0', name: '', arguments: { command: 'pwd' } }))
    reducer.ingest(flushLine())
    const orphan = reducer.ingest(
      jsonLine({
        type: 'tool_execution_end',
        toolCallId: 'toolcall0',
        toolName: '',
        isError: true,
        result: { content: [{ type: 'text', text: 'Tool  not found' }] }
      })
    )
    expect(orphan).toEqual([])

    const real = reducer.ingest(
      jsonLine({
        type: 'tool_execution_end',
        toolCallId: 'call-1',
        toolName: 'run_shell_command',
        isError: false,
        output: 'Exit code: 0'
      })
    )
    expect(real).toEqual([
      expect.objectContaining({ type: 'tool_result', toolId: 'call-1', toolStatus: 'success' })
    ])
  })

  it('emits tool_use on toolcall_end and tool_result on tool_execution_end', () => {
    const reducer = new PiRpcTurnReducer()
    reducer.ingest(toolCallEndLine({ id: 'call-1', name: 'bash', arguments: { command: 'ls' } }))
    const use = reducer.ingest(flushLine())
    expect(use).toEqual([
      expect.objectContaining({
        type: 'tool_use',
        toolId: 'call-1',
        toolName: 'bash',
        toolKind: 'execute',
        toolInput: { command: 'ls' }
      })
    ])

    const result = reducer.ingest(
      jsonLine({
        type: 'tool_execution_end',
        toolCallId: 'call-1',
        toolName: 'bash',
        isError: false,
        output: 'README.md'
      })
    )
    expect(result).toEqual([
      expect.objectContaining({
        type: 'tool_result',
        toolId: 'call-1',
        toolStatus: 'success',
        toolOutput: 'README.md'
      })
    ])
  })

  it('sums usage across multiple turn_end events and reports it at settle', () => {
    const reducer = new PiRpcTurnReducer()
    const turnEnd = (input: number, output: number, cost: number): PiStreamLine =>
      jsonLine({
        type: 'turn_end',
        message: {
          usage: {
            input,
            output,
            cacheRead: 5,
            cacheWrite: 0,
            cost: { total: cost }
          }
        }
      })
    reducer.ingest(turnEnd(1000, 50, 0.01))
    reducer.ingest(turnEnd(2000, 150, 0.02))
    const settled = reducer.ingest(jsonLine({ type: 'agent_settled' }))
    expect(settled).toHaveLength(1)
    expect(settled[0]).toMatchObject({
      type: 'result',
      status: 'success',
      usage: {
        inputTokens: 3000,
        outputTokens: 200,
        cacheReadTokens: 10,
        cacheWriteTokens: 0
      },
      lastUsage: {
        inputTokens: 2000,
        outputTokens: 150,
        cacheReadTokens: 5,
        cacheWriteTokens: 0
      }
    })
    expect(settled[0]?.usage?.costUsd).toBeCloseTo(0.03)
    expect(reducer.isSettled).toBe(true)
    expect(reducer.terminalOutcome()).toMatchObject({ failed: false, status: 'success' })
  })

  it('captures session id and model label from get_state responses', () => {
    const reducer = new PiRpcTurnReducer()
    reducer.ingest(
      jsonLine({
        type: 'response',
        command: 'get_state',
        success: true,
        data: { sessionId: 'sess-9', model: { name: 'DeepSeek V4 Pro' } }
      })
    )
    const settled = reducer.ingest(jsonLine({ type: 'agent_settled' }))
    expect(settled[0]).toMatchObject({ sessionId: 'sess-9', model: 'DeepSeek V4 Pro' })
  })

  it('treats a rejected prompt command as a terminal failure', () => {
    const reducer = new PiRpcTurnReducer()
    const warned = reducer.ingest(
      jsonLine({ type: 'response', command: 'prompt', success: false, error: 'Model not found' })
    )
    expect(warned).toEqual([expect.objectContaining({ type: 'provider_warning' })])
    const settled = reducer.ingest(jsonLine({ type: 'agent_settled' }))
    expect(settled[0]).toMatchObject({ type: 'result', status: 'error' })
    expect(reducer.terminalOutcome()).toMatchObject({ failed: true, subtype: 'error' })
    expect(reducer.terminalOutcome().text).toContain('Model not found')
  })

  it('marks assistant error deltas failed and aborted reasons as aborted', () => {
    const errored = new PiRpcTurnReducer()
    errored.ingest(
      jsonLine({
        type: 'message_update',
        assistantMessageEvent: { type: 'error', reason: 'error', error: '401 unauthorized' }
      })
    )
    errored.ingest(jsonLine({ type: 'agent_settled' }))
    expect(errored.terminalOutcome()).toMatchObject({ failed: true })
    expect(errored.failureText).toContain('401')

    const aborted = new PiRpcTurnReducer()
    const settled = aborted.ingest(
      jsonLine({
        type: 'message_update',
        assistantMessageEvent: { type: 'error', reason: 'aborted' }
      })
    )
    expect(settled).toHaveLength(1)
    aborted.ingest(jsonLine({ type: 'agent_settled' }))
    expect(aborted.terminalOutcome().failed).toBe(true)
  })

  it('surfaces auto-retry as warnings and keeps final retry failures', () => {
    const reducer = new PiRpcTurnReducer()
    const warned = reducer.ingest(
      jsonLine({ type: 'auto_retry_start', attempt: 1, maxAttempts: 3, errorMessage: '529 overloaded' })
    )
    expect(warned[0]?.type).toBe('provider_warning')
    expect(warned[0]?.text).toContain('529 overloaded')

    reducer.ingest(jsonLine({ type: 'auto_retry_end', success: false, finalError: '529 gave up' }))
    reducer.ingest(jsonLine({ type: 'agent_settled' }))
    expect(reducer.terminalOutcome()).toMatchObject({ failed: true })
    expect(reducer.terminalOutcome().text).toContain('529 gave up')
  })

  // ── Shapes captured from a LIVE pi 0.82.1 run (see PiRpc.ts comments) ──
  it('fails the turn when the assistant message carries stopReason error', () => {
    // Live-verified: a 401 emits NO message_update error delta. The only
    // failure signal is on the assistant message, and without this the turn
    // settled as SUCCESS with empty text.
    const reducer = new PiRpcTurnReducer()
    const warned = reducer.ingest(
      jsonLine({
        type: 'turn_end',
        message: {
          role: 'assistant',
          content: [],
          stopReason: 'error',
          errorMessage: '401: {"message":"Authentication Fails","type":"authentication_error"}',
          usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: { total: 0 } }
        }
      })
    )
    expect(warned).toEqual([
      expect.objectContaining({ type: 'provider_warning', text: expect.stringContaining('401') })
    ])
    const settled = reducer.ingest(jsonLine({ type: 'agent_settled' }))
    expect(settled[0]).toMatchObject({ type: 'result', status: 'error' })
    expect(reducer.terminalOutcome()).toMatchObject({ failed: true, subtype: 'error' })
    expect(reducer.terminalOutcome().text).toContain('Authentication Fails')
  })

  it('treats stopReason aborted as an aborted turn', () => {
    const reducer = new PiRpcTurnReducer()
    reducer.ingest(
      jsonLine({
        type: 'turn_end',
        message: { role: 'assistant', content: [], stopReason: 'aborted' }
      })
    )
    const settled = reducer.ingest(jsonLine({ type: 'agent_settled' }))
    expect(settled[0]).toMatchObject({ type: 'result', status: 'aborted' })
    expect(reducer.terminalOutcome().failed).toBe(true)
  })

  it('keeps a clean turn clean when stopReason is a normal stop', () => {
    const reducer = new PiRpcTurnReducer()
    reducer.ingest(
      jsonLine({
        type: 'turn_end',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'done' }],
          stopReason: 'stop',
          usage: { input: 10, output: 2, cacheRead: 0, cacheWrite: 0, cost: { total: 0.001 } }
        }
      })
    )
    reducer.ingest(jsonLine({ type: 'agent_settled' }))
    expect(reducer.terminalOutcome()).toMatchObject({ failed: false, status: 'success' })
  })

  it('unwraps tool result content blocks into plain text', () => {
    const reducer = new PiRpcTurnReducer()
    const result = reducer.ingest(
      jsonLine({
        type: 'tool_execution_end',
        toolCallId: 'call_1',
        toolName: 'ls',
        result: { content: [{ type: 'text', text: 'a.ts\n' }, { type: 'text', text: 'b.ts' }] }
      })
    )
    expect(result[0]).toMatchObject({ type: 'tool_result', toolOutput: 'a.ts\nb.ts' })
    // Never leak the block markup into the transcript.
    expect(result[0]?.toolOutput).not.toContain('"type"')
  })

  it('reports an unsettled process exit as failure with the exit code', () => {
    const reducer = new PiRpcTurnReducer()
    const outcome = reducer.unsettledExitOutcome(1)
    expect(outcome).toMatchObject({ failed: true, subtype: 'error' })
    expect(outcome.text).toContain('exit code 1')
  })

  it('builds stdin command lines as single-line JSON', () => {
    expect(JSON.parse(piPromptCommand('hi', 'p1'))).toEqual({
      type: 'prompt',
      message: 'hi',
      id: 'p1'
    })
    expect(JSON.parse(piAbortCommand())).toEqual({ type: 'abort' })
    expect(JSON.parse(piSteerCommand('focus'))).toEqual({ type: 'steer', message: 'focus' })
    expect(piPromptCommand('a\nb')).not.toContain('\n')
  })
})
