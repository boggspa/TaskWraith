import { describe, expect, it, vi } from 'vitest'
import type { ExecutionGraphRevision } from '../executionGraph/ExecutionGraphModel'
import type { ExecutionRunProjection } from '../executionGraph/ExecutionGraphRun'
import {
  startUltraTaskWorkflow,
  type PrepareUltraTaskStageInput,
  type StartUltraTaskWorkflowInput,
  type UltraTaskCoordinatorDeps
} from './UltraTaskCoordinator'

function input(overrides: Partial<StartUltraTaskWorkflowInput> = {}): StartUltraTaskWorkflowInput {
  return {
    title: 'Parser UltraTask',
    task: 'Implement and verify the parser.',
    workspaceId: 'workspace-one',
    rootChatId: 'chat-one',
    permissionCeilingRef: {
      schemaVersion: 1,
      referenceId: 'parent-ceiling',
      authorityDigest: 'parent-authority',
      workspaceId: 'workspace-one'
    },
    scouts: [
      { provider: 'codex', model: 'gpt-5.6-luna' },
      { provider: 'codex', model: 'gpt-5.6-terra' }
    ],
    worker: { provider: 'codex', model: 'gpt-5.6-sol' },
    reviewer: { provider: 'codex', model: 'gpt-5.5' },
    synthesis: { provider: 'codex', model: 'gpt-5.6-terra' },
    workerEffect: 'workspace_write',
    ...overrides
  }
}

function deps() {
  let revision: ExecutionGraphRevision | undefined
  const calls: string[] = []
  const prepareStage = vi.fn((stage: PrepareUltraTaskStageInput) => {
    calls.push(`prepare:${stage.stage}:${stage.stageIndex}`)
    return {
      runTemplateRef: `template-${stage.stage}-${stage.stageIndex}`,
      permissionAuthorityDigest: `authority-${stage.stage}-${stage.stageIndex}`
    }
  })
  const saveRevision = vi.fn((candidate: ExecutionGraphRevision) => {
    calls.push('save')
    revision = candidate
    return candidate
  })
  const startExecutionGraph = vi.fn((request) => {
    calls.push('start')
    return {
      executionId: request.executionId,
      state: 'running',
      topology: { steps: request.revision.steps, edges: request.revision.edges },
      topologyDigest: 'digest',
      activations: {},
      attempts: {},
      eventCount: 1,
      lastSequence: 1,
      integrity: 'valid',
      baseRevisionMissing: false,
      diagnostics: []
    } as ExecutionRunProjection
  })
  let id = 0
  const result: UltraTaskCoordinatorDeps & {
    prepareStage: typeof prepareStage
    saveRevision: typeof saveRevision
    startExecutionGraph: typeof startExecutionGraph
  } = {
    prepareStage,
    saveRevision,
    startExecutionGraph,
    createId: (kind) => `${kind}-${++id}`,
    now: () => '2026-08-24T02:00:00.000Z'
  }
  return { deps: result, calls, revision: () => revision }
}

describe('startUltraTaskWorkflow', () => {
  it('prepares read-only auxiliary stages and the explicitly postured worker', () => {
    const harness = deps()
    const started = startUltraTaskWorkflow(input(), harness.deps)

    expect(harness.deps.prepareStage).toHaveBeenCalledTimes(5)
    expect(harness.deps.prepareStage.mock.calls.map(([request]) => request.effect)).toEqual([
      'read_only',
      'read_only',
      'workspace_write',
      'read_only',
      'read_only'
    ])
    expect(
      started.revision.steps.find((step) => step.id === started.stageIds.worker)
    ).toMatchObject({
      effect: 'workspace_write',
      permissionRequestRef: {
        ceilingReferenceId: 'parent-ceiling',
        authorityDigest: 'authority-worker-0'
      }
    })
    for (const stepId of [
      ...started.stageIds.scouts,
      started.stageIds.reviewer,
      started.stageIds.synthesis
    ]) {
      expect(started.revision.steps.find((step) => step.id === stepId)?.effect).toBe('read_only')
    }
  })

  it('saves before start and does not anchor lifecycle to the initiating provider run', () => {
    const harness = deps()
    const started = startUltraTaskWorkflow(input(), harness.deps)

    expect(harness.calls.slice(-2)).toEqual(['save', 'start'])
    expect(harness.deps.startExecutionGraph).toHaveBeenCalledWith(
      expect.objectContaining({
        executionId: started.workflowId,
        tenant: { kind: 'workflow', tenantId: started.workflowId }
      })
    )
    const startInput = harness.deps.startExecutionGraph.mock.calls[0]?.[0]
    expect(startInput).not.toHaveProperty('anchorRunRef')
  })

  it('compiles exact staged data flow for worker, reviewer, and synthesis', () => {
    const harness = deps()
    const started = startUltraTaskWorkflow(input(), harness.deps)
    const edges = started.revision.edges

    expect(edges).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'control',
          fromStepId: started.stageIds.worker,
          toStepId: started.stageIds.reviewer
        }),
        expect.objectContaining({
          kind: 'data',
          from: { stepId: started.stageIds.worker, port: 'artifact' },
          to: { stepId: started.stageIds.reviewer, port: 'worker_artifact' }
        }),
        expect.objectContaining({
          kind: 'data',
          from: { stepId: started.stageIds.reviewer, port: 'review' },
          to: { stepId: started.stageIds.synthesis, port: 'review' }
        })
      ])
    )
  })

  it('fails before preparing or launching when any model is a sentinel', () => {
    const harness = deps()
    expect(() =>
      startUltraTaskWorkflow(
        input({ reviewer: { provider: 'claude', model: 'cli-default' } }),
        harness.deps
      )
    ).toThrow(/exact concrete model/i)
    expect(harness.deps.prepareStage).not.toHaveBeenCalled()
    expect(harness.deps.startExecutionGraph).not.toHaveBeenCalled()
  })

  it('fails closed on mixed-provider stages until a composite ceiling exists', () => {
    const harness = deps()
    expect(() =>
      startUltraTaskWorkflow(
        input({ reviewer: { provider: 'claude', model: 'claude-sonnet-5' } }),
        harness.deps
      )
    ).toThrow(/one provider authority ceiling.*composite ceiling/i)
    expect(harness.deps.prepareStage).not.toHaveBeenCalled()
  })

  it('does not launch a graph when template preparation fails', () => {
    const harness = deps()
    harness.deps.prepareStage.mockImplementationOnce(() => {
      throw new Error('Template signing failed.')
    })

    expect(() => startUltraTaskWorkflow(input(), harness.deps)).toThrow(/template signing failed/i)
    expect(harness.deps.saveRevision).not.toHaveBeenCalled()
    expect(harness.deps.startExecutionGraph).not.toHaveBeenCalled()
  })
})
