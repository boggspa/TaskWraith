import { resolveEffectiveRunPermissions } from '../EffectiveRunPermissions'
import {
  buildRunPermissionPostureSnapshot,
  type RunPermissionPostureContext
} from '../RunPermissionPosture'
import type {
  AppSettings,
  EffectiveRunPermissions,
  PermissionPresetId,
  ProviderId,
  RunPermissionPostureSnapshot,
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
