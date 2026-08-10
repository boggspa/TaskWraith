import { describe, expect, it } from 'vitest'
import {
  museExecLineToEvents,
  museRecordedAtMs,
  parseMuseEnvelope,
  parseMuseExecJsonChunk,
  parseMuseExecJsonl
} from './MuseExecJson'

/** Synthetic stdout envelopes from wave1-C §3.2 (echo probe shape). */
function envelope(overrides: Record<string, unknown>): Record<string, unknown> {
  return {
    schema_version: 1,
    id: '11111111-1111-1111-1111-111111111111',
    stream: { kind: 'session', id: 'sess-echo-1' },
    sequence: 1,
    recorded_at: 1780531400000000,
    record_type: 'event',
    durability: 'ephemeral',
    payload_type: 'run.output.delta',
    payload_schema_version: 1,
    payload: { kind: 'run_output_delta', text: 'hi' },
    ...overrides
  }
}

describe('parseMuseExecJsonChunk', () => {
  it('splits NDJSON and carries a partial trailing line', () => {
    const a = parseMuseExecJsonChunk(
      `${JSON.stringify(envelope({ sequence: 1 }))}\n{"schema_version":1,"id":"`,
      ''
    )
    expect(a.lines).toHaveLength(1)
    expect(a.lines[0].envelope?.payload_type).toBe('run.output.delta')
    expect(a.carry.startsWith('{"schema_version":1,"id":"')).toBe(true)

    const rest =
      '22222222-2222-2222-2222-222222222222","stream":{"kind":"session","id":"sess-echo-1"},' +
      '"sequence":2,"recorded_at":1780531400000001,"record_type":"event",' +
      '"payload_type":"run.terminal.completed","payload":{"kind":"run_terminal_completed",' +
      '"terminal":"completed","text":"hi","reason":"done"}}\n'
    const b = parseMuseExecJsonChunk(rest, a.carry)
    expect(b.lines).toHaveLength(1)
    expect(b.lines[0].envelope?.payload_type).toBe('run.terminal.completed')
    expect(b.carry).toBe('')
  })

  it('surfaces non-JSON lines without throwing', () => {
    const { lines } = parseMuseExecJsonChunk('not json here\n', '')
    expect(lines[0].nonJson).toBe('not json here')
    expect(lines[0].parseError).toBeTruthy()
  })
})

describe('parseMuseEnvelope', () => {
  it('accepts a well-formed envelope', () => {
    const parsed = parseMuseEnvelope(envelope({}))
    expect(parsed?.id).toBe('11111111-1111-1111-1111-111111111111')
    expect(parsed?.stream.id).toBe('sess-echo-1')
    expect(parsed?.payload_type).toBe('run.output.delta')
  })

  it('rejects missing required fields', () => {
    expect(parseMuseEnvelope({ schema_version: 1 })).toBeNull()
    expect(parseMuseEnvelope(null)).toBeNull()
    expect(parseMuseEnvelope('x')).toBeNull()
  })
})

describe('museRecordedAtMs', () => {
  it('converts microseconds to milliseconds', () => {
    expect(museRecordedAtMs(1780531400000000)).toBe(1780531400000)
    expect(museRecordedAtMs(0)).toBe(0)
  })
})

describe('museExecLineToEvents', () => {
  it('maps run.output.delta to content and terminal.completed to terminal', () => {
    const events = parseMuseExecJsonl(
      [
        JSON.stringify(
          envelope({
            sequence: 6,
            payload_type: 'run.output.delta',
            payload: { kind: 'run_output_delta', text: 'Hello' }
          })
        ),
        JSON.stringify(
          envelope({
            id: '33333333-3333-3333-3333-333333333333',
            sequence: 7,
            payload_type: 'run.terminal.completed',
            payload: {
              kind: 'run_terminal_completed',
              terminal: 'completed',
              text: 'Hello',
              reason: 'echo'
            }
          })
        )
      ].join('\n') + '\n'
    )
    expect(events.map((e) => e.type)).toEqual(['content', 'terminal'])
    expect(events[0].text).toBe('Hello')
    expect(events[1].terminal).toBe('completed')
  })

  it('maps lifecycle / task payload types', () => {
    const started = museExecLineToEvents({
      envelope: parseMuseEnvelope(
        envelope({
          payload_type: 'run.lifecycle.started',
          payload: { kind: 'run_lifecycle_started', prompt: 'ping' }
        })
      )!
    })
    expect(started[0].type).toBe('run_started')

    const task = museExecLineToEvents({
      envelope: parseMuseEnvelope(
        envelope({
          payload_type: 'task.lifecycle.completed',
          payload: { kind: 'task_lifecycle_completed' }
        })
      )!
    })
    expect(task[0].type).toBe('task')
  })

  it('maps command_accepted and session.run.linked', () => {
    expect(
      museExecLineToEvents({
        envelope: parseMuseEnvelope(
          envelope({
            payload_type: 'runtime.command.accepted',
            payload: { kind: 'command_accepted', command_kind: 'turn.submit' }
          })
        )!
      })[0].type
    ).toBe('command_accepted')

    expect(
      museExecLineToEvents({
        envelope: parseMuseEnvelope(
          envelope({
            payload_type: 'session.run.linked',
            payload: { kind: 'session_run_linked', run_id: 'run-1' }
          })
        )!
      })[0].type
    ).toBe('session_linked')
  })
})
