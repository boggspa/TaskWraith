import { isTaskWraithMcpToolName } from './mcp/McpResultHelpers'
import type {
  AgenticServiceId,
  AgenticServicePolicy,
  AppSettings,
  EffectiveRunPermissions
} from './store/types'

export type NativePermissionResolution = {
  policy: AgenticServicePolicy
  workspaceGrantAllowed: boolean
  sessionGrantAllowed: boolean
  decision: 'allow' | 'ask' | 'deny'
}

export type NativeApprovalPreflight =
  | { kind: 'none' }
  | {
      kind: 'deny'
      policy: AgenticServicePolicy
      effectivePermissions?: EffectiveRunPermissions
    }
  | {
      kind: 'allow'
      policy: AgenticServicePolicy
      reason: 'workspace_grant' | 'session_grant' | 'policy' | 'session_yolo'
      scope: 'workspace' | 'session' | 'request'
      effectivePermissions?: EffectiveRunPermissions
    }
  | {
      kind: 'ask'
      policy: AgenticServicePolicy
      effectivePermissions?: EffectiveRunPermissions
    }

export function effectiveAgenticSettings(
  settings: AppSettings,
  effectivePermissions: EffectiveRunPermissions | undefined
): AppSettings {
  if (!effectivePermissions) return settings
  const current = settings.agenticServices
  const effective = effectivePermissions.agenticServices
  return {
    ...settings,
    agenticServices: {
      ...current,
      shellCommands: preserveCurrentDeny(current.shellCommands, effective.shellCommands),
      fileChanges: preserveCurrentDeny(current.fileChanges, effective.fileChanges),
      mcpTools: preserveCurrentDeny(current.mcpTools, effective.mcpTools),
      subThreadDelegation: preserveCurrentDeny(
        current.subThreadDelegation,
        effective.subThreadDelegation
      ),
      networkAccess: current.networkAccess === 'deny' ? 'deny' : effectivePermissions.networkAccess
    }
  }
}

function preserveCurrentDeny(
  current: AgenticServicePolicy | undefined,
  requested: AgenticServicePolicy
): AgenticServicePolicy {
  return current === 'deny' ? 'deny' : requested
}

export function automaticApprovalReason(args: {
  workspaceGrantAllowed: boolean
  sessionGrantAllowed: boolean
}): {
  reason: 'workspace_grant' | 'session_grant' | 'policy'
  scope: 'workspace' | 'session' | 'request'
} {
  if (args.workspaceGrantAllowed) return { reason: 'workspace_grant', scope: 'workspace' }
  if (args.sessionGrantAllowed) return { reason: 'session_grant', scope: 'session' }
  return { reason: 'policy', scope: 'request' }
}

export function resolveNativeApprovalPreflightDecision(args: {
  resolution: NativePermissionResolution
  externalPathDetected?: boolean
  sessionYoloEnabled?: boolean
  readOnly?: boolean
  effectivePermissions?: EffectiveRunPermissions
}): Exclude<NativeApprovalPreflight, { kind: 'none' }> {
  const { policy, workspaceGrantAllowed, sessionGrantAllowed, decision } = args.resolution
  if (decision === 'deny') return { kind: 'deny', policy, effectivePermissions: args.effectivePermissions }
  if (args.externalPathDetected) return { kind: 'ask', policy, effectivePermissions: args.effectivePermissions }
  if (args.sessionYoloEnabled && !args.readOnly) {
    return {
      kind: 'allow',
      policy,
      reason: 'session_yolo',
      scope: 'session',
      effectivePermissions: args.effectivePermissions
    }
  }
  if (decision === 'allow') {
    const automatic = automaticApprovalReason({ workspaceGrantAllowed, sessionGrantAllowed })
    return {
      kind: 'allow',
      policy,
      reason: automatic.reason,
      scope: automatic.scope,
      effectivePermissions: args.effectivePermissions
    }
  }
  return { kind: 'ask', policy, effectivePermissions: args.effectivePermissions }
}

export function canonicalTaskWraithToolName(toolName: string): string {
  const lower = (toolName || '').trim().toLowerCase()
  if (lower.startsWith('mcp__')) {
    const idx = lower.indexOf('__', 5)
    return idx > 5 ? lower.slice(idx + 2) : lower.slice('mcp__'.length)
  }
  if (lower.startsWith('taskwraith__')) return lower.slice('taskwraith__'.length)
  return lower
}

export function taskWraithToolAgenticService(toolName: string): AgenticServiceId {
  if (toolName === 'run_shell_command' || toolName === 'run_task') return 'shellCommands'
  if (
    toolName === 'write_file' ||
    toolName === 'replace' ||
    toolName === 'apply_patch' ||
    toolName === 'git_stage' ||
    toolName === 'git_commit'
  )
    return 'fileChanges'
  if (toolName === 'delegate_to_subthread' || toolName === 'cancel_subthread')
    return 'subThreadDelegation'
  return 'mcpTools'
}

export function taskWraithToolServiceIfKnown(toolName: string): AgenticServiceId | null {
  const canonicalToolName = canonicalTaskWraithToolName(toolName)
  if (!isTaskWraithMcpToolName(canonicalToolName)) return null
  return taskWraithToolAgenticService(canonicalToolName)
}
