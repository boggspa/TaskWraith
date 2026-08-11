/**
 * BrokerSteerTransport — LiveSteerTransport for broker-injection providers.
 *
 * Strategy B (broker-injection): providers where TaskWraith already owns the
 * MCP/tool broker (Cursor Path-B, and any future MCP-brokered provider).
 *
 * When a steering message arrives mid-turn, the orchestrator calls
 * `sendSteer(text)`, which arms this transport. On the NEXT `tools/call`
 * through the broker, the broker handler in McpBridgeRuntime reads the pending
 * text from the session, prepends it to the tool-result content as a
 * privileged `[TaskWraith Steering]` block, and clears the pending flag.
 *
 * The model sees the steering interjection at its next tool boundary without
 * a kill/restart cycle. If the tool call never arrives (e.g. the model is
 * composing its final answer), the ordinary boundary-delivery path still
 * carries the steering message after the run finishes — this transport is
 * purely opportunistic.
 */

import type { LiveSteerDeliveryHooks, LiveSteerTransport } from '../RunManager'

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
