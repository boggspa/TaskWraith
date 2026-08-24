import type { ProviderId } from '../store/types'
import type {
  ExecutionEffect,
  ExecutionGraphRevision,
  ExecutionPermissionCeilingRef,
  ExecutionPermissionRequestRef
} from '../executionGraph/ExecutionGraphModel'
import type { ExecutionRunProjection } from '../executionGraph/ExecutionGraphRun'
import type { StartExecutionGraphInput } from '../services/ExecutionGraphCoordinator'
import { isConcreteUltraTaskModelId } from './UltraTaskCapabilityResolver'
import {
  buildUltraTaskStageGraph,
  type UltraTaskStageAgent,
  type UltraTaskStageIds
} from './UltraTaskStagePlanner'

export type UltraTaskStageKind = 'scout' | 'worker' | 'reviewer' | 'synthesis'

export interface UltraTaskStageSeat {
  provider: ProviderId
  model: string
  reasoningEffort?: string
  runtimeProfileId?: string
}

export interface PrepareUltraTaskStageInput {
  workflowId: string
  stage: UltraTaskStageKind
  stageIndex: number
  task: string
  prompt: string
  effect: Extract<ExecutionEffect, 'read_only' | 'workspace_write'>
  seat: UltraTaskStageSeat
  workspaceId: string
  rootChatId: string
  permissionCeilingRef: ExecutionPermissionCeilingRef
}

export interface PreparedUltraTaskStage {
  runTemplateRef: string
  permissionAuthorityDigest: string
}

export interface StartUltraTaskWorkflowInput {
  title?: string
  task: string
  workspaceId: string
  rootChatId: string
  permissionCeilingRef: ExecutionPermissionCeilingRef
  scouts: readonly UltraTaskStageSeat[]
  worker: UltraTaskStageSeat
  reviewer: UltraTaskStageSeat
  synthesis: UltraTaskStageSeat
  workerEffect: Extract<ExecutionEffect, 'read_only' | 'workspace_write'>
}

export interface UltraTaskCoordinatorDeps {
  prepareStage(input: PrepareUltraTaskStageInput): PreparedUltraTaskStage
  saveRevision(revision: ExecutionGraphRevision): ExecutionGraphRevision
  startExecutionGraph(input: StartExecutionGraphInput): ExecutionRunProjection
  createId(kind: 'workflow' | 'graph'): string
  now(): string
}

export interface StartedUltraTaskWorkflow {
  workflowId: string
  graphId: string
  executionId: string
  stageIds: UltraTaskStageIds
  revision: ExecutionGraphRevision
  projection: ExecutionRunProjection
}

function text(value: string, label: string): string {
  const normalized = value.trim()
  if (!normalized) throw new Error(`UltraTask ${label} is required.`)
  return normalized
}

function validateSeat(seat: UltraTaskStageSeat, label: string): void {
  if (!seat.provider) throw new Error(`UltraTask ${label} provider is required.`)
  if (!isConcreteUltraTaskModelId(seat.model)) {
    throw new Error(`UltraTask ${label} requires an exact concrete model.`)
  }
}

function stagePrompt(stage: UltraTaskStageKind, task: string, index: number): string {
  if (stage === 'scout') {
    return (
      `UltraTask scout ${index + 1}: investigate independently and return structured facts, ` +
      `constraints, risks, and recommendations. Do not modify files.\n\nTask: ${task}`
    )
  }
  if (stage === 'worker') {
    return (
      'Execute the task using every structured scout input supplied by TaskWraith. Return a ' +
      `structured result plus artifact/diff evidence for independent review.\n\nTask: ${task}`
    )
  }
  if (stage === 'reviewer') {
    return (
      'Review the terminal worker artifact supplied by TaskWraith. Verify acceptance criteria ' +
      'and return a structured verdict with blocking findings. Do not mutate the workspace.\n\n' +
      `Task: ${task}`
    )
  }
  return (
    'Synthesize the worker artifact and independent review supplied by TaskWraith into one ' +
    'honest final result. Do not claim completion when review is blocking or evidence is missing.\n\n' +
    `Task: ${task}`
  )
}

function permissionRequestRef(
  workflowId: string,
  stage: UltraTaskStageKind,
  index: number,
  ceiling: ExecutionPermissionCeilingRef,
  prepared: PreparedUltraTaskStage
): ExecutionPermissionRequestRef {
  const digest = prepared.permissionAuthorityDigest.trim()
  if (!digest) throw new Error(`UltraTask ${stage} stage has no permission authority digest.`)
  return {
    schemaVersion: 1,
    referenceId: `${workflowId}-${stage}-${index + 1}`,
    ceilingReferenceId: ceiling.referenceId,
    authorityDigest: digest
  }
}

function preparedAgent(
  deps: UltraTaskCoordinatorDeps,
  input: StartUltraTaskWorkflowInput,
  workflowId: string,
  stage: UltraTaskStageKind,
  stageIndex: number,
  seat: UltraTaskStageSeat,
  effect: Extract<ExecutionEffect, 'read_only' | 'workspace_write'>,
  task: string
): UltraTaskStageAgent {
  const prepared = deps.prepareStage({
    workflowId,
    stage,
    stageIndex,
    task,
    prompt: stagePrompt(stage, task, stageIndex),
    effect,
    seat,
    workspaceId: input.workspaceId,
    rootChatId: input.rootChatId,
    permissionCeilingRef: input.permissionCeilingRef
  })
  if (!prepared.runTemplateRef.trim()) {
    throw new Error(`UltraTask ${stage} stage has no run template.`)
  }
  return {
    provider: seat.provider,
    model: seat.model,
    runTemplateRef: prepared.runTemplateRef,
    permissionRequestRef: permissionRequestRef(
      workflowId,
      stage,
      stageIndex,
      input.permissionCeilingRef,
      prepared
    )
  }
}

/**
 * Product adapter over the generic graph kernel. The execution deliberately has
 * no parent-run anchor: a provider may finish its initiating turn immediately,
 * while the durable workflow continues until success, cancellation, or failure.
 */
export function startUltraTaskWorkflow(
  input: StartUltraTaskWorkflowInput,
  deps: UltraTaskCoordinatorDeps
): StartedUltraTaskWorkflow {
  const task = text(input.task, 'task')
  text(input.workspaceId, 'workspace id')
  text(input.rootChatId, 'root chat id')
  if (input.scouts.length < 2) throw new Error('UltraTask requires at least two scout seats.')
  input.scouts.forEach((seat, index) => validateSeat(seat, `scout ${index + 1}`))
  validateSeat(input.worker, 'worker')
  validateSeat(input.reviewer, 'reviewer')
  validateSeat(input.synthesis, 'synthesis')
  const provider = input.worker.provider
  const providerMismatch = [...input.scouts, input.reviewer, input.synthesis].find(
    (seat) => seat.provider !== provider
  )
  if (providerMismatch) {
    throw new Error(
      'UltraTask staged graphs currently require one provider authority ceiling; mixed-provider stages need a signed composite ceiling.'
    )
  }

  const workflowId = text(deps.createId('workflow'), 'workflow id')
  const graphId = text(deps.createId('graph'), 'graph id')
  const scouts = input.scouts.map((seat, index) =>
    preparedAgent(deps, input, workflowId, 'scout', index, seat, 'read_only', task)
  )
  const worker = preparedAgent(
    deps,
    input,
    workflowId,
    'worker',
    0,
    input.worker,
    input.workerEffect,
    task
  )
  const reviewer = preparedAgent(
    deps,
    input,
    workflowId,
    'reviewer',
    0,
    input.reviewer,
    'read_only',
    task
  )
  const synthesis = preparedAgent(
    deps,
    input,
    workflowId,
    'synthesis',
    0,
    input.synthesis,
    'read_only',
    task
  )
  const plan = buildUltraTaskStageGraph({
    graphId,
    revision: 1,
    workspaceId: input.workspaceId,
    createdAt: deps.now(),
    task,
    scouts,
    worker,
    reviewer,
    synthesis,
    workerEffect: input.workerEffect
  })
  if (!plan.ok) {
    throw new Error(
      `UltraTask graph compilation failed: ${plan.issues.map((entry) => entry.code).join(', ')}.`
    )
  }
  const revision = deps.saveRevision(plan.revision)
  if (revision.revisionId !== plan.revision.revisionId) {
    throw new Error('UltraTask graph revision changed while it was saved.')
  }
  const projection = deps.startExecutionGraph({
    executionId: workflowId,
    title: input.title?.trim() || 'UltraTask',
    workspaceId: input.workspaceId,
    rootChatId: input.rootChatId,
    tenant: { kind: 'workflow', tenantId: workflowId },
    revision,
    permissionCeilingRef: input.permissionCeilingRef
  })
  if (projection.executionId !== workflowId) {
    throw new Error('UltraTask graph start returned a different execution identity.')
  }
  return {
    workflowId,
    graphId,
    executionId: projection.executionId,
    stageIds: plan.stageIds,
    revision,
    projection
  }
}
