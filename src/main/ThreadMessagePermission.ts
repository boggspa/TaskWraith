/**
 * Pure decision core for peer thread-to-thread messages (S3).
 *
 * Modelled on `BossmanAutoApproval`: fail-closed, side-effect-free, and
 * unit-testable without Electron, so the one place that decides whether one chat
 * may push content into another can be read in full and argued about.
 *
 * The threat this gate exists for: an inbound message becomes part of the
 * receiving seat's context. A sender that could place messages freely could
 * steer another agent — across workspaces, or into running a turn nobody asked
 * for. So the two dangerous shapes are separated from the ordinary one:
 *
 *  - QUEUED, same workspace — the ordinary case. Auto-allowed when the user has
 *    granted the `threadMessage` service (which Full Access does), mirroring how
 *    cross-thread recall auto-allows a read inside the caller's own workspace.
 *  - CROSS-WORKSPACE — a boundary the user drew. Always reaches a human unless
 *    every elevation ground below holds.
 *  - WAKE — asks the target to run a turn immediately, under the TARGET's
 *    permissions, with nobody watching. Never allowed by a bare service grant,
 *    denied outright to read-only and remote-issued senders, and allowed
 *    unattended only same-workspace with the full elevation stack.
 *
 * Every allow that no human saw sets `ledgerRequired`. A silent auto-allow is
 * the failure mode this feature could most easily ship with: it would look
 * exactly like a working feature.
 */

import type { AgenticServicePolicy } from './store/types'
import type { ThreadMessageDelivery, ThreadMessageOrigin } from '../shared/threadMessage'

/**
 * Grounds that together permit an unattended cross-workspace or wake send. Each
 * is resolved by the caller from an existing authority — this module deliberately
 * does not know how to derive any of them.
 */
export interface ThreadMessageElevationGrounds {
  /** Genuine Full Access posture — `isFullShellAccessGranted` on the post-clamp
   * effective permissions, so a forged or unsigned posture has already been
   * clamped to read_only before it can get here. */
  fullAccess: boolean
  /** A live, task-scoped Trusted Session grant matching this chat/provider/
   * workspace — not merely a write-capable posture. */
  trustedSession: boolean
  /** Boss/Captain Auto Approvals consent recorded on the ensemble, with a live
   * approval authority. */
  bossAutoApproval: boolean
}

export interface ThreadMessageGateInput {
  /** Who composed it. `'agent'` is the gated path; see `normalizedOrigin`. */
  origin: ThreadMessageOrigin
  /** What the sender ASKED for. A wake request is never granted by policy alone. */
  requestedDelivery: ThreadMessageDelivery
  /** Sender and recipient are in different workspaces, or either is unscoped. */
  crossWorkspace: boolean
  /** Resolved `threadMessage` policy for the SENDING run. */
  servicePolicy: AgenticServicePolicy
  /** The sending run's read-only / plan posture. Never widened here. */
  readOnly: boolean
  /** The send was issued by a remote (phone) prompt rather than at the desk. */
  remoteOrigin: boolean
  elevation: ThreadMessageElevationGrounds
}

export type ThreadMessageGateVerdict = 'allow' | 'prompt' | 'deny'

export type ThreadMessageGateReason =
  /** The user composed it in the UI; they are the authority. */
  | 'user-origin'
  /** Same workspace, queued, and the service is granted. */
  | 'service-granted'
  /** Cross-workspace or wake, carried by the full elevation stack. */
  | 'elevated'
  /** The service is at 'ask'/'workspace' — a human decides. */
  | 'service-ask'
  /** Crosses a workspace boundary without elevation. */
  | 'cross-workspace'
  /** Asks the target to run a turn without elevation. */
  | 'wake-requested'
  /** A read-only seat may not auto-send even if the policy would allow it. */
  | 'read-only-seat'
  | 'service-denied'
  /** A read-only seat may never cause another thread to run. */
  | 'read-only-wake'
  /** A phone-issued run may never cause another thread to run. */
  | 'remote-wake'

export interface ThreadMessageGateDecision {
  verdict: ThreadMessageGateVerdict
  reason: ThreadMessageGateReason
  /**
   * True when an allow was decided by policy rather than by a human, so the
   * approval ledger MUST record it. The user's requirement, restated: elevation
   * applies AT the gate and never bypasses the audit trail.
   */
  ledgerRequired: boolean
  /** Which grounds carried an elevated allow, for the ledger row. */
  elevationGrounds?: readonly (keyof ThreadMessageElevationGrounds)[]
}

const ELEVATION_GROUNDS: readonly (keyof ThreadMessageElevationGrounds)[] = [
  'fullAccess',
  'trustedSession',
  'bossAutoApproval'
]

/**
 * Every ground must hold. This is a conjunction on purpose: it is the only path
 * to an unattended cross-workspace or wake send, so it should be reachable only
 * when the user has said yes three separate ways.
 */
function elevationSatisfied(grounds: ThreadMessageElevationGrounds): boolean {
  return ELEVATION_GROUNDS.every((ground) => grounds[ground] === true)
}

/**
 * Decide whether a send may proceed.
 *
 * Hard guarantees, each enforced in order below:
 *  - a policy `deny` always wins, including for a user-composed send (the global
 *    setting is the user's own kill switch);
 *  - a read-only seat can never cause another thread to RUN, and can never
 *    auto-send even where the policy would allow it;
 *  - a remote-issued run can never cause another thread to run;
 *  - a wake request is never granted by a service grant alone;
 *  - a cross-workspace send is never granted by a service grant alone;
 *  - elevation requires ALL grounds AND the same workspace, so the elevation
 *    stack cannot carry a send across a workspace boundary; and
 *  - every allow that no human saw is flagged for the approval ledger.
 */
export function evaluateThreadMessageGate(
  input: ThreadMessageGateInput
): ThreadMessageGateDecision {
  const wake = input.requestedDelivery === 'wake'

  // A hard deny wins first — same ordering as the agentic-service gates.
  if (input.servicePolicy === 'deny') {
    return { verdict: 'deny', reason: 'service-denied', ledgerRequired: false }
  }

  // Waking runs a turn in ANOTHER thread with nobody watching. Neither a
  // read-only seat nor a phone-issued prompt may reach that, whatever the policy
  // says — these are refusals, not prompts, because there is no posture under
  // which the answer becomes yes.
  if (wake && input.readOnly) {
    return { verdict: 'deny', reason: 'read-only-wake', ledgerRequired: false }
  }
  if (wake && input.remoteOrigin) {
    return { verdict: 'deny', reason: 'remote-wake', ledgerRequired: false }
  }

  // The user composing a message in the UI is the authority for it. This is the
  // only allow that needs no ledger row: the human decision IS the human record.
  // Reachable only for `origin: 'user'`, which an agent cannot set — the shared
  // model hardcodes 'agent' for anything it did not receive as 'user'.
  if (input.origin === 'user') {
    return { verdict: 'allow', reason: 'user-origin', ledgerRequired: false }
  }

  // Elevation can carry an unattended send, but never across a workspace
  // boundary: the boundary is the user's own line and no grant stack redraws it.
  const elevated = !input.crossWorkspace && !input.readOnly && elevationSatisfied(input.elevation)

  if (wake) {
    return elevated
      ? {
          verdict: 'allow',
          reason: 'elevated',
          ledgerRequired: true,
          elevationGrounds: ELEVATION_GROUNDS
        }
      : { verdict: 'prompt', reason: 'wake-requested', ledgerRequired: false }
  }

  if (input.crossWorkspace) {
    // Deliberately unreachable-as-allow: `elevated` is false whenever
    // crossWorkspace is true. Kept as an explicit branch so the rule is visible
    // here rather than implied by the definition of `elevated` above.
    return { verdict: 'prompt', reason: 'cross-workspace', ledgerRequired: false }
  }

  // A read-only seat never auto-sends. Under the shipped presets this is already
  // unreachable (read_only and plan both set threadMessage:'deny', caught above),
  // so it is defence for a custom preset that leaves the service at 'ask'.
  if (input.readOnly) {
    return { verdict: 'prompt', reason: 'read-only-seat', ledgerRequired: false }
  }

  // Same workspace, queued, service granted: the ordinary case, mirroring how
  // cross-thread recall auto-allows a read inside the caller's own workspace.
  if (input.servicePolicy === 'allow') {
    return { verdict: 'allow', reason: 'service-granted', ledgerRequired: true }
  }

  return { verdict: 'prompt', reason: 'service-ask', ledgerRequired: false }
}

/** Human-readable refusal text for a denied send, shown to the sending agent. */
export function threadMessageDenialMessage(reason: ThreadMessageGateReason): string {
  switch (reason) {
    case 'service-denied':
      return 'Thread messages are disabled for this run (a read-only seat, or turned off in settings).'
    case 'read-only-wake':
      return 'A read-only seat cannot ask another thread to start a turn. Send it queued instead.'
    case 'remote-wake':
      return 'A phone-issued run cannot ask another thread to start a turn. Send it queued instead.'
    default:
      return 'The thread message was not approved.'
  }
}

/**
 * Ledger payload for an auto-allowed send. Returns null when the decision does
 * not require a row, so a caller cannot accidentally record a human approval
 * twice — the human path already writes its own.
 */
export function threadMessageApprovalLedgerMetadata(
  decision: ThreadMessageGateDecision,
  context: {
    fromChatId: string
    toChatId: string
    requestedDelivery: ThreadMessageDelivery
    crossWorkspace: boolean
    servicePolicy: AgenticServicePolicy
  }
): Record<string, unknown> | null {
  if (!decision.ledgerRequired) return null
  return {
    actionClass: 'threadMessage',
    policy: context.servicePolicy,
    decisionReason: decision.reason,
    fromChatId: context.fromChatId,
    toChatId: context.toChatId,
    requestedDelivery: context.requestedDelivery,
    crossWorkspace: context.crossWorkspace,
    ...(decision.elevationGrounds ? { elevationGrounds: [...decision.elevationGrounds] } : {}),
    rationale:
      decision.reason === 'elevated'
        ? 'Auto-allowed by Full Access + Trusted Session + Boss/Captain Auto Approvals, same workspace; recorded because no human saw this send.'
        : 'Auto-allowed by the threadMessage service grant, same workspace, queued delivery; recorded because no human saw this send.'
  }
}
