import type { ProviderId } from '../store/types'
import {
  compileExecutionGraphRevision,
  type ExecutionGraphCompilationIssue
} from '../executionGraph/ExecutionGraphCompiler'
import type {
  ExecutionEffect,
  ExecutionGraphLimits,
  ExecutionGraphRevision,
  ExecutionGraphRevisionDraft,
  ExecutionJsonSchema,
  ExecutionPermissionRequestRef,
  ExecutionStepDefinition
} from '../executionGraph/ExecutionGraphModel'
import { isConcreteUltraTaskModelId } from './UltraTaskCapabilityResolver'

const STRUCTURED_OUTPUT_SCHEMA = Object.freeze({
  type: 'object',
  additionalProperties: true
}) as ExecutionJsonSchema

export interface UltraTaskStageAgent {
  provider: ProviderId
  model: string
  runTemplateRef: string
  permissionRequestRef?: ExecutionPermissionRequestRef
}

export interface BuildUltraTaskStageGraphInput {
  graphId: string
  revision: number
  workspaceId: string
  createdAt: string
  task: string
  /** Two or more independent read-only branches make the join real. */
  scouts: readonly UltraTaskStageAgent[]
  worker: UltraTaskStageAgent
  reviewer: UltraTaskStageAgent
  synthesis: UltraTaskStageAgent
  /** Must come from the signed permission ceiling; never inferred here. */
  workerEffect: Extract<ExecutionEffect, 'read_only' | 'workspace_write'>
  retryMaxAttempts?: number
  budgets?: Pick<ExecutionGraphLimits, 'maxWallClockMs' | 'maxTokens' | 'maxCostUsd'>
}

export interface UltraTaskStageIds {
  scouts: string[]
  scoutJoin: string
  worker: string
  reviewer: string
  synthesis: string
  output: string
}

export type UltraTaskStageGraphPlan =
  | {
      ok: true
      revision: ExecutionGraphRevision
      stageIds: UltraTaskStageIds
    }
  | {
      ok: false
      issues: readonly ExecutionGraphCompilationIssue[]
    }

function issue(code: string, path: string, message: string): ExecutionGraphCompilationIssue {
  return { code, path, message }
}

function validAgent(agent: UltraTaskStageAgent, path: string): ExecutionGraphCompilationIssue[] {
  const issues: ExecutionGraphCompilationIssue[] = []
  if (!agent.provider)
    issues.push(issue('invalid_provider', `${path}.provider`, 'Provider is required.'))
  if (!isConcreteUltraTaskModelId(agent.model)) {
    issues.push(
      issue(
        'concrete_model_required',
        `${path}.model`,
        'UltraTask stages require an exact concrete model id.'
      )
    )
  }
  if (!agent.runTemplateRef.trim()) {
    issues.push(
      issue('run_template_required', `${path}.runTemplateRef`, 'Run template ref is required.')
    )
  }
  return issues
}

function soloStep(input: {
  id: string
  title: string
  objective: string
  effect: ExecutionEffect
  agent: UltraTaskStageAgent
  retryMaxAttempts: number
  inputs?: Array<{ name: string; required?: boolean }>
  outputs?: Array<{ name: string; required?: boolean }>
}): ExecutionStepDefinition {
  return {
    id: input.id,
    kind: 'solo_agent',
    title: input.title,
    objective: input.objective,
    effect: input.effect,
    ...(input.inputs
      ? {
          inputs: input.inputs.map((port) => ({
            ...port,
            schema: STRUCTURED_OUTPUT_SCHEMA
          }))
        }
      : {}),
    ...(input.outputs
      ? {
          outputs: input.outputs.map((port) => ({
            ...port,
            schema: STRUCTURED_OUTPUT_SCHEMA
          }))
        }
      : {}),
    retry: { maxAttempts: input.retryMaxAttempts },
    ...(input.agent.permissionRequestRef
      ? { permissionRequestRef: input.agent.permissionRequestRef }
      : {}),
    agent: {
      provider: input.agent.provider,
      model: input.agent.model,
      runTemplateRef: input.agent.runTemplateRef,
      session: { mode: 'fresh' }
    }
  }
}

/**
 * Compile the first-class UltraTask DAG. This is product-specific planning on
 * top of the generic execution-graph kernel; consent, quota, pricing, and
 * provider selection are resolved before this boundary.
 */
export function buildUltraTaskStageGraph(
  input: BuildUltraTaskStageGraphInput
): UltraTaskStageGraphPlan {
  const preflight: ExecutionGraphCompilationIssue[] = []
  if (input.scouts.length < 2) {
    preflight.push(
      issue(
        'scout_quorum_required',
        'scouts',
        'A staged UltraTask requires at least two independent scout branches.'
      )
    )
  }
  if (!input.task.trim()) {
    preflight.push(issue('task_required', 'task', 'UltraTask task is required.'))
  }
  const retryMaxAttempts = input.retryMaxAttempts ?? 1
  if (!Number.isInteger(retryMaxAttempts) || retryMaxAttempts < 1 || retryMaxAttempts > 3) {
    preflight.push(
      issue(
        'invalid_retry_limit',
        'retryMaxAttempts',
        'UltraTask retryMaxAttempts must be an integer from 1 to 3.'
      )
    )
  }
  input.scouts.forEach((agent, index) => {
    preflight.push(...validAgent(agent, `scouts[${index}]`))
  })
  preflight.push(...validAgent(input.worker, 'worker'))
  preflight.push(...validAgent(input.reviewer, 'reviewer'))
  preflight.push(...validAgent(input.synthesis, 'synthesis'))
  if (preflight.length > 0) return { ok: false, issues: preflight }

  const stageIds: UltraTaskStageIds = {
    scouts: input.scouts.map((_agent, index) => `ultratask-scout-${index + 1}`),
    scoutJoin: 'ultratask-scout-join',
    worker: 'ultratask-worker',
    reviewer: 'ultratask-reviewer',
    synthesis: 'ultratask-synthesis',
    output: 'ultratask-output'
  }
  const scoutSteps = input.scouts.map((agent, index) =>
    soloStep({
      id: stageIds.scouts[index]!,
      title: `UltraTask Scout ${index + 1}`,
      objective:
        `Investigate the assigned aspect of this task independently and return structured ` +
        `facts, constraints, risks, and recommendations: ${input.task.trim()}`,
      effect: 'read_only',
      agent,
      retryMaxAttempts,
      outputs: [{ name: 'report', required: true }]
    })
  )
  const workerInputs = stageIds.scouts.map((_id, index) => ({
    name: `scout_${index + 1}`,
    required: true
  }))
  const workerStep = soloStep({
    id: stageIds.worker,
    title: 'UltraTask Worker',
    objective:
      `Execute the task using every joined scout report. Return a structured result plus ` +
      `artifact/diff references suitable for independent review: ${input.task.trim()}`,
    effect: input.workerEffect,
    agent: input.worker,
    retryMaxAttempts,
    inputs: workerInputs,
    outputs: [{ name: 'artifact', required: true }]
  })
  const reviewerStep = soloStep({
    id: stageIds.reviewer,
    title: 'UltraTask Reviewer',
    objective:
      'Review the terminal worker artifact independently. Verify acceptance criteria, inspect referenced changes/evidence, and return a structured verdict with blocking findings.',
    effect: 'read_only',
    agent: input.reviewer,
    retryMaxAttempts,
    inputs: [{ name: 'worker_artifact', required: true }],
    outputs: [{ name: 'review', required: true }]
  })
  const synthesisStep = soloStep({
    id: stageIds.synthesis,
    title: 'UltraTask Synthesis',
    objective:
      'Synthesize the worker artifact and independent reviewer verdict into one honest final result. Never claim completion when the review is blocking or required evidence is missing.',
    effect: 'read_only',
    agent: input.synthesis,
    retryMaxAttempts,
    inputs: [
      { name: 'worker_artifact', required: true },
      { name: 'review', required: true }
    ],
    outputs: [{ name: 'answer', required: true }]
  })
  const steps: ExecutionStepDefinition[] = [
    ...scoutSteps,
    {
      id: stageIds.scoutJoin,
      kind: 'join',
      title: 'UltraTask Scout Join',
      objective: 'Wait durably for every required scout branch before the worker starts.',
      effect: 'read_only',
      retry: { maxAttempts: 1 },
      join: { mode: 'all' }
    },
    workerStep,
    reviewerStep,
    synthesisStep,
    {
      id: stageIds.output,
      kind: 'output',
      title: 'UltraTask Result',
      objective: 'Publish the reviewed synthesis to the owning TaskWraith run.',
      effect: 'read_only',
      inputs: [{ name: 'answer', schema: STRUCTURED_OUTPUT_SCHEMA, required: true }],
      retry: { maxAttempts: 1 },
      output: { label: 'UltraTask result', projectReference: 'none' }
    }
  ]
  const controlEdges = [
    ...stageIds.scouts.map((scoutId, index) => ({
      id: `ultratask-control-scout-${index + 1}-join`,
      kind: 'control' as const,
      fromStepId: scoutId,
      toStepId: stageIds.scoutJoin,
      outcome: 'success' as const
    })),
    {
      id: 'ultratask-control-join-worker',
      kind: 'control' as const,
      fromStepId: stageIds.scoutJoin,
      toStepId: stageIds.worker,
      outcome: 'success' as const
    },
    {
      id: 'ultratask-control-worker-reviewer',
      kind: 'control' as const,
      fromStepId: stageIds.worker,
      toStepId: stageIds.reviewer,
      outcome: 'success' as const
    },
    {
      id: 'ultratask-control-reviewer-synthesis',
      kind: 'control' as const,
      fromStepId: stageIds.reviewer,
      toStepId: stageIds.synthesis,
      outcome: 'success' as const
    },
    {
      id: 'ultratask-control-synthesis-output',
      kind: 'control' as const,
      fromStepId: stageIds.synthesis,
      toStepId: stageIds.output,
      outcome: 'success' as const
    }
  ]
  const dataEdges = [
    ...stageIds.scouts.map((scoutId, index) => ({
      id: `ultratask-data-scout-${index + 1}-worker`,
      kind: 'data' as const,
      from: { stepId: scoutId, port: 'report' },
      to: { stepId: stageIds.worker, port: `scout_${index + 1}` }
    })),
    {
      id: 'ultratask-data-worker-reviewer',
      kind: 'data' as const,
      from: { stepId: stageIds.worker, port: 'artifact' },
      to: { stepId: stageIds.reviewer, port: 'worker_artifact' }
    },
    {
      id: 'ultratask-data-worker-synthesis',
      kind: 'data' as const,
      from: { stepId: stageIds.worker, port: 'artifact' },
      to: { stepId: stageIds.synthesis, port: 'worker_artifact' }
    },
    {
      id: 'ultratask-data-reviewer-synthesis',
      kind: 'data' as const,
      from: { stepId: stageIds.reviewer, port: 'review' },
      to: { stepId: stageIds.synthesis, port: 'review' }
    },
    {
      id: 'ultratask-data-synthesis-output',
      kind: 'data' as const,
      from: { stepId: stageIds.synthesis, port: 'answer' },
      to: { stepId: stageIds.output, port: 'answer' }
    }
  ]
  const maxAttempts = input.scouts.length * retryMaxAttempts + retryMaxAttempts * 3 + 2 // join + output are deterministic one-attempt steps
  const draft: ExecutionGraphRevisionDraft = {
    graphId: input.graphId,
    revision: input.revision,
    workspaceId: input.workspaceId,
    name: 'UltraTask',
    description: input.task.trim(),
    createdAt: input.createdAt,
    steps,
    edges: [...controlEdges, ...dataEdges],
    limits: {
      maxSteps: steps.length,
      maxConcurrentSteps: input.scouts.length,
      maxAttempts,
      ...(input.budgets?.maxWallClockMs !== undefined
        ? { maxWallClockMs: input.budgets.maxWallClockMs }
        : {}),
      ...(input.budgets?.maxTokens !== undefined ? { maxTokens: input.budgets.maxTokens } : {}),
      ...(input.budgets?.maxCostUsd !== undefined ? { maxCostUsd: input.budgets.maxCostUsd } : {})
    }
  }
  const compiled = compileExecutionGraphRevision(draft)
  return compiled.ok
    ? { ok: true, revision: compiled.revision, stageIds }
    : { ok: false, issues: compiled.issues }
}
