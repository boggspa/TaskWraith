import { describe, expect, it } from 'vitest'
import {
  createWorkflowRunEvent,
  filterWorkflowRunEvents,
  foldWorkflowRunSummary,
  nextWorkflowRunSequence,
  parseWorkflowRunEventLine,
  reconcileStaleLedgerExecutions,
  safeWorkflowRunFileName,
  serializeWorkflowRunEvent,
  WORKFLOW_RUN_SCHEMA_VERSION,
  type WorkflowRunEvent,
  type WorkflowRunEventInput
} from './WorkflowRunStore'

const ev = (over: Partial<WorkflowRunEventInput>, seq: number, ts: string): WorkflowRunEvent =>
  createWorkflowRunEvent(
    { workflowExecutionId: 'exec-1', workflowId: 'wf-1', kind: 'materialized', ...over },
    seq,
    ts
  )

describe('safeWorkflowRunFileName', () => {
  it('sanitizes path-injection characters', () => {
    expect(safeWorkflowRunFileName('exec-1')).toBe('exec-1.jsonl')
    // Dots are kept (mirrors safeRunEventFileName); only path separators → '_',
    // so the result can't escape the dir.
    expect(safeWorkflowRunFileName('../../etc/passwd')).toBe('.._.._etc_passwd.jsonl')
    expect(safeWorkflowRunFileName('')).toBe('unknown-execution.jsonl')
  })
})

describe('createWorkflowRunEvent', () => {
  it('stamps schemaVersion + sequence + timestamp', () => {
    const e = createWorkflowRunEvent(
      { workflowExecutionId: 'exec-1', workflowId: 'wf-1', kind: 'dispatched', runId: 'run-1' },
      3,
      '2026-06-24T00:00:00.000Z'
    )
    expect(e).toMatchObject({
      schemaVersion: WORKFLOW_RUN_SCHEMA_VERSION,
      sequence: 3,
      timestamp: '2026-06-24T00:00:00.000Z',
      kind: 'dispatched',
      runId: 'run-1'
    })
  })

  it('clamps a non-positive sequence to 1', () => {
    expect(ev({}, 0, 't').sequence).toBe(1)
    expect(ev({}, -5, 't').sequence).toBe(1)
  })

  it('throws without a workflowExecutionId or workflowId', () => {
    expect(() =>
      createWorkflowRunEvent({ workflowExecutionId: '', workflowId: 'wf-1', kind: 'running' }, 1)
    ).toThrow('workflowExecutionId')
    expect(() =>
      createWorkflowRunEvent(
        { workflowExecutionId: 'exec-1', workflowId: '', kind: 'running' },
        1
      )
    ).toThrow('workflowId')
  })
})

describe('serialize / parse round-trip', () => {
  it('round-trips through a JSONL line', () => {
    const e = ev({ kind: 'completed', tokens: 1200, costUsd: 0.34 }, 2, '2026-06-24T00:00:01.000Z')
    const line = serializeWorkflowRunEvent(e)
    expect(line.endsWith('\n')).toBe(true)
    expect(parseWorkflowRunEventLine(line)).toEqual(e)
  })

  it('rejects blank / malformed / wrong-schema lines', () => {
    expect(parseWorkflowRunEventLine('')).toBeNull()
    expect(parseWorkflowRunEventLine('   ')).toBeNull()
    expect(parseWorkflowRunEventLine('{not json')).toBeNull()
    expect(parseWorkflowRunEventLine(JSON.stringify({ schemaVersion: 99, kind: 'x' }))).toBeNull()
    expect(
      parseWorkflowRunEventLine(
        JSON.stringify({ schemaVersion: WORKFLOW_RUN_SCHEMA_VERSION, kind: 'completed' })
      )
    ).toBeNull() // no workflowExecutionId
  })
})

describe('nextWorkflowRunSequence', () => {
  it('is 1 for an empty log and max+1 otherwise', () => {
    expect(nextWorkflowRunSequence([])).toBe(1)
    expect(
      nextWorkflowRunSequence([ev({}, 1, 't'), ev({}, 4, 't'), ev({}, 2, 't')])
    ).toBe(5)
  })
})

describe('foldWorkflowRunSummary', () => {
  it('folds a full lifecycle into a terminal summary with harvested totals', () => {
    const events = [
      ev({ kind: 'materialized', plannedFor: '2026-06-24T00:00:00.000Z' }, 1, '2026-06-24T00:00:00.000Z'),
      ev({ kind: 'dispatched', runId: 'run-1' }, 2, '2026-06-24T00:00:01.000Z'),
      ev({ kind: 'running' }, 3, '2026-06-24T00:00:02.000Z'),
      ev(
        { kind: 'completed', tokens: 5000, costUsd: 0.42, durationMs: 60000 },
        4,
        '2026-06-24T00:01:02.000Z'
      )
    ]
    const summary = foldWorkflowRunSummary('exec-1', events)
    expect(summary).toMatchObject({
      workflowExecutionId: 'exec-1',
      workflowId: 'wf-1',
      status: 'completed',
      isTerminal: true,
      runId: 'run-1',
      plannedFor: '2026-06-24T00:00:00.000Z',
      dispatchedAt: '2026-06-24T00:00:01.000Z',
      startedAt: '2026-06-24T00:00:02.000Z',
      completedAt: '2026-06-24T00:01:02.000Z',
      tokens: 5000,
      costUsd: 0.42,
      durationMs: 60000,
      eventCount: 4
    })
  })

  it('captures a budget breach as an annotation, with the terminal failed status after it', () => {
    const events = [
      ev({ kind: 'dispatched', runId: 'run-1' }, 1, 't1'),
      ev({ kind: 'running' }, 2, 't2'),
      ev(
        { kind: 'budget_breach', breach: { kind: 'tokens', limit: 1000, observed: 1500 } },
        3,
        't3'
      ),
      ev({ kind: 'failed', error: 'token budget exceeded' }, 4, 't4')
    ]
    const summary = foldWorkflowRunSummary('exec-1', events)
    expect(summary.status).toBe('failed')
    expect(summary.isTerminal).toBe(true)
    expect(summary.breach).toEqual({ kind: 'tokens', limit: 1000, observed: 1500 })
    expect(summary.error).toBe('token budget exceeded')
  })

  it('reports a non-terminal status for an in-flight execution', () => {
    const summary = foldWorkflowRunSummary('exec-1', [
      ev({ kind: 'dispatched', runId: 'run-1' }, 1, 't1'),
      ev({ kind: 'running' }, 2, 't2')
    ])
    expect(summary.status).toBe('running')
    expect(summary.isTerminal).toBe(false)
    expect(summary.completedAt).toBeUndefined()
  })

  it('treats harvested as a forensic annotation (folds tokens/cost/duration, status unchanged)', () => {
    const summary = foldWorkflowRunSummary('exec-1', [
      ev({ kind: 'running' }, 1, 't1'),
      ev({ kind: 'completed' }, 2, '2026-06-24T00:01:00.000Z'),
      ev({ kind: 'harvested', tokens: 4200, costUsd: 0.19, durationMs: 30000 }, 3, 't3')
    ])
    // status stays terminal 'completed'; the harvest only contributes forensics.
    expect(summary.status).toBe('completed')
    expect(summary.isTerminal).toBe(true)
    expect(summary.completedAt).toBe('2026-06-24T00:01:00.000Z')
    expect(summary.tokens).toBe(4200)
    expect(summary.costUsd).toBe(0.19)
    expect(summary.durationMs).toBe(30000)
  })

  it('treats stall_settled as a TERMINAL close (the startup reconciler writes it)', () => {
    const summary = foldWorkflowRunSummary('exec-1', [
      ev({ kind: 'dispatched', runId: 'run-1' }, 1, 't1'),
      ev({ kind: 'running' }, 2, 't2'),
      ev({ kind: 'stall_settled', error: 'restarted before terminal' }, 3, '2026-06-24T00:05:00.000Z')
    ])
    expect(summary.status).toBe('stall_settled')
    expect(summary.isTerminal).toBe(true)
    expect(summary.completedAt).toBe('2026-06-24T00:05:00.000Z')
    expect(summary.error).toBe('restarted before terminal')
  })

  it('folds a LOOP execution: sums per-iteration forensics, terminal on loop_settled, counts iterations', () => {
    const summary = foldWorkflowRunSummary('exec-1', [
      ev({ kind: 'running' }, 1, 't1'), // execution-level loop start
      ev({ kind: 'running', iteration: 1 }, 2, 't2'),
      ev({ kind: 'harvested', iteration: 1, tokens: 100, costUsd: 0.1, durationMs: 1000 }, 3, 't3'),
      ev({ kind: 'running', iteration: 2 }, 4, 't4'),
      ev({ kind: 'harvested', iteration: 2, tokens: 150, costUsd: 0.2, durationMs: 2000 }, 5, 't5'),
      ev({ kind: 'loop_settled' }, 6, '2026-06-24T01:00:00.000Z')
    ])
    expect(summary.status).toBe('loop_settled')
    expect(summary.isTerminal).toBe(true)
    expect(summary.completedAt).toBe('2026-06-24T01:00:00.000Z')
    expect(summary.startedAt).toBe('t1') // execution-level running, not a per-iteration one
    expect(summary.tokens).toBe(250) // 100 + 150 summed across iterations
    expect(summary.costUsd).toBeCloseTo(0.3)
    expect(summary.durationMs).toBe(3000)
    expect(summary.iterationCount).toBe(2)
  })

  it('does NOT terminalize a loop on a per-iteration completed (only an exec-level terminal does)', () => {
    const midFlight = foldWorkflowRunSummary('exec-1', [
      ev({ kind: 'running' }, 1, 't1'),
      ev({ kind: 'running', iteration: 1 }, 2, 't2'),
      ev({ kind: 'completed', iteration: 1 }, 3, 't3') // iteration 1 done; the loop continues
    ])
    expect(midFlight.status).toBe('running') // execution still running, NOT 'completed'
    expect(midFlight.isTerminal).toBe(false)
    expect(midFlight.completedAt).toBeUndefined()
    expect(midFlight.iterationCount).toBe(1)
  })

  it('leaves iterationCount undefined for a single-occurrence (non-loop) run', () => {
    expect(foldWorkflowRunSummary('exec-1', [ev({ kind: 'completed' }, 1, 't')]).iterationCount).toBeUndefined()
  })

  it('ignores events for a different execution', () => {
    const mine = ev({ kind: 'completed' }, 1, 't1')
    const other = createWorkflowRunEvent(
      { workflowExecutionId: 'exec-2', workflowId: 'wf-9', kind: 'failed' },
      1,
      't1'
    )
    const summary = foldWorkflowRunSummary('exec-1', [mine, other])
    expect(summary.status).toBe('completed')
    expect(summary.eventCount).toBe(1)
  })
})

describe('filterWorkflowRunEvents', () => {
  const events = [
    createWorkflowRunEvent({ workflowExecutionId: 'a', workflowId: 'wf-1', kind: 'completed' }, 1, '2026-06-24T00:00:00.000Z'),
    createWorkflowRunEvent({ workflowExecutionId: 'b', workflowId: 'wf-1', kind: 'failed' }, 1, '2026-06-24T00:00:10.000Z'),
    createWorkflowRunEvent({ workflowExecutionId: 'c', workflowId: 'wf-2', kind: 'completed' }, 1, '2026-06-24T00:00:20.000Z')
  ]

  it('filters by workflowId', () => {
    expect(filterWorkflowRunEvents(events, { workflowId: 'wf-1' }).map((e) => e.workflowExecutionId)).toEqual([
      'a',
      'b'
    ])
  })

  it('filters by execution + fromTimestamp + limit', () => {
    expect(filterWorkflowRunEvents(events, { workflowExecutionId: 'b' })).toHaveLength(1)
    expect(
      filterWorkflowRunEvents(events, { fromTimestamp: '2026-06-24T00:00:10.000Z' }).map(
        (e) => e.workflowExecutionId
      )
    ).toEqual(['b', 'c'])
    expect(filterWorkflowRunEvents(events, { limit: 1 }).map((e) => e.workflowExecutionId)).toEqual(['c'])
  })
})

describe('reconcileStaleLedgerExecutions (slice 2 startup reconciler)', () => {
  const summaryOf = (kinds: Partial<WorkflowRunEventInput>[], execId = 'exec-1') =>
    foldWorkflowRunSummary(
      execId,
      kinds.map((o, i) =>
        createWorkflowRunEvent(
          { workflowExecutionId: execId, workflowId: 'wf-1', kind: 'materialized', ...o },
          i + 1,
          `t${i}`
        )
      )
    )

  it('flags non-terminal (dispatched / running tail) executions to settle', () => {
    const dispatched = summaryOf([{ kind: 'materialized' }, { kind: 'dispatched' }], 'd')
    const running = summaryOf([{ kind: 'dispatched' }, { kind: 'running' }], 'r')
    const stale = reconcileStaleLedgerExecutions([dispatched, running])
    expect(stale.map((s) => s.workflowExecutionId).sort()).toEqual(['d', 'r'])
    expect(stale.find((s) => s.workflowExecutionId === 'r')?.status).toBe('running')
  })

  it('skips already-terminal executions (incl. stall_settled — boot-idempotent)', () => {
    const completed = summaryOf([{ kind: 'running' }, { kind: 'completed' }], 'c')
    const failed = summaryOf([{ kind: 'running' }, { kind: 'failed' }], 'f')
    const cancelled = summaryOf([{ kind: 'running' }, { kind: 'cancelled' }], 'x')
    const skipped = summaryOf([{ kind: 'skipped' }], 'k')
    const alreadySettled = summaryOf([{ kind: 'running' }, { kind: 'stall_settled' }], 's')
    expect(
      reconcileStaleLedgerExecutions([completed, failed, cancelled, skipped, alreadySettled])
    ).toEqual([])
  })

  it('skips empty / unknown executions (no parseable lifecycle event)', () => {
    const empty = foldWorkflowRunSummary('exec-empty', [])
    expect(empty.status).toBe('unknown')
    expect(reconcileStaleLedgerExecutions([empty])).toEqual([])
  })

  it('settles only the stale ones in a mixed set', () => {
    const healthy = summaryOf([{ kind: 'running' }, { kind: 'completed' }], 'ok')
    const stale = summaryOf([{ kind: 'dispatched' }], 'bad')
    expect(
      reconcileStaleLedgerExecutions([healthy, stale]).map((s) => s.workflowExecutionId)
    ).toEqual(['bad'])
  })
})
