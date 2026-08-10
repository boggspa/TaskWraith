import { describe, expect, it } from 'vitest'
import { parseMuseEnvelope } from './MuseExecJson'
import { museLinkedSubagentSessionLogPath, projectMuseEnvelopeTools } from './MuseToolProjection'

function runtimeSessionEnvelope(event: Record<string, unknown>, extras?: Record<string, unknown>) {
  return parseMuseEnvelope({
    schema_version: 1,
    id: '6988506d-7d58-4857-875c-847cc2ea5a62',
    stream: { kind: 'session', id: '73f052ed-1965-47c1-82cb-d965d45d258d' },
    sequence: 18,
    recorded_at: 1786360204007521,
    record_type: 'event',
    durability: 'durable',
    causation_id: null,
    payload_type: 'runtime.session',
    payload_schema_version: 1,
    payload: {
      kind: 'run',
      run_id: '73f052ed-1965-47c1-82cb-d965d45d258d',
      event,
      ...extras
    }
  })!
}

describe('projectMuseEnvelopeTools', () => {
  it('projects assistant_tool_calls_committed into tool_use events', () => {
    const envelope = runtimeSessionEnvelope({
      kind: 'assistant_tool_calls_committed',
      message_id: '018f0000-0000-7000-8000-00000000000b',
      response_id: 'resp_6a79b18b07fe22843260455e',
      tool_calls: [
        {
          id: 'fc_019feb5d89f2730183159570c1340d08',
          call_id: 'call_019feb5d89f2730183159570c1340d08',
          name: 'submit_reminder_decision',
          args: '{"decision":"none","reason":"Deliverable present"}'
        },
        {
          id: 'fc_write',
          call_id: 'call_write',
          name: 'write_file',
          args: { path: 'test_fun_silly.py', content: 'ok' }
        }
      ]
    })

    const events = projectMuseEnvelopeTools(envelope)
    expect(events).toHaveLength(2)
    expect(events[0]).toMatchObject({
      type: 'tool_use',
      toolId: 'call_019feb5d89f2730183159570c1340d08',
      toolName: 'submit_reminder_decision',
      toolInput: { decision: 'none', reason: 'Deliverable present' },
      runId: '73f052ed-1965-47c1-82cb-d965d45d258d'
    })
    expect(events[1]).toMatchObject({
      type: 'tool_use',
      toolId: 'call_write',
      toolName: 'write_file',
      toolInput: { path: 'test_fun_silly.py', content: 'ok' }
    })
  })

  it('projects tool_result_batch_committed into tool_result events', () => {
    const envelope = runtimeSessionEnvelope({
      kind: 'tool_result_batch_committed',
      batch_id: '018f0000-0000-7000-8000-00000000000b',
      results: [
        {
          tool_call_index: 0,
          tool_call_id: 'call_019feb5d89f2730183159570c1340d08',
          text: 'reminder decision recorded'
        }
      ]
    })

    expect(projectMuseEnvelopeTools(envelope)).toEqual([
      expect.objectContaining({
        type: 'tool_result',
        toolId: 'call_019feb5d89f2730183159570c1340d08',
        toolOutput: 'reminder decision recorded',
        toolStatus: 'success'
      })
    ])
  })

  it('ignores non-tool runtime.session kinds', () => {
    const envelope = runtimeSessionEnvelope({
      kind: 'side_effect_intent',
      task_id: '6a9f9ac4-b1ff-455f-b1f2-274e3121b7cb',
      operation: 'model.meta.response'
    })
    expect(projectMuseEnvelopeTools(envelope)).toEqual([])
  })
})

describe('museLinkedSubagentSessionLogPath', () => {
  it('returns the relative subagent session.jsonl path from task_stream_linked', () => {
    const envelope = runtimeSessionEnvelope({
      kind: 'task_stream_linked',
      task_id: '4bc90d20-30df-4401-bad3-3c0ed45bba78',
      task_stream: { kind: 'task', id: '4bc90d20-30df-4401-bad3-3c0ed45bba78' },
      execution_mode: 'background',
      display: {
        label: 'plugin:tbh-reminders:scope-reminder reminder',
        role: 'reminder',
        path: 'subagent/e9ab8acd-e7d8-4939-af5c-7dc38b23d2ab/session.jsonl',
        model: 'same-as-main'
      }
    })
    expect(museLinkedSubagentSessionLogPath(envelope)).toBe(
      'subagent/e9ab8acd-e7d8-4939-af5c-7dc38b23d2ab/session.jsonl'
    )
  })

  it('rejects absolute or parent-escaping paths', () => {
    const envelope = runtimeSessionEnvelope({
      kind: 'task_stream_linked',
      display: { path: '../escape/session.jsonl' }
    })
    expect(museLinkedSubagentSessionLogPath(envelope)).toBeNull()
  })
})
