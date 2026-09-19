import type { AcpPermissionRequest } from '../grok/GrokAcpProtocol'
import type { EffectiveRunPermissions } from '../store/types'
import { extractShellCommandFromToolCall } from '../grok/GrokReadOnlyShell'
import type { MistralPermissionDecision } from './MistralPermissionPolicy'

type ShellPolicy = EffectiveRunPermissions['agenticServices']['shellCommands']

/**
 * THE producer for "may this Mistral seat run native shell?".
 *
 * Both the runtime gate and the launch seal call this, so a scheduled
 * occurrence cannot be sealed with one answer and executed with another. Same
 * rule the Codex seat already follows for its sandbox mode: call the producer,
 * never re-derive the expectation at the consumer.
 *
 * Two conditions, both necessary:
 *  - the seat is write-capable. A read-only/plan seat keeps its hard deny, which
 *    is the one case the owner's "escalate, never deny" rule excepts.
 *  - the run's signed shell posture is not `deny`. The native Mistral handler
 *    has never consulted `agenticServices.shellCommands`, so the global shell
 *    kill-switch did not previously reach native shell at all.
 */
export function mistralNativeShellPermitted(input: {
  readOnlySeat: boolean
  shellPolicy: ShellPolicy | null | undefined
}): boolean {
  if (input.readOnlySeat) return false
  return (
    input.shellPolicy !== undefined && input.shellPolicy !== null && input.shellPolicy !== 'deny'
  )
}

export interface MistralNativeShellGateDeps {
  /**
   * `requestAgenticServiceApproval` for this run, already bound to its sender,
   * provider, service and workspace. Returning true means the call may run.
   */
  requestApproval: (request: {
    method: string
    title: string
    body: string
    preview: Record<string, unknown>
  }) => Promise<boolean>
}

/**
 * Route a native shell request into the shared approval chokepoint.
 *
 * Everything that governs a brokered shell call lives behind that one function
 * — the non-grantable host-destructive wall, the destructive-command ask wall,
 * the per-tier holds, the command rules, the approval card and the ledger — so
 * a native call is handed to it rather than to a parallel set of checks that
 * would drift.
 */
export function createMistralNativeShellGate(
  deps: MistralNativeShellGateDeps
): (request: AcpPermissionRequest) => Promise<MistralPermissionDecision> {
  return async (request) => {
    const command = extractShellCommandFromToolCall(request.rawToolCall)
    if (!command) {
      // Fail CLOSED. With no readable command the card cannot show what it is
      // approving and the destructive-command classifier cannot see anything to
      // classify — a silent pass here would be the widest hole in the feature.
      return {
        decision: 'deny',
        origin: 'host-policy',
        reason:
          'TaskWraith could not read the command text for this native shell call, so it could not be shown for approval. Use the listed TaskWraith shell tool instead.'
      }
    }
    const toolName = (request.toolName || 'bash').trim() || 'bash'
    const approved = await deps.requestApproval({
      method: 'mistral-acp/native-shell',
      title: `Approve Mistral shell: ${toolName}`,
      body: command,
      // `params.command` is the shape every host shell classifier reads.
      preview: { kind: 'tool', toolName, params: { command } }
    })
    if (approved) return 'allow'
    // The chokepoint returns a bare boolean, so a decline and an approval
    // timeout are indistinguishable here. Say so rather than attributing it to
    // the user: a seat told "the user rejected this" when nobody was asked is
    // the exact misattribution this workstream exists to remove.
    return {
      decision: 'deny',
      origin: 'unknown',
      reason:
        'The approval request for this command was not granted — it was declined, or it timed out with nobody present. Do not retry it; report the blocker.'
    }
  }
}
