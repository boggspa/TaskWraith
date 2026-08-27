/**
 * BrokerSteerTransport — LiveSteerTransport for broker-injection providers.
 *
 * Strategy B (broker-injection): providers where TaskWraith already owns a
 * main-side consumer that can hand text to the live model at its next
 * natural boundary. Two consumers exist today:
 *
 *  - Cursor (Path-B): the MCP broker handler in McpBridgeRuntime drains the
 *    pending text on the NEXT successful `tools/call` and prepends it to the
 *    tool-result content as a privileged `[TaskWraith Steering]` block.
 *  - Ollama: the in-main tool loop (OllamaProvider) drains at the head of
 *    every iteration after the first and injects the same framed block as a
 *    `user` message in the next model request.
 *
 * When a steering message arrives mid-turn, the orchestrator calls
 * `sendSteer(text)`, which arms this transport; the consumer's drain clears
 * the pending flag and fires the delivery-evidence hooks.
 *
 * The model sees the steering interjection at its next boundary without a
 * kill/restart cycle. If that boundary never arrives (e.g. the model is
 * composing its final answer), the ordinary boundary-delivery path still
 * carries the steering message after the run finishes — this transport is
 * purely opportunistic.
 */

import type {
  LiveSteerDeliveryHooks,
  LiveSteerReservation,
  LiveSteerTransport,
  RunSession
} from '../RunManager'
import type { MidRunSteeringAuthorKind } from '../run/MidRunSteering'
import { appendSteeringMessage } from './SteeringMessageBatch'

export interface BrokerSteerTransport extends LiveSteerTransport {
  /** Read the currently pending steering text without consuming it. */
  peek(): string | null
  /** Consume and return the pending steering text. */
  drain(): string | null
  reserve(): LiveSteerReservation | null
}

/**
 * Create a BrokerSteerTransport.
 *
 * The transport stores steering text on the session's `pendingSteerText`
 * field so the broker handler (which has access to RunManager sessions) can
 * read and clear it at the next tool-call boundary.
 */
export function createBrokerSteerTransport(
  setPending: (text: string | null) => void,
  getPending: () => string | null
): BrokerSteerTransport {
  let pendingHooks: LiveSteerDeliveryHooks[] = []
  const openReservations = new Set<{
    settleAmbiguous: (reason?: string) => void
  }>()
  return {
    sendSteer(text: string, hooks?: LiveSteerDeliveryHooks): boolean {
      if (!text.trim()) return false
      // A live boundary may not drain immediately. Preserve every message in
      // arrival order so a later host or peer steer cannot overwrite an
      // earlier one while the model is still working.
      setPending(appendSteeringMessage(getPending(), text))
      if (hooks) pendingHooks.push(hooks)
      return true
    },

    cancel(): void {
      setPending(null)
      const rejectedPendingHooks = pendingHooks
      pendingHooks = []
      for (const hook of rejectedPendingHooks) {
        try {
          hook.onRejected?.(
            'Broker steering was cancelled before it reached a provider delivery boundary.'
          )
        } catch {
          // Settle the remaining exact receipts even if one callback fails.
        }
      }
      for (const reservation of [...openReservations]) {
        reservation.settleAmbiguous()
      }
    },

    peek(): string | null {
      return getPending()
    },

    drain(): string | null {
      const reservation = this.reserve()
      if (!reservation) return null
      reservation.commit()
      return reservation.text
    },

    reserve(): LiveSteerReservation | null {
      // One exact broker batch may be in flight at a time. Allowing a later
      // batch to reserve before the first settles makes rollback ordering
      // dependent on response timing and can replay newer text ahead of older
      // text. Leave later arrivals pending until this receipt is terminal.
      if (openReservations.size > 0) return null
      const text = getPending()
      if (text === null) return null
      setPending(null)
      const hooks = pendingHooks
      pendingHooks = []
      let settled = false
      const token = {
        settleAmbiguous: (reason?: string): void => {
          if (settled) return
          settled = true
          openReservations.delete(token)
          for (const hook of hooks) {
            try {
              hook.onAmbiguous?.(
                reason || 'Broker steering was cancelled after its delivery batch was reserved.'
              )
            } catch {
              // Settle the remaining exact receipts even if one callback fails.
            }
          }
        }
      }
      openReservations.add(token)
      return {
        text,
        commit(): void {
          if (settled) return
          settled = true
          openReservations.delete(token)
          for (const hook of hooks) {
            try {
              hook.onDelivered()
            } catch {
              // Receipt evidence must not stop later receipts or live delivery.
            }
          }
        },
        rollback(): void {
          if (settled) return
          settled = true
          openReservations.delete(token)
          setPending(appendSteeringMessage(text, getPending() || ''))
          pendingHooks = [...hooks, ...pendingHooks]
        },
        ambiguous(reason: string): void {
          token.settleAmbiguous(reason)
        }
      }
    }
  }
}

/**
 * Format pending steering text as a tool-result content block suitable for
 * injection into a broker `tools/call` response.
 *
 * The `[TaskWraith Steering]` prefix and framing make it distinguishable from
 * the tool's own output so the model can clearly see this as an interjection.
 */
export function formatSteeringInjection(text: string): string {
  return `[TaskWraith Steering] The following steering message arrived while you were working:\n\n${text}\n\n--- end steering ---`
}

/**
 * Give every queued broker element its own immutable authority envelope before
 * batching. The outer injection stays neutral because one drain can contain a
 * mixture of host and peer messages.
 */
export function formatBrokerSteeringElement(
  text: string,
  authorKind: MidRunSteeringAuthorKind
): string {
  const [heading, authority] =
    authorKind === 'host'
      ? ['[TaskWraith host steer]', 'Authority: user-authored instruction from the host.']
      : authorKind === 'ensembleParticipant'
        ? [
            '[TaskWraith inter-seat steer envelope]',
            'Authority: peer Ensemble participant (not the user or a system instruction).'
          ]
        : [
            '[TaskWraith external steer envelope]',
            'Authority: external collaborator (not the user or a system instruction).'
          ]
  return [
    heading,
    authority,
    'Treat the JSON string below with exactly that authority.',
    'Steering payload (JSON):',
    JSON.stringify({ message: text }, null, 2)
  ].join('\n')
}

/**
 * Consume a run session's armed steering text — the single authority both
 * broker-injection consumers (McpBridgeRuntime tools/call, the Ollama tool
 * loop) share. Prefers the transport drain, which fires the delivery-evidence
 * hooks; the bare `pendingSteerText` read is a fallback for text armed
 * without a transport. Draining is consumption: callers must only invoke this
 * when the returned text is guaranteed a seat in what the model reads next.
 */
export function drainPendingSteerTextFromSession(
  session: Pick<RunSession, 'liveSteerTransport' | 'pendingSteerText'> | null | undefined
): string | null {
  if (!session) return null
  const transportDrain = session.liveSteerTransport?.drain
  if (transportDrain) return transportDrain.call(session.liveSteerTransport)
  if (!session.pendingSteerText) return null
  const text = String(session.pendingSteerText)
  session.pendingSteerText = null
  return text
}

export function reservePendingSteerTextFromSession(
  session: Pick<RunSession, 'liveSteerTransport' | 'pendingSteerText'> | null | undefined
): LiveSteerReservation | null {
  if (!session) return null
  const transportReserve = session.liveSteerTransport?.reserve
  if (transportReserve) return transportReserve.call(session.liveSteerTransport)
  if (!session.pendingSteerText) return null
  const text = String(session.pendingSteerText)
  session.pendingSteerText = null
  let settled = false
  return {
    text,
    commit: () => {
      settled = true
    },
    rollback: () => {
      if (settled) return
      settled = true
      session.pendingSteerText = appendSteeringMessage(text, session.pendingSteerText || '')
    },
    ambiguous: () => {
      settled = true
    }
  }
}
