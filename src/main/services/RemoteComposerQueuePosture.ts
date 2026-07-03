import { resolveEffectiveRunPermissions } from '../EffectiveRunPermissions'
import {
  buildRunPermissionPostureSnapshot,
  type RunPermissionPostureContext
} from '../RunPermissionPosture'
import type {
  AppSettings,
  ChatScope,
  ChatWorkflowMode,
  EffectiveRunPermissions,
  PermissionPresetId,
  ProviderId,
  RunPermissionPostureSnapshot
} from '../store/types'

export interface RemoteComposerQueuePostureInput {
  provider: ProviderId
  scope: ChatScope
  workspacePath?: string
  chatId: string
  runId: string
  text: string
  approvalMode?: string | null
  workflowMode?: ChatWorkflowMode | null
  settings: Pick<AppSettings, 'agenticServices' | 'agenticWorkspaceGrants'>
  signRunPermissionPosture: (
    approvalMode: string | null | undefined,
    effectivePermissions: EffectiveRunPermissions | null | undefined,
    context?: RunPermissionPostureContext | null
  ) => string
}

export function buildRemoteComposerQueuePermissionPosture(
  input: RemoteComposerQueuePostureInput
): RunPermissionPostureSnapshot {
  const workflowMode = input.scope !== 'global' && input.workflowMode === 'plan' ? 'plan' : 'normal'
  const approvalMode =
    input.scope === 'global'
      ? 'plan'
      : workflowMode === 'plan'
        ? 'plan'
        : normalizeApprovalMode(input.approvalMode)
  const permissionPresetId = remoteComposerQueuePermissionPresetId(approvalMode, workflowMode)
  const effectivePermissions = permissionPresetId
    ? resolveEffectiveRunPermissions({
        provider: input.provider,
        workspacePath: input.scope === 'global' ? undefined : input.workspacePath,
        settings: input.settings,
        presetId: permissionPresetId
      })
    : undefined
  const context: RunPermissionPostureContext = {
    provider: input.provider,
    scope: input.scope,
    appRunId: input.runId,
    appChatId: input.chatId,
    prompt: input.text,
    workflowMode
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

function remoteComposerQueuePermissionPresetId(
  approvalMode: string,
  workflowMode: ChatWorkflowMode
): PermissionPresetId | undefined {
  if (workflowMode === 'plan') return 'plan'
  if (approvalMode === 'plan') return 'read_only'
  return undefined
}

function normalizeApprovalMode(value: string | null | undefined): string {
  return typeof value === 'string' && value.trim() ? value : 'default'
}
