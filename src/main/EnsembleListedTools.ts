import type {
  EffectiveRunPermissions,
  PermissionPresetId,
  ProviderId,
  TaskWraithMcpProfileId
} from './store/types'
import { listCursorPathBReceiptTools } from './cursor/CursorPathBBrokerReceipt'
import { resolveCursorPathBBrokerPolicy } from './cursor/CursorPathBLaunchPlan'
import { cursorWriteCapable } from './cursor/CursorCliArgs'
import { taskWraithMcpAdvertisedToolNamesForProfile } from './mcp/McpToolProfiles'
import { ULTRATASK_DELEGATION_AUTO_ALLOW_SOURCE } from './UltraTaskDelegationConsent'

const ULTRATASK_PRIORITY_TOOL_NAMES = [
  'ensemble_fanout',
  'delegate_wave',
  'delegate_to_subthread'
] as const

export function resolveEnsembleListedTools(input: {
  readonly listedTools?: readonly string[]
  readonly provider: ProviderId
  readonly profileId?: TaskWraithMcpProfileId | null
  readonly permissionPresetId?: PermissionPresetId | null
  readonly reasoningEffort?: string | null
}): readonly string[] | undefined {
  if (input.listedTools) return input.listedTools
  if (!input.profileId) return undefined
  if (input.provider === 'cursor') {
    const writeCapable = cursorWriteCapable(cursorApprovalModeForPreset(input.permissionPresetId))
    const policy = resolveCursorPathBBrokerPolicy({
      writeCapable,
      planSeat: input.permissionPresetId === 'plan',
      taskWraithMcpProfileId: input.profileId,
      effectivePermissions: cursorUltraTaskPermissions(input.reasoningEffort)
    })
    return listCursorPathBReceiptTools({
      allowRules: policy.allowRules,
      taskWraithMcpProfileId: input.profileId
    })
  }
  const advertised = new Set(taskWraithMcpAdvertisedToolNamesForProfile(input.profileId))
  return ULTRATASK_PRIORITY_TOOL_NAMES.filter((name) => advertised.has(name))
}

function cursorApprovalModeForPreset(preset: PermissionPresetId | null | undefined): string | null {
  if (!preset) return null
  if (preset === 'plan' || preset === 'read_only') return 'plan'
  if (preset === 'workspace_write' || preset === 'full_access') return 'auto_edit'
  return 'default'
}

function cursorUltraTaskPermissions(
  reasoningEffort: string | null | undefined
): EffectiveRunPermissions | null {
  if (reasoningEffort?.trim().toLowerCase() !== 'ultratask') return null
  return {
    subThreadDelegationAutoAllowSource: ULTRATASK_DELEGATION_AUTO_ALLOW_SOURCE
  } as EffectiveRunPermissions
}
