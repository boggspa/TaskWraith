import type { AcpPermissionDecision, AcpPermissionRequest } from '../grok/GrokAcpProtocol'
import type { NativeWorkspaceToolPreflight } from '../native-tools/NativeWorkspaceToolGate'
import type { ApprovalLedgerRequestInput } from '../store/types'

export interface MistralPermissionDenial {
  decision: 'deny'
  origin: 'host-containment' | 'host-policy' | 'human' | 'unknown'
  reason: string
}

export type MistralPermissionDecision = AcpPermissionDecision | MistralPermissionDenial

/** The existing Mistral gate, with provenance added to its deny decisions.
 * Keep the ordering: a native preflight refusal cannot fall through to a read
 * allowance, and broker calls still pass through their own permission gate. */
export function createMistralPermissionHandler(input: {
  isBrokerTool: (request: AcpPermissionRequest) => boolean
  isNetworkRead: (request: AcpPermissionRequest) => boolean
  networkAllowed: () => boolean
  preflight: (request: AcpPermissionRequest) => NativeWorkspaceToolPreflight
  isReadOnlyShell: (request: AcpPermissionRequest) => boolean
  readOnlySeat: boolean
  /**
   * Present only when the seat permits native shell. Routes the request into
   * `requestAgenticServiceApproval('shellCommands')`, which is where the
   * non-grantable host-destructive wall, the destructive-command ask wall, the
   * per-tier holds, the command rules, the approval card and the ledger already
   * live. Absent reproduces the previous behaviour exactly: the terminal
   * host-containment deny below.
   */
  gateNativeShell?: (request: AcpPermissionRequest) => Promise<MistralPermissionDecision>
}): (
  request: AcpPermissionRequest
) => MistralPermissionDecision | Promise<MistralPermissionDecision> {
  return (request) => {
    if (input.isBrokerTool(request)) return 'allow'
    const networkRead = input.isNetworkRead(request)
    if (networkRead && !input.networkAllowed()) {
      return {
        decision: 'deny',
        origin: 'host-policy',
        reason: 'Network access is disabled for this run.'
      }
    }
    const preflight = input.preflight(request)
    if (preflight.kind === 'deny') {
      // The shell gate records its checked cwd only after workspace validation.
      // An outside cwd, unknown action, or file scope refusal has no recovery
      // grant. A validated cwd with no runtime sandbox is a transport refusal.
      const containedShell =
        preflight.canonicalTool === 'run_shell_command' &&
        preflight.requiresRuntimeSandbox &&
        preflight.checkedPaths.length > 0
      return {
        decision: 'deny',
        origin: containedShell ? 'host-containment' : 'host-policy',
        reason: preflight.reason
      }
    }
    if (networkRead) return 'allow'
    if (preflight.kind === 'allow' && preflight.access === 'read') return 'allow'
    if (input.isReadOnlyShell(request)) return 'allow'
    if (input.readOnlySeat) {
      return {
        decision: 'deny',
        origin: 'host-policy',
        reason: 'This read-only seat does not allow this native operation.'
      }
    }
    if (preflight.kind !== 'allow') {
      return {
        decision: 'deny',
        origin: 'host-policy',
        reason: 'This native operation is not allowed by the Mistral seat policy.'
      }
    }
    // Native shell on a write-capable seat whose posture permits it. Deliberately
    // below the read-only seat check above, so a recon seat keeps its hard deny,
    // and below the read allow and read-only-shell fast paths, so `ls` and
    // `git status` are not pushed through an approval card they never needed.
    if (preflight.access === 'shell' && input.gateNativeShell) {
      return input.gateNativeShell(request)
    }
    return {
      decision: 'deny',
      origin: 'host-containment',
      reason:
        'Native mutations cannot provide TaskWraith exact-edit transactions; use an actually listed TaskWraith broker tool within the assigned scope.'
    }
  }
}

export function mistralPermissionRefusalText(denial: MistralPermissionDenial): string {
  const source =
    denial.origin === 'human'
      ? 'The user declined this request.'
      : denial.origin === 'unknown'
        ? 'The refusal origin is unconfirmed; do not attribute it to the user.'
        : `TaskWraith refused this request automatically (${denial.origin}); no human was asked.`
  return `${source} ${denial.reason}`
}

export function mistralPermissionLedgerRecord(
  context: { runId: string; chatId?: string; workspacePath?: string },
  request: AcpPermissionRequest,
  denial: MistralPermissionDenial
): ApprovalLedgerRequestInput {
  return {
    ...context,
    approvalId: `${context.runId}:mistral-native:${request.rpcId}`,
    provider: 'mistral',
    providerSessionId: request.sessionId,
    rpcId: request.rpcId,
    method: 'mistral-acp/native-refusal',
    title: `Mistral ${request.toolName} refused (${denial.origin})`,
    body: mistralPermissionRefusalText(denial),
    actions: [],
    status: 'denied',
    decision: denial.origin === 'human' ? 'decline' : 'autoDeny',
    ...(denial.origin === 'unknown'
      ? {}
      : { decisionSource: denial.origin === 'human' ? 'user' : 'system' }),
    metadata: {
      refusalOrigin: denial.origin,
      toolName: request.toolName,
      toolCallId: request.rawToolCall?.toolCallId
    },
    expiration: { mode: 'none', description: 'Recorded refusal; no pending human approval.' }
  }
}
