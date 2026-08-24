/**
 * Host Arc Wave 3.5 — HostSupervisor (in-main lifecycle owner).
 *
 * WHAT THIS IS. The HostSupervisor is the single lifecycle owner for the
 * composed in-main Host. It builds the composition, establishes the central
 * projection reconciler, and only then opens the local server on start(). It
 * tears all three down on stop() and exposes an honest supervised-health
 * provider that the composition's own health passthrough routes to clients.
 *
 * WHY IT LOOKS LIKE THIS. Per the placement ruling the Host lives IN-MAIN
 * this wave: the supervisor is injected a composition factory and a server
 * factory, never the AppStore or provider singletons directly. That seam
 * keeps every port testable and survives a future dedicated-Host migration
 * where only the factory closures become RPC-backed stubs.
 *
 * BOUNDARIES (enforced by the import-isolation test alongside this file):
 * - zero `electron` imports;
 * - zero AppStore / BridgeActionExecutor / provider / resolver / pipeline
 *   VALUE imports;
 * - zero composition-root edits.
 */

import type { HostMainComposition, HostMainCompositionInput } from './HostMainComposition'
import type { HostLocalServer, HostLocalServerOptions } from './HostLocalServer'
import type { HostAuthority } from './HostAuthority'
import type { AppStoreHostAuthorityHealthProvider } from './AppStoreHostAuthority'
import type { HostHealthProjection } from '../shared/hostProtocol'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Backoff policy for crash-restart attempts. */
export interface HostSupervisorBackoff {
  /** First retry delay in ms. */
  readonly baseMs: number
  /** Hard ceiling in ms. */
  readonly maxMs: number
}

/** Conservative defaults: 2 s base, 60 s ceiling. */
export const DEFAULT_BACKOFF: HostSupervisorBackoff = {
  baseMs: 2_000,
  maxMs: 60_000
}

/** Everything the supervisor needs, all injected. */
export interface HostSupervisorInput {
  /**
   * Composition factory — receives HostMainCompositionInput and returns the
   * composed Host. In production the closure is createHostMainComposition.
   */
  readonly createComposition: (input: HostMainCompositionInput) => HostMainComposition
  /**
   * Server factory — receives HostLocalServerOptions and returns a fresh
   * HostLocalServer. The supervisor owns the listener lifecycle.
   */
  readonly createServer: (options: HostLocalServerOptions) => HostLocalServer
  /** Forwarded directly to the composition factory. */
  readonly compositionInput: HostMainCompositionInput
  /** Injectable clock in ms; defaults to Date.now(). */
  readonly now?: () => number
  /** Backoff policy for crash-restart; defaults to DEFAULT_BACKOFF. */
  readonly backoff?: HostSupervisorBackoff
  /** Optional diagnostic logger. */
  readonly log?: (line: string) => void
  /**
   * When true a crash (unexpected throw inside start/restart) triggers a
   * bounded backoff retry.  DEFAULT FALSE per goal: no undeclared background
   * service, and explicit user stop is the only persistent state-change.
   */
  readonly allowCrashRestart?: boolean
}

/** Public surface the composition root (Wave 3.6) wires. */
export interface HostSupervisor {
  /** Build composition, establish convergence, then listen. Idempotent when running. */
  start(): Promise<void>
  /** Graceful async stop.  Persistent — only an explicit start() revives. */
  stop(): Promise<void>
  /** Synchronous stop safe for will-quit / exit hooks.  Idempotent. */
  stopSync(): void
  /** True between start() and stop()/stopSync(), or after a crash-restart succeeds. */
  readonly isRunning: boolean
  /**
   * True after an explicit stop() — persistent marker that prevents silent
   * auto-respawn.  Only cleared by an explicit start().
   */
  readonly isStopped: boolean
  /** Current local-socket occupancy, or zero before start / after teardown. */
  readonly connectedClientCount?: number
  /**
   * Honest supervised-health provider — conforms to
   * AppStoreHostAuthorityHealthProvider so it can be injected directly into
   * the composition.  supervised = true only while actively managing a
   * running host; false after stop / terminal failure.
   */
  readonly healthProvider: AppStoreHostAuthorityHealthProvider
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

/**
 * Create the in-main Host lifecycle supervisor.
 *
 * Construction is pure — no side effects, no server, no composition created.
 * Call `start()` to bring the Host online.
 */
export function createHostSupervisor(input: HostSupervisorInput): HostSupervisor {
  if (!input || typeof input !== 'object') {
    throw new Error('HostSupervisor requires an options object')
  }
  if (typeof input.createComposition !== 'function') {
    throw new Error('HostSupervisor requires an injected createComposition')
  }
  if (typeof input.createServer !== 'function') {
    throw new Error('HostSupervisor requires an injected createServer')
  }
  if (!input.compositionInput || typeof input.compositionInput !== 'object') {
    throw new Error('HostSupervisor requires an injected compositionInput')
  }

  const now = input.now ?? (() => Date.now())
  const backoff = input.backoff ?? DEFAULT_BACKOFF
  const log = input.log
  const allowCrashRestart = input.allowCrashRestart === true

  let composition: HostMainComposition | null = null
  let server: HostLocalServer | null = null
  let running = false
  let stopped = false

  // -------------------------------------------------------------------
  // Health provider
  // -------------------------------------------------------------------

  const healthProvider: AppStoreHostAuthorityHealthProvider = (): HostHealthProjection => ({
    hostStatus: running ? 'ok' : 'offline',
    connectionPhase: running ? 'live' : 'connecting',
    supervised: running,
    freshness: 'live'
  })

  // -------------------------------------------------------------------
  // Internal helpers
  // -------------------------------------------------------------------

  const buildAndStart = async (): Promise<void> => {
    // Build the composition first — fail-closed if the composition factory
    // throws (stores corrupted, data-dir unwritable, etc.).
    // Await: the factory may be async in tests; in production it is
    // synchronous, but awaiting a sync value is a no-op.
    const builtComposition = await input.createComposition(input.compositionInput)
    composition = builtComposition
    const { hostId, hostVersion } = input.compositionInput.host

    server = input.createServer({
      userDataPath: input.compositionInput.userDataPath,
      hostId,
      hostVersion,
      session: builtComposition.session,
      authority: new Proxy(
        builtComposition.authority as HostAuthority & Record<string | symbol, unknown>,
        {
          get(target, prop, receiver) {
            if (prop === 'exportTwMission')
              return builtComposition.exportTwMission.bind(builtComposition)
            return Reflect.get(target, prop, receiver)
          }
        }
      ) as unknown as HostAuthority & { exportTwMission: typeof builtComposition.exportTwMission },
      subscribeDeltas: (listener) =>
        builtComposition.subscribeDeltas((event) => listener(event.record.envelope)),
      log: log ? (line: string) => log(`[host-supervisor] ${line}`) : undefined,
      now
    })

    // Establish a coherent Host projection before any client can connect.
    // This turns legacy/AppStore-side mutations into the same ordered journal
    // used by governed Host commands, without exposing another cursor.
    await builtComposition.startProjectionReconciliation()
    await server.start()
    log?.('[host-supervisor] Host started')
  }

  const teardown = async (): Promise<void> => {
    const s = server
    server = null
    if (s) {
      try {
        await s.stop()
      } catch (err) {
        log?.(`[host-supervisor] server stop error: ${String(err)}`)
      }
    }

    const c = composition
    composition = null
    if (c) {
      try {
        await c.shutdown()
      } catch (err) {
        log?.(`[host-supervisor] composition shutdown error: ${String(err)}`)
      }
    }
  }

  const crashLoop = async (firstAttempt: () => Promise<void>): Promise<void> => {
    let attempt = 0
    let delay = backoff.baseMs

    while (true) {
      try {
        await firstAttempt()
        return // success
      } catch (err) {
        // Clean up any partial composition, reconciliation timer or listener
        // before deciding whether a fresh attempt is allowed.
        running = false
        await teardown()

        if (!allowCrashRestart || stopped) {
          log?.('[host-supervisor] crash-restart disabled — not retrying')
          throw err
        }

        attempt += 1
        log?.(
          `[host-supervisor] start attempt ${attempt} failed: ${String(err)} — retrying in ${delay}ms`
        )

        await new Promise<void>((resolve) => setTimeout(resolve, delay))
        delay = Math.min(delay * 2, backoff.maxMs)
      }
    }
  }

  // -------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------

  const start = async (): Promise<void> => {
    if (running) return

    // An explicit start() clears the persistent stopped flag.
    stopped = false

    await crashLoop(async () => {
      await buildAndStart()
      running = true
      log?.('[host-supervisor] Host running')
    })
  }

  const stop = async (): Promise<void> => {
    // Set the persistent flag FIRST — a crash-loop between attempts has
    // running=false + null server/composition, but must still bail out.
    stopped = true
    if (!running && !server && !composition) return
    running = false
    await teardown()
    log?.('[host-supervisor] Host stopped (persistent)')
  }

  const stopSync = (): void => {
    // Set the persistent flag FIRST — same bail-out guarantee as stop().
    stopped = true
    if (!running && !server && !composition) return
    running = false

    // Synchronous server teardown exactly per the v1 will-quit pattern.
    if (server) {
      try {
        server.stopSync()
      } catch (err) {
        log?.(`[host-supervisor] server stopSync error: ${String(err)}`)
      }
      server = null
    }

    // Fire-and-forget the async composition shutdown — cannot await inside
    // a will-quit handler, and the process is exiting anyway.
    if (composition) {
      const c = composition
      composition = null
      c.shutdown().catch((err) => {
        log?.(`[host-supervisor] composition shutdown error: ${String(err)}`)
      })
    }

    log?.('[host-supervisor] Host stopped synchronously')
  }

  return {
    start,
    stop,
    stopSync,
    get isRunning(): boolean {
      return running
    },
    get isStopped(): boolean {
      return stopped
    },
    get connectedClientCount(): number {
      return server?.clientCount() ?? 0
    },
    healthProvider
  }
}
