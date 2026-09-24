import { describe, it, expect, vi } from 'vitest'
import { GeminiStreamAdapter } from './GeminiAdapter'
import { applyAssistantDelta } from './applyAssistantDelta'
import { projectRunItemAssistantDelta } from './runItemProjection'
import type { ChatMessage } from '../../../main/store/types'

describe('GeminiStreamAdapter', () => {
  it('parses complete JSONL lines correctly', () => {
    const onEvent = vi.fn()
    const adapter = new GeminiStreamAdapter(onEvent)

    adapter.appendChunk('{"type":"init","session_id":"123","model":"gemini"}\n')

    expect(onEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'run_started',
        session_id: '123',
        model: 'gemini'
      })
    )
    expect(onEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'raw_event',
        data: { type: 'init', session_id: '123', model: 'gemini' }
      })
    )
  })

  // Muse opaque exec emits several model-less `init` lines after the first
  // (command_accepted / run.lifecycle.started). Inventing `model: 'unknown'`
  // made the transcript badge read "Muse unknown" once App overwrote
  // actualModel from the later run_started events.
  it('does not invent model unknown when init omits model', () => {
    const onEvent = vi.fn()
    const adapter = new GeminiStreamAdapter(onEvent)

    adapter.appendChunk('{"type":"init","session_id":"muse-session","provider":"muse"}\n')

    expect(onEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'run_started',
        session_id: 'muse-session'
      })
    )
    const started = onEvent.mock.calls
      .map((call) => call[0])
      .find((event) => event && event.type === 'run_started')
    expect(started).toBeTruthy()
    expect(started.model).not.toBe('unknown')
    expect(started.model == null || started.model === '').toBe(true)
  })

  it('preserves provider model labels on run start and content deltas', () => {
    const onEvent = vi.fn()
    const adapter = new GeminiStreamAdapter(onEvent)

    adapter.appendChunk(
      [
        '{"type":"init","session_id":"ollama://qwen3:4b-instruct","model":"qwen3:4b-instruct","modelLabel":"Qwen 3 (4B Param)"}',
        '{"type":"content","text":"Hi","model":"qwen3:4b-instruct","modelLabel":"Qwen 3 (4B Param)"}'
      ].join('\n') + '\n'
    )

    expect(onEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'run_started',
        model: 'qwen3:4b-instruct',
        modelLabel: 'Qwen 3 (4B Param)'
      })
    )
    expect(onEvent).toHaveBeenCalledWith({
      type: 'assistant_message_delta',
      content: 'Hi',
      model: 'qwen3:4b-instruct',
      modelLabel: 'Qwen 3 (4B Param)'
    })
  })

  it('emits run item sidecars before the legacy normalized event', () => {
    const onEvent = vi.fn()
    const adapter = new GeminiStreamAdapter(onEvent)

    adapter.appendChunk(
      JSON.stringify({
        type: 'content',
        text: 'Hi',
        itemId: 'item-1',
        runItemEvents: [
          {
            protocolVersion: 1,
            kind: 'item/delta',
            chatId: 'chat-1',
            runId: 'run-1',
            provider: 'codex',
            itemId: 'item-1',
            itemKind: 'assistant_message',
            channel: 'assistant',
            delta: 'Hi',
            sequence: 2,
            createdAt: '2026-06-29T00:00:00.000Z'
          }
        ]
      }) + '\n'
    )

    expect(onEvent.mock.calls[0][0]).toMatchObject({
      type: 'run_item_event',
      event: {
        kind: 'item/delta',
        runId: 'run-1',
        itemId: 'item-1',
        sequence: 2
      }
    })
    expect(onEvent.mock.calls[1][0]).toMatchObject({
      type: 'assistant_message_delta',
      content: 'Hi',
      itemId: 'item-1',
      projectedFromRunItem: true
    })
  })

  it('does not mark legacy content as projected for an empty assistant sidecar delta', () => {
    const onEvent = vi.fn()
    const adapter = new GeminiStreamAdapter(onEvent)

    adapter.appendChunk(
      JSON.stringify({
        type: 'content',
        text: 'Hi',
        runItemEvents: [
          {
            protocolVersion: 1,
            kind: 'item/delta',
            chatId: 'chat-1',
            runId: 'run-1',
            provider: 'claude',
            itemId: 'run-1:assistant',
            itemKind: 'assistant_message',
            channel: 'assistant',
            delta: '',
            sequence: 2,
            createdAt: '2026-06-29T00:00:00.000Z'
          }
        ]
      }) + '\n'
    )

    // The sidecar carried no text, so the legacy lane must stay the writer.
    expect(onEvent).toHaveBeenCalledWith({
      type: 'assistant_message_delta',
      content: 'Hi'
    })
  })

  it('does not mark legacy content as projected for non-assistant sidecars', () => {
    const onEvent = vi.fn()
    const adapter = new GeminiStreamAdapter(onEvent)

    adapter.appendChunk(
      JSON.stringify({
        type: 'content',
        text: 'Hi',
        itemId: 'item-1',
        runItemEvents: [
          {
            protocolVersion: 1,
            kind: 'tool/progress',
            chatId: 'chat-1',
            runId: 'run-1',
            provider: 'codex',
            itemId: 'tool-1',
            toolName: 'read_file',
            status: 'running',
            sequence: 2,
            createdAt: '2026-06-29T00:00:00.000Z'
          }
        ]
      }) + '\n'
    )

    expect(onEvent).toHaveBeenCalledWith({
      type: 'assistant_message_delta',
      content: 'Hi',
      itemId: 'item-1'
    })
  })

  it('buffers and parses chunks split across multiple calls', () => {
    const onEvent = vi.fn()
    const adapter = new GeminiStreamAdapter(onEvent)

    adapter.appendChunk('{"type":"me')
    expect(onEvent).not.toHaveBeenCalled()

    adapter.appendChunk('ssage","role":"user"')
    expect(onEvent).not.toHaveBeenCalled()

    adapter.appendChunk(',"content":"Hi"}\n')

    expect(onEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'user_message',
        content: 'Hi'
      })
    )
  })

  it('accumulates assistant deltas correctly based on delta field or token type', () => {
    const onEvent = vi.fn()
    const adapter = new GeminiStreamAdapter(onEvent)

    adapter.appendChunk('{"type":"message","role":"assistant","content":"Hel","delta":true}\n')
    adapter.appendChunk('{"type":"token","content":"lo"}\n')

    expect(onEvent).toHaveBeenCalledWith({ type: 'assistant_message_delta', content: 'Hel' })
    expect(onEvent).toHaveBeenCalledWith({ type: 'assistant_message_delta', content: 'lo' })
  })

  it('falls back to malformed_json if it is not valid JSON', () => {
    const onEvent = vi.fn()
    const adapter = new GeminiStreamAdapter(onEvent)

    adapter.appendChunk('This is just raw text from stderr or something\n')

    expect(onEvent).toHaveBeenCalledWith({
      type: 'malformed_json',
      text: 'This is just raw text from stderr or something'
    })
  })

  it('recognizes tool_call as tool_use and extracts tool name', () => {
    const onEvent = vi.fn()
    const adapter = new GeminiStreamAdapter(onEvent)

    adapter.appendChunk('{"type":"tool_call","tool":"readFile"}\n')

    expect(onEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'tool_event',
        name: 'readFile',
        data: { type: 'tool_call', tool: 'readFile' },
        isUse: true,
        isResult: false
      })
    )
  })

  it('extracts tool_name for tool_use events', () => {
    const onEvent = vi.fn()
    const adapter = new GeminiStreamAdapter(onEvent)

    adapter.appendChunk(
      '{"type":"tool_use","tool_name":"read_file","tool_id":"123","parameters":{"file_path":"README.md"}}\n'
    )

    expect(onEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'tool_event',
        name: 'read_file',
        isUse: true,
        isResult: false
      })
    )
  })

  it('extracts tool_name for tool_result events', () => {
    const onEvent = vi.fn()
    const adapter = new GeminiStreamAdapter(onEvent)

    adapter.appendChunk(
      '{"type":"tool_result","tool_name":"read_file","tool_id":"123","output":"Hello"}\n'
    )

    expect(onEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'tool_event',
        name: 'read_file',
        isUse: false,
        isResult: true
      })
    )
  })

  it('falls back to event type if no tool_name is present', () => {
    const onEvent = vi.fn()
    const adapter = new GeminiStreamAdapter(onEvent)

    adapter.appendChunk('{"type":"custom_event","value":42}\n')

    expect(onEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'tool_event',
        name: 'custom_event',
        isUse: false,
        isResult: false
      })
    )
  })

  it('normalizes update_topic events into visible task progress', () => {
    const onEvent = vi.fn()
    const adapter = new GeminiStreamAdapter(onEvent)

    adapter.appendChunk(
      '{"type":"update_topic","title":"Metal Triangles Harness","summary":"Setting up the SwiftPM harness."}\n'
    )

    expect(onEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'tool_event',
        name: 'update_topic',
        isUse: true
      })
    )
    expect(onEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'tool_event',
        name: 'update_topic',
        isResult: true,
        data: expect.objectContaining({ output: 'Setting up the SwiftPM harness.' })
      })
    )
  })

  it('normalizes invoke_agent progress without hidden thinking fields', () => {
    const onEvent = vi.fn()
    const adapter = new GeminiStreamAdapter(onEvent)

    adapter.appendChunk(
      '{"type":"invoke_agent","payload":{"title":"Metal Triangles Harness","summary":"I am initializing a new Swift package.","thought":"private scratchpad"}}\n'
    )

    const toolUse = onEvent.mock.calls.find(
      ([event]) => event.type === 'tool_event' && event.isUse
    )?.[0]
    expect(toolUse).toMatchObject({
      type: 'tool_event',
      name: 'invoke_agent',
      data: {
        parameters: expect.objectContaining({
          title: 'Metal Triangles Harness',
          summary: 'I am initializing a new Swift package.'
        })
      }
    })
    expect(JSON.stringify(toolUse)).not.toContain('private scratchpad')
  })

  it('normalizes top-level visible summary events', () => {
    const onEvent = vi.fn()
    const adapter = new GeminiStreamAdapter(onEvent)

    adapter.appendChunk('{"summary":"No shell tools are available in this environment."}\n')

    expect(onEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'tool_event',
        name: 'summary',
        isResult: true
      })
    )
  })

  it('normalizes Kimi SubagentEvent records as visible delegated tool activity', () => {
    const onEvent = vi.fn()
    const adapter = new GeminiStreamAdapter(onEvent)

    adapter.appendChunk(
      '{"method":"event","params":{"type":"SubagentEvent","agent_id":"agent-42","parent_tool_call_id":"tool-1","subagent_type":"explore"}}\n'
    )

    expect(onEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'tool_event',
        name: 'SubagentEvent',
        isUse: true,
        data: expect.objectContaining({
          type: 'tool_use',
          tool_name: 'SubagentEvent',
          tool_id: 'agent-42'
        })
      })
    )
  })

  // Phase K1 — Codex `content` events carry an `itemId` per logical
  // assistant message item and a `complete: true` sentinel at the end of
  // each item. We propagate the id but skip emitting an event for the
  // zero-text completion sentinel so the renderer doesn't clobber the
  // live message with empty content.
  it('propagates itemId on Codex content deltas', () => {
    const onEvent = vi.fn()
    const adapter = new GeminiStreamAdapter(onEvent)

    adapter.appendChunk(
      '{"type":"content","text":"Hel","provider":"codex","itemId":"agent-msg-1"}\n'
    )

    expect(onEvent).toHaveBeenCalledWith({
      type: 'assistant_message_delta',
      content: 'Hel',
      itemId: 'agent-msg-1'
    })
  })

  it('normalizes media_refs compat events for assistant media rendering', () => {
    const onEvent = vi.fn()
    const adapter = new GeminiStreamAdapter(onEvent)

    adapter.appendChunk(
      '{"type":"media_refs","mediaRefs":[{"id":"img-1","kind":"image","source":"generated","mimeType":"image/png","name":"Generated image"}]}\n'
    )

    expect(onEvent).toHaveBeenCalledWith({
      type: 'assistant_media_refs',
      mediaRefs: [
        {
          id: 'img-1',
          kind: 'image',
          source: 'generated',
          mimeType: 'image/png',
          name: 'Generated image'
        }
      ]
    })
  })

  it('skips emitting an event for empty Codex completion sentinels', () => {
    const onEvent = vi.fn()
    const adapter = new GeminiStreamAdapter(onEvent)

    adapter.appendChunk(
      '{"type":"content","text":"","provider":"codex","itemId":"agent-msg-1","complete":true}\n'
    )

    // Adapter should still emit the raw event for audit but NOT an
    // assistant_message_delta with empty content (which would clobber
    // the live message).
    const eventTypes = onEvent.mock.calls.map((args) => args[0]?.type)
    expect(eventTypes).toContain('raw_event')
    expect(eventTypes).not.toContain('assistant_message_delta')
    expect(eventTypes).not.toContain('assistant_message_complete')
  })

  it('still emits a delta when complete=true arrives with non-empty text (defensive)', () => {
    // Defensive: if main ever bundles the final tail + complete=true on
    // the same line instead of two events, the renderer should still
    // see the text as a delta and not silently drop it.
    const onEvent = vi.fn()
    const adapter = new GeminiStreamAdapter(onEvent)

    adapter.appendChunk(
      '{"type":"content","text":"tail","provider":"codex","itemId":"agent-msg-2","complete":true}\n'
    )

    expect(onEvent).toHaveBeenCalledWith({
      type: 'assistant_message_delta',
      content: 'tail',
      itemId: 'agent-msg-2'
    })
  })

  it('keeps representative provider streaming fixtures intact', () => {
    const fixtures = [
      {
        provider: 'codex',
        stats: { input_tokens: 11, output_tokens: 7, total_tokens: 18, duration_ms: 501 },
        jsonl: [
          { type: 'init', session_id: 'codex-session', model: 'codex', provider: 'codex' },
          { type: 'content', text: 'Codex ', provider: 'codex', itemId: 'item-1' },
          { type: 'content', text: 'stream', provider: 'codex', itemId: 'item-1' },
          {
            type: 'tool_use',
            tool_name: 'read_file',
            tool_id: 'tool-1',
            parameters: { path: 'README.md' },
            provider: 'codex'
          },
          {
            type: 'tool_result',
            tool_name: 'read_file',
            tool_id: 'tool-1',
            output: 'ok',
            provider: 'codex'
          },
          { type: 'content', text: '', provider: 'codex', itemId: 'item-1', complete: true },
          {
            type: 'result',
            status: 'success',
            providerThreadId: 'codex-session',
            stats: { input_tokens: 11, output_tokens: 7, total_tokens: 18, duration_ms: 501 }
          }
        ],
        text: 'Codex stream',
        tool: 'read_file'
      },
      {
        provider: 'claude',
        stats: { input_tokens: 13, output_tokens: 5, total_tokens: 18, duration_ms: 502 },
        jsonl: [
          { type: 'init', session_id: 'claude-session', model: 'claude', provider: 'claude' },
          { type: 'message', role: 'assistant', content: 'Claude ', delta: true },
          { type: 'token', content: 'stream' },
          {
            type: 'tool_use',
            tool_name: 'run_shell_command',
            tool_id: 'tool-2',
            parameters: { command: 'pwd' },
            provider: 'claude'
          },
          {
            type: 'tool_result',
            tool_name: 'run_shell_command',
            tool_id: 'tool-2',
            output: '/tmp',
            provider: 'claude'
          },
          {
            type: 'result',
            status: 'success',
            providerThreadId: 'claude-session',
            stats: { input_tokens: 13, output_tokens: 5, total_tokens: 18, duration_ms: 502 }
          }
        ],
        text: 'Claude stream',
        tool: 'run_shell_command'
      },
      {
        provider: 'gemini',
        stats: { input_tokens: 17, output_tokens: 9, total_tokens: 26, duration_ms: 503 },
        jsonl: [
          { type: 'init', session_id: 'gemini-session', model: 'gemini', provider: 'gemini' },
          { type: 'message', role: 'assistant', content: 'Gemini ', delta: true },
          { type: 'message', role: 'assistant', content: 'stream', delta: true },
          {
            type: 'tool_use',
            tool_name: 'list_directory',
            tool_id: 'tool-3',
            parameters: { path: '.' },
            provider: 'gemini'
          },
          {
            type: 'tool_result',
            tool_name: 'list_directory',
            tool_id: 'tool-3',
            output: 'src',
            provider: 'gemini'
          },
          {
            type: 'result',
            status: 'success',
            providerThreadId: 'gemini-session',
            stats: { input_tokens: 17, output_tokens: 9, total_tokens: 26, duration_ms: 503 }
          }
        ],
        text: 'Gemini stream',
        tool: 'list_directory'
      },
      {
        provider: 'kimi',
        stats: { input_tokens: 19, output_tokens: 3, total_tokens: 22, duration_ms: 504 },
        jsonl: [
          { type: 'init', session_id: 'kimi-session', model: 'kimi', provider: 'kimi' },
          { type: 'content', text: 'Kimi ', provider: 'kimi' },
          { type: 'content', text: 'stream', provider: 'kimi' },
          {
            type: 'tool_use',
            tool_name: 'kimi_thinking',
            tool_id: 'tool-4',
            parameters: { title: 'Kimi thinking' },
            provider: 'kimi'
          },
          {
            type: 'tool_result',
            tool_name: 'kimi_thinking',
            tool_id: 'tool-4',
            output: 'reasoning summary',
            provider: 'kimi'
          },
          {
            type: 'result',
            status: 'success',
            providerThreadId: 'kimi-session',
            stats: { input_tokens: 19, output_tokens: 3, total_tokens: 22, duration_ms: 504 }
          }
        ],
        text: 'Kimi stream',
        tool: 'kimi_thinking'
      }
    ]

    for (const fixture of fixtures) {
      const onEvent = vi.fn()
      const adapter = new GeminiStreamAdapter(onEvent)
      const jsonl = fixture.jsonl.map((event) => JSON.stringify(event)).join('\n') + '\n'

      adapter.appendChunk(jsonl.slice(0, Math.floor(jsonl.length / 2)))
      adapter.appendChunk(jsonl.slice(Math.floor(jsonl.length / 2)))
      adapter.end()

      const events = onEvent.mock.calls.map(([event]) => event)
      const streamedText = events
        .filter((event) => event.type === 'assistant_message_delta')
        .map((event) => event.content)
        .join('')
      expect(streamedText).toBe(fixture.text)
      expect(events).toContainEqual(
        expect.objectContaining({
          type: 'tool_event',
          name: fixture.tool,
          isUse: true
        })
      )
      expect(events).toContainEqual(
        expect.objectContaining({
          type: 'tool_event',
          name: fixture.tool,
          isResult: true
        })
      )
      expect(events).toContainEqual(
        expect.objectContaining({
          type: 'run_finished',
          status: 'success',
          stats: fixture.stats
        })
      )
    }
  })

  it('flushes a terminal result with stats when the final JSON line has no newline', () => {
    const onEvent = vi.fn()
    const adapter = new GeminiStreamAdapter(onEvent)

    adapter.appendChunk(
      '{"type":"result","status":"success","stats":{"input_tokens":3,"output_tokens":2,"total_tokens":5,"duration_ms":99}}'
    )
    adapter.end()

    expect(onEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'run_finished',
        status: 'success',
        stats: {
          input_tokens: 3,
          output_tokens: 2,
          total_tokens: 5,
          duration_ms: 99
        }
      })
    )
  })

  // A Wire `result` line with a non-terminal status is a turn boundary, not
  // completion (mirror of ChannelAgentRunEventCollector.resultStatus). Sealing
  // the run on it produced the endedAt-set-but-still-running ghost that broke
  // solo close-outs and Task Complete receipts.
  it.each(['running', 'starting', 'cancelling'])(
    'does not emit run_finished for a non-terminal %s result',
    (status) => {
      const onEvent = vi.fn()
      const adapter = new GeminiStreamAdapter(onEvent)

      adapter.appendChunk(`{"type":"result","status":"${status}","stats":{"total_tokens":5}}\n`)
      adapter.end()

      expect(onEvent).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'run_finished' }))
    }
  )

  it('emits run_finished for a terminal result after an earlier running result', () => {
    const onEvent = vi.fn()
    const adapter = new GeminiStreamAdapter(onEvent)

    adapter.appendChunk('{"type":"result","status":"running"}\n')
    adapter.appendChunk('{"type":"result","status":"success","stats":{"total_tokens":7}}\n')
    adapter.end()

    const finished = onEvent.mock.calls
      .map(([event]) => event)
      .filter((event) => event.type === 'run_finished')
    expect(finished).toEqual([expect.objectContaining({ type: 'run_finished', status: 'success' })])
  })

  it('normalizes case and whitespace when guarding non-terminal results', () => {
    const onEvent = vi.fn()
    const adapter = new GeminiStreamAdapter(onEvent)

    adapter.appendChunk('{"type":"result","status":" Running "}\n')
    adapter.end()

    expect(onEvent).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'run_finished' }))
  })

  it('keeps Codex parent to Claude sub-thread delegation streaming paired', () => {
    const onEvent = vi.fn()
    const adapter = new GeminiStreamAdapter(onEvent)
    const fixture = [
      {
        type: 'init',
        provider: 'codex',
        session_id: 'codex-parent-session',
        model: 'gpt-5.5'
      },
      {
        type: 'content',
        provider: 'codex',
        itemId: 'parent-msg-1',
        text: 'I will ask Claude to review. '
      },
      {
        type: 'tool_use',
        provider: 'codex',
        tool_name: 'delegate_to_subthread',
        tool_id: 'delegate-claude-1',
        parameters: {
          provider: 'claude',
          prompt: 'Review this patch for behavioral risk.',
          returnResult: true
        }
      },
      {
        type: 'tool_result',
        provider: 'codex',
        tool_name: 'delegate_to_subthread',
        tool_id: 'delegate-claude-1',
        output: 'Spawned claude sub-thread (id=claude-sub-1).',
        result: {
          subThreadId: 'claude-sub-1',
          provider: 'claude'
        }
      },
      {
        type: 'content',
        provider: 'codex',
        itemId: 'parent-msg-1',
        text: 'Waiting for Claude.'
      },
      {
        type: 'result',
        provider: 'codex',
        status: 'success',
        providerThreadId: 'codex-parent-session',
        stats: { input_tokens: 101, output_tokens: 29, total_tokens: 130, duration_ms: 900 }
      }
    ]
    const jsonl = fixture.map((event) => JSON.stringify(event)).join('\n') + '\n'

    adapter.appendChunk(jsonl.slice(0, 137))
    adapter.appendChunk(jsonl.slice(137, 319))
    adapter.appendChunk(jsonl.slice(319))
    adapter.end()

    const events = onEvent.mock.calls.map(([event]) => event)
    const streamedText = events
      .filter((event) => event.type === 'assistant_message_delta')
      .map((event) => event.content)
      .join('')

    expect(streamedText).toBe('I will ask Claude to review. Waiting for Claude.')
    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'tool_event',
        name: 'delegate_to_subthread',
        isUse: true,
        data: expect.objectContaining({
          tool_id: 'delegate-claude-1',
          parameters: expect.objectContaining({ provider: 'claude' })
        })
      })
    )
    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'tool_event',
        name: 'delegate_to_subthread',
        isResult: true,
        data: expect.objectContaining({
          tool_id: 'delegate-claude-1',
          output: expect.stringContaining('claude sub-thread'),
          result: expect.objectContaining({ subThreadId: 'claude-sub-1' })
        })
      })
    )
    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'run_finished',
        status: 'success',
        stats: { input_tokens: 101, output_tokens: 29, total_tokens: 130, duration_ms: 900 }
      })
    )
  })

  it('converts a workflow_event compat line into a workflow_telemetry event', () => {
    const events: unknown[] = []
    const adapter = new GeminiStreamAdapter((event) => events.push(event))

    adapter.appendChunk(
      JSON.stringify({
        type: 'workflow_event',
        tool_id: 'toolu_99',
        provider: 'claude',
        workflow: { workflowName: 'howto-docs-audit', status: 'running', totalTokens: 1234 }
      }) + '\n'
    )

    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'workflow_telemetry',
        toolUseId: 'toolu_99',
        telemetry: expect.objectContaining({ workflowName: 'howto-docs-audit', status: 'running' })
      })
    )
    // It must NOT be emitted as a generic tool row.
    expect(events).not.toContainEqual(expect.objectContaining({ type: 'tool_event' }))
  })

  it('does not mistake a workflow_event summary for a Summary tool row', () => {
    const events: unknown[] = []
    const adapter = new GeminiStreamAdapter((event) => events.push(event))

    adapter.appendChunk(
      JSON.stringify({
        type: 'workflow_event',
        tool_id: 'toolu_99',
        workflow: { status: 'completed', summary: 'All phases complete.' }
      }) + '\n'
    )

    expect(events).not.toContainEqual(expect.objectContaining({ type: 'tool_event' }))
    expect(events).toContainEqual(expect.objectContaining({ type: 'workflow_telemetry' }))
  })

  it('converts a review_event compat line into a review_telemetry event', () => {
    const events: unknown[] = []
    const adapter = new GeminiStreamAdapter((event) => events.push(event))

    adapter.appendChunk(
      JSON.stringify({
        type: 'review_event',
        tool_id: 'rev_1',
        provider: 'codex',
        review: { status: 'running', target: 'uncommitted changes' }
      }) + '\n'
    )

    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'review_telemetry',
        toolUseId: 'rev_1',
        telemetry: expect.objectContaining({ status: 'running', provider: 'codex' })
      })
    )
    expect(events).not.toContainEqual(expect.objectContaining({ type: 'tool_event' }))
  })

  it('converts a multi_agent_event compat line into a multi_agent_telemetry event', () => {
    const events: unknown[] = []
    const adapter = new GeminiStreamAdapter((event) => events.push(event))

    adapter.appendChunk(
      JSON.stringify({
        type: 'multi_agent_event',
        tool_id: 'ma_1',
        provider: 'codex',
        multiAgent: {
          status: 'working',
          detailLevel: 'full',
          subagents: [{ id: 'call_a', agentThreadId: 'thread-a', status: 'working' }]
        }
      }) + '\n'
    )

    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'multi_agent_telemetry',
        toolUseId: 'ma_1',
        telemetry: expect.objectContaining({
          status: 'working',
          detailLevel: 'full',
          provider: 'codex'
        })
      })
    )
    // Coordination never leaks into the generic tool viewport.
    expect(events).not.toContainEqual(expect.objectContaining({ type: 'tool_event' }))
  })
})

/*
 * Dual-lane hand-off — the assistant text must never fall between the lanes.
 *
 * Captured 2026-09-10 from a solo Muse turn on the MSP transport (run
 * `1789001724340-m7x225im22h`, chat `1325574d-…`). The durable ledger records
 * `item/started` for `<runId>:assistant` at runItem sequence 84, then 27
 * sequence numbers filtered out of the ledger (`item/delta` is dropped there)
 * before `run/completed` at 112 — and NO `item/completed`, because Muse's MSP
 * `content` frames are pure increments that are never re-stated. Main's
 * compat mapper turns each one into a `type:"content"` wire line carrying BOTH
 * the legacy `text` and an assistant `item/delta` sidecar, so both lanes hold
 * the same bytes and exactly one of them must apply.
 *
 * The whole 409-character answer never reached the transcript: the user got an
 * activity header and a close-out reading "The run completed without a final
 * written summary". The adapter had suppressed the legacy twin on the strength
 * of the sidecar merely being PRESENT on the line, so whenever the sidecar lane
 * then declined or faulted, the text had nowhere left to land — no fallback,
 * no diagnostic, no trace in the raw log.
 *
 * The harness below mirrors the two App.tsx lanes (run_item_event apply +
 * flag-gated legacy skip, including the applier's `chatId === runChatId`
 * guard) over the REAL adapter, so the wire shapes stay byte-faithful.
 */
describe('GeminiStreamAdapter assistant dual-lane hand-off (captured Muse MSP turn)', () => {
  const CHAT = '1325574d-08ca-4bb6-ad69-057fc54fc29f'
  const RUN = '1789001724340-m7x225im22h'
  const ASSISTANT_ITEM = `${RUN}:assistant`
  const ANSWER =
    'Done! Added some fresh jokes \u{1F642}\n\n' +
    '- [jokes.py](/Users/chrisizatt/Documents/Test 1/jokes.py): +4 entries ' +
    '(2x en, 1x es, 1x pt — now 13 total, new language: Portuguese)\n' +
    '- `jokes_en.txt` (untracked file): +5 jokes (#21–25, now 25 total)\n\n' +
    'Verified: `test_jokes.py` — all 4 tests pass. `jokes.py` change committed ' +
    'as `5854902`; `jokes_en.txt` is untracked so its additions are in the ' +
    'working tree but not committed.'

  const DELTA_COUNT = 27

  function envelope(sequence: number, sidecarChatId = CHAT) {
    return {
      protocolVersion: 1,
      chatId: sidecarChatId,
      runId: RUN,
      provider: 'muse',
      source: 'adapter',
      sequence,
      createdAt: '2026-09-10T00:56:17.153Z'
    }
  }

  /** One `type:"content"` wire line exactly as `sendAgentCompatLine` writes it. */
  function contentLine(
    delta: string,
    sequence: number,
    options: { withItemStarted?: boolean; sidecarChatId?: string } = {}
  ): string {
    const sidecars: Record<string, unknown>[] = []
    let next = sequence
    if (options.withItemStarted) {
      sidecars.push({
        kind: 'item/started',
        itemId: ASSISTANT_ITEM,
        itemKind: 'assistant_message',
        ...envelope(next, options.sidecarChatId)
      })
      next += 1
    }
    sidecars.push({
      kind: 'item/delta',
      itemId: ASSISTANT_ITEM,
      itemKind: 'assistant_message',
      channel: 'assistant',
      delta,
      cumulative: false,
      ...envelope(next, options.sidecarChatId)
    })
    return (
      JSON.stringify({
        type: 'content',
        text: delta,
        provider: 'muse',
        appRunId: RUN,
        appChatId: CHAT,
        runItemEvents: sidecars
      }) + '\n'
    )
  }

  /** The terminal `result` line; its sidecar is `run/completed`, sequence 112. */
  function resultLine(): string {
    return (
      JSON.stringify({
        type: 'result',
        status: 'success',
        subtype: 'success',
        provider: 'muse',
        providerThreadId: '01a088d0-484a-7950-858c-c20aa6faf8d3',
        result: ANSWER,
        appRunId: RUN,
        appChatId: CHAT,
        runItemEvents: [
          {
            kind: 'run/completed',
            itemKind: 'run',
            itemId: `${RUN}:run`,
            status: 'success',
            ...envelope(112)
          }
        ]
      }) + '\n'
    )
  }

  function deltas(): string[] {
    const size = Math.ceil(ANSWER.length / DELTA_COUNT)
    const parts: string[] = []
    for (let index = 0; index < ANSWER.length; index += size) {
      parts.push(ANSWER.slice(index, index + size))
    }
    return parts
  }

  interface HarnessOptions {
    /** The sidecar lane throws while applying — exactly the shape of App's
     *  sidecar reducer faulting inside `updateChatById`. */
    sidecarThrows?: boolean
    /** The sidecar events are addressed to another chat, so App's applier
     *  (keyed on `runChatId`) drops them. */
    sidecarChatId?: string
  }

  function harness(options: HarnessOptions = {}) {
    let messages: ChatMessage[] = [
      { id: 'u1', role: 'user', content: 'hi Muse', timestamp: '2026-09-10T00:55:24.525Z' },
      { id: 't1', role: 'tool', content: '', runId: RUN, timestamp: '2026-09-10T00:55:50.101Z' }
    ]
    let nextId = 0
    const deps = {
      createMessageId: () => `msg-${++nextId}`,
      now: () => '2026-09-10T00:56:17.153Z'
    }
    const seen: string[] = []
    const adapter = new GeminiStreamAdapter((event) => {
      seen.push(event.type)
      if (event.type === 'run_item_event') {
        const projection = projectRunItemAssistantDelta(event.event)
        // App.tsx: the sidecar applier is keyed on the RUN's chat id.
        if (!projection || projection.chatId !== CHAT) return
        if (options.sidecarThrows) throw new Error('updateChatById reducer failed')
        messages = applyAssistantDelta(messages, projection.input, deps)
        return
      }
      if (event.type === 'assistant_message_delta') {
        // App.tsx: flag-set means the sidecar owns the text — skip.
        if (event.projectedFromRunItem === true) return
        messages = applyAssistantDelta(messages, { incoming: event.content, runId: RUN }, deps)
      }
    })
    return {
      play(over: HarnessOptions = options) {
        let sequence = 84
        deltas().forEach((delta, index) => {
          adapter.appendChunk(
            contentLine(delta, sequence, {
              withItemStarted: index === 0,
              ...(over.sidecarChatId ? { sidecarChatId: over.sidecarChatId } : {})
            })
          )
          sequence += index === 0 ? 2 : 1
        })
        adapter.appendChunk(resultLine())
      },
      assistantText: () =>
        messages
          .filter((message) => message.role === 'assistant')
          .map((message) => message.content)
          .join(''),
      assistantMessages: () => messages.filter((message) => message.role === 'assistant'),
      seen: () => seen
    }
  }

  it('lands the captured answer as one assistant message when the sidecar lane applies', () => {
    const run = harness()
    run.play()
    expect(run.assistantMessages()).toHaveLength(1)
    expect(run.assistantText()).toBe(ANSWER)
  })

  it('keeps the answer when the sidecar lane faults mid-line (no silent text loss)', () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const run = harness({ sidecarThrows: true })
      run.play()
      // The legacy twin on the same line is the only copy left — it must carry
      // the text rather than being skipped for a sidecar that never landed.
      expect(run.assistantText()).toBe(ANSWER)
      // A consumer fault must not delete the rest of the line, and a line that
      // parsed perfectly must never be reported as provider garbage.
      expect(run.seen()).toContain('raw_event')
      expect(run.seen()).not.toContain('malformed_json')
      // Recoverable AND detectable — but never on a transcript surface.
      expect(logged).toHaveBeenCalled()
    } finally {
      logged.mockRestore()
    }
  })

  it('keeps the answer when the sidecar is addressed to another chat than its own line', () => {
    const run = harness({ sidecarChatId: 'a-different-chat' })
    run.play({ sidecarChatId: 'a-different-chat' })
    expect(run.assistantText()).toBe(ANSWER)
  })
})
