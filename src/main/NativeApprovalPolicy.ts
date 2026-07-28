import { isTaskWraithMcpToolName } from './mcp/McpResultHelpers'
import { canonicalTaskWraithToolName } from './TaskWraithMcpTools'
import { catalogToolAgenticService } from '../shared/canonicalToolCoalesce'
import type {
  AgenticServiceId,
  AgenticServicePolicy,
  AppSettings,
  EffectiveRunPermissions
} from './store/types'

export { canonicalTaskWraithToolName } from './TaskWraithMcpTools'

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
      reason:
        | 'workspace_grant'
        | 'session_grant'
        | 'policy'
        | 'session_yolo'
        | 'trusted_session'
        | 'readonly_shell'
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
      externalPublish: preserveCurrentDeny(
        current.externalPublish,
        effective.externalPublish
      ),
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
      // Sketch edits have their own ladder: Recon deny, Plan ask, and
      // Default/Workspace Write/Trusted Session allow. Preserve global deny.
      sketchCanvas: preserveCurrentDeny(current.sketchCanvas, effective.sketchCanvas),
      // Mesh Canvas is its own authoring/import service. Preserve a Recon
      // deny through this main-owned effective-policy rebuild.
      meshCanvas: preserveCurrentDeny(current.meshCanvas, effective.meshCanvas),
      // Cross-thread reads: the read_only preset's crossThreadRead:'deny' must
      // survive this key-by-key rebuild (same deny-survival as canvasInteraction).
      crossThreadRead: preserveCurrentDeny(current.crossThreadRead, effective.crossThreadRead),
      // Thread messages: same deny-survival. A read_only/plan seat's
      // threadMessage:'deny' must not be softened to a prompt by this rebuild, or a
      // read-only seat could push content into another thread with one approval.
      threadMessage: preserveCurrentDeny(current.threadMessage, effective.threadMessage),
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
  /**
   * A live Trusted Session matched the exact chat/provider/lane and the
   * request is an external write from that active task. This narrowly lifts
   * the ordinary external-path prompt for Full Access only.
   */
  trustedSessionExternalWrite?: boolean
  /**
   * The request is a strictly-classified read-only git shell command —
   * `git status` / `git diff` / `git log` (isReadOnlyGitShellCommand). Allowed
   * under EVERY posture — including a read_only/plan shell deny — mirroring
   * the auto-allowed MCP git read tools. The caller computes this from the
   * RAW command; external-path detection still wins (these commands never
   * carry external paths, so a detection means the classification cannot be
   * trusted).
   */
  readOnlyShellFastPath?: boolean
  effectivePermissions?: EffectiveRunPermissions
}): Exclude<NativeApprovalPreflight, { kind: 'none' }> {
  const { policy, workspaceGrantAllowed, sessionGrantAllowed, decision } = args.resolution
  if (
    args.readOnlyShellFastPath &&
    !args.neverAutoAllow &&
    !args.externalPathDetected &&
    decision !== 'allow'
  ) {
    return {
      kind: 'allow',
      policy,
      reason: 'readonly_shell',
      scope: 'request',
      effectivePermissions: args.effectivePermissions
    }
  }
  if (decision === 'deny')
    return { kind: 'deny', policy, effectivePermissions: args.effectivePermissions }
  if (args.neverAutoAllow)
    return { kind: 'ask', policy, effectivePermissions: args.effectivePermissions }
  if (args.trustedSessionExternalWrite) {
    return {
      kind: 'allow',
      policy,
      reason: 'trusted_session',
      scope: 'session',
      effectivePermissions: args.effectivePermissions
    }
  }
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

/**
 * Agentic-service bucket for the Codex/Gemini/Kimi/Cursor native-tool gate.
 *
 * WS-C: the classification ladder now lives in ONE shared source of truth,
 * `catalogToolAgenticService` (`src/shared/canonicalToolCoalesce.ts`). This gate,
 * the Settings policy chip, and the display/audit normalizers all delegate to it
 * so the service a tool is ENFORCED under can never drift from the one it is
 * SHOWN under. The security-load-bearing routing (shell/externalPublish/media/
 * fileChanges/canvasInteraction/sketchCanvas/canvasEval/crossThreadRead) is
 * documented there.
 */
export function taskWraithToolAgenticService(toolName: string): AgenticServiceId {
  return catalogToolAgenticService(toolName)
}

export function taskWraithToolServiceIfKnown(toolName: string): AgenticServiceId | null {
  const canonicalToolName = canonicalTaskWraithToolName(toolName)
  if (!isTaskWraithMcpToolName(canonicalToolName)) return null
  return taskWraithToolAgenticService(canonicalToolName)
}
