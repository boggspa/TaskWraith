import type { RunEvent, RunEventSink } from './RunEventBus'

/**
 * BridgeRunEventSink — fans every `RunEventBus` event out to the daemon
 * via JSON-RPC notification, which then forwards to any connected iOS
 * devices over QUIC.
 *
 * Design lift from Phase B: `RunEventBus` was deliberately built as a
 * fan-out primitive so additional sinks could be added without touching
 * the ~10 emission call sites scattered through `main/index.ts`. The
 * Electron IPC sink was the first subscriber (preserves legacy renderer
 * behavior); this is the second. From the perspective of the renderer
 * and the adapters, nothing changed — events still flow through
 * `runEventBus.publish(...)` and the renderer still receives them.
 *
 * Filtering today: the host may attach a sink-level interest filter before
 * JSON encoding. When no phone has asserted a watch signal, the filter fails
 * open and preserves the old forward-everything behavior.
 *
 * Performance: each forwarded notification is a single stdout `write`
 * line into the daemon's stdin pipe. Cost is dominated by JSON encoding
 * (which the renderer-side IPC sink ALSO does); same order of magnitude.
 * In normal use without iOS active, the daemon receives + discards
 * (no connected QUIC peers), which is cheap. When iOS is paired and
 * connected, this becomes the live transcript stream.
 *
 * Wire shape (the notification the daemon receives):
 *
 *   `bridge.runEvent`
 *   {
 *     channel: "agent-output",
 *     provider: "gemini",
 *     payload: {...the routed event payload...},
 *     publishedAt: "2026-05-15T..."
 *   }
 *
 * The daemon (Swift side, separate slice) will translate this into an
 * iOS-bound QUIC frame on each active pair connection.
 */

export interface BridgeRunEventNotifier {
  /** Send a fire-and-forget notification to the daemon over stdio. Same
   * `BridgeDaemonClient.notify` shape — abstracted so tests don't need a
   * real daemon spawned. */
  notify(method: string, params: unknown): void
}

export interface BridgeRunEventSinkOptions {
  /** Notifier used to push to the daemon. Production wires
   * `BridgeDaemonClient`. Tests wire a vi.fn(). */
  notifier: BridgeRunEventNotifier
  /** When set, the sink's published events are also forwarded here.
   * Useful when running with `TASKWRAITH_DEBUG_BUS=1` so the forwarded
   * notifications show up in the dev terminal. */
  log?: (line: string) => void
  /** Optional filter to drop events before forwarding. Defaults to
   * forward-everything. Per-pair routing eventually plugs in here. */
  filter?: (event: RunEvent) => boolean
}

const NOTIFICATION_METHOD = 'bridge.runEvent'

export function makeBridgeRunEventSink(options: BridgeRunEventSinkOptions): RunEventSink {
  const { notifier, log, filter } = options
  return {
    id: 'bridge-run-events',
    filter,
    handle(event) {
      // Strip the (non-serializable) `sender: Electron.WebContents` before
      // forwarding — it's only meaningful to the in-process Electron IPC
      // sink. Everything else round-trips through JSON without surprise.
      //
      // Surface `appChatId` as a top-level `threadId` on the notification.
      // The host-side sink filter uses the same extraction before this handle
      // path runs, so filtered events avoid both JSON encoding and the daemon
      // pipe write. Absent threadId stays fail-open.
      const threadId = extractThreadId(event.payload)
      const wireEvent: Record<string, unknown> = {
        channel: event.channel,
        provider: event.provider,
        payload: event.payload,
        publishedAt: event.publishedAt
      }
      if (threadId !== null) {
        wireEvent.threadId = threadId
      }
      try {
        notifier.notify(NOTIFICATION_METHOD, wireEvent)
      } catch (err) {
        // Best-effort — a failed notify (daemon dead, stdin closed) must
        // not break the bus. Log + swallow.
        log?.(
          `[BridgeRunEventSink] notify failed for channel="${event.channel}": ${err instanceof Error ? err.message : String(err)}`
        )
        return
      }
      log?.(
        `[BridgeRunEventSink] forwarded channel="${event.channel}" provider="${event.provider}"${
          threadId !== null ? ` threadId="${threadId}"` : ''
        }`
      )
    }
  }
}

/** Best-effort extraction of `appChatId` from a routed run-event payload.
 * Returns null when the payload doesn't carry one (e.g. provider-level
 * errors without route context, or older event shapes). The daemon
 * falls back to broadcast-all when threadId is absent, so a null
 * return preserves current behavior. */
export function extractThreadId(payload: unknown): string | null {
  if (!payload || typeof payload !== 'object') return null
  const record = payload as Record<string, unknown>
  // Direct field — most agent-output / agent-error / agent-exit events
  // carry `appChatId` after route enrichment.
  if (typeof record.appChatId === 'string' && record.appChatId.length > 0) {
    return record.appChatId
  }
  // Synthetic approval events are bridge-only and carry the routing
  // identifier as `threadId` directly.
  if (typeof record.threadId === 'string' && record.threadId.length > 0) {
    return record.threadId
  }
  // The payload may also be a nested `{provider, data, appRunId, appChatId}`
  // shape (sendAgentCompatLine's wrapper). Check one level deep.
  if (typeof record.data === 'object' && record.data !== null) {
    const inner = record.data as Record<string, unknown>
    if (typeof inner.appChatId === 'string' && inner.appChatId.length > 0) {
      return inner.appChatId
    }
    if (typeof inner.threadId === 'string' && inner.threadId.length > 0) {
      return inner.threadId
    }
  }
  return null
}
