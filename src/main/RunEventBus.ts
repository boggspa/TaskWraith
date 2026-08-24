import type { HostRunEventTarget } from '../host-runtime/HostRunEventTarget'
import type { ProviderId } from './store/types'

/**
 * Centralized fan-out for provider/run streaming events.
 *
 * Before this module existed, every place in `main/index.ts` that wanted to
 * notify the renderer about an agent output / error / exit called
 * `event.sender.send(channel, payload)` directly. That meant ~10 scattered
 * call sites, with no way to add a second subscriber (e.g. a remote iOS
 * bridge sink, a durable replay logger, or a telemetry hook) without
 * patching each one.
 *
 * `RunEventBus` is the single publish point. The three legacy helpers
 * (`sendAgentCompatLine` / `Error` / `Exit`) and the few direct-call sites
 * all funnel through `runEventBus.publish(...)`, and any number of sinks can
 * subscribe to observe events.
 *
 * The first subscriber is the Electron IPC sink — it preserves today's
 * behavior of forwarding events to the renderer via `WebContents.send`.
 * A second subscriber (debug logger, gated by `TASKWRAITH_DEBUG_BUS=1`) is
 * registered during Phase B kickoff to prove fan-out works.
 *
 * Future remote-bridge work (Phase C) will register additional sinks
 * (websocket / Tailscale transport) here, without changing publish call
 * sites at all.
 */

export type RunEventChannel =
  | 'agent-output'
  | 'agent-error'
  | 'agent-exit'
  | 'gemini-output'
  | 'gemini-error'
  | 'gemini-exit'

export interface RunEvent {
  /** IPC channel this event would be published on. */
  channel: RunEventChannel
  /** Provider id (informational; redundant with the channel for gemini-*). */
  provider: ProviderId
  /** Already route-enriched + serializable payload. */
  payload: unknown
  /** Originating Host run target. The optional desktop IPC sink forwards to
   * targets with an Electron-compatible delivery shape; remote sinks ignore it. */
  sender?: HostRunEventTarget
  /** Skip the legacy renderer IPC sink while preserving delivery to the other
   * in-process sinks. Canonical Ensemble output uses this after main has
   * already materialized the transcript; forwarding the same raw provider
   * payload to the renderer would only create a duplicate, unbounded lane. */
  suppressElectronIpc?: boolean
  /** ISO timestamp at publish time. Useful for ordering + telemetry. */
  publishedAt: string
}

export interface RunEventSink {
  /** Unique identifier so the bus can warn on duplicate subscriptions and
   * surface meaningful sink names in error messages. */
  id: string
  /** Optional filter — return `false` to skip this sink for a given event. */
  filter?: (event: RunEvent) => boolean
  /** Receive an event. Errors are caught + logged by the bus so one sink
   * failure can't block the others. */
  handle(event: RunEvent): void
}

export interface RunEventAudienceLease {
  readonly runId: string
  readonly sinkIds: readonly string[]
  /** Idempotent; a stale lease can never release a later owner of the run id. */
  release(): boolean
}

const MAX_RUN_EVENT_IDENTIFIER_LENGTH = 512
const MAX_RUN_EVENT_AUDIENCE_SINKS = 16

interface RunEventAudienceClaim {
  readonly token: object
  readonly sinkIds: ReadonlySet<string>
}

function isBoundedIdentifier(value: unknown): value is string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > MAX_RUN_EVENT_IDENTIFIER_LENGTH ||
    value.trim() !== value
  ) {
    return false
  }
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index)
    if (code < 0x20 || code === 0x7f) return false
  }
  return true
}

function exactPayloadRunId(payload: unknown): string | null {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null
  try {
    const descriptor = Object.getOwnPropertyDescriptor(payload, 'appRunId')
    if (!descriptor || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) return null
    return isBoundedIdentifier(descriptor.value) ? descriptor.value : null
  } catch {
    return null
  }
}

export class RunEventBus {
  private sinks: Map<string, RunEventSink> = new Map()
  private runAudienceClaims: Map<string, RunEventAudienceClaim> = new Map()

  /**
   * Register a sink. Returns an unsubscribe function. Throws if a sink with
   * the same id is already registered (prevents accidental double-subscribe).
   */
  subscribe(sink: RunEventSink): () => void {
    if (this.sinks.has(sink.id)) {
      throw new Error(`RunEventBus: sink "${sink.id}" is already subscribed`)
    }
    this.sinks.set(sink.id, sink)
    return () => {
      this.sinks.delete(sink.id)
    }
  }

  /**
   * Restrict one exact main-owned run to a closed set of sink ids. This is an
   * additive confidentiality boundary for isolated executions: publication and
   * lifecycle still occur, but raw provider events cannot reach renderer,
   * remote, debug, telemetry, or future sinks outside the named audience.
   */
  claimRunAudience(runId: string, sinkIds: readonly string[]): RunEventAudienceLease {
    if (
      !isBoundedIdentifier(runId) ||
      !Array.isArray(sinkIds) ||
      sinkIds.length < 1 ||
      sinkIds.length > MAX_RUN_EVENT_AUDIENCE_SINKS ||
      sinkIds.some((sinkId) => !isBoundedIdentifier(sinkId))
    ) {
      throw new Error('RunEventBus: run audience claim is invalid')
    }
    const uniqueSinkIds = [...new Set(sinkIds)]
    if (uniqueSinkIds.length !== sinkIds.length) {
      throw new Error('RunEventBus: run audience sink ids must be unique')
    }
    if (this.runAudienceClaims.has(runId)) {
      throw new Error('RunEventBus: run audience is already claimed')
    }
    const token = Object.freeze({})
    const claim: RunEventAudienceClaim = {
      token,
      sinkIds: new Set(uniqueSinkIds)
    }
    this.runAudienceClaims.set(runId, claim)
    let released = false
    return Object.freeze({
      runId,
      sinkIds: Object.freeze([...uniqueSinkIds]),
      release: () => {
        if (released || this.runAudienceClaims.get(runId)?.token !== token) return false
        released = true
        this.runAudienceClaims.delete(runId)
        return true
      }
    })
  }

  /**
   * Publish an event to all subscribed sinks. Sink errors are caught + logged;
   * an exception in one sink does not block delivery to the others.
   */
  publish(event: Omit<RunEvent, 'publishedAt'> & { publishedAt?: string }): void {
    const stamped: RunEvent = {
      ...event,
      publishedAt: event.publishedAt ?? new Date().toISOString()
    }
    const audience = this.runAudienceClaims.get(exactPayloadRunId(stamped.payload) ?? '')
    for (const sink of this.sinks.values()) {
      try {
        if (audience && !audience.sinkIds.has(sink.id)) continue
        if (sink.filter && !sink.filter(stamped)) continue
        sink.handle(stamped)
      } catch (err) {
        // Use bare console here — the bus is a foundational module and
        // shouldn't take a dependency on app-level logging utilities.

        console.error(`[RunEventBus] sink "${sink.id}" threw on channel "${stamped.channel}":`, err)
      }
    }
  }

  /** Diagnostics: list currently-subscribed sink ids. */
  listSinks(): string[] {
    return Array.from(this.sinks.keys())
  }

  restrictedRunCount(): number {
    return this.runAudienceClaims.size
  }

  /** Diagnostics / tests: drop all subscribers. */
  reset(): void {
    this.sinks.clear()
    this.runAudienceClaims.clear()
  }
}

export const runEventBus = new RunEventBus()

// Compatibility export while index.ts still registers this optional desktop
// presentation adapter from the historical RunEventBus module path.
export { makeElectronIpcSink } from './ElectronRunEventSink'

/**
 * Debug subscriber. Logs a compact one-line summary per event so we can
 * verify the bus is actually fanning out. Gated externally — register only
 * when `TASKWRAITH_DEBUG_BUS=1` (or similar) is set, so production traffic stays
 * quiet.
 */
export function makeDebugLoggerSink(): RunEventSink {
  return {
    id: 'debug-logger',
    handle(event) {
      let summary: string
      if (event.payload && typeof event.payload === 'object') {
        const keys = Object.keys(event.payload as Record<string, unknown>)
        summary = keys.slice(0, 4).join(',') + (keys.length > 4 ? `…(+${keys.length - 4})` : '')
      } else {
        summary = String(event.payload).slice(0, 60)
      }

      console.log(
        `[RunEventBus] ${event.channel} provider=${event.provider} at=${event.publishedAt} keys=${summary}`
      )
    }
  }
}
