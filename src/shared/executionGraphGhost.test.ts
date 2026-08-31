import { describe, expect, it } from 'vitest'
import {
  executionGhostStatusForActivation,
  executionGhostSummary,
  executionGraphGhostCellStates,
  executionGraphGhostCounts,
  isWorkBearingStepKind
} from './executionGraphGhost'

const steps = [
  { id: 'scout-1', kind: 'solo_agent', title: 'Scout 1' },
  { id: 'scout-2', kind: 'solo_agent', title: 'Scout 2' },
  { id: 'scout-3', kind: 'solo_agent', title: 'Scout 3' },
  { id: 'gate', kind: 'human_gate', title: 'Approve the plan' },
  { id: 'join', kind: 'join', title: 'Join' },
  { id: 'review', kind: 'ensemble_round', title: 'Review' },
  { id: 'check', kind: 'deterministic_check', title: 'Check' },
  { id: 'out', kind: 'output', title: 'Publish' }
]

describe('execution graph ghost cells', () => {
  // The strip answers "how many AGENTS", so it must count participants, not
  // graph structure. Counting joins and outputs would inflate every total and
  // make "3 of 7 settled" describe nothing the reader can point at.
  it('counts only steps that occupy a participant', () => {
    const cells = executionGraphGhostCellStates({ steps, activations: [] })
    expect(cells.map((cell) => cell.id)).toEqual([
      'scout-1',
      'scout-2',
      'scout-3',
      'gate',
      'review'
    ])
    expect(isWorkBearingStepKind('join')).toBe(false)
    expect(isWorkBearingStepKind('output')).toBe(false)
    expect(isWorkBearingStepKind('deterministic_check')).toBe(false)
  })

  // A human gate is the state the reader most needs to see. Excluding it would
  // render a graph paused on an approval as entirely idle.
  it('keeps a human gate in the strip', () => {
    const cells = executionGraphGhostCellStates({
      steps,
      activations: [{ stepId: 'gate', state: 'waiting_approval' }]
    })
    expect(cells.find((cell) => cell.id === 'gate')?.status).toBe('needs_action')
  })

  it('renders a step with no activation as proposed', () => {
    const cells = executionGraphGhostCellStates({ steps, activations: [] })
    expect(cells.every((cell) => cell.status === 'proposed')).toBe(true)
  })

  it('holds topology order as cells fill, so a cell never moves', () => {
    const cells = executionGraphGhostCellStates({
      steps,
      activations: [
        { stepId: 'scout-3', state: 'succeeded' },
        { stepId: 'scout-1', state: 'running' }
      ]
    })
    expect(cells.map((cell) => `${cell.id}:${cell.status}`)).toEqual([
      'scout-1:working',
      'scout-2:proposed',
      'scout-3:completed',
      'gate:proposed',
      'review:proposed'
    ])
  })

  // A retried step has more than one activation. Showing the older one would
  // report a step as failed while it is actually back in flight.
  it('lets the newest activation win for a retried step', () => {
    const cells = executionGraphGhostCellStates({
      steps,
      activations: [
        { stepId: 'scout-1', state: 'failed', updatedAt: '2026-08-29T01:00:00Z' },
        { stepId: 'scout-1', state: 'running', updatedAt: '2026-08-29T01:05:00Z' }
      ]
    })
    expect(cells[0]).toMatchObject({ id: 'scout-1', status: 'working' })
  })

  // A state this module has never heard of is not evidence of progress.
  it('treats an unrecognised activation state as unstarted, never as finished', () => {
    expect(executionGhostStatusForActivation('some_future_state')).toBe('proposed')
    expect(executionGhostStatusForActivation(undefined)).toBe('proposed')
  })

  it('maps every known activation state', () => {
    const expected: Record<string, string> = {
      dormant: 'proposed',
      ready: 'proposed',
      claimed: 'queued',
      queued: 'queued',
      running: 'working',
      waiting_retry: 'queued',
      waiting_input: 'needs_action',
      waiting_approval: 'needs_action',
      requires_action: 'needs_action',
      succeeded: 'completed',
      failed: 'failed',
      cancelled: 'skipped',
      skipped: 'skipped'
    }
    for (const [state, status] of Object.entries(expected)) {
      expect(executionGhostStatusForActivation(state), state).toBe(status)
    }
  })
})

describe('execution graph ghost counts', () => {
  it('settles completed, failed and skipped together', () => {
    const cells = executionGraphGhostCellStates({
      steps,
      activations: [
        { stepId: 'scout-1', state: 'succeeded' },
        { stepId: 'scout-2', state: 'failed' },
        { stepId: 'scout-3', state: 'cancelled' },
        { stepId: 'gate', state: 'waiting_approval' },
        { stepId: 'review', state: 'running' }
      ]
    })
    expect(executionGraphGhostCounts(cells)).toEqual({
      total: 5,
      proposed: 0,
      queued: 0,
      running: 1,
      needsAction: 1,
      completed: 1,
      failed: 1,
      skipped: 1,
      settled: 3
    })
  })

  // The summary must never claim work that is not happening.
  it('names only what is true', () => {
    const idle = executionGraphGhostCounts(
      executionGraphGhostCellStates({ steps, activations: [] })
    )
    expect(executionGhostSummary(idle)).toBe('0 of 5 settled · 5 proposed')
    expect(executionGhostSummary(idle)).not.toContain('running')

    const active = executionGraphGhostCounts(
      executionGraphGhostCellStates({
        steps,
        activations: [
          { stepId: 'scout-1', state: 'queued' },
          { stepId: 'scout-2', state: 'running' }
        ]
      })
    )
    expect(executionGhostSummary(active)).toBe('0 of 5 settled · 1 running · 1 queued · 3 proposed')

    const done = executionGraphGhostCounts(
      executionGraphGhostCellStates({
        steps,
        activations: [
          { stepId: 'scout-1', state: 'succeeded' },
          { stepId: 'scout-2', state: 'succeeded' },
          { stepId: 'scout-3', state: 'succeeded' },
          { stepId: 'gate', state: 'succeeded' },
          { stepId: 'review', state: 'succeeded' }
        ]
      })
    )
    expect(executionGhostSummary(done)).toBe('5 of 5 settled')
  })

  it('says so when a graph has no agent steps at all', () => {
    const cells = executionGraphGhostCellStates({
      steps: [{ id: 'out', kind: 'output' }],
      activations: []
    })
    expect(executionGhostSummary(executionGraphGhostCounts(cells))).toBe('No agent steps')
  })
})
