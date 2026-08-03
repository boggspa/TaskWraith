import { describe, expect, it } from 'vitest'
import {
  classifyForInspector,
  classifyEventsForInspector,
  type InspectorRow
} from './RunEventClassifier'
import type { RunEventRecord, RunEventKind } from '../../../main/store/types'

/** Minimal RunEventRecord factory — the classifier only reads `kind`,
 * `summary`, and `payload`, so the rest stays at safe defaults. */
function makeEvent(overrides: Partial<RunEventRecord> & { kind: RunEventKind }): RunEventRecord {
  return {
    schemaVersion: 1,
    id: 'evt-x',
    sequence: 1,
    runId: 'run-x',
    phase: 'normalized',
    source: 'main',
    timestamp: '2026-05-17T00:00:00.000Z',
    ...overrides
  } as RunEventRecord
}

describe('classifyForInspector', () => {
  describe('approval_request', () => {
    it('pulls title/approvalKind/toolName/paths from a Codex-style approval payload', () => {
      const row = classifyForInspector(
        makeEvent({
          kind: 'approval_request',
          summary: 'Approve Codex tool call',
          payload: {
            preview: {
              kind: 'tool',
              toolName: 'shell',
              changes: [{ path: 'src/foo.ts' }, { path: 'src/bar.ts' }]
            }
          }
        })
      )
      expect(row.kind).toBe('approval_request')
      if (row.kind === 'approval_request') {
        expect(row.title).toBe('Approve Codex tool call')
        expect(row.approvalKind).toBe('tool')
        expect(row.toolName).toBe('shell')
        expect(row.paths).toEqual(['src/foo.ts', 'src/bar.ts'])
      }
    })

    it('falls back to a default title when summary missing', () => {
      const row = classifyForInspector(makeEvent({ kind: 'approval_request' }))
      expect(row.kind).toBe('approval_request')
      if (row.kind === 'approval_request') {
        expect(row.title).toBe('Approval requested')
        expect(row.approvalKind).toBeUndefined()
        expect(row.paths).toBeUndefined()
      }
    })

    it('handles non-object payload gracefully', () => {
      const row = classifyForInspector(
        makeEvent({ kind: 'approval_request', payload: 'unexpected-string' })
      )
      expect(row.kind).toBe('approval_request')
    })
  })

  describe('approval_response', () => {
    it('classifies known decisions', () => {
      const decisions = [
        'accept',
        'acceptForSession',
        'acceptForWorkspace',
        'decline',
        'cancel'
      ] as const
      for (const d of decisions) {
        const row = classifyForInspector(
          makeEvent({ kind: 'approval_response', payload: { decision: d } })
        )
        expect(row.kind).toBe('approval_response')
        if (row.kind === 'approval_response') expect(row.decision).toBe(d)
      }
    })

    it('falls back to unknown for missing/unrecognised decision', () => {
      const row = classifyForInspector(makeEvent({ kind: 'approval_response' }))
      expect(row.kind).toBe('approval_response')
      if (row.kind === 'approval_response') expect(row.decision).toBe('unknown')

      const row2 = classifyForInspector(
        makeEvent({ kind: 'approval_response', payload: { decision: 'wat' } })
      )
      if (row2.kind === 'approval_response') expect(row2.decision).toBe('unknown')
    })
  })

  it('classifies approval_timer_armed and approval_timer_timeout distinctly', () => {
    const armed = classifyForInspector(makeEvent({ kind: 'approval_timer_armed' }))
    const timeout = classifyForInspector(makeEvent({ kind: 'approval_timer_timeout' }))
    expect(armed.kind).toBe('approval_timer')
    expect(timeout.kind).toBe('approval_timer')
    if (armed.kind === 'approval_timer') expect(armed.phase).toBe('armed')
    if (timeout.kind === 'approval_timer') expect(timeout.phase).toBe('timeout')
  })

  it('classifies tool kind with toolName lookup', () => {
    const row = classifyForInspector(
      makeEvent({ kind: 'tool', payload: { toolName: 'read_file' } })
    )
    expect(row.kind).toBe('tool_call')
    if (row.kind === 'tool_call') expect(row.toolName).toBe('read_file')
  })

  describe('diff', () => {
    it('extracts paths from preview.changes', () => {
      const row = classifyForInspector(
        makeEvent({
          kind: 'diff',
          payload: { preview: { changes: [{ path: 'a.ts' }, { path: 'b.ts' }] } }
        })
      )
      expect(row.kind).toBe('diff')
      if (row.kind === 'diff') expect(row.paths).toEqual(['a.ts', 'b.ts'])
    })

    it('extracts paths from top-level path field', () => {
      const row = classifyForInspector(makeEvent({ kind: 'diff', payload: { path: 'solo.ts' } }))
      if (row.kind === 'diff') expect(row.paths).toEqual(['solo.ts'])
    })

    it('extracts paths from top-level paths array', () => {
      const row = classifyForInspector(
        makeEvent({ kind: 'diff', payload: { paths: ['a.ts', 'b.ts', 42] } })
      )
      if (row.kind === 'diff') expect(row.paths).toEqual(['a.ts', 'b.ts'])
    })

    it('returns undefined paths when none findable', () => {
      const row = classifyForInspector(makeEvent({ kind: 'diff', payload: {} }))
      if (row.kind === 'diff') expect(row.paths).toBeUndefined()
    })
  })

  describe('subthread', () => {
    it('classifies subthread_spawned with all metadata fields', () => {
      const row = classifyForInspector(
        makeEvent({
          kind: 'subthread_spawned',
          payload: {
            subThreadId: 'sub-1',
            provider: 'kimi',
            delegationPrompt: 'do the thing'
          }
        })
      )
      expect(row.kind).toBe('subthread_spawn')
      if (row.kind === 'subthread_spawn') {
        expect(row.subThreadId).toBe('sub-1')
        expect(row.provider).toBe('kimi')
        expect(row.delegationPrompt).toBe('do the thing')
      }
    })

    it('classifies subthread_returned preferring payload.summary over event.summary', () => {
      const row = classifyForInspector(
        makeEvent({
          kind: 'subthread_returned',
          summary: 'fallback summary',
          payload: { subThreadId: 'sub-1', summary: 'rich result' }
        })
      )
      if (row.kind === 'subthread_return') {
        expect(row.summaryText).toBe('rich result')
        expect(row.subThreadId).toBe('sub-1')
      }
    })

    it('falls back to event.summary when payload.summary missing', () => {
      const row = classifyForInspector(
        makeEvent({ kind: 'subthread_returned', summary: 'fallback only' })
      )
      if (row.kind === 'subthread_return') {
        expect(row.summaryText).toBe('fallback only')
      }
    })

    it('classifies side-chat returns through the linked-child result row', () => {
      const row = classifyForInspector(
        makeEvent({
          kind: 'side_chat_returned',
          summary: 'Side-chat result returned',
          payload: { subThreadId: 'side-1', summary: 'Async result' }
        })
      )
      expect(row).toMatchObject({
        kind: 'subthread_return',
        subThreadId: 'side-1',
        summaryText: 'Async result'
      })
    })

    it('classifies subthread_dispatch_failed with reason', () => {
      const row = classifyForInspector(
        makeEvent({
          kind: 'subthread_dispatch_failed',
          payload: { reason: 'archived sub-thread' }
        })
      )
      if (row.kind === 'subthread_dispatch_failed') {
        expect(row.reason).toBe('archived sub-thread')
      }
    })

    it('classifies subthread_autoresume_dispatched with sub-thread + continuation ids', () => {
      const row = classifyForInspector(
        makeEvent({
          kind: 'subthread_autoresume_dispatched',
          payload: {
            subThreadId: 'sub-1',
            continuationRunId: 'run-7'
          }
        })
      )
      expect(row.kind).toBe('subthread_autoresume')
      if (row.kind === 'subthread_autoresume') {
        expect(row.subThreadId).toBe('sub-1')
        expect(row.continuationRunId).toBe('run-7')
      }
    })
  })

  it('classifies delegation as a marker row', () => {
    const row = classifyForInspector(makeEvent({ kind: 'delegation' }))
    expect(row.kind).toBe('delegation')
  })

  describe('final_message → reply', () => {
    it('computes length from payload.text', () => {
      const row = classifyForInspector(
        makeEvent({ kind: 'final_message', payload: { text: 'hello world' } })
      )
      expect(row.kind).toBe('reply')
      if (row.kind === 'reply') expect(row.length).toBe(11)
    })

    it('computes length from payload.message as fallback', () => {
      const row = classifyForInspector(
        makeEvent({ kind: 'final_message', payload: { message: 'hi' } })
      )
      if (row.kind === 'reply') expect(row.length).toBe(2)
    })

    it('omits length when text empty/missing', () => {
      const row = classifyForInspector(makeEvent({ kind: 'final_message' }))
      if (row.kind === 'reply') expect(row.length).toBeUndefined()
    })
  })

  it('classifies lifecycle, timeline, provider_raw as their respective kinds', () => {
    expect(classifyForInspector(makeEvent({ kind: 'lifecycle' })).kind).toBe('lifecycle')
    expect(classifyForInspector(makeEvent({ kind: 'timeline' })).kind).toBe('timeline')
    expect(classifyForInspector(makeEvent({ kind: 'provider_raw' })).kind).toBe('provider_raw')
  })

  describe('provider_error / provider_exit', () => {
    it('extracts error message from payload.error then payload.message', () => {
      const a = classifyForInspector(
        makeEvent({ kind: 'provider_error', payload: { error: 'oops' } })
      )
      if (a.kind === 'provider_error') expect(a.message).toBe('oops')

      const b = classifyForInspector(
        makeEvent({ kind: 'provider_error', payload: { message: 'meh' } })
      )
      if (b.kind === 'provider_error') expect(b.message).toBe('meh')
    })

    it('extracts exit code from payload.code; null when missing', () => {
      const a = classifyForInspector(makeEvent({ kind: 'provider_exit', payload: { code: 137 } }))
      if (a.kind === 'provider_exit') expect(a.code).toBe(137)

      const b = classifyForInspector(makeEvent({ kind: 'provider_exit' }))
      if (b.kind === 'provider_exit') expect(b.code).toBeNull()
    })
  })

  it('preserves the raw event on every classification for downstream access', () => {
    const evt = makeEvent({ kind: 'lifecycle', summary: 'hi' })
    const row = classifyForInspector(evt)
    expect(row.raw).toBe(evt)
  })
})

describe('classifyEventsForInspector', () => {
  it('preserves order and length of the input array', () => {
    const events: RunEventRecord[] = [
      makeEvent({ kind: 'approval_request', sequence: 1 }),
      makeEvent({ kind: 'tool', sequence: 2 }),
      makeEvent({ kind: 'subthread_spawned', sequence: 3 }),
      makeEvent({ kind: 'final_message', sequence: 4 })
    ]
    const rows: InspectorRow[] = classifyEventsForInspector(events)
    expect(rows).toHaveLength(4)
    expect(rows.map((r) => r.kind)).toEqual([
      'approval_request',
      'tool_call',
      'subthread_spawn',
      'reply'
    ])
  })

  it('handles an empty array', () => {
    expect(classifyEventsForInspector([])).toEqual([])
  })
})
