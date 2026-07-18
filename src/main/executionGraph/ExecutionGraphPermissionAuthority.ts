import { resolveEffectiveRunPermissions } from '../EffectiveRunPermissions'
import {
  buildRunPermissionPostureSnapshot,
  type RunPermissionPostureContext
} from '../RunPermissionPosture'
import type {
  AppSettings,
  ChatScope,
  EffectiveRunPermissions,
  PermissionPresetId,
  ProviderId,
  RunPermissionPostureSnapshot,
  RunQueueJob,
  RunQueueRequestSnapshot
} from '../store/types'

export interface BuildExecutionGraphPermissionPostureInput {
  readonly provider: ProviderId
  readonly workspacePath: string
  readonly chatId: string
  readonly request: RunQueueRequestSnapshot
  readonly runtimeProfileId?: string
  readonly settings: Pick<AppSettings, 'agenticServices' | 'agenticWorkspaceGrants'>
  readonly sign: (
    approvalMode: string,
    effectivePermissions: EffectiveRunPermissions,
    context: RunPermissionPostureContext
  ) => string
}

export interface VerifyExecutionGraphPermissionPostureInput {
  readonly provider: ProviderId
  readonly workspacePath: string
  readonly chatId: string
  readonly request: RunQueueRequestSnapshot
  readonly runtimeProfileId?: string
  readonly posture: RunPermissionPostureSnapshot
  readonly verify: (
    approvalMode: string,
    effectivePermissions: EffectiveRunPermissions,
    signature: string,
    context: RunPermissionPostureContext
  ) => boolean
}

export interface FrozenExecutionGraphPermissionPosture {
  readonly approvalMode: string
  readonly workflowMode: 'normal' | 'plan'
  readonly effectivePermissions: EffectiveRunPermissions
}

export interface ExecutionGraphComposerIdentity {
  readonly provider: ProviderId
  readonly scope: ChatScope
  readonly chatId: string
  readonly workspacePath?: string
  readonly runtimeProfileId?: string
}

export interface ResolveExecutionGraphQueuePermissionPostureInput {
  readonly job: RunQueueJob | null | undefined
  readonly expected: ExecutionGraphComposerIdentity
  readonly verify: VerifyExecutionGraphPermissionPostureInput['verify']
}

const PERMISSION_PRESETS = new Set<PermissionPresetId>([
  'read_only',
  'plan',
  'default',
  'workspace_write',
  'full_access',
  'custom'
])

function workflowMode(request: RunQueueRequestSnapshot): 'normal' | 'plan' {
  return request.workflowMode === 'plan' ? 'plan' : 'normal'
}

function boundedPreset(request: RunQueueRequestSnapshot): PermissionPresetId {
  if (request.workflowMode === 'plan') return 'plan'
  if (request.approvalMode === 'plan') {
    return request.permissionPresetId === 'plan' ? 'plan' : 'read_only'
  }
  const requested = request.permissionPresetId
  if (!requested || !PERMISSION_PRESETS.has(requested)) return 'default'
  // Trusted Session is deliberately non-durable. A Stack may preserve write
  // authority, but it cannot preserve host-wide Full Access after this turn.
  return requested === 'full_access' ? 'workspace_write' : requested
}

function postureContext(input: {
  provider: ProviderId
  chatId: string
  request: RunQueueRequestSnapshot
  runtimeProfileId?: string
}): RunPermissionPostureContext {
  return {
    provider: input.provider,
    scope: 'workspace',
    appChatId: input.chatId,
    prompt: input.request.prompt,
    workflowMode: workflowMode(input.request),
    ...(input.runtimeProfileId ? { runtimeProfileId: input.runtimeProfileId } : {})
  }
}

export function buildExecutionGraphPermissionPosture(
  input: BuildExecutionGraphPermissionPostureInput
): RunPermissionPostureSnapshot {
  if (!input.request.prompt.trim()) throw new Error('Execution graph prompt is required.')
  const effectivePermissions = resolveEffectiveRunPermissions({
    provider: input.provider,
    workspacePath: input.workspacePath,
    model: input.request.customModel.trim() || input.request.selectedModelType,
    settings: input.settings,
    presetId: boundedPreset(input.request),
    explicitExternalPathGrants: input.request.externalPathGrants ?? []
  })
  const context = postureContext(input)
  const signature = input.sign(effectivePermissions.approvalMode, effectivePermissions, context)
  if (!signature) throw new Error('Execution graph permission posture could not be signed.')
  return buildRunPermissionPostureSnapshot({
    approvalMode: effectivePermissions.approvalMode,
    workflowMode: workflowMode(input.request),
    effectivePermissions,
    signature,
    context
  })
}

function effectivePermissionsFromSnapshot(
  posture: RunPermissionPostureSnapshot,
  request: RunQueueRequestSnapshot
): EffectiveRunPermissions {
  if (
    !posture.approvalMode ||
    !posture.presetId ||
    typeof posture.readOnly !== 'boolean' ||
    !posture.agenticServices ||
    !posture.networkAccess
  ) {
    throw new Error('Execution graph permission posture is incomplete.')
  }
  return {
    presetId: posture.presetId,
    approvalMode: posture.approvalMode,
    agenticServices: posture.agenticServices,
    networkAccess: posture.networkAccess,
    externalPathGrants: [...(request.externalPathGrants ?? [])],
    workspaceGrantServiceIds: [...(posture.workspaceGrantServiceIds ?? [])],
    readOnly: posture.readOnly
  }
}

export function verifyExecutionGraphPermissionPosture(
  input: VerifyExecutionGraphPermissionPostureInput
): FrozenExecutionGraphPermissionPosture {
  const signature = input.posture.signature
  if (!input.posture.signaturePresent || !signature) {
    throw new Error('Execution graph permission posture is unsigned.')
  }
  const effectivePermissions = effectivePermissionsFromSnapshot(input.posture, input.request)
  const context = postureContext(input)
  if (!input.verify(input.posture.approvalMode!, effectivePermissions, signature, context)) {
    throw new Error('Execution graph permission posture is invalid or stale.')
  }
  return {
    approvalMode: input.posture.approvalMode!,
    workflowMode: workflowMode(input.request),
    effectivePermissions
  }
}

/**
 * Resolve the frozen posture for a graph-owned queue job at the composer
 * boundary. The renderer supplies the composer identity, but the request and
 * permission snapshot are read only from the main-owned queue row. Ordinary
 * jobs deliberately fall through so their existing composer policy applies.
 */
export function resolveExecutionGraphQueuePermissionPosture(
  input: ResolveExecutionGraphQueuePermissionPostureInput
): FrozenExecutionGraphPermissionPosture | null {
  const job = input.job
  if (!job?.executionGraph) return null

  const { expected } = input
  if (expected.scope !== 'workspace' || job.scope !== expected.scope) {
    throw new Error('Execution graph queue job scope does not match the composer.')
  }
  if (!expected.workspacePath || job.workspacePath !== expected.workspacePath) {
    throw new Error('Execution graph queue job workspace does not match the composer.')
  }
  if (job.provider !== expected.provider) {
    throw new Error('Execution graph queue job provider does not match the composer.')
  }
  if (job.chatId !== expected.chatId) {
    throw new Error('Execution graph queue job chat does not match the composer.')
  }

  const request = job.request
  if (!request) throw new Error('Execution graph queue job request is unavailable.')
  const posture = job.permissionPosture
  if (!posture) throw new Error('Execution graph queue job permission posture is unavailable.')

  if (request.scope !== expected.scope) {
    throw new Error('Execution graph queue request scope does not match the composer.')
  }
  if (
    job.runtimeProfileId !== expected.runtimeProfileId ||
    request.runtimeProfileId !== expected.runtimeProfileId
  ) {
    throw new Error('Execution graph queue job runtime profile does not match the composer.')
  }

  const expectedWorkflowMode = workflowMode(request)
  const context = posture.context
  if (
    !context ||
    context.provider !== expected.provider ||
    context.scope !== expected.scope ||
    context.appChatId !== expected.chatId ||
    context.workflowMode !== expectedWorkflowMode ||
    context.runtimeProfileId !== expected.runtimeProfileId ||
    !context.promptHash
  ) {
    throw new Error('Execution graph queue permission authority does not match the composer.')
  }

  return verifyExecutionGraphPermissionPosture({
    provider: expected.provider,
    workspacePath: expected.workspacePath,
    chatId: expected.chatId,
    request,
    ...(expected.runtimeProfileId ? { runtimeProfileId: expected.runtimeProfileId } : {}),
    posture,
    verify: input.verify
  })
}
