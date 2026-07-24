import type { ProviderId } from '../store/types'
import type { ProviderAdapter } from '../ProviderAdapters'
import type { AgentRunPayload, AgentRunRoute } from '../run/AgentRunTypes'

/**
 * RunCoordinator — Phase B1 extraction.
 *
 * First piece of the long-pole Phase B refactor: pulls the
 * run-dispatch chokepoint out of `src/main/index.ts`'s 9.7k-line
 * whenReady closure into a testable service with explicit
 * dependencies. Behaviour is byte-identical to the previous inline
 * `dispatchAgentRun`; the win is:
 *   - Testable in isolation (unit tests now mock the five
 *     dependencies instead of needing a full Electron + renderer
 *     bootstrap).
 *   - One place to evolve (cancellation, queueing, multi-provider
 *     orchestration — all hooks attach here).
 *   - The "renderer composes a turn, main dispatches it" boundary
 *     becomes visible — future Phase B slices (composer/run-
 *     construction migration from App.tsx) all funnel through
 *     this coordinator.
 *
 * The `provider adapter registry` it depends on is the existing
 * `createProviderAdapterRegistry` instance — we don't re-create
 * the adapters here, we just delegate `.run()` through them.
 *
 * Failure model: matches the original inline helper. Adapter errors
 * are reported via `sendAgentCompatError` + `sendAgentCompatExit`
 * to the sender; the function returns `{ dispatched: false }` and
 * never throws.
 */

export interface RunCoordinatorDeps {
  /** Normalize raw / partial payloads to the canonical AgentRunPayload
   * shape. Currently in index.ts as `normalizeAgentRunPayload`. */
  normalizePayload: (raw: unknown) => AgentRunPayload
  /** Assign / preserve an appRunId for the run. Currently
   * `routeWithRunId`. */
  routeWithRunId: (provider: ProviderId, route?: AgentRunRoute | null) => AgentRunRoute
  /** Apply runtime profile overrides (binary path, env, MCP profile,
   * approval mode, etc.) to the payload in-place. Throws on bad
   * profile id. Currently `applyRuntimeProfileToPayload`. */
  applyRuntimeProfileToPayload: (payload: AgentRunPayload) => AgentRunPayload
  /** Preflight: workspace allowlist, agentic-service grants,
   * scheduled-task attachment, trust check. Returns false to abort
   * the dispatch (the function has already surfaced the error to the
   * sender). Currently `ensureProviderRunPreflight`. */
  ensureProviderRunPreflight: (
    sender: Electron.WebContents,
    payload: AgentRunPayload,
    reservation?: object
  ) => Promise<boolean>
  /** Materialize an explicit, signed Project reference context after all
   * preflight checks and immediately before provider dispatch. */
  captureReferenceContext?: (payload: AgentRunPayload) => void | Promise<void>
  /** Revalidate the immutable outer dispatch token immediately before any
   * history-owned Project reference bytes/events are materialized. */
  authorizeBeforeReferenceCapture?: (
    payload: AgentRunPayload,
    reservation?: object
  ) => void | Promise<void>
  /** Register context identity without reading it so approvals raised by
   * preflight can be linked after materialization. */
  prepareReferenceContext?: (payload: AgentRunPayload) => void
  /** Freeze main-owned durable chat authority at the outer dispatch boundary,
   * before normalization or any preflight work can await. Facade callers pass
   * their already-reserved token into `dispatch`; direct callers reserve here. */
  reserveDispatch?: (payload: AgentRunPayload) => object
  /**
   * Last main-owned admission gate before an adapter can observe the payload.
   * Execution-graph runs use this to re-check their exact durable lease after
   * normalization, runtime-profile application, preflight, and context capture.
   */
  authorizeBeforeAdapterRun?: (
    payload: AgentRunPayload,
    reservation?: object
  ) => void | Promise<void>
  /** Always release a reservation after preflight/dispatch settles. */
  releaseDispatchReservation?: (reservation: object) => void
  /** Optional main-owned adapter invocation context for provenance fencing. */
  runAdapter?: (
    adapter: ProviderAdapter,
    event: RunDispatchEvent,
    payload: AgentRunPayload
  ) => Promise<void>
  /** Adapter lookup. Throws when the provider isn't registered.
   * Currently `providerAdapters.require`. */
  getAdapter: (provider: ProviderId) => ProviderAdapter
  /** Report a per-run error to the originating sender. Currently
   * `sendAgentCompatError`. */
  sendError: (
    sender: Electron.WebContents,
    provider: ProviderId,
    message: string,
    route: AgentRunRoute,
    reservation?: object
  ) => void
  /** Report a per-run exit (process termination, dispatch abort,
   * etc.) to the sender. Currently `sendAgentCompatExit`. */
  sendExit: (
    sender: Electron.WebContents,
    provider: ProviderId,
    exitCode: number,
    route: AgentRunRoute,
    reservation?: object
  ) => void
}

export interface DispatchResult {
  /** True when the adapter's run() was invoked. False on preflight
   * or runtime-profile failures. */
  dispatched: boolean
  /** The resolved appRunId. Empty string when normalization didn't
   * produce one (edge case — payload didn't carry an appChatId). */
  appRunId: string
  /** The workspace selected by main preflight for a successfully dispatched
   * run. This is authoritative when a runtime profile allocates a per-thread
   * worktree, so renderer-owned diff capture can follow the provider cwd. */
  effectiveWorkspacePath?: string
}

/**
 * Minimum event-shape `dispatch` actually needs. The real
 * `Electron.IpcMainInvokeEvent` is a superset (it carries `frameId`,
 * `processId`, `senderFrame`, etc.) but the dispatch path + every
 * production `ProviderAdapter.run` only ever touch `event.sender`.
 *
 * Widening the public type to this structural interface makes the
 * delegation path (MCP tool `delegate_to_subthread`, F3) honest: it
 * synthesizes a `{ sender }` object and used to need a `as
 * IpcMainInvokeEvent` cast that silently skipped the type check. With
 * this structural contract the cast is gone, the renderer call site
 * is unaffected (an `IpcMainInvokeEvent` trivially satisfies
 * `{ sender }`), and adapters that DO need more fields would fail at
 * the type level the moment they reached for them.
 */
export interface RunDispatchEvent {
  sender: Electron.WebContents
}

export class RunCoordinator {
  constructor(private deps: RunCoordinatorDeps) {}

  /** Dispatch a run on behalf of either the renderer (via the
   * `run-agent` IPC handler) or the bridge action executor (iOS-
   * initiated run) or the agent-driven sub-thread delegation path
   * (MCP `delegate_to_subthread`). Behaviour is identical for all
   * callers — the difference is purely in how the `sender` was
   * constructed.
   *
   * Returns `{ dispatched: false }` on handled preflight /
   * runtime-profile failures; in those cases the sender has already
   * received the corresponding compat-line error / exit. Adapter
   * resolution and adapter runtime failures intentionally propagate so
   * non-IPC callers such as `delegate_to_subthread` can surface the
   * failed child-run dispatch instead of leaving a sub-thread pending. */
  async dispatch(
    payload: AgentRunPayload,
    event: RunDispatchEvent,
    outerDispatchReservation?: object
  ): Promise<DispatchResult> {
    const ownsDispatchReservation = outerDispatchReservation === undefined
    const dispatchReservation =
      outerDispatchReservation ?? this.deps.reserveDispatch?.(payload)
    try {
      const normalizedPayload = this.deps.normalizePayload(payload)
      normalizedPayload.appRunId = this.deps.routeWithRunId(
        normalizedPayload.provider,
        normalizedPayload
      ).appRunId
      try {
        this.deps.applyRuntimeProfileToPayload(normalizedPayload)
      } catch (error) {
        const route = this.deps.routeWithRunId(normalizedPayload.provider, normalizedPayload)
        const message = error instanceof Error ? error.message : String(error)
        this.deps.sendError(
          event.sender,
          normalizedPayload.provider,
          message,
          route,
          dispatchReservation
        )
        this.deps.sendExit(
          event.sender,
          normalizedPayload.provider,
          -1,
          route,
          dispatchReservation
        )
        return { dispatched: false, appRunId: normalizedPayload.appRunId ?? '' }
      }
      const adapter = this.deps.getAdapter(normalizedPayload.provider)
      try {
        this.deps.prepareReferenceContext?.(normalizedPayload)
      } catch (error) {
        const route = this.deps.routeWithRunId(normalizedPayload.provider, normalizedPayload)
        const message = error instanceof Error ? error.message : String(error)
        this.deps.sendError(
          event.sender,
          normalizedPayload.provider,
          message,
          route,
          dispatchReservation
        )
        this.deps.sendExit(
          event.sender,
          normalizedPayload.provider,
          -1,
          route,
          dispatchReservation
        )
        return { dispatched: false, appRunId: normalizedPayload.appRunId ?? '' }
      }
      if (
        !(await this.deps.ensureProviderRunPreflight(
          event.sender,
          normalizedPayload,
          dispatchReservation
        ))
      ) {
        return { dispatched: false, appRunId: normalizedPayload.appRunId ?? '' }
      }
      try {
        await this.deps.authorizeBeforeReferenceCapture?.(
          normalizedPayload,
          dispatchReservation
        )
        await this.deps.captureReferenceContext?.(normalizedPayload)
      } catch (error) {
        const route = this.deps.routeWithRunId(normalizedPayload.provider, normalizedPayload)
        const message = error instanceof Error ? error.message : String(error)
        this.deps.sendError(
          event.sender,
          normalizedPayload.provider,
          message,
          route,
          dispatchReservation
        )
        this.deps.sendExit(
          event.sender,
          normalizedPayload.provider,
          -1,
          route,
          dispatchReservation
        )
        return { dispatched: false, appRunId: normalizedPayload.appRunId ?? '' }
      }
      await this.deps.authorizeBeforeAdapterRun?.(normalizedPayload, dispatchReservation)
      if (this.deps.runAdapter) {
        await this.deps.runAdapter(adapter, event, normalizedPayload)
      } else {
        await adapter.run({ event, payload: normalizedPayload })
      }
      return {
        dispatched: true,
        appRunId: normalizedPayload.appRunId ?? '',
        effectiveWorkspacePath: normalizedPayload.workspace
      }
    } finally {
      if (ownsDispatchReservation && dispatchReservation) {
        this.deps.releaseDispatchReservation?.(dispatchReservation)
      }
    }
  }
}
