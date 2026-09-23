import { isAbsolute, parse, resolve } from 'node:path'

import {
  HOST_TERMINATION_SUCCESS_KINDS,
  terminateHostProcess,
  type HostTerminationOutcome
} from '../../host-client/HostProcessTermination'
import { HostShutdownClient } from '../../host-client/HostShutdownClient'
import type { HostLifecycleHostIdentity } from '../../shared/hostLifecycle'
import type { HostHealthProjection } from '../../shared/hostProtocol'
import type { HostLifecycleSupervisor } from './HostLifecycleController'
import type { HostExternalEnsureResult, HostExternalSupervisor } from './HostExternalSupervisor'

export interface HostExternalLifecycleAdapterOptions {
  readonly profilePath: string
  readonly supervisor: HostExternalSupervisor
  readonly preparedResult?: HostExternalEnsureResult
  readonly createShutdownClient?: (profilePath: string) => Pick<HostShutdownClient, 'shutdown'>
  /**
   * Verified termination (D9) when the authenticated stop fails: identity is
   * re-checked before TERM and again before KILL, and an unverifiable Host is
   * never signalled. `cause` is the socket failure, so the socket is not asked
   * twice.
   */
  readonly terminate?: (
    profilePath: string,
    cause: unknown
  ) => Promise<Pick<HostTerminationOutcome, 'kind' | 'pid' | 'detail'>>
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function sameHost(
  left: HostLifecycleHostIdentity | undefined,
  right: HostLifecycleHostIdentity | undefined
): boolean {
  if (!left || !right) return left === right
  return (
    left.pid === right.pid && left.startedAt === right.startedAt && left.hostId === right.hostId
  )
}

async function defaultTerminate(
  profilePath: string,
  cause: unknown
): Promise<HostTerminationOutcome> {
  return terminateHostProcess({
    profilePath,
    ports: {
      shutdown: async () => {
        throw cause instanceof Error ? cause : new Error(String(cause))
      }
    }
  })
}

/**
 * Desktop lifecycle over an independent Node Host.
 *
 * Async stop is an explicit user action (stop, or the stop half of a restart):
 * the Host's authenticated shutdown first, then identity-verified termination
 * when that path fails. stopSync is ordinary app teardown: it sends nothing
 * and signals nothing. Main releases its Host lease just before it (the lease
 * socket is main wiring, not this adapter), so the Host — shared with any
 * TUI — stops on its own one grace later only if nothing else holds it.
 */
export function createHostExternalLifecycleAdapter(
  options: HostExternalLifecycleAdapterOptions
): HostLifecycleSupervisor {
  if (
    !options ||
    !isAbsolute(options.profilePath) ||
    resolve(options.profilePath) !== options.profilePath ||
    options.profilePath === parse(options.profilePath).root ||
    typeof options.supervisor?.ensureAvailable !== 'function'
  ) {
    throw new Error('External Host lifecycle adapter requires canonical options.')
  }
  const createShutdownClient =
    options.createShutdownClient ??
    ((profilePath: string) => new HostShutdownClient({ profilePath }))
  const terminate = options.terminate ?? defaultTerminate
  let preparedResult = options.preparedResult ?? null
  let activeResult: HostExternalEnsureResult | null = null
  let running = false
  let stopped = false
  let startPromise: Promise<void> | null = null
  let stopPromise: Promise<void> | null = null

  const start = (): Promise<void> => {
    if (running) return Promise.resolve()
    if (startPromise) return startPromise
    startPromise = (async () => {
      const result = preparedResult ?? (await options.supervisor.ensureAvailable())
      preparedResult = null
      activeResult = result
      running = true
      stopped = false
    })().finally(() => {
      startPromise = null
    })
    return startPromise
  }

  /** The socket stop, then (D9) verified termination when the socket path fails. */
  const stopHost = async (): Promise<void> => {
    try {
      await createShutdownClient(options.profilePath).shutdown()
      return
    } catch (shutdownError) {
      const outcome = await terminate(options.profilePath, shutdownError)
      if (HOST_TERMINATION_SUCCESS_KINDS.has(outcome.kind)) return
      throw new Error(
        `Host did not stop: ${describe(shutdownError)}; verified termination ended ${
          outcome.kind
        }${outcome.detail ? ` (${outcome.detail})` : ''}.`
      )
    }
  }

  const stop = (): Promise<void> => {
    if (stopPromise) return stopPromise
    stopPromise = (async () => {
      if (!running || !activeResult) {
        running = false
        stopped = true
        activeResult = null
        preparedResult = null
        options.supervisor.close()
        return
      }
      try {
        await stopHost()
        running = false
        stopped = true
        activeResult = null
        options.supervisor.close()
      } catch (error) {
        // Keep the live handle/state so HostLifecycleController can retry the
        // explicit stop without constructing a competing supervisor.
        running = true
        stopped = false
        throw error
      }
    })().finally(() => {
      stopPromise = null
    })
    return stopPromise
  }

  const stopSync = (): void => {
    running = false
    stopped = true
    activeResult = null
    preparedResult = null
    options.supervisor.close()
  }

  /**
   * Main lost its lease: probe again through the same supervisor, which
   * attaches to the Host that is there or relaunches one if it exited (its
   * readiness probe then holds the Host until main's lease is back).
   */
  const ensureLive = async (): Promise<boolean> => {
    if (!running || !activeResult) throw new Error('External Host is not attached.')
    const before = activeResult.host
    const result = await options.supervisor.ensureAvailable()
    if (!running) throw new Error('External Host was detached while it was re-verified.')
    activeResult = result
    return result.kind === 'launched' || !sameHost(before, result.host)
  }

  const healthProvider = (): HostHealthProjection => ({
    hostStatus: running ? 'ok' : 'offline',
    connectionPhase: running ? 'live' : 'connecting',
    // The Host is independent; Desktop owns an attachment, not its process.
    supervised: false,
    freshness: 'live'
  })

  return {
    start,
    stop,
    stopSync,
    ensureLive,
    get isRunning() {
      return running
    },
    get isStopped() {
      return stopped
    },
    get connectedClientCount() {
      return 0
    },
    get hostIdentity() {
      return activeResult?.host ?? null
    },
    healthProvider
  }
}
