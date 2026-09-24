import { describe, expect, it } from 'vitest'
import { parseMuseEnvelope } from './MuseExecJson'
import { createMuseReasoningProjector } from './MuseReasoningProjection'

function envelope(
  sequence: number,
  event: Record<string, unknown>,
  sessionId = 'session-1',
  runId = 'run-1'
) {
  return parseMuseEnvelope({
    schema_version: 1,
    id: `${sessionId}-${sequence}`,
    stream: { kind: 'session', id: sessionId },
    sequence,
    recorded_at: 1786360202716949 + sequence,
    record_type: 'event',
    payload_type: 'runtime.session',
    payload: { kind: 'run', run_id: runId, event: { message_id: 'message-1', ...event } }
  })!
}

describe('Muse reasoning summaries', () => {
  it('streams parts and suppresses the completed restatement observed in Muse Code 1.0.3', () => {
    const project = createMuseReasoningProjector()
    expect(
      project(envelope(1, { kind: 'reasoning_summary_delta', summary_index: 0, text: 'Count ' }))
    ).toMatchObject([{ type: 'thinking', text: 'Count ', thinkingCumulative: true }])
    const delta = envelope(2, {
      kind: 'reasoning_summary_delta',
      summary_index: 0,
      text: 'the complement.'
    })
    expect(project(delta)[0].text).toBe('Count the complement.')
    expect(project(delta)).toEqual([])
    expect(
      project(
        envelope(3, { kind: 'reasoning_summary_delta', summary_index: 1, text: 'Verify it.' })
      )[0].text
    ).toBe('Count the complement.\n\nVerify it.')
    expect(
      project(
        envelope(4, {
          kind: 'reasoning_summary_committed',
          text: 'Count the complement.\n\nVerify it.'
        })
      )
    ).toEqual([])
    expect(project(envelope(5, { kind: 'reasoning_summary_delta', text: 'late replay' }))).toEqual(
      []
    )
  })

  it('recovers a completed summary when deltas were missed, including a missing suffix', () => {
    const project = createMuseReasoningProjector()
    project(envelope(1, { kind: 'reasoning_summary_delta', text: 'Inspect' }))
    expect(
      project(envelope(2, { kind: 'reasoning_summary_committed', text: 'Inspect and verify.' }))[0]
        .text
    ).toBe('Inspect and verify.')
    expect(
      project(
        envelope(3, {
          kind: 'reasoning_summary_committed',
          message_id: 'message-2',
          text: 'Final check.'
        })
      )[0].text
    ).toBe('Final check.')
  })

  it('keeps identical summaries from different messages, runs, and child sessions distinct', () => {
    const project = createMuseReasoningProjector()
    const event = { kind: 'reasoning_summary_committed', text: 'Check it.' }
    const results = [
      project(envelope(1, event)),
      project(envelope(2, { ...event, message_id: 'message-2' })),
      project(envelope(3, event, 'session-1', 'run-2')),
      project(envelope(1, event, 'child-session'))
    ].flat()
    expect(results).toHaveLength(4)
    expect(new Set(results.map((result) => result.thinkingId)).size).toBe(4)
  })

  it('ignores empty or malformed summaries and never projects raw or encrypted reasoning', () => {
    const project = createMuseReasoningProjector()
    for (const event of [
      { kind: 'reasoning_committed', text: 'private text', encrypted_content: 'ciphertext' },
      { kind: 'reasoning_summary_delta', text: 'bad index', summary_index: -1 },
      { kind: 'reasoning_summary_delta', text: 'missing id', message_id: null },
      { kind: 'reasoning_summary_committed', text: null },
      { kind: 'reasoning_summary_committed', text: ' \n ' },
      { kind: 'assistant_message_committed', text: 'Final answer.' }
    ]) {
      expect(project(envelope(1, event))).toEqual([])
    }
    const output = project(
      envelope(2, {
        kind: 'reasoning_summary_committed',
        message_id: 'visible-summary',
        text: 'Visible summary.',
        encrypted_content: 'never include this'
      })
    )
    expect(JSON.stringify(output)).not.toContain('never include this')
  })
})
