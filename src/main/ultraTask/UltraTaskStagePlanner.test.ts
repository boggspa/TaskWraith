import { describe, expect, it } from 'vitest'
import { validateExecutionGraphV1RuntimeAdmission } from '../executionGraph/ExecutionGraphCompiler'
import type { ExecutionPermissionRequestRef } from '../executionGraph/ExecutionGraphModel'
import {
  buildUltraTaskStageGraph,
  type BuildUltraTaskStageGraphInput,
  type UltraTaskStageAgent
} from './UltraTaskStagePlanner'

const permissionRequestRef: ExecutionPermissionRequestRef = {
  schemaVersion: 1,
  referenceId: 'ultratask-permission-worker',
  ceilingReferenceId: 'run-ceiling',
  authorityDigest: 'signed-ceiling'
}

function agent(
  provider: UltraTaskStageAgent['provider'],
  model: string,
  role: string,
  withPermission = false
): UltraTaskStageAgent {
  return {
    provider,
    model,
    runTemplateRef: `template-${role}`,
    ...(withPermission ? { permissionRequestRef } : {})
  }
}

function input(
  overrides: Partial<BuildUltraTaskStageGraphInput> = {}
): BuildUltraTaskStageGraphInput {
  return {
    graphId: 'ultratask-graph-1',
    revision: 1,
    workspaceId: 'workspace-1',
    createdAt: '2026-08-24T02:00:00.000Z',
    task: 'Implement and verify the parser.',
    scouts: [
      agent('codex', 'gpt-5.6-luna', 'scout-1'),
      agent('claude', 'claude-sonnet-5', 'scout-2')
    ],
    worker: agent('codex', 'gpt-5.6-sol', 'worker', true),
    reviewer: agent('muse', 'muse-spark-1.2', 'reviewer'),
    synthesis: agent('codex', 'gpt-5.6-terra', 'synthesis'),
    workerEffect: 'workspace_write',
    ...overrides
  }
}

describe('buildUltraTaskStageGraph', () => {
  it('compiles scout branches, a real join, worker, reviewer, synthesis, and output', () => {
    const result = buildUltraTaskStageGraph(input())
    expect(result.ok).toBe(true)
    if (!result.ok) return

    expect(result.stageIds.scouts).toHaveLength(2)
    expect(result.revision.steps.map((step) => step.kind)).toEqual([
      'solo_agent',
      'solo_agent',
      'join',
      'solo_agent',
      'solo_agent',
      'solo_agent',
      'output'
    ])
    const join = result.revision.steps.find((step) => step.id === result.stageIds.scoutJoin)
    expect(join).toMatchObject({ kind: 'join', join: { mode: 'all' }, effect: 'read_only' })
    expect(
      result.revision.edges.filter(
        (edge) => edge.kind === 'control' && edge.toStepId === result.stageIds.scoutJoin
      )
    ).toHaveLength(2)
  })

  it('hands every scout report to the worker through typed data edges', () => {
    const result = buildUltraTaskStageGraph(input())
    if (!result.ok) throw new Error(JSON.stringify(result.issues))
    const worker = result.revision.steps.find((step) => step.id === result.stageIds.worker)
    expect(worker?.inputs?.map((port) => port.name)).toEqual(['scout_1', 'scout_2'])
    expect(
      result.revision.edges.filter(
        (edge) => edge.kind === 'data' && edge.to.stepId === result.stageIds.worker
      )
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          from: { stepId: result.stageIds.scouts[0], port: 'report' },
          to: { stepId: result.stageIds.worker, port: 'scout_1' }
        }),
        expect.objectContaining({
          from: { stepId: result.stageIds.scouts[1], port: 'report' },
          to: { stepId: result.stageIds.worker, port: 'scout_2' }
        })
      ])
    )
  })

  it('starts review only after the worker artifact and gives synthesis both inputs', () => {
    const result = buildUltraTaskStageGraph(input())
    if (!result.ok) throw new Error(JSON.stringify(result.issues))
    const controls = result.revision.edges.filter((edge) => edge.kind === 'control')
    expect(controls).toContainEqual(
      expect.objectContaining({
        fromStepId: result.stageIds.worker,
        toStepId: result.stageIds.reviewer
      })
    )
    expect(controls).toContainEqual(
      expect.objectContaining({
        fromStepId: result.stageIds.reviewer,
        toStepId: result.stageIds.synthesis
      })
    )
    const reviewer = result.revision.steps.find((step) => step.id === result.stageIds.reviewer)
    expect(reviewer?.inputs?.map((port) => port.name)).toEqual(['worker_artifact'])
    expect(reviewer?.effect).toBe('read_only')
    expect(reviewer?.objective).toMatch(/terminal worker artifact/i)

    const synthesis = result.revision.steps.find((step) => step.id === result.stageIds.synthesis)
    expect(synthesis?.inputs?.map((port) => port.name)).toEqual(['worker_artifact', 'review'])
  })

  it('keeps scouts/reviewer/synthesis read-only and carries only the signed worker request', () => {
    const result = buildUltraTaskStageGraph(input())
    if (!result.ok) throw new Error(JSON.stringify(result.issues))
    for (const stepId of [
      ...result.stageIds.scouts,
      result.stageIds.reviewer,
      result.stageIds.synthesis
    ]) {
      const step = result.revision.steps.find((candidate) => candidate.id === stepId)
      expect(step?.effect).toBe('read_only')
      expect(step?.permissionRequestRef).toBeUndefined()
    }
    const worker = result.revision.steps.find((step) => step.id === result.stageIds.worker)
    expect(worker).toMatchObject({
      effect: 'workspace_write',
      permissionRequestRef
    })
  })

  it('carries bounded retries and execution budgets into the compiled graph', () => {
    const result = buildUltraTaskStageGraph(
      input({
        retryMaxAttempts: 2,
        budgets: { maxWallClockMs: 600_000, maxTokens: 200_000, maxCostUsd: 12.5 }
      })
    )
    if (!result.ok) throw new Error(JSON.stringify(result.issues))
    expect(result.revision.limits).toMatchObject({
      maxConcurrentSteps: 2,
      maxAttempts: 12,
      maxWallClockMs: 600_000,
      maxTokens: 200_000,
      maxCostUsd: 12.5
    })
  })

  it('fails closed on fewer than two scouts or any sentinel model', () => {
    const tooFew = buildUltraTaskStageGraph(input({ scouts: [agent('codex', 'gpt-5.5', 'one')] }))
    expect(tooFew).toMatchObject({
      ok: false,
      issues: expect.arrayContaining([expect.objectContaining({ code: 'scout_quorum_required' })])
    })

    const sentinel = buildUltraTaskStageGraph(
      input({ reviewer: agent('claude', 'cli-default', 'reviewer') })
    )
    expect(sentinel).toMatchObject({
      ok: false,
      issues: expect.arrayContaining([expect.objectContaining({ code: 'concrete_model_required' })])
    })
  })

  it('documents the exact generic-kernel capabilities the bound V1 executor still lacks', () => {
    const result = buildUltraTaskStageGraph(input())
    if (!result.ok) throw new Error(JSON.stringify(result.issues))
    const codes = validateExecutionGraphV1RuntimeAdmission(result.revision).map(
      (entry) => entry.code
    )
    expect(codes).toEqual(
      expect.arrayContaining([
        'runtime_concurrency_unsupported',
        'runtime_data_edge_unsupported',
        'runtime_parallel_topology_unsupported',
        'runtime_step_kind_unsupported'
      ])
    )
  })
})
