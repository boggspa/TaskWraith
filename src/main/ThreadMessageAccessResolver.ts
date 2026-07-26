/**
 * Host-side resolver that turns a `ThreadMessagePermission` decision into an
 * answer for the `thread_message` executor (S5).
 *
 * Extracted rather than inlined in index.ts for the reason the composition-root
 * policy exists, and for one specific reason of its own: this is the ONLY place
 * that writes the approval-ledger row for an auto-allowed send. The requirement
 * is that automation may skip the prompt but never the audit trail, and a
 * requirement spread across call sites is a requirement that eventually has a
 * call site that forgot. Here it is one unconditional branch with a test on it.
 */

import {
  evaluateThreadMessageGate,
  threadMessageApprovalLedgerMetadata,
  type ThreadMessageElevationGrounds,
  type ThreadMessageGateDecision
} from './ThreadMessagePermission'
import type { AgenticServicePolicy } from './store/types'
import type { ThreadMessageDelivery } from '../shared/threadMessage'

export interface ThreadMessageAccessRequest {
  context: { appChatId?: string; appRunId?: string; workspacePath?: string }
  parentProvider: string
  crossWorkspace: boolean
  requestedDelivery: ThreadMessageDelivery
  fromChatId: string
  toChatId: string
}

export interface ThreadMessageAccessResolverDeps {
  /** Resolved `threadMessage` policy for the sending run (post-clamp). */
  resolveServicePolicy: (request: ThreadMessageAccessRequest) => AgenticServicePolicy
  /** The sending run's read-only / plan posture. */
  isReadOnlyRun: (request: ThreadMessageAccessRequest) => boolean
  /** True for a phone-issued run. */
  isRemoteOriginRun: (request: ThreadMessageAccessRequest) => boolean
  /** Elevation grounds; each must be resolvable or reported false (fail closed). */
  resolveElevation: (request: ThreadMessageAccessRequest) => ThreadMessageElevationGrounds
  /** Show the human approval card. Resolves true when approved. */
  requestApproval: (
    request: ThreadMessageAccessRequest,
    servicePolicy: AgenticServicePolicy
  ) => Promise<boolean>
  /** Write the approval-ledger row for an allow no human saw. */
  recordAutoAllowLedgerRow: (
    request: ThreadMessageAccessRequest,
    metadata: Record<string, unknown>
  ) => void
}

export type ThreadMessageAccessResolver = (
  request: ThreadMessageAccessRequest
) => Promise<ThreadMessageGateDecision>

export function createThreadMessageAccessResolver(
  deps: ThreadMessageAccessResolverDeps
): ThreadMessageAccessResolver {
  return async function resolveThreadMessageAccess(request) {
    const servicePolicy = deps.resolveServicePolicy(request)
    const decision = evaluateThreadMessageGate({
      // An agent send: the user path is the IPC route, never a tool call.
      origin: 'agent',
      requestedDelivery: request.requestedDelivery,
      crossWorkspace: request.crossWorkspace,
      servicePolicy,
      readOnly: deps.isReadOnlyRun(request),
      remoteOrigin: deps.isRemoteOriginRun(request),
      elevation: deps.resolveElevation(request)
    })

    if (decision.verdict === 'deny') return decision

    if (decision.verdict === 'allow') {
      // Unconditional: an allow that no human saw is recorded, or the elevation
      // has quietly bought itself an unaudited capability.
      const metadata = threadMessageApprovalLedgerMetadata(decision, {
        fromChatId: request.fromChatId,
        toChatId: request.toChatId,
        requestedDelivery: request.requestedDelivery,
        crossWorkspace: request.crossWorkspace,
        servicePolicy
      })
      if (metadata) deps.recordAutoAllowLedgerRow(request, metadata)
      return decision
    }

    // A human decides. The approval flow writes its own ledger row, so this path
    // deliberately does NOT set ledgerRequired — doing so would double-record.
    const approved = await deps.requestApproval(request, servicePolicy)
    return {
      verdict: approved ? 'allow' : 'deny',
      reason: decision.reason,
      ledgerRequired: false
    }
  }
}
