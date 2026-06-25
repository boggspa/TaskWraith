import { isTaskWraithMcpToolName } from './mcp/McpResultHelpers'
import { MEDIA_EDITING_TOOLS } from './TaskWraithMcpTools'
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
      // Without this, the read_only preset's canvasInteraction:'deny' is dropped
      // here and canvas_click/fill would only PROMPT (or a grant could auto-allow)
      // under read_only — see the P1 adversarial review.
      canvasInteraction: preserveCurrentDeny(
        current.canvasInteraction,
        effective.canvasInteraction
      ),
      // Cross-thread reads: the read_only preset's crossThreadRead:'deny' must
      // survive this key-by-key rebuild (same deny-survival as canvasInteraction).
      crossThreadRead: preserveCurrentDeny(current.crossThreadRead, effective.crossThreadRead),
      // SECURITY-LOAD-BEARING: media now maps to mediaEditing, NOT mcpTools, so the
      // gate's mcpTools->shellCommands read-only reroute no longer fires for it. The
      // read_only preset's mediaEditing:'deny' MUST survive this rebuild or the
      // write-class media tools would only PROMPT under read-only instead of being
      // DENIED (exactly the canvasInteraction P1 leak class).
      mediaEditing: preserveCurrentDeny(current.mediaEditing, effective.mediaEditing),
      // Media recording (future capture) default-deny must likewise survive.
      mediaRecording: preserveCurrentDeny(current.mediaRecording, effective.mediaRecording),
      // Same as canvasInteraction: the read_only preset's canvasEval:'deny' must
      // survive this key-by-key rebuild, or read-only eval would only prompt.
      canvasEval: preserveCurrentDeny(current.canvasEval, effective.canvasEval),
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
  /**
   * Hard "never automatically allow" flag for signed-elevated services
   * (canvas_eval / RCE). When set, the decision is clamped to `ask` regardless of
   * policy, grant, or session-YOLO — only an explicit `deny` short-circuits above
   * it. The caller (resolveNativeApprovalPreflight) sets this for `canvasEval`.
   */
  neverAutoAllow?: boolean
  effectivePermissions?: EffectiveRunPermissions
}): Exclude<NativeApprovalPreflight, { kind: 'none' }> {
  const { policy, workspaceGrantAllowed, sessionGrantAllowed, decision } = args.resolution
  if (decision === 'deny')
    return { kind: 'deny', policy, effectivePermissions: args.effectivePermissions }
  if (args.neverAutoAllow)
    return { kind: 'ask', policy, effectivePermissions: args.effectivePermissions }
  if (args.externalPathDetected)
    return { kind: 'ask', policy, effectivePermissions: args.effectivePermissions }
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
  // Dedicated grant bucket (Codex path): keep app-mutating canvas interactions
  // out of the generic mcpTools session/workspace grant.
  if (toolName === 'canvas_click' || toolName === 'canvas_fill') return 'canvasInteraction'
  // Arbitrary eval gets its OWN, stricter bucket (non-grantable / never-YOLO).
  if (toolName === 'canvas_eval') return 'canvasEval'
  // Cross-thread retrospection reads route to crossThreadRead (grantable) so a
  // generic mcpTools grant can't auto-allow reading another thread/workspace.
  if (
    toolName === 'tw_recall_find' ||
    toolName === 'tw_recall_read' ||
    toolName === 'tw_recall_read_events'
  )
    return 'crossThreadRead'
  // Audio/video media tools route to the dedicated mediaEditing service (grant
  // bucket + audit) so they're gated/audited at shell/file strictness instead of
  // the generic mcpTools service. Set is sourced from the canonical tool list.
  if (MEDIA_EDITING_TOOLS.has(toolName)) return 'mediaEditing'
  return 'mcpTools'
}

export function taskWraithToolServiceIfKnown(toolName: string): AgenticServiceId | null {
  const canonicalToolName = canonicalTaskWraithToolName(toolName)
  if (!isTaskWraithMcpToolName(canonicalToolName)) return null
  return taskWraithToolAgenticService(canonicalToolName)
}
