import { describe, expect, it } from 'vitest'
import {
  compileExecutionGraphRevision,
  executionGraphAuthorityDigest,
  executionGraphRevisionRef,
  stableExecutionGraphStringify,
  validateExecutionGraphV1RuntimeAdmission
} from './ExecutionGraphCompiler'
import type {
  ExecutionEdge,
  ExecutionJsonSchema,
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
  it('compiles all generic V1 step kinds into a deeply immutable revision', () => {
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
    expect(executionGraphAuthorityDigest(changed.revision)).not.toBe(
      executionGraphAuthorityDigest(first.revision)
    )
  })

  it('separates canonical definition integrity from presentation-neutral authority', () => {
    const first = compileExecutionGraphRevision(draft())
    const presentationSteps = [...graphSteps()].reverse().map((step) => {
      const presented = {
        ...step,
        title: `Renamed ${step.id}`,
        objective: `Updated display objective for ${step.id}`
      }
      if (presented.kind === 'human_gate') {
        return {
          ...presented,
          gate: {
            ...presented.gate,
            approveLabel: 'Ship it',
            declineLabel: 'Not yet'
          }
        } as ExecutionStepDefinition
      }
      if (presented.kind === 'output') {
        return {
          ...presented,
          output: { ...presented.output, label: 'Renamed delivery' }
        } as ExecutionStepDefinition
      }
      return presented
    })
    const presented = compileExecutionGraphRevision(
      draft({
        name: 'A different graph name',
        description: 'Updated explanatory copy.',
        createdAt: '2026-07-19T11:30:00.000Z',
        steps: presentationSteps,
        edges: [...graphEdges()].reverse()
      })
    )
    expect(first.ok && presented.ok).toBe(true)
    if (!first.ok || !presented.ok) return

    expect(presented.revision.definitionDigest).not.toBe(first.revision.definitionDigest)
    expect(executionGraphAuthorityDigest(presented.revision)).toBe(
      executionGraphAuthorityDigest(first.revision)
    )
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

  it('rejects a data consumer without a success-control dependency on its producer', () => {
    const steps = graphSteps().slice(0, 2)
    const result = compileExecutionGraphRevision(
      draft({
        steps,
        edges: [
          {
            id: 'plan-check-data',
            kind: 'data',
            from: { stepId: 'plan', port: 'report' },
            to: { stepId: 'check', port: 'input' }
          }
        ]
      })
    )
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.issues).toContainEqual(
      expect.objectContaining({ code: 'data_dependency_missing_control_path' })
    )
  })

  it('accepts a data dependency backed by a transitive success-control path', () => {
    const [plan, check, ensemble] = graphSteps()
    const result = compileExecutionGraphRevision(
      draft({
        steps: [plan, ensemble, check],
        edges: [
          {
            id: 'plan-ensemble',
            kind: 'control',
            fromStepId: 'plan',
            toStepId: 'ensemble',
            outcome: 'success'
          },
          {
            id: 'ensemble-check',
            kind: 'control',
            fromStepId: 'ensemble',
            toStepId: 'check',
            outcome: 'success'
          },
          {
            id: 'plan-check-data',
            kind: 'data',
            from: { stepId: 'plan', port: 'report' },
            to: { stepId: 'check', port: 'input' }
          }
        ]
      })
    )
    expect(result.ok).toBe(true)
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

  it('validates oversized and deeply nested drafts without recursive stack overflow', () => {
    const simpleStep = (id: string): ExecutionStepDefinition => ({
      id,
      title: id,
      objective: `Execute ${id}`,
      effect: 'read_only',
      retry: { maxAttempts: 1 },
      kind: 'solo_agent',
      agent: { provider: 'codex', session: { mode: 'fresh' } }
    })
    const oversized = Array.from({ length: 5_000 }, (_, index) => simpleStep(`step-${index}`))
    expect(() =>
      compileExecutionGraphRevision(draft({ steps: oversized, edges: [] }))
    ).not.toThrow()
    const oversizedResult = compileExecutionGraphRevision(draft({ steps: oversized, edges: [] }))
    expect(oversizedResult.ok).toBe(false)
    if (!oversizedResult.ok) {
      expect(oversizedResult.issues).toContainEqual(
        expect.objectContaining({ code: 'step_limit_exceeded' })
      )
    }

    const deepSteps = Array.from({ length: 1_000 }, (_, index) => simpleStep(`deep-${index}`))
    const deepEdges: ExecutionEdge[] = deepSteps.slice(1).map((step, index) => ({
      id: `deep-edge-${index}`,
      kind: 'control',
      fromStepId: deepSteps[index].id,
      toStepId: step.id,
      outcome: 'success'
    }))
    const deepResult = compileExecutionGraphRevision(
      draft({
        steps: deepSteps,
        edges: deepEdges,
        limits: { maxSteps: 1_000, maxConcurrentSteps: 1, maxAttempts: 1_000 }
      })
    )
    expect(deepResult.ok).toBe(true)

    let nestedSchema: ExecutionJsonSchema = { type: 'string' }
    for (let depth = 0; depth < 2_000; depth += 1) {
      nestedSchema = { type: 'object', properties: { next: nestedSchema } }
    }
    const nestedStep = simpleStep('nested')
    const nestedResult = compileExecutionGraphRevision(
      draft({
        steps: [{ ...nestedStep, outputs: [{ name: 'value', schema: nestedSchema }] }],
        edges: []
      })
    )
    expect(nestedResult.ok).toBe(false)
    if (!nestedResult.ok) {
      expect(nestedResult.issues).toContainEqual(
        expect.objectContaining({ code: 'invalid_port_schema' })
      )
    }
  })

  it('makes unsupported bound-runtime semantics explicit without narrowing generic compilation', () => {
    const steps = graphSteps()
    steps[0] = { ...steps[0], timeoutMs: 5_000 }
    steps[1] = {
      ...steps[1],
      inputs: [{ name: 'input', schema: reportSchema, required: true }]
    }
    const compiled = compileExecutionGraphRevision(
      draft({
        steps,
        limits: {
          maxSteps: 20,
          maxConcurrentSteps: 4,
          maxAttempts: 30,
          maxWallClockMs: 60_000,
          maxTokens: 10_000,
          maxCostUsd: 2
        }
      })
    )
    expect(compiled.ok).toBe(true)
    if (!compiled.ok) return
    const unsupportedCodes = validateExecutionGraphV1RuntimeAdmission(compiled.revision).map(
      (entry) => entry.code
    )
    expect(unsupportedCodes).toEqual(
      expect.arrayContaining([
        'runtime_budget_unsupported',
        'runtime_retry_unsupported',
        'runtime_retry_backoff_unsupported',
        'runtime_timeout_unsupported',
        'runtime_join_mode_unsupported',
        'runtime_output_shape_unsupported',
        'runtime_step_kind_unsupported'
      ])
    )
    for (const supportedCode of [
      'runtime_concurrency_unsupported',
      'runtime_parallel_topology_unsupported',
      'runtime_data_edge_unsupported',
      'runtime_data_port_unsupported'
    ]) {
      expect(unsupportedCodes).not.toContain(supportedCode)
    }

    const admitted = compileExecutionGraphRevision(
      draft({
        steps: [
          {
            ...common('execute'),
            inputs: [],
            outputs: [],
            retry: { maxAttempts: 1 },
            kind: 'solo_agent',
            agent: {
              provider: 'codex',
              runTemplateRef: 'template:execute@1',
              session: { mode: 'fresh' }
            }
          }
        ],
        edges: [],
        limits: { maxSteps: 1, maxConcurrentSteps: 1, maxAttempts: 1 }
      })
    )
    expect(admitted.ok).toBe(true)
    if (admitted.ok) expect(validateExecutionGraphV1RuntimeAdmission(admitted.revision)).toEqual([])
  })

  it('admits structured data transport and terminal output nodes', () => {
    const compiled = compileExecutionGraphRevision(
      draft({
        steps: [
          {
            ...common('producer'),
            inputs: [],
            outputs: [{ name: 'result', schema: reportSchema }],
            retry: { maxAttempts: 1 },
            kind: 'solo_agent',
            agent: {
              provider: 'codex',
              runTemplateRef: 'template:producer@1',
              session: { mode: 'fresh' }
            }
          },
          {
            ...common('result'),
            inputs: [{ name: 'result', schema: reportSchema, required: true }],
            outputs: [],
            retry: { maxAttempts: 1 },
            kind: 'output',
            output: { label: 'Result', projectReference: 'propose' }
          }
        ],
        edges: [
          {
            id: 'producer-result-control',
            kind: 'control',
            fromStepId: 'producer',
            toStepId: 'result',
            outcome: 'success'
          },
          {
            id: 'producer-result-data',
            kind: 'data',
            from: { stepId: 'producer', port: 'result' },
            to: { stepId: 'result', port: 'result' }
          }
        ],
        limits: { maxSteps: 2, maxConcurrentSteps: 1, maxAttempts: 2 }
      })
    )
    expect(compiled.ok).toBe(true)
    if (!compiled.ok) return

    expect(validateExecutionGraphV1RuntimeAdmission(compiled.revision)).toEqual([])
  })
})
