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

import type { LiveSteerDeliveryHooks, LiveSteerTransport, RunSession } from '../RunManager'

export interface BrokerSteerTransport extends LiveSteerTransport {
  /** Read the currently pending steering text without consuming it. */
  peek(): string | null
  /** Consume and return the pending steering text. */
  drain(): string | null
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
  let pendingHooks: LiveSteerDeliveryHooks | undefined
  return {
    sendSteer(text: string, hooks?: LiveSteerDeliveryHooks): boolean {
      if (!text.trim()) return false
      // Replace any existing pending steer — the newest one wins.
      setPending(text)
      pendingHooks = hooks
      return true
    },

    cancel(): void {
      setPending(null)
      pendingHooks = undefined
    },

    peek(): string | null {
      return getPending()
    },

    drain(): string | null {
      const text = getPending()
      if (text !== null) {
        setPending(null)
        const hooks = pendingHooks
        pendingHooks = undefined
        hooks?.onDelivered()
      }
      return text
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
  return `[TaskWraith Steering] The user sent the following message while you were working:\n\n${text}\n\n--- end steering ---`
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
  const transportText = session.liveSteerTransport?.drain?.()
  if (transportText) return transportText
  if (!session.pendingSteerText) return null
  const text = session.pendingSteerText
  session.pendingSteerText = null
  return text
}
