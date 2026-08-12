import { catalogToolAgenticService } from '../shared/canonicalToolCoalesce'
import {
  resolveProviderNativeActionStrict,
  resolveToolDispatchContractForServerStrict,
  resolveToolDispatchContractStrict
} from '../shared/providerActionTaxonomy'
import type { TaskWraithMcpToolName } from '../shared/taskWraithMcpCatalog'
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
        | 'inspection_shell'
        | 'external_read'
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
      externalPublish: preserveCurrentDeny(current.externalPublish, effective.externalPublish),
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
      // Default/Full WS Access/Full Access allow. Preserve global deny.
      sketchCanvas: preserveCurrentDeny(current.sketchCanvas, effective.sketchCanvas),
      // Mesh Canvas is its own authoring/import service. Preserve a Recon
      // deny through this main-owned effective-policy rebuild.
      meshCanvas: preserveCurrentDeny(current.meshCanvas, effective.meshCanvas),
      // Simulator Canvas mirrors subThreadDelegation: Ask/Plan stay ASK (not
      // deny), but a global deny must still survive this rebuild.
      simulatorCanvas: preserveCurrentDeny(current.simulatorCanvas, effective.simulatorCanvas),
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
      // Browser navigation: a global webBrowsing 'deny' (kill switch) must
      // survive the rebuild, or a denied browser would come back as a prompt.
      webBrowsing: preserveCurrentDeny(current.webBrowsing, effective.webBrowsing),
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
   * A live Full Access matched the exact chat/provider/lane and the
   * request is an external write from that active task. This narrowly lifts
   * the ordinary external-path prompt for Full Access only.
   */
  trustedSessionExternalWrite?: boolean
  /**
   * The request passed the canonical prompt-free read-shell proof (strict Git
   * reads or a fail-closed inspection-only shell command). Allowed under EVERY
   * posture — including a read_only/plan shell deny. The caller computes this
   * from the RAW command; external-path detection still wins.
   */
  readOnlyShellFastPath?: boolean
  /**
   * Slice E (2026-08-04): the detected external path is a READ and the signed
   * posture is a write tier (workspace_write / full_access) — outside-workspace
   * reads auto-approve there by owner spec; writes keep the external-path ask.
   */
  externalPathReadAutoAllowed?: boolean
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
  if (args.externalPathDetected && args.externalPathReadAutoAllowed) {
    return {
      kind: 'allow',
      policy,
      reason: 'external_read',
      scope: 'request',
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
export function taskWraithToolAgenticService(toolName: TaskWraithMcpToolName): AgenticServiceId {
  return catalogToolAgenticService(toolName)
}

export function taskWraithToolServiceIfKnown(
  toolName: string,
  toolArgs?: unknown
): AgenticServiceId | null {
  const contract = resolveToolDispatchContractStrict(toolName, toolArgs)
  return contract.ok ? contract.service : null
}

export type CodexMcpApprovalIdentity =
  | {
      readonly recognized: true
      readonly toolName: string
      readonly effectiveToolName: string
      readonly service: AgenticServiceId
    }
  | {
      readonly recognized: false
    }

/**
 * Recognize a TaskWraith MCP approval without laundering a foreign server
 * namespace. When Codex supplies split server/tool fields, both must match the
 * exact TaskWraith route; otherwise the call remains generic MCP.
 */
export function resolveCodexMcpApprovalIdentity(input: {
  readonly toolName: string
  readonly serverName?: string | null
  readonly toolArgs?: unknown
}): CodexMcpApprovalIdentity {
  const contract =
    typeof input.serverName === 'string' && input.serverName.trim()
      ? resolveToolDispatchContractForServerStrict(input.serverName, input.toolName, input.toolArgs)
      : resolveToolDispatchContractStrict(input.toolName, input.toolArgs)
  return contract.ok
    ? {
        recognized: true,
        toolName: contract.toolName,
        effectiveToolName: contract.effectiveToolName,
        service: contract.service
      }
    : { recognized: false }
}

/**
 * Extract the exact tool arguments carried by a Codex approval request.
 *
 * Codex app-server MCP elicitations place arguments under
 * `_meta.tool_params`, while provider-native approvals use the top-level
 * `arguments` / `input` fields. Direct structural fields win; display text is
 * never parsed as authority.
 */
export function codexToolArgumentsFromApprovalParams(paramsValue: unknown): unknown {
  const params = objectRecord(paramsValue)
  if (!params) return undefined
  const item = objectRecord(params.item)
  for (const candidate of [params.arguments, params.input, item?.arguments]) {
    if (candidate !== undefined) return candidate
  }
  const metadata = objectRecord(params._meta)
  return metadata?.tool_params
}

/** Exact shell command evidence from native or MCP-elicitation approval params. */
export function codexShellCommandFromApprovalParams(paramsValue: unknown): unknown {
  const params = objectRecord(paramsValue)
  if (!params) return undefined
  const exec = objectRecord(params.exec)
  const item = objectRecord(params.item)
  for (const candidate of [params.command, params.commandLine, exec?.command, item?.command]) {
    if (candidate !== undefined) return candidate
  }
  const toolArguments = objectRecord(codexToolArgumentsFromApprovalParams(params))
  return toolArguments?.command
}

export type CodexStructuralApprovalAction = 'commandExecution' | 'fileChange'

export type CodexStructuralApprovalResolution =
  | {
      readonly kind: 'not_applicable'
    }
  | {
      readonly kind: 'resolved'
      readonly nativeAction: CodexStructuralApprovalAction
      readonly catalogTool: TaskWraithMcpToolName
      readonly service: AgenticServiceId
    }
  | {
      readonly kind: 'deny'
      readonly code: 'codex_structural_identity_conflict' | 'codex_structural_payload_missing'
      readonly reason: string
    }

function objectRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function codexStructuralAction(value: unknown): CodexStructuralApprovalAction | null {
  return value === 'commandExecution' || value === 'fileChange' ? value : null
}

function hasCodexCommandPayload(value: unknown): boolean {
  if (typeof value === 'string') return value.trim().length > 0
  if (Array.isArray(value)) {
    return value.some((entry) => typeof entry === 'string' && entry.trim().length > 0)
  }
  return false
}

function hasCodexFileChangePayload(value: unknown): boolean {
  if (Array.isArray(value)) return value.length > 0
  if (typeof value === 'string') return value.trim().length > 0
  return Boolean(value && typeof value === 'object')
}

/**
 * Resolve Codex app-server approval authority from exact structural identity.
 *
 * Human labels and whichever payload happens to be populated never choose the
 * policy bucket. Exact method/type identity selects the closed Codex adapter;
 * payload is then checked only for required evidence and contradictions.
 */
export function resolveCodexStructuralApproval(input: {
  readonly method: string
  readonly params: unknown
  readonly cachedFileChangeAvailable?: boolean
}): CodexStructuralApprovalResolution {
  const params = objectRecord(input.params) || {}
  const item = objectRecord(params.item)
  const exec = objectRecord(params.exec)
  const methodAction =
    input.method === 'item/commandExecution/requestApproval'
      ? 'commandExecution'
      : input.method === 'item/fileChange/requestApproval'
        ? 'fileChange'
        : null
  const declaredActions = [
    codexStructuralAction(params.approvalType),
    codexStructuralAction(params.type),
    codexStructuralAction(params.kind),
    codexStructuralAction(item?.type)
  ].filter((action): action is CodexStructuralApprovalAction => action !== null)
  const identities = new Set<CodexStructuralApprovalAction>(declaredActions)
  if (methodAction) identities.add(methodAction)
  if (identities.size === 0) return { kind: 'not_applicable' }
  if (identities.size !== 1) {
    return {
      kind: 'deny',
      code: 'codex_structural_identity_conflict',
      reason: `Codex approval method/type identities disagree: ${[...identities].join(', ')}.`
    }
  }

  const nativeAction = [...identities][0]
  const hasCommand =
    hasCodexCommandPayload(params.command) ||
    hasCodexCommandPayload(params.commandLine) ||
    hasCodexCommandPayload(exec?.command) ||
    hasCodexCommandPayload(item?.command)
  const hasFileChange =
    hasCodexFileChangePayload(params.changes) ||
    hasCodexFileChangePayload(params.diff) ||
    hasCodexFileChangePayload(params.patch) ||
    hasCodexFileChangePayload(params.preview) ||
    hasCodexFileChangePayload(item?.changes) ||
    hasCodexFileChangePayload(item?.diff) ||
    hasCodexFileChangePayload(item?.patch) ||
    input.cachedFileChangeAvailable === true
  const contradictoryPayload =
    (nativeAction === 'commandExecution' && hasFileChange) ||
    (nativeAction === 'fileChange' && hasCommand)
  if (contradictoryPayload) {
    return {
      kind: 'deny',
      code: 'codex_structural_identity_conflict',
      reason: `Codex ${nativeAction} approval carried contradictory ${
        nativeAction === 'commandExecution' ? 'file-change' : 'command'
      } payload.`
    }
  }
  if (
    (nativeAction === 'commandExecution' && !hasCommand) ||
    (nativeAction === 'fileChange' && !hasFileChange)
  ) {
    return {
      kind: 'deny',
      code: 'codex_structural_payload_missing',
      reason: `Codex ${nativeAction} approval omitted its required structural payload.`
    }
  }

  const resolution = resolveProviderNativeActionStrict('codex', nativeAction)
  if (!resolution.ok) {
    return {
      kind: 'deny',
      code: 'codex_structural_identity_conflict',
      reason: resolution.reason
    }
  }
  return {
    kind: 'resolved',
    nativeAction,
    catalogTool: resolution.catalogTool,
    service: resolution.metadata.service
  }
}
