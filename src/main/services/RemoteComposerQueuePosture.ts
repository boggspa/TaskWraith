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
  permissionPresetId?: string | null
  trustedSessionGranted?: boolean
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
  const permissionPresetId = remoteComposerQueuePermissionPresetId(
    approvalMode,
    workflowMode,
    input.permissionPresetId,
    input.trustedSessionGranted === true
  )
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
  workflowMode: ChatWorkflowMode,
  permissionPresetId?: string | null,
  trustedSessionGranted = false
): PermissionPresetId | undefined {
  if (workflowMode === 'plan') return 'plan'
  if (approvalMode === 'plan') return 'read_only'
  // Trusted Session is a live, main-owned host-trust receipt. A queued remote
  // prompt may carry the old `full_access` value, but it cannot freeze host
  // access unless the desktop has an active scoped receipt at queue time.
  if (permissionPresetId === 'full_access') {
    return trustedSessionGranted ? 'full_access' : 'workspace_write'
  }
  return undefined
}

function normalizeApprovalMode(value: string | null | undefined): string {
  return typeof value === 'string' && value.trim() ? value : 'default'
}
