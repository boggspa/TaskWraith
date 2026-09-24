import type { AcpPermissionRequest } from '../grok/GrokAcpProtocol'
import { extractShellCommandFromToolCall } from '../grok/GrokReadOnlyShell'
import type { EffectiveRunPermissions, ProviderId } from '../store/types'

type ShellPolicy = EffectiveRunPermissions['agenticServices']['shellCommands']

/** A refusal carrying where it came from, so a seat cannot misread it. */
export interface NativeShellGateDenial {
  decision: 'deny'
  origin: 'host-containment' | 'host-policy' | 'human' | 'unknown'
  reason: string
}

export type NativeShellGateDecision = 'allow' | 'deny' | NativeShellGateDenial

/**
 * THE producer for "may this seat run native shell?".
 *
 * The runtime gate and the launch seal both call it, so a scheduled occurrence
 * cannot be minted under one answer and executed under another — the rule the
 * Codex seat already follows for its sandbox mode.
 *
 * Two necessary conditions:
 *  - the seat is write-capable. A read-only/plan seat keeps its hard deny; that
 *    is the single exception to "escalate, never deny".
 *  - the run's signed shell posture is not `deny`, so the global shell
 *    kill-switch reaches native shell rather than stopping at the broker.
 */
export function nativeShellPermitted(input: {
  readOnlySeat: boolean
  shellPolicy: ShellPolicy | null | undefined
}): boolean {
  if (input.readOnlySeat) return false
  return (
    input.shellPolicy !== undefined && input.shellPolicy !== null && input.shellPolicy !== 'deny'
  )
}

export interface NativeShellApprovalGateDeps {
  /** The seat's provider, for the card's title and the audit method. */
  provider: ProviderId
  /**
   * `requestAgenticServiceApproval` for this run, already bound to its sender,
   * provider, service and workspace. True means the call may run.
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
 * Everything governing a brokered shell call already lives behind that one
 * function — the non-grantable host-destructive wall, the destructive-command
 * ask wall, the per-tier holds, the command rules, the card and the ledger — so
 * a native call is handed to it rather than to a parallel set of checks that
 * would drift from it.
 */
export function createNativeShellApprovalGate(
  deps: NativeShellApprovalGateDeps
): (request: AcpPermissionRequest) => Promise<NativeShellGateDecision> {
  return async (request) => {
    const command = extractShellCommandFromToolCall(request.rawToolCall)
    if (!command) {
      // Fail CLOSED. With no readable command the card cannot show what it is
      // approving and the destructive-command classifier has nothing to
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
      method: `${deps.provider}-acp/native-shell`,
      title: `Approve ${deps.provider} shell: ${toolName}`,
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
