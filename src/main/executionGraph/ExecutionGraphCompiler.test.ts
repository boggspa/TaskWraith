import { describe, expect, it } from 'vitest'
import {
  compileExecutionGraphRevision,
  executionGraphRevisionRef,
  stableExecutionGraphStringify
} from './ExecutionGraphCompiler'
import type {
  ExecutionEdge,
  ExecutionGraphRevisionDraft,
  ExecutionStepCommon,
  ExecutionStepDefinition
} from './ExecutionGraphModel'

const now = '2026-07-18T10:00:00.000Z'
const reportSchema = { type: 'object', required: ['summary'] } as const

function common(id: string): ExecutionStepCommon {
  return {
    id,
    title: ` ${id} `,
    objective: `Complete ${id}`,
    effect: 'read_only',
    retry: { maxAttempts: 2, backoffMs: 100 },
    inputs: [{ name: 'input', schema: reportSchema }],
    outputs: [{ name: 'report', schema: reportSchema }]
  }
}

function graphSteps(): ExecutionStepDefinition[] {
  return [
    {
      ...common('plan'),
      kind: 'solo_agent',
      inputs: [],
      agent: {
        provider: 'codex',
        runTemplateRef: 'template:readonly-review@1',
        session: { mode: 'fresh' }
      }
    },
    {
      ...common('check'),
      kind: 'deterministic_check',
      check: { handlerRef: 'checks.tests', version: '1' }
    },
    {
      ...common('ensemble'),
      kind: 'ensemble_round',
      inputs: [],
      ensemble: {
        snapshotRef: 'roster:review@1',
        prompt: 'Review independently.',
        orchestrationMode: 'turn_bound'
      }
    },
    {
      ...common('join'),
      kind: 'join',
      inputs: [],
      join: { mode: 'quorum', quorum: 2, deadlineMs: 30_000 }
    },
    {
      ...common('gate'),
      kind: 'human_gate',
      inputs: [],
      gate: { mode: 'approval', prompt: 'Approve the result?' }
    },
    {
      ...common('deliver'),
      kind: 'output',
      outputs: [],
      output: { label: 'Delivery', projectReference: 'propose' }
    }
  ]
}

function graphEdges(): ExecutionEdge[] {
  return [
    {
      id: 'plan-check',
      kind: 'control',
      fromStepId: 'plan',
      toStepId: 'check',
      outcome: 'success'
    },
    {
      id: 'plan-check-data',
      kind: 'data',
      from: { stepId: 'plan', port: 'report' },
      to: { stepId: 'check', port: 'input' }
    },
    {
      id: 'plan-ensemble',
      kind: 'control',
      fromStepId: 'plan',
      toStepId: 'ensemble',
      outcome: 'success'
    },
    {
      id: 'check-join',
      kind: 'control',
      fromStepId: 'check',
      toStepId: 'join',
      outcome: 'success'
    },
    {
      id: 'ensemble-join',
      kind: 'control',
      fromStepId: 'ensemble',
      toStepId: 'join',
      outcome: 'success'
    },
    { id: 'join-gate', kind: 'control', fromStepId: 'join', toStepId: 'gate', outcome: 'success' },
    {
      id: 'gate-deliver',
      kind: 'control',
      fromStepId: 'gate',
      toStepId: 'deliver',
      outcome: 'success'
    }
  ]
}

function draft(overrides: Partial<ExecutionGraphRevisionDraft> = {}): ExecutionGraphRevisionDraft {
  return {
    graphId: 'graph-review',
    revision: 1,
    workspaceId: 'workspace-1',
    name: ' Review graph ',
    createdAt: now,
    steps: graphSteps(),
    edges: graphEdges(),
    limits: { maxSteps: 20, maxConcurrentSteps: 4, maxAttempts: 30 },
    ...overrides
  }
}

describe('ExecutionGraph compiler', () => {
  it('compiles all V1 step kinds into a deeply immutable revision', () => {
    const result = compileExecutionGraphRevision(draft())
    expect(result.ok).toBe(true)
    if (!result.ok) return

    expect(result.revision).toMatchObject({
      schemaVersion: 1,
      revisionId: 'graph-review@1',
      name: 'Review graph'
    })
    expect(result.revision.definitionDigest).toMatch(/^[a-f0-9]{64}$/)
    expect(result.revision.steps.map((step) => step.kind)).toEqual([
      'solo_agent',
      'deterministic_check',
      'ensemble_round',
      'join',
      'human_gate',
      'output'
    ])
    expect(result.revision.steps[0].title).toBe('plan')
    expect(
      result.revision.steps[0].kind === 'solo_agent'
        ? result.revision.steps[0].agent.runTemplateRef
        : undefined
    ).toBe('template:readonly-review@1')
    expect(Object.isFrozen(result.revision)).toBe(true)
    expect(Object.isFrozen(result.revision.steps)).toBe(true)
    expect(Object.isFrozen(result.revision.steps[0])).toBe(true)
    expect(executionGraphRevisionRef(result.revision)).toEqual({
      schemaVersion: 1,
      graphId: 'graph-review',
      revision: 1,
      revisionId: 'graph-review@1',
      definitionDigest: result.revision.definitionDigest
    })
  })

  it('excludes projection layout from the immutable definition and digest', () => {
    const withLayout = {
      ...draft(),
      layout: { positions: { plan: { x: 1, y: 2 } } }
    } as ExecutionGraphRevisionDraft
    const movedLayout = {
      ...draft(),
      layout: { positions: { plan: { x: 999, y: -20 } } }
    } as ExecutionGraphRevisionDraft
    const first = compileExecutionGraphRevision(withLayout)
    const second = compileExecutionGraphRevision(movedLayout)
    expect(first.ok && second.ok).toBe(true)
    if (!first.ok || !second.ok) return
    expect('layout' in first.revision).toBe(false)
    expect(first.revision.definitionDigest).toBe(second.revision.definitionDigest)
  })

  it('makes execution-authority changes produce a new digest deterministically', () => {
    const first = compileExecutionGraphRevision(draft())
    const repeated = compileExecutionGraphRevision(draft())
    const changedSteps = graphSteps()
    changedSteps[0] = { ...changedSteps[0], effect: 'workspace_write' }
    const changed = compileExecutionGraphRevision(draft({ steps: changedSteps }))
    expect(first.ok && repeated.ok && changed.ok).toBe(true)
    if (!first.ok || !repeated.ok || !changed.ok) return
    expect(first.revision.definitionDigest).toBe(repeated.revision.definitionDigest)
    expect(changed.revision.definitionDigest).not.toBe(first.revision.definitionDigest)
  })

  it('rejects cycles, output successors, unsupported outcomes, and unreachable quorum', () => {
    const steps = graphSteps()
    const edges = [
      ...graphEdges(),
      {
        id: 'deliver-plan',
        kind: 'control',
        fromStepId: 'deliver',
        toStepId: 'plan',
        outcome: 'failure'
      } as unknown as ExecutionEdge
    ]
    const result = compileExecutionGraphRevision(
      draft({
        steps: steps.map((step) =>
          step.kind === 'join' ? { ...step, join: { mode: 'quorum', quorum: 3 } } : step
        ),
        edges
      })
    )
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.issues.map((entry) => entry.code)).toEqual(
      expect.arrayContaining([
        'unsupported_control_outcome',
        'cycle_not_supported',
        'output_not_terminal',
        'join_quorum_unreachable'
      ])
    )
  })

  it('rejects incompatible data ports and duplicate target bindings', () => {
    const steps = graphSteps()
    steps[1] = {
      ...steps[1],
      inputs: [{ name: 'input', schema: { type: 'string' } }]
    }
    const edges = [
      ...graphEdges(),
      {
        id: 'ensemble-check-data',
        kind: 'data',
        from: { stepId: 'ensemble', port: 'report' },
        to: { stepId: 'check', port: 'input' }
      } as const
    ]
    const result = compileExecutionGraphRevision(draft({ steps, edges }))
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.issues.map((entry) => entry.code)).toEqual(
      expect.arrayContaining(['incompatible_port_schema', 'duplicate_data_binding'])
    )
  })

  it('rejects unregistered node kinds, effectful kernel-only steps, and invalid caps', () => {
    const steps = graphSteps()
    steps[1] = { ...steps[1], effect: 'workspace_write' }
    steps.push({ ...common('code'), kind: 'arbitrary_code' } as unknown as ExecutionStepDefinition)
    const result = compileExecutionGraphRevision(
      draft({ steps, limits: { maxSteps: 0, maxConcurrentSteps: 100, maxAttempts: 0 } })
    )
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.issues.map((entry) => entry.code)).toEqual(
      expect.arrayContaining([
        'effectful_deterministic_check',
        'unsupported_step_kind',
        'invalid_graph_limit'
      ])
    )
  })

  it('uses a stable encoder independent of object key insertion order', () => {
    expect(stableExecutionGraphStringify({ b: 2, a: { d: 4, c: 3 } })).toBe(
      stableExecutionGraphStringify({ a: { c: 3, d: 4 }, b: 2 })
    )
  })
})
