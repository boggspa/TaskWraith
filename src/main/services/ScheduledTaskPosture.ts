import { resolveEffectiveRunPermissions } from '../EffectiveRunPermissions'
import {
  buildRunPermissionPostureSnapshot,
  type RunPermissionPostureContext
} from '../RunPermissionPosture'
import {
  resolveUnattendedApprovalMode,
  unattendedElevationPresetId,
  type UnattendedElevationAck
} from '../UnattendedPostureGate'
import type {
  AppSettings,
  ChatWorkflowMode,
  EffectiveRunPermissions,
  PermissionPresetId,
  ProviderId,
  RunPermissionPostureSnapshot
} from '../store/types'

export interface ScheduledTaskPermissionPostureInput {
  id: string
  provider: ProviderId
  workspacePath: string
  chatId: string
  prompt: string
  approvalMode?: string | null
  workflowMode?: ChatWorkflowMode | null
  selectedModelType?: string | null
  customModel?: string | null
  runtimeProfileId?: string | null
  settings: Pick<AppSettings, 'agenticServices' | 'agenticWorkspaceGrants'>
  unattendedElevationAck?: UnattendedElevationAck | null
  signRunPermissionPosture: (
    approvalMode: string | null | undefined,
    effectivePermissions: EffectiveRunPermissions | null | undefined,
    context?: RunPermissionPostureContext | null
  ) => string
}

export function buildScheduledTaskPermissionPosture(
  input: ScheduledTaskPermissionPostureInput
): RunPermissionPostureSnapshot {
  const workflowMode = input.workflowMode === 'plan' ? 'plan' : 'normal'
  const requestedApprovalMode = normalizeApprovalMode(input.approvalMode)
  const approvalMode = resolveUnattendedApprovalMode(
    input.unattendedElevationAck ?? undefined,
    requestedApprovalMode
  )
  const elevatedPresetId =
    approvalMode !== 'plan'
      ? unattendedElevationPresetId(input.unattendedElevationAck?.level)
      : undefined
  const presetId = scheduledTaskPermissionPresetId(approvalMode, workflowMode, elevatedPresetId)
  const effectivePermissions = presetId
    ? resolveEffectiveRunPermissions({
        provider: input.provider,
        workspacePath: input.workspacePath,
        model: normalizeModelHint(input.customModel) || normalizeModelHint(input.selectedModelType),
        settings: input.settings,
        presetId,
        ...(elevatedPresetId ? { overrides: { networkAccess: 'deny' } } : {})
      })
    : undefined
  const context: RunPermissionPostureContext = {
    provider: input.provider,
    scope: 'workspace',
    appRunId: input.id,
    appChatId: input.chatId,
    prompt: input.prompt,
    workflowMode,
    runtimeProfileId: normalizeModelHint(input.runtimeProfileId)
  }
  const signature = input.signRunPermissionPosture(approvalMode, effectivePermissions, context)
  return buildRunPermissionPostureSnapshot({
    approvalMode,
    workflowMode,
    effectivePermissions,
    signature,
    context
  })
}

function scheduledTaskPermissionPresetId(
  approvalMode: string,
  workflowMode: ChatWorkflowMode,
  elevatedPresetId: PermissionPresetId | undefined
): PermissionPresetId | undefined {
  if (approvalMode === 'plan') return workflowMode === 'plan' ? 'plan' : 'read_only'
  return elevatedPresetId
}

function normalizeApprovalMode(value: string | null | undefined): string {
  return typeof value === 'string' && value.trim() ? value : 'default'
}

function normalizeModelHint(value: string | null | undefined): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined
}
