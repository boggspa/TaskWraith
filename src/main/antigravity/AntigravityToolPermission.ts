import type { AcpPermissionRequest } from '../acp/AcpProtocol'
import {
  attributedToolRefusalText,
  type AcpAttributedPermissionDecision
} from '../acp/AcpToolRefusalAttribution'
import type { NativeWorkspaceToolPreflight } from '../native-tools/NativeWorkspaceToolGate'
import type { AgentApprovalAction, ApprovalLedgerRequestInput } from '../store/types'
import type { ToolRefusalReceipt } from '../providers/RunToolCapabilityReceipt'

/** Preserve the official ACP adapter's existing gate order and outcomes. */
export function createAntigravityAcpPermissionHandler(input: {
  isBrokerTool: (request: AcpPermissionRequest) => boolean
  preflight: (request: AcpPermissionRequest) => NativeWorkspaceToolPreflight
  isReadOnlyShell: (request: AcpPermissionRequest) => boolean
}): (request: AcpPermissionRequest) => AcpAttributedPermissionDecision {
  return (request) => {
    if (input.isBrokerTool(request)) return 'allow'
    const preflight = input.preflight(request)
    if (preflight.kind === 'deny')
      return {
        decision: 'deny',
        decisionSource: 'system',
        origin:
          preflight.canonicalTool === 'run_shell_command' &&
          preflight.requiresRuntimeSandbox &&
          preflight.checkedPaths.length > 0
            ? 'host-containment'
            : 'host-policy',
        reason: preflight.reason
      }
    if (preflight.kind === 'allow' && preflight.access === 'read') return 'allow'
    if (input.isReadOnlyShell(request)) return 'allow'
    return {
      decision: 'deny',
      decisionSource: 'system',
      origin: preflight.kind === 'allow' ? 'host-containment' : 'host-policy',
      reason:
        preflight.kind === 'allow'
          ? 'Native mutations do not provide TaskWraith exact-edit transactions.'
          : 'This native action is not permitted by the active ACP seat policy.'
    }
  }
}

export function antigravityRefusalLedgerRecord(
  context: { runId: string; chatId?: string; workspacePath?: string },
  request: AcpPermissionRequest,
  receipt: ToolRefusalReceipt
): ApprovalLedgerRequestInput {
  return {
    ...context,
    approvalId: receipt.approvalId || `${context.runId}:agy-acp:${request.rpcId}`,
    provider: 'antigravity',
    providerSessionId: request.sessionId,
    rpcId: request.rpcId,
    method: 'antigravity-acp/native-refusal',
    title: `${request.toolName} refused (${receipt.origin})`,
    body: attributedToolRefusalText(receipt),
    actions: [],
    status: 'denied',
    decision:
      receipt.origin === 'human' && receipt.decisionSource === 'user' ? 'decline' : 'autoDeny',
    ...(receipt.decisionSource === 'user' || receipt.decisionSource === 'system'
      ? { decisionSource: receipt.decisionSource }
      : {}),
    metadata: {
      refusalOrigin: receipt.origin,
      toolName: request.toolName,
      toolCallId: receipt.toolCallId,
      generation: receipt.generation,
      reply: receipt.reply
    },
    expiration: { mode: 'none', description: 'Recorded native refusal; no pending approval.' }
  }
}

/** agy's hook can carry a reason. Preserve the actual human/system decision
 * when one was observed; an unexplained false must not be labelled user/tier. */
export async function captureAgyApproval(input: {
  toolCallId: string
  toolName: string
  request: (hooks: {
    resolveAction: (action: AgentApprovalAction, source: 'user' | 'system') => void
    onApprovalPromptCreated: (receipt: { approvalId: string }) => void
  }) => Promise<boolean>
}): Promise<{ allowed: boolean; refusal: Omit<ToolRefusalReceipt, 'generation'> | null }> {
  let observed: { action: AgentApprovalAction; source: 'user' | 'system' } | undefined
  let approvalId: string | undefined
  let allowed = false
  try {
    allowed = await input.request({
      resolveAction: (action, source) => {
        observed = { action, source }
      },
      onApprovalPromptCreated: (receipt) => {
        approvalId = receipt.approvalId
      }
    })
  } catch {
    /* Remains an unattributed host failure. */
  }
  if (allowed) return { allowed, refusal: null }
  const human =
    observed?.source === 'user' && (observed.action === 'decline' || observed.action === 'cancel')
  const system = observed?.source === 'system'
  return {
    allowed,
    refusal: {
      toolCallId: input.toolCallId,
      toolName: input.toolName,
      origin: human ? 'human' : system ? 'system-cancelled' : 'unknown',
      decisionSource: human ? 'user' : system ? 'system' : 'unknown',
      approvalId,
      reason: human
        ? 'The exact requested operation was declined.'
        : system
          ? 'The approval timed out or was cancelled by TaskWraith.'
          : 'TaskWraith did not approve this operation; no attributed human decision was returned.',
      reply: 'host-result'
    }
  }
}
