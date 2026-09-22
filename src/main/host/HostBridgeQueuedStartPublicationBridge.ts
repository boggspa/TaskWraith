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
 * - `prepared` (ensemble) -> `starting`, then a persist-proven `succeeded`
 *                 settlement binding `start.roundId` as the ROUND entity. Not
 *                 a participant run: at the round-start persist boundary every
 *                 participant is minted `idle` with no runId, so the proof is
 *                 thread + round. Exactly one entity is ever bound.
 * - `settled` started -> no call; `prepared` already drove success.
 * - `settled` failed/cancelled -> one terminalizing settlement.
 * - adapter failure -> one terminalizing settlement, `publication_failed`.
 *
 * ABSORB RACE — a started settlement with no prepared. When the send resolves
 * with no live round, registers, and a round starts before dispatch, the
 * orchestrator absorbs it and no `prepared` ever arrives. The receipt then
 * ends INDETERMINATE: we cannot prove the start, but the prompt was delivered,
 * so `failed` would be a lie and `succeeded` would be unearned. That outcome
 * travels through the Authority's separate `abortQueuedStart`, never through a
 * fourth HostCommandExecutionResult status.
 *
 * This is also the only entrance this glue owns. A dispatch that returns
 * success carrying neither a run identity nor a queue reservation never
 * reaches an adapter view at all; classifying that belongs to the in-main ACK
 * executor, which calls the same abort route.
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
  /**
   * Abandonment of proof, NOT a settlement — see the Authority's own doc. The
   * glue needs it because it is the only component that knows whether a
   * `started` settlement was preceded by a `prepared` it drove.
   */
  abortQueuedStart(commandId: string): void
}

export type HostBridgeQueuedStartPublicationRefusal =
  /** An ensemble `prepared` carrying no usable round id; nothing to bind. */
  | 'missing_round_identity'
  /** A solo `prepared` carrying no usable run id; nothing to bind. */
  | 'missing_run_identity'
  /** Not a `host:command:<lowercase-uuid>` correlation; no Host authority. */
  | 'invalid_action_id'
  /** A `prepared` view with no prepared evidence attached. */
  | 'missing_prepared_evidence'
  /** A `settled` view with no settlement attached. */
  | 'missing_settled_evidence'
  /** A terminal decision was already forwarded for this commandId. */
  | 'already_forwarded'

/**
 * A `started` result binds EXACTLY ONE entity: the solo run row or the
 * ensemble round row. Both discriminate on `kind: 'started'` because the
 * caller's decision is the same — only the evidence differs.
 */
export type HostBridgeQueuedStartPublicationResult =
  | {
      readonly kind: 'started'
      readonly commandId: string
      readonly runEntityId: string
    }
  | {
      readonly kind: 'started'
      readonly commandId: string
      readonly roundEntityId: string
    }
  | {
      readonly kind: 'terminalized'
      readonly commandId: string
      /**
       * `indeterminate` is an ABANDONMENT of proof, not an execution outcome —
       * it never reaches HostCommandExecutionResult, whose union stays
       * succeeded/failed/cancelled. It routes through the Authority's separate
       * abort method instead.
       */
      readonly status: 'failed' | 'cancelled' | 'indeterminate'
    }
  | {
      readonly kind: 'ignored'
      readonly reason: 'queued_phase_owned_by_authority' | 'started_settlement_already_published'
    }
  | { readonly kind: 'refused'; readonly reason: HostBridgeQueuedStartPublicationRefusal }

export interface HostBridgeQueuedStartPublicationBridge {
  /** Adapter `queued` view. Never calls the Authority. */
  onQueued(view: HostBridgeQueuedStartView): HostBridgeQueuedStartPublicationResult
  /** Adapter `prepared` view. Binds the solo run or the ensemble round. */
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
    typeof authority.handleQueuedStartDispatchSettled !== 'function' ||
    typeof authority.abortQueuedStart !== 'function'
  ) {
    throw new Error('HostBridgeQueuedStartPublicationBridge requires an injected authority port')
  }
  // Exactly-once fence for the TERMINAL decision. The publication coordinator
  // fences again on its own pending map; this keeps the glue from issuing a
  // second settlement that the coordinator would only silently discard.
  const forwarded = new Set<string>()
  // Command ids whose `prepared` this glue actually drove to a persist-proven
  // success. Distinct from `forwarded`, which also holds terminalized ids: the
  // difference is what separates "success already published" from "a started
  // settlement arrived that we never saw prepared".
  const publishedStart = new Set<string>()

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
      const start = prepared.start
      // Exactly one entity is bound per start. An id that is not usable is
      // refused rather than forwarded as an empty binding, which the
      // coordinator would read as "bind nothing" and fall back to the
      // commandId lookup the in-main route cannot satisfy.
      const boundEntityId = start.kind === 'solo' ? start.runId : start.roundId
      if (typeof boundEntityId !== 'string' || boundEntityId.length === 0) {
        return {
          kind: 'refused',
          reason: start.kind === 'solo' ? 'missing_run_identity' : 'missing_round_identity'
        }
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
      //
      // Solo binds the run row. Ensemble binds the ROUND row instead: at the
      // round-start persist boundary the participants are minted `idle` with
      // no runId, so there is no participant run to bind and a proof resting
      // on one would be vacuous exactly when it is needed. Never both — the
      // coordinator refuses that pair as incoherent.
      forwarded.add(commandId)
      publishedStart.add(commandId)
      if (start.kind === 'solo') {
        authority.handleQueuedStartDispatchSettled(
          commandId,
          { status: 'succeeded' },
          { runEntityId: boundEntityId }
        )
        return { kind: 'started', commandId, runEntityId: boundEntityId }
      }
      authority.handleQueuedStartDispatchSettled(
        commandId,
        { status: 'succeeded' },
        { roundEntityId: boundEntityId }
      )
      return { kind: 'started', commandId, roundEntityId: boundEntityId }
    },

    onSettled(view) {
      const settled = view.settled
      if (!settled) return { kind: 'refused', reason: 'missing_settled_evidence' }
      if (settled.status === 'started') {
        const started = commandIdOf(view.hostCommandActionId)
        if (!started) return { kind: 'refused', reason: 'invalid_action_id' }
        if (publishedStart.has(started)) {
          // `prepared` already published the persist-proven success. Settling
          // again would be a second terminal decision on one receipt.
          return { kind: 'ignored', reason: 'started_settlement_already_published' }
        }
        // A started settlement with no prepared we drove: the absorb race —
        // the send resolved with no live round, registered, and the
        // orchestrator then absorbed it into a round that started meanwhile,
        // so no round-start persist and no `prepared` ever arrived. We hold no
        // proof. The receipt must not succeed (nothing was proven) and must not
        // fail (the prompt may well have been delivered), so proof is abandoned
        // and the receipt goes indeterminate. It joins the same terminal fence,
        // so a repeat abandons nothing a second time.
        if (forwarded.has(started)) return { kind: 'refused', reason: 'already_forwarded' }
        forwarded.add(started)
        authority.abortQueuedStart(started)
        return { kind: 'terminalized', commandId: started, status: 'indeterminate' }
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
