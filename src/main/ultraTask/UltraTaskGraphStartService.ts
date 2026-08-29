import type {
  ChatWorkflowMode,
  PermissionPresetId,
  ProviderId,
  RunPermissionPostureSnapshot,
  RunQueueRequestSnapshot
} from '../store/types'
import type {
  ExecutionEffect,
  ExecutionGraphRevision,
  ExecutionOwnerRef,
  ExecutionPermissionCeilingRef,
  JsonObject
} from '../executionGraph/ExecutionGraphModel'
import type { ExecutionRunProjection } from '../executionGraph/ExecutionGraphRun'
import type { StartExecutionGraphInput } from '../services/ExecutionGraphCoordinator'
import { executionGraphRunTemplatePermissionCeilingDigest } from '../executionGraph/ExecutionGraphRunTemplateAuthority'
import {
  startUltraTaskWorkflow,
  type PreparedUltraTaskStage,
  type PrepareUltraTaskStageInput,
  type StartedUltraTaskWorkflow
} from './UltraTaskCoordinator'
import { buildUltraTaskRunTemplateRequest } from './UltraTaskRunTemplate'

export interface StartUltraTaskGraphInput {
  title?: string
  task: string
  provider: ProviderId
  model: string
  reasoningEffort?: string
  workspaceId: string
  workspacePath: string
  rootChatId: string
  parentApprovalMode: string
  parentPermissionPresetId: PermissionPresetId
  parentWorkflowMode?: ChatWorkflowMode
  workerEffect: Extract<ExecutionEffect, 'read_only' | 'workspace_write'>
  /** Mandatory accountable thread/seat. Main resolves this from the live run;
   * it is never provider-authored. */
  owner: ExecutionOwnerRef
  /** Two to six independent scouts. Dispatch concurrency is a kernel concern. */
  scoutCount?: number
}

export interface UltraTaskGraphStartServiceDeps {
  resolvePermissionPosture(input: {
    provider: ProviderId
    request: RunQueueRequestSnapshot
    workspacePath: string
    rootChatId: string
  }): RunPermissionPostureSnapshot
  saveRunTemplate(content: JsonObject): { templateId: string }
  saveRevision(revision: ExecutionGraphRevision): ExecutionGraphRevision
  startExecutionGraph(input: StartExecutionGraphInput): ExecutionRunProjection
  createId(kind: 'workflow' | 'graph'): string
  now(): string
}

function jsonObject(value: unknown): JsonObject {
  return JSON.parse(JSON.stringify(value)) as JsonObject
}

function stageEnvelope(
  input: StartUltraTaskGraphInput,
  prompt: string,
  effect: StartUltraTaskGraphInput['workerEffect'],
  deps: UltraTaskGraphStartServiceDeps
): { content: JsonObject; digest: string; request: RunQueueRequestSnapshot } {
  const request = buildUltraTaskRunTemplateRequest({
    prompt,
    effect,
    seat: {
      provider: input.provider,
      model: input.model,
      ...(input.reasoningEffort ? { reasoningEffort: input.reasoningEffort } : {})
    },
    parentApprovalMode: input.parentApprovalMode,
    parentPermissionPresetId: input.parentPermissionPresetId,
    parentWorkflowMode: input.parentWorkflowMode
  })
  const permissionPosture = deps.resolvePermissionPosture({
    provider: input.provider,
    request,
    workspacePath: input.workspacePath,
    rootChatId: input.rootChatId
  })
  if (!permissionPosture.signaturePresent || !permissionPosture.signature) {
    throw new Error('UltraTask graph stage permission posture is unsigned.')
  }
  if (effect === 'read_only' && permissionPosture.readOnly !== true) {
    throw new Error('UltraTask auxiliary stage did not resolve to read-only authority.')
  }
  if (effect === 'workspace_write' && permissionPosture.readOnly !== false) {
    throw new Error('UltraTask worker did not resolve to workspace-write authority.')
  }
  const content = jsonObject({
    schemaVersion: 1,
    provider: input.provider,
    scope: 'workspace',
    workspaceId: input.workspaceId,
    workspacePath: input.workspacePath,
    chatId: input.rootChatId,
    request,
    permissionPosture
  })
  return {
    content,
    digest: executionGraphRunTemplatePermissionCeilingDigest(content),
    request
  }
}

function scoutCount(value: number | undefined): number {
  const count = value ?? 2
  if (!Number.isInteger(count) || count < 2 || count > 6) {
    throw new Error('UltraTask scoutCount must be an integer from 2 to 6.')
  }
  return count
}

/**
 * Main-facing adapter that freezes every stage template before handing the
 * product workflow to `startUltraTaskWorkflow`.
 *
 * The graph carries no parent-run ANCHOR — an anchor would make the graph wait
 * on the initiating run, which is backwards here: the parent waits on its child
 * graph, not the reverse. It does carry a mandatory OWNER, so the initiating
 * thread and seat stay accountable and the graph pauses if they disappear.
 */
export function startPreparedUltraTaskGraph(
  input: StartUltraTaskGraphInput,
  deps: UltraTaskGraphStartServiceDeps
): StartedUltraTaskWorkflow {
  const count = scoutCount(input.scoutCount)
  const parent = stageEnvelope(
    input,
    'UltraTask parent permission ceiling.',
    input.workerEffect,
    deps
  )
  const permissionCeilingRef: ExecutionPermissionCeilingRef = {
    schemaVersion: 1,
    referenceId: `ultratask-ceiling-${parent.digest}`,
    authorityDigest: parent.digest,
    workspaceId: input.workspaceId
  }
  const seat = {
    provider: input.provider,
    model: input.model,
    ...(input.reasoningEffort ? { reasoningEffort: input.reasoningEffort } : {})
  }
  const prepareStage = (stage: PrepareUltraTaskStageInput): PreparedUltraTaskStage => {
    if (
      stage.permissionCeilingRef.referenceId !== permissionCeilingRef.referenceId ||
      stage.permissionCeilingRef.authorityDigest !== permissionCeilingRef.authorityDigest
    ) {
      throw new Error('UltraTask stage preparation received a different parent ceiling.')
    }
    const prepared = stageEnvelope(input, stage.prompt, stage.effect, deps)
    const record = deps.saveRunTemplate(prepared.content)
    if (!record.templateId.trim()) throw new Error('UltraTask stage template was not persisted.')
    return {
      runTemplateRef: record.templateId,
      permissionAuthorityDigest: prepared.digest
    }
  }
  return startUltraTaskWorkflow(
    {
      title: input.title,
      task: input.task,
      workspaceId: input.workspaceId,
      rootChatId: input.rootChatId,
      permissionCeilingRef,
      scouts: Array.from({ length: count }, () => ({ ...seat })),
      worker: { ...seat },
      reviewer: { ...seat },
      synthesis: { ...seat },
      workerEffect: input.workerEffect,
      owner: input.owner
    },
    {
      prepareStage,
      saveRevision: deps.saveRevision,
      startExecutionGraph: deps.startExecutionGraph,
      createId: deps.createId,
      now: deps.now
    }
  )
}
