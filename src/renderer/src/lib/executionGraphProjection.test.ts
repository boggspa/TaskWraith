import { describe, expect, it } from 'vitest'
import type {
  EffectiveExecutionTopology,
  ExecutionEdge,
  ExecutionStepDefinition,
  StepActivation,
  StepAttempt
} from '../../../main/executionGraph/ExecutionGraphModel'
import { buildExecutionGraphProjection } from './executionGraphProjection'

const at = '2026-07-18T10:00:00.000Z'

function step(
  id: string,
  kind: 'solo_agent' | 'deterministic_check' | 'output' = 'solo_agent'
): ExecutionStepDefinition {
  const common = {
    id,
    title: id.charAt(0).toUpperCase() + id.slice(1),
    objective: `Complete ${id}`,
    effect: 'read_only' as const,
    retry: { maxAttempts: 1 }
  }
  if (kind === 'deterministic_check') {
    return { ...common, kind, check: { handlerRef: `check/${id}` } }
  }
  if (kind === 'output') {
    return { ...common, kind, output: { projectReference: 'none' } }
  }
  return {
    ...common,
    kind,
    agent: { provider: 'codex', session: { mode: 'fresh' } }
  }
}

function control(id: string, fromStepId: string, toStepId: string): ExecutionEdge {
  return { id, kind: 'control', fromStepId, toStepId, outcome: 'success' }
}

function topology(
  steps: readonly ExecutionStepDefinition[],
  edges: readonly ExecutionEdge[]
): EffectiveExecutionTopology {
  return { steps, edges }
}

function activation(
  stepId: string,
  state: StepActivation['state'],
  overrides: Partial<StepActivation> = {}
): StepActivation {
  return {
    id: `activation-${stepId}`,
    stepId,
    state,
    createdAt: at,
    updatedAt: at,
    attemptIds: [],
    ...overrides
  }
}

describe('buildExecutionGraphProjection', () => {
  it('builds deterministic semantic stages and Current/Next/Then Stack positions', () => {
    const steps = [
      step('recon'),
      step('review', 'deterministic_check'),
      step('draft'),
      step('publish', 'output')
    ]
    const edges = [
      control('e-recon-review', 'recon', 'review'),
      control('e-recon-draft', 'recon', 'draft'),
      control('e-review-publish', 'review', 'publish'),
      control('e-draft-publish', 'draft', 'publish')
    ]

    const projection = buildExecutionGraphProjection({
      runId: 'run-1',
      runState: 'running',
      title: 'Release Stack',
      topology: topology(steps, edges),
      activations: [
        activation('recon', 'succeeded'),
        activation('review', 'ready'),
        activation('draft', 'running'),
        activation('publish', 'dormant')
      ],
      runtimeAppendedStepIds: ['publish']
    })

    expect(projection.stages.map((stage) => stage.steps.map((item) => item.stepId))).toEqual([
      ['recon'],
      ['review', 'draft'],
      ['publish']
    ])
    expect(
      projection.stackRows.map((item) => [item.stepId, item.stackPosition, item.statusLabel])
    ).toEqual([
      ['review', 'next', 'Ready'],
      ['draft', 'current', 'Running'],
      ['publish', 'then', 'Planned']
    ])
    expect(projection.orderedSteps.find((item) => item.stepId === 'publish')).toMatchObject({
      blocker: 'Waiting for Review, Draft',
      isRuntimeAppended: true
    })
    expect(projection.hasRuntimeAppends).toBe(true)
    expect(projection.liveSummary).toContain('Current: Draft')
  })

  it('makes all concurrently ready nodes Current when nothing is already active', () => {
    const projection = buildExecutionGraphProjection({
      runId: 'run-ready',
      runState: 'running',
      topology: topology([step('one'), step('two')], []),
      activations: [activation('one', 'ready'), activation('two', 'ready')]
    })

    expect(projection.stackRows.map((item) => item.stackPosition)).toEqual(['current', 'current'])
  })

  it('surfaces failed dependency blockers instead of presenting successors as runnable', () => {
    const projection = buildExecutionGraphProjection({
      runId: 'run-failed',
      runState: 'failed',
      topology: topology(
        [step('source'), step('dependent')],
        [control('e-source-dependent', 'source', 'dependent')]
      ),
      activations: [
        activation('source', 'failed'),
        activation('dependent', 'dormant', { reason: undefined })
      ],
      attempts: [
        {
          id: 'attempt-source',
          activationId: 'activation-source',
          stepId: 'source',
          ordinal: 1,
          state: 'failed',
          createdAt: at,
          updatedAt: at,
          completedAt: at,
          error: 'Provider exited'
        }
      ]
    })

    expect(projection.orderedSteps.find((item) => item.stepId === 'source')).toMatchObject({
      stackPosition: 'current',
      blocker: 'Provider exited',
      statusTone: 'failure'
    })
    expect(projection.orderedSteps.find((item) => item.stepId === 'dependent')?.blocker).toBe(
      'Blocked by Source (Failed)'
    )
  })

  it('projects attempts, artifacts, data bindings, and the latest activation without mutation', () => {
    const source = {
      ...step('source'),
      outputs: [{ name: 'report', required: true }]
    } as ExecutionStepDefinition
    const sink = {
      ...step('sink', 'output'),
      inputs: [{ name: 'input', required: true }]
    } as ExecutionStepDefinition
    const attempts: StepAttempt[] = [
      {
        id: 'attempt-sink',
        activationId: 'activation-sink-new',
        stepId: 'sink',
        ordinal: 1,
        state: 'succeeded',
        createdAt: at,
        updatedAt: at,
        result: {
          schemaVersion: 1,
          artifactRefs: [
            {
              schemaVersion: 1,
              id: 'artifact-1',
              kind: 'report',
              uri: 'file:///tmp/report.md',
              createdByAttemptId: 'attempt-sink',
              trust: 'deterministic'
            }
          ],
          trust: 'deterministic'
        }
      }
    ]

    const projection = buildExecutionGraphProjection({
      runId: 'run-data',
      runState: 'succeeded',
      topology: topology(
        [source, sink],
        [
          {
            id: 'data-source-sink',
            kind: 'data',
            from: { stepId: 'source', port: 'report' },
            to: { stepId: 'sink', port: 'input' }
          }
        ]
      ),
      activations: [
        activation('source', 'succeeded'),
        activation('sink', 'running', {
          id: 'activation-sink-old',
          updatedAt: '2026-07-18T09:00:00.000Z'
        }),
        activation('sink', 'succeeded', { id: 'activation-sink-new' })
      ],
      attempts
    })

    const projectedSink = projection.orderedSteps.find((item) => item.stepId === 'sink')
    expect(projectedSink?.dependencies[0].label).toBe('Receives input from Source.report')
    expect(projectedSink?.activationId).toBe('activation-sink-new')
    expect(projectedSink?.artifactRefs[0].id).toBe('artifact-1')
    expect(projection.stackRows).toEqual([])
  })

  it('fails visibly but deterministically when handed an invalid cyclic projection', () => {
    const projection = buildExecutionGraphProjection({
      runId: 'run-cycle',
      runState: 'requires_action',
      topology: topology(
        [step('alpha'), step('beta')],
        [control('a-b', 'alpha', 'beta'), control('b-a', 'beta', 'alpha')]
      )
    })

    expect(projection.orderedSteps.map((item) => item.stepId)).toEqual(['alpha', 'beta'])
    expect(projection.issues).toEqual([
      'The effective topology contains a dependency cycle; cyclic steps are display-only.'
    ])
  })

  it('ignores unknown and malformed persisted edge kinds with diagnostic issues', () => {
    const unsafeEdges = [
      {
        id: 'future-edge',
        kind: 'feedback',
        fromStepId: 'alpha',
        toStepId: 'beta'
      },
      {
        id: 'broken-data',
        kind: 'data',
        from: { stepId: 'alpha', port: 'report' },
        to: null
      }
    ] as unknown as ExecutionEdge[]

    const projection = buildExecutionGraphProjection({
      runId: 'run-forward-compatible',
      runState: 'running',
      topology: topology([step('alpha'), step('beta')], unsafeEdges),
      activations: [activation('alpha', 'dormant'), activation('beta', 'dormant')]
    })

    expect(projection.orderedSteps.map((item) => [item.stepId, item.stage])).toEqual([
      ['alpha', 0],
      ['beta', 0]
    ])
    expect(projection.orderedSteps.every((item) => item.dependencies.length === 0)).toBe(true)
    expect(projection.orderedSteps.every((item) => item.canCancel)).toBe(true)
    expect(projection.issues).toEqual([
      'Edge future-edge has unsupported kind "feedback" and was ignored.',
      'Edge broken-data is malformed for kind "data" and was ignored.'
    ])
  })

  it('keeps dormant cancellation limited to the effective topology frontier', () => {
    const projection = buildExecutionGraphProjection({
      runId: 'run-cancellable-frontier',
      runState: 'running',
      topology: topology(
        [step('source'), step('frontier')],
        [control('source-frontier', 'source', 'frontier')]
      ),
      activations: [activation('source', 'dormant'), activation('frontier', 'dormant')]
    })

    expect(projection.orderedSteps.map((item) => [item.stepId, item.canCancel])).toEqual([
      ['source', false],
      ['frontier', true]
    ])
  })
})
