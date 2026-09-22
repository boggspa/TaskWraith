/**
 * In-main Bridge -> Authority queued-start glue (Independent Threads M2,
 * producer step 2).
 *
 * UNWIRED BY CONSTRUCTION. Nothing builds this yet: no composition root, no
 * `src/main/index.ts` call, no flag. It takes injected FUNCTION ports only and
 * never reaches for a composition bind, so landing it cannot change any live
 * route. Step 3 (the IntegrationOwner-granted wiring) is separate work.
 *
 * WHY IT EXISTS. The standalone Host route runs the provider under
 * `runId === commandId`, so its start publication can look the run row up by
 * commandId. The in-main Bridge route cannot: `appRunId` is allocated (and for
 * a busy send, RESERVED in the durable queue) before a Host command exists,
 * and that id is the wire identity every paired device navigates by. Re-keying
 * it to the commandId would rewrite a published identity. So this glue leaves
 * the run id alone and BINDS it as evidence at the settled boundary — the
 * A-prime ruling. See HostQueuedStartEffectIdentity.runEntityId.
 *
 * EVENT MAPPING (deliberately partial — each omission is a decision):
 * - `queued`   -> no Authority call. The Authority marks its own receipt
 *                 `queued` when it ACKs; a second write here would race it.
 * - `prepared` (solo) -> `starting`, then a persist-proven `succeeded`
 *                 settlement binding `start.runId` as the run entity.
 * - `prepared` (ensemble) -> REFUSED, no Authority call. Ensemble proof needs
 *                 every participant run plus the round row; that is step 2b
 *                 and must not be half-served here.
 * - `settled` started -> no call; `prepared` already drove success.
 * - `settled` failed/cancelled -> one terminalizing settlement.
 * - adapter failure -> one terminalizing settlement, `publication_failed`.
 *
 * NO DURABLE PRE-SPAWN CLAIM. The in-main route has no execution-claim
 * journal, so the `starting` view carries NO executionClaimCursor. A receipt
 * promoted by a restart therefore classifies as `unknown`, never `claimed` —
 * conservative recovery is preserved, not widened.
 */

import { HOST_COMMAND_ACTION_ID_PREFIX, resolveHostCommandActionId } from './HostCommandIdentity'
import type {
  HostBridgeQueuedStartFailure,
  HostBridgeQueuedStartView
} from './HostBridgeQueuedStartAdapter'
import type { HostCommandExecutionResult } from '../../host-runtime/HostCommandExecutionResult'
import type {
  HostQueuedStartEntities,
  HostQueuedStartStartedView
} from '../../host-runtime/HostQueuedStartPublication'

/**
 * The exact slice of AppStoreHostAuthority this glue is allowed to touch.
 * Structural, so a test can supply spies and production can pass the real
 * Authority without this module importing it.
 */
export interface HostBridgeQueuedStartAuthorityPort {
  handleQueuedStartStarting(view: HostQueuedStartStartedView): void
  handleQueuedStartDispatchSettled(
    commandId: string,
    result: HostCommandExecutionResult,
    startEntities?: HostQueuedStartEntities
  ): void
}

export type HostBridgeQueuedStartPublicationRefusal =
  /** Ensemble starts are step 2b. Never partially published. */
  | 'ensemble_start_deferred'
  /** Not a `host:command:<lowercase-uuid>` correlation; no Host authority. */
  | 'invalid_action_id'
  /** A `prepared` view with no prepared evidence attached. */
  | 'missing_prepared_evidence'
  /** A `settled` view with no settlement attached. */
  | 'missing_settled_evidence'
  /** A terminal decision was already forwarded for this commandId. */
  | 'already_forwarded'

export type HostBridgeQueuedStartPublicationResult =
  | {
      readonly kind: 'started'
      readonly commandId: string
      readonly runEntityId: string
    }
  | {
      readonly kind: 'terminalized'
      readonly commandId: string
      readonly status: 'failed' | 'cancelled'
    }
  | {
      readonly kind: 'ignored'
      readonly reason: 'queued_phase_owned_by_authority' | 'started_settlement_already_published'
    }
  | { readonly kind: 'refused'; readonly reason: HostBridgeQueuedStartPublicationRefusal }

export interface HostBridgeQueuedStartPublicationBridge {
  /** Adapter `queued` view. Never calls the Authority. */
  onQueued(view: HostBridgeQueuedStartView): HostBridgeQueuedStartPublicationResult
  /** Adapter `prepared` view. Solo only; ensemble is refused untouched. */
  onPrepared(view: HostBridgeQueuedStartView): HostBridgeQueuedStartPublicationResult
  /** Adapter `settled` view. failed/cancelled terminalize exactly once. */
  onSettled(view: HostBridgeQueuedStartView): HostBridgeQueuedStartPublicationResult
  /** Adapter publication failure. Terminalizes with `publication_failed`. */
  onFailure(failure: HostBridgeQueuedStartFailure): HostBridgeQueuedStartPublicationResult
  /** Command ids whose terminal decision has been forwarded. Diagnostics only. */
  forwardedCount(): number
}

/**
 * Resolve the Host commandId carried by a Bridge correlation.
 *
 * Fail-closed on anything that is not the exact minted form: a client-shaped
 * action id must never be able to address a Host receipt.
 */
function commandIdOf(hostCommandActionId: string): string | null {
  const actionId = resolveHostCommandActionId(hostCommandActionId)
  if (!actionId) return null
  return actionId.slice(HOST_COMMAND_ACTION_ID_PREFIX.length)
}

export function createHostBridgeQueuedStartPublicationBridge(options: {
  readonly authority: HostBridgeQueuedStartAuthorityPort
}): HostBridgeQueuedStartPublicationBridge {
  const authority = options.authority
  if (
    !authority ||
    typeof authority.handleQueuedStartStarting !== 'function' ||
    typeof authority.handleQueuedStartDispatchSettled !== 'function'
  ) {
    throw new Error('HostBridgeQueuedStartPublicationBridge requires an injected authority port')
  }
  // Exactly-once fence for the TERMINAL decision. The publication coordinator
  // fences again on its own pending map; this keeps the glue from issuing a
  // second settlement that the coordinator would only silently discard.
  const forwarded = new Set<string>()

  return {
    onQueued() {
      // The Authority writes `queued` on its own receipt when it ACKs the
      // send. Forwarding it here would race that write and could regress the
      // phase, which the receipt store refuses anyway.
      return { kind: 'ignored', reason: 'queued_phase_owned_by_authority' }
    },

    onPrepared(view) {
      const prepared = view.prepared
      if (!prepared) return { kind: 'refused', reason: 'missing_prepared_evidence' }
      // Ensemble proof needs the round row and every participant run. Serving
      // it through the solo single-run binding would publish a start that was
      // never proven, so it is refused whole.
      if (prepared.start.kind !== 'solo') {
        return { kind: 'refused', reason: 'ensemble_start_deferred' }
      }
      const commandId = commandIdOf(view.hostCommandActionId)
      if (!commandId) return { kind: 'refused', reason: 'invalid_action_id' }
      if (forwarded.has(commandId)) return { kind: 'refused', reason: 'already_forwarded' }

      // `starting` carries NO executionClaimCursor: the in-main route holds no
      // durable pre-spawn claim, so recovery must classify it `unknown`.
      const startingView: HostQueuedStartStartedView = {
        commandId,
        threadId: view.threadId,
        fingerprint: view.authority.commandFingerprint,
        phase: 'starting',
        startedEvidence: false,
        terminalOutcome: null
      }
      authority.handleQueuedStartStarting(startingView)

      // A `prepared` view exists only for an event whose
      // `durablePromptAndStartPersisted` was the literal `true`, so the
      // prompt and start row are already durable at this point. That is the
      // same persist boundary the standalone route waits for.
      const runEntityId = prepared.start.runId
      forwarded.add(commandId)
      authority.handleQueuedStartDispatchSettled(
        commandId,
        { status: 'succeeded' },
        { runEntityId }
      )
      return { kind: 'started', commandId, runEntityId }
    },

    onSettled(view) {
      const settled = view.settled
      if (!settled) return { kind: 'refused', reason: 'missing_settled_evidence' }
      if (settled.status === 'started') {
        // `prepared` already published the persist-proven success. Settling
        // again would be a second terminal decision on one receipt.
        return { kind: 'ignored', reason: 'started_settlement_already_published' }
      }
      const commandId = commandIdOf(view.hostCommandActionId)
      if (!commandId) return { kind: 'refused', reason: 'invalid_action_id' }
      if (forwarded.has(commandId)) return { kind: 'refused', reason: 'already_forwarded' }
      forwarded.add(commandId)
      authority.handleQueuedStartDispatchSettled(commandId, {
        status: settled.status,
        ...(settled.errorCode !== undefined ? { errorCode: settled.errorCode } : {})
      })
      return { kind: 'terminalized', commandId, status: settled.status }
    },

    onFailure(failure) {
      const commandId = commandIdOf(failure.hostCommandActionId)
      if (!commandId) return { kind: 'refused', reason: 'invalid_action_id' }
      if (forwarded.has(commandId)) return { kind: 'refused', reason: 'already_forwarded' }
      forwarded.add(commandId)
      authority.handleQueuedStartDispatchSettled(commandId, {
        status: 'failed',
        errorCode: failure.reason
      })
      return { kind: 'terminalized', commandId, status: 'failed' }
    },

    forwardedCount() {
      return forwarded.size
    }
  }
}
