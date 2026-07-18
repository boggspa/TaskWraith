import { createHash } from 'node:crypto'
import { ipcMain, type IpcMainInvokeEvent } from 'electron'
import {
  compileExecutionGraphRevision,
  stableExecutionGraphStringify
} from '../executionGraph/ExecutionGraphCompiler'
import type {
  ExecutionEffect,
  ExecutionGraphLayout,
  ExecutionGraphRevision,
  ExecutionPermissionCeilingRef,
  JsonObject
} from '../executionGraph/ExecutionGraphModel'
import type {
  ExecutionGraphRepository,
  ExecutionGraphRunTemplate
} from '../executionGraph/ExecutionGraphRepository'
import type { ExecutionRunEvent, ExecutionRunProjection } from '../executionGraph/ExecutionGraphRun'
import { executionGraphRunTemplatePermissionCeilingDigest } from '../executionGraph/ExecutionGraphRunTemplateAuthority'
import type {
  AppendExecutionStackStepInput,
  ExecutionGraphCoordinator
} from '../services/ExecutionGraphCoordinator'
import type {
  ProviderId,
  RunPermissionPostureSnapshot,
  RunQueueJob,
  RunQueueRequestSnapshot
} from '../store/types'

export interface ExecutionRunListFilter {
  readonly workspaceId?: string
  readonly rootChatId?: string
  readonly includeTerminal?: boolean
}

export interface ExecutionStackAppendCommand {
  readonly clientRequestId: string
  readonly executionId?: string
  readonly workspaceId: string
  readonly rootChatId: string
  readonly anchorRunRef?: string
  readonly title?: string
  readonly stepTitle: string
  readonly objective: string
  readonly provider: ProviderId
  readonly request: RunQueueRequestSnapshot
}

export interface ExecutionRunCancelStepCommand {
  readonly executionId: string
  readonly activationId: string
}

export interface ExecutionRunFormalizeCommand {
  readonly executionId: string
  readonly name?: string
}

export interface ExecutionStackTarget {
  readonly workspaceId: string
  readonly workspacePath: string
  readonly rootChatId: string
  readonly anchorRunRef?: string
}

export interface ExecutionGraphHandlersDeps {
  assertMainRendererSender: (event: IpcMainInvokeEvent) => void
  assertLocalChatHistoryDurable: () => void
  resolveStackTarget: (input: {
    workspaceId: string
    rootChatId: string
    anchorRunRef?: string
  }) => ExecutionStackTarget
  resolveAuthorizedAttachmentPaths: (event: IpcMainInvokeEvent) => string[]
  prepareQueueJob: (
    input: unknown,
    options: { authorizedFilePaths?: string[] }
  ) => Partial<RunQueueJob> & Pick<RunQueueJob, 'runId' | 'provider' | 'source'>
  resolvePermissionPosture: (input: {
    provider: ProviderId
    workspaceId: string
    workspacePath: string
    rootChatId: string
    request: RunQueueRequestSnapshot
    runtimeProfileId?: string
  }) => RunPermissionPostureSnapshot
  repository: Pick<
    ExecutionGraphRepository,
    | 'saveRunTemplate'
    | 'listRevisions'
    | 'getRevision'
    | 'saveRevision'
    | 'saveLayout'
    | 'getLayout'
    | 'readExecutionEvents'
  >
  coordinator: Pick<
    ExecutionGraphCoordinator,
    | 'listExecutions'
    | 'getExecution'
    | 'resolveStackAppendReceipt'
    | 'appendStackStep'
    | 'cancelExecution'
    | 'cancelDormantStep'
  >
  now?: () => string
}

interface PreparedStackTemplate {
  readonly record: ExecutionGraphRunTemplate
  readonly provider: ProviderId
  readonly effect: ExecutionEffect
  readonly model?: string
  readonly ceiling: ExecutionPermissionCeilingRef
}

const PROVIDERS = new Set<ProviderId>(['codex', 'claude', 'kimi', 'grok', 'cursor', 'ollama'])
const EXECUTION_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function nonEmpty(value: unknown, label: string, max = 512): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${label} is required.`)
  const normalized = value.trim()
  if (normalized.length > max) throw new Error(`${label} is too long.`)
  return normalized
}

function optionalString(value: unknown, max = 512): string | undefined {
  if (typeof value !== 'string' || !value.trim()) return undefined
  const normalized = value.trim()
  if (normalized.length > max) throw new Error('Optional execution value is too long.')
  return normalized
}

function executionId(value: unknown): string {
  const id = nonEmpty(value, 'Execution id', 128)
  if (!EXECUTION_ID.test(id)) throw new Error('Execution id is not canonical.')
  return id
}

function clientRequestId(value: unknown): string {
  const id = nonEmpty(value, 'Stack append client request id', 128)
  if (!EXECUTION_ID.test(id)) throw new Error('Stack append client request id is not canonical.')
  return id
}

function providerId(value: unknown): ProviderId {
  if (typeof value !== 'string' || !PROVIDERS.has(value as ProviderId)) {
    throw new Error('Execution provider is invalid or retired.')
  }
  return value as ProviderId
}

function stackAppendSubmissionDigest(input: {
  workspaceId: string
  rootChatId: string
  stepTitle: string
  objective: string
  provider: ProviderId
  request: JsonObject
}): string {
  return createHash('sha256')
    .update(
      stableExecutionGraphStringify({
        schemaVersion: 1,
        workspaceId: input.workspaceId,
        rootChatId: input.rootChatId,
        step: {
          title: input.stepTitle,
          objective: input.objective,
          provider: input.provider,
          request: input.request
        }
      })
    )
    .digest('hex')
}

function jsonObject(value: unknown): JsonObject {
  const cloned = JSON.parse(JSON.stringify(value)) as unknown
  if (!isRecord(cloned)) throw new Error('Prepared run template is not a JSON object.')
  return cloned as JsonObject
}

function effectForPreparedTemplate(content: JsonObject): ExecutionEffect {
  const request = isRecord(content.request) ? content.request : {}
  const preset = request.permissionPresetId
  if (preset === 'read_only' || preset === 'plan') return 'read_only'
  if (preset === 'full_access' || preset === 'custom') return 'external_side_effect'
  if (Array.isArray(request.externalPathGrants) && request.externalPathGrants.length > 0) {
    return 'external_side_effect'
  }
  return 'workspace_write'
}

function runTemplateContent(
  prepared: Partial<RunQueueJob>,
  permissionPosture: RunPermissionPostureSnapshot
): JsonObject {
  const request = prepared.request
    ? {
        ...prepared.request,
        // A durable graph step may execute after the originating renderer turn
        // and must never inherit the composer's ephemeral Trusted Session.
        sessionTrust: false
      }
    : undefined
  return jsonObject({
    schemaVersion: 1,
    provider: prepared.provider,
    scope: prepared.scope,
    workspaceId: prepared.workspaceId,
    workspacePath: prepared.workspacePath,
    chatId: prepared.chatId,
    request,
    permissionPosture,
    runtimeProfileId: prepared.runtimeProfileId,
    handoffSourceRunId: prepared.handoffSourceRunId
  })
}

function assertBoundStackRuntimeAdmission(
  prepared: Partial<RunQueueJob> & Pick<RunQueueJob, 'runId' | 'provider' | 'source'>
): asserts prepared is typeof prepared & { request: RunQueueRequestSnapshot } {
  const request = prepared.request
  if (!request) throw new Error('Prepared Stack request snapshot is unavailable.')
  if (prepared.scope !== 'workspace' || (request.scope && request.scope !== 'workspace')) {
    throw new Error('Stack steps require a workspace-scoped request.')
  }
  if (
    request.scheduledTaskId ||
    request.scheduledRunAt ||
    request.remoteComposer ||
    request.guestParentChatId ||
    request.guestRole ||
    request.dmTargetParticipantId
  ) {
    throw new Error('Stack steps cannot reuse scheduled, remote, guest, or Ensemble provenance.')
  }
  if (request.discordContextSelection) {
    throw new Error('Stack steps cannot reuse Discord context.')
  }
  if (request.projectReferenceContextSelection) {
    throw new Error('V1 Stack steps cannot resolve mutable project-reference context at dispatch.')
  }
  if (request.codexNativeReview) {
    throw new Error('Stack steps cannot run a Codex native review.')
  }
  if (request.handoffSourceRunId || prepared.handoffSourceRunId) {
    throw new Error('Stack steps cannot reuse a handoff source run.')
  }
  if (request.preserveComposer) {
    throw new Error('Stack steps cannot preserve an originating composer submission.')
  }
  if (request.geminiWorktree || request.effectiveWorkspacePath) {
    throw new Error('Stack steps cannot use worktree-bound execution context.')
  }
  if (request.externalPathGrants?.some((grant) => grant.duration === 'thisRun')) {
    throw new Error('Stack steps cannot reuse run-scoped external path grants.')
  }
}

function prepareStackTemplate(
  deps: ExecutionGraphHandlersDeps,
  event: IpcMainInvokeEvent,
  input: Record<string, unknown>,
  target: ExecutionStackTarget,
  provider: ProviderId,
  clientRequestId: string,
  objective: string
): PreparedStackTemplate {
  if (!isRecord(input.request)) throw new Error('Stack step request snapshot is required.')
  const runtimeProfileId = optionalString(input.request.runtimeProfileId)
  if (runtimeProfileId) {
    throw new Error('V1 Stack steps do not support mutable runtime profiles.')
  }
  // Attachment staging and external-grant normalization can bind to runId.
  // Deriving the probe from the durable mutation nonce makes an exact retry
  // reproduce the same sanitized template instead of minting false variance.
  const probeRunId = `graph-template-probe-${createHash('sha256')
    .update(clientRequestId)
    .digest('hex')
    .slice(0, 32)}`
  const prepared = deps.prepareQueueJob(
    {
      id: probeRunId,
      runId: probeRunId,
      provider,
      scope: 'workspace',
      workspaceId: target.workspaceId,
      workspacePath: target.workspacePath,
      chatId: target.rootChatId,
      source: 'system',
      status: 'paused',
      ...(runtimeProfileId ? { runtimeProfileId } : {}),
      request: input.request
    },
    { authorizedFilePaths: deps.resolveAuthorizedAttachmentPaths(event) }
  )
  if (
    prepared.provider !== provider ||
    prepared.workspaceId !== target.workspaceId ||
    prepared.workspacePath !== target.workspacePath ||
    prepared.chatId !== target.rootChatId ||
    !prepared.request
  ) {
    throw new Error('Prepared Stack request did not preserve its authoritative target.')
  }
  if (prepared.status !== 'paused' || prepared.lastError) {
    throw new Error(
      prepared.lastError || 'Stack request could not be durably prepared in a paused state.'
    )
  }
  if (prepared.runtimeProfileId !== prepared.request.runtimeProfileId) {
    throw new Error('Prepared Stack runtime profile did not preserve its signed request context.')
  }
  const canonicalPrompt = prepared.request.prompt.trim()
  if (!canonicalPrompt) throw new Error('Stack step prompt is required.')
  if (objective !== canonicalPrompt) {
    throw new Error('Stack step objective must match its canonical prepared prompt.')
  }
  assertBoundStackRuntimeAdmission(prepared)
  const frozenRequest: RunQueueRequestSnapshot = {
    ...prepared.request,
    prompt: canonicalPrompt,
    sessionTrust: false
  }
  const permissionPosture = deps.resolvePermissionPosture({
    provider,
    workspaceId: target.workspaceId,
    workspacePath: target.workspacePath,
    rootChatId: target.rootChatId,
    request: frozenRequest,
    ...(prepared.runtimeProfileId ? { runtimeProfileId: prepared.runtimeProfileId } : {})
  })
  if (!permissionPosture.signaturePresent || !permissionPosture.signature) {
    throw new Error('Stack step permission posture is not signed.')
  }
  const content = runTemplateContent({ ...prepared, request: frozenRequest }, permissionPosture)
  const record = deps.repository.saveRunTemplate(content)
  const authorityDigest = executionGraphRunTemplatePermissionCeilingDigest(content)
  const ceiling: ExecutionPermissionCeilingRef = {
    schemaVersion: 1,
    referenceId: `execution-ceiling-${authorityDigest}`,
    authorityDigest,
    workspaceId: target.workspaceId
  }
  const request = prepared.request
  const model = request.customModel?.trim() || request.selectedModelType?.trim() || undefined
  return {
    record,
    provider,
    effect: effectForPreparedTemplate(content),
    ...(model ? { model } : {}),
    ceiling
  }
}

function requireOwnedExecution(
  deps: ExecutionGraphHandlersDeps,
  id: string
): ExecutionRunProjection {
  const projection = deps.coordinator.getExecution(id)
  if (!projection) throw new Error('Execution is unavailable.')
  return projection
}

function formalizeExecution(
  deps: ExecutionGraphHandlersDeps,
  input: Record<string, unknown>
): ExecutionGraphRevision {
  const projection = requireOwnedExecution(deps, executionId(input.executionId))
  if (projection.integrity !== 'valid' || projection.baseRevisionMissing) {
    throw new Error('Only a verified effective topology can be saved.')
  }
  if (!projection.workspaceId || projection.topology.steps.length === 0) {
    throw new Error('Execution has no saveable topology.')
  }
  const readableGraphId = `stack-${projection.executionId}`
  const graphId = EXECUTION_ID.test(readableGraphId)
    ? readableGraphId
    : `stack-${createHash('sha256').update(projection.executionId).digest('hex')}`
  const nextRevision =
    Math.max(0, ...deps.repository.listRevisions(graphId).map((revision) => revision.revision)) + 1
  const compiled = compileExecutionGraphRevision({
    graphId,
    revision: nextRevision,
    workspaceId: projection.workspaceId,
    name: optionalString(input.name, 160) || projection.title || 'Saved Stack workflow',
    createdAt: (deps.now ?? (() => new Date().toISOString()))(),
    steps: projection.topology.steps,
    edges: projection.topology.edges
  })
  if (!compiled.ok) {
    throw new Error(
      `Effective topology could not be saved: ${compiled.issues.map((issue) => issue.code).join(', ')}.`
    )
  }
  return deps.repository.saveRevision(compiled.revision)
}

/** Register the main-window command/query surface for execution graphs. */
export function registerExecutionGraphHandlers(deps: ExecutionGraphHandlersDeps): void {
  ipcMain.handle('execution-graphs:list', (event, workspaceId?: string) => {
    deps.assertMainRendererSender(event)
    const workspace = optionalString(workspaceId, 128)
    return deps.repository
      .listRevisions()
      .filter((revision) => !workspace || revision.workspaceId === workspace)
  })

  ipcMain.handle(
    'execution-graphs:get',
    (event, input: { graphId?: unknown; revision?: unknown }) => {
      deps.assertMainRendererSender(event)
      if (!isRecord(input)) throw new Error('Graph lookup is invalid.')
      const graphId = nonEmpty(input.graphId, 'Graph id', 128)
      if (!Number.isInteger(input.revision) || Number(input.revision) < 1) {
        throw new Error('Graph revision is invalid.')
      }
      return deps.repository.getRevision(graphId, Number(input.revision)) ?? null
    }
  )

  ipcMain.handle(
    'execution-graphs:get-layout',
    (event, input: { graphId?: unknown; revision?: unknown }) => {
      deps.assertMainRendererSender(event)
      if (!isRecord(input)) throw new Error('Graph layout lookup is invalid.')
      const graphId = nonEmpty(input.graphId, 'Graph id', 128)
      if (!Number.isInteger(input.revision) || Number(input.revision) < 1) {
        throw new Error('Graph revision is invalid.')
      }
      return deps.repository.getLayout(graphId, Number(input.revision)) ?? null
    }
  )

  ipcMain.handle('execution-runs:list', (event, filter?: unknown) => {
    deps.assertMainRendererSender(event)
    if (filter !== undefined && filter !== null && !isRecord(filter)) {
      throw new Error('Execution run filter is invalid.')
    }
    const record = isRecord(filter) ? filter : {}
    return deps.coordinator.listExecutions({
      workspaceId: optionalString(record.workspaceId, 128),
      rootChatId: optionalString(record.rootChatId, 128),
      includeTerminal: record.includeTerminal !== false
    })
  })

  ipcMain.handle('execution-runs:get', (event, id: unknown) => {
    deps.assertMainRendererSender(event)
    return deps.coordinator.getExecution(executionId(id)) ?? null
  })

  ipcMain.handle('execution-runs:events', (event, id: unknown): readonly ExecutionRunEvent[] => {
    deps.assertMainRendererSender(event)
    const canonicalId = executionId(id)
    requireOwnedExecution(deps, canonicalId)
    return deps.repository.readExecutionEvents(canonicalId)
  })

  ipcMain.handle('execution-runs:append-stack-step', (event, raw: unknown) => {
    deps.assertMainRendererSender(event)
    if (!isRecord(raw)) throw new Error('Stack append command is invalid.')
    const canonicalClientRequestId = clientRequestId(raw.clientRequestId)
    const requestedExecutionId = optionalString(raw.executionId, 128)
    const canonicalExecutionId = requestedExecutionId
      ? executionId(requestedExecutionId)
      : undefined
    const workspaceId = nonEmpty(raw.workspaceId, 'Workspace id', 128)
    const rootChatId = nonEmpty(raw.rootChatId, 'Root chat id', 128)
    const requestedAnchor = optionalString(raw.anchorRunRef, 128)
    const title = optionalString(raw.title, 160)
    const stepTitle = nonEmpty(raw.stepTitle, 'Step title', 160)
    const objective = nonEmpty(raw.objective, 'Step objective', 32_000)
    const provider = providerId(raw.provider)
    if (!isRecord(raw.request)) throw new Error('Stack step request snapshot is required.')
    const clientSubmissionDigest = stackAppendSubmissionDigest({
      workspaceId,
      rootChatId,
      stepTitle,
      objective,
      provider,
      request: jsonObject(raw.request)
    })
    const committed = deps.coordinator.resolveStackAppendReceipt({
      clientRequestId: canonicalClientRequestId,
      clientSubmissionDigest,
      workspaceId,
      rootChatId
    })
    if (committed) return committed
    deps.assertLocalChatHistoryDurable()
    const target = deps.resolveStackTarget({
      workspaceId,
      rootChatId,
      ...(requestedAnchor ? { anchorRunRef: requestedAnchor } : {})
    })
    const template = prepareStackTemplate(
      deps,
      event,
      raw,
      target,
      provider,
      canonicalClientRequestId,
      objective
    )
    const command: AppendExecutionStackStepInput = {
      clientRequestId: canonicalClientRequestId,
      clientSubmissionDigest,
      ...(canonicalExecutionId ? { executionId: canonicalExecutionId } : {}),
      workspaceId: target.workspaceId,
      rootChatId: target.rootChatId,
      ...(target.anchorRunRef ? { anchorRunRef: target.anchorRunRef } : {}),
      ...(title ? { title } : {}),
      stepTitle,
      objective,
      provider,
      ...(template.model ? { model: template.model } : {}),
      effect: template.effect,
      runTemplateRef: template.record.templateId,
      permissionCeilingRef: template.ceiling
    }
    return deps.coordinator.appendStackStep(command)
  })

  ipcMain.handle('execution-runs:cancel', async (event, id: unknown, reason?: unknown) => {
    deps.assertMainRendererSender(event)
    const canonicalId = executionId(id)
    requireOwnedExecution(deps, canonicalId)
    await deps.coordinator.cancelExecution(
      canonicalId,
      optionalString(reason, 512) || 'Cancelled by user.'
    )
    return deps.coordinator.getExecution(canonicalId) ?? null
  })

  ipcMain.handle('execution-runs:cancel-step', async (event, raw: unknown) => {
    deps.assertMainRendererSender(event)
    if (!isRecord(raw)) throw new Error('Step cancellation command is invalid.')
    const canonicalId = executionId(raw.executionId)
    requireOwnedExecution(deps, canonicalId)
    return await deps.coordinator.cancelDormantStep(
      canonicalId,
      nonEmpty(raw.activationId, 'Activation id', 128)
    )
  })

  ipcMain.handle('execution-runs:formalize', (event, raw: unknown) => {
    deps.assertMainRendererSender(event)
    if (!isRecord(raw)) throw new Error('Formalize command is invalid.')
    return formalizeExecution(deps, raw)
  })

  ipcMain.handle('execution-graphs:save-layout', (event, raw: unknown) => {
    deps.assertMainRendererSender(event)
    if (!isRecord(raw)) throw new Error('Execution layout is invalid.')
    return deps.repository.saveLayout(raw as unknown as ExecutionGraphLayout)
  })
}
