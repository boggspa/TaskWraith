import { describe, expect, it } from 'vitest'
import { foldIterations } from './WorkflowRunHistory'
import type { WorkflowRunEvent } from '../../../main/WorkflowRunStore'

const ev = (over: Partial<WorkflowRunEvent>): WorkflowRunEvent => ({
  workflowExecutionId: 'exec-1',
  workflowId: 'wf-1',
  kind: 'harvested',
  schemaVersion: 1,
  sequence: 1,
  timestamp: 't',
  ...over
})

describe('foldIterations (WorkflowRunHistory)', () => {
  it('groups maker + verifier events per iteration, summing tokens + lifting the verdict', () => {
    const rows = foldIterations([
      ev({ iteration: 1, tokens: 100 }), // maker
      ev({ iteration: 1, tokens: 5, verdict: { decision: 'revise', evidence: 'add a test' } }), // verifier
      ev({ iteration: 2, tokens: 120 }),
      ev({ iteration: 2, tokens: 5, verdict: { decision: 'accept' } })
    ])
    expect(rows).toEqual([
      { iteration: 1, tokens: 105, decision: 'revise', evidence: 'add a test' },
      { iteration: 2, tokens: 125, decision: 'accept' }
    ])
  })

  it('ignores execution-level events (no iteration) and sorts by iteration', () => {
    const rows = foldIterations([
      ev({ kind: 'loop_settled', stopReason: 'accepted' }), // no iteration → skipped
      ev({ iteration: 2, tokens: 10 }),
      ev({ kind: 'running' }), // no iteration → skipped
      ev({ iteration: 1, tokens: 20 })
    ])
    expect(rows.map((r) => r.iteration)).toEqual([1, 2])
  })

  it('returns [] for a single-occurrence run (no per-iteration events)', () => {
    expect(foldIterations([ev({ kind: 'completed' })])).toEqual([])
  })
})
