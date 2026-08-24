import { isAbsolute, parse, resolve } from 'node:path'

import { HostShutdownClient } from '../../host-client/HostShutdownClient'
import type { HostHealthProjection } from '../../shared/hostProtocol'
import type { HostSupervisor } from '../../host-runtime/HostSupervisor'
import type { HostExternalEnsureResult, HostExternalSupervisor } from './HostExternalSupervisor'

export interface HostExternalLifecycleAdapterOptions {
  readonly profilePath: string
  readonly supervisor: HostExternalSupervisor
  readonly preparedResult?: HostExternalEnsureResult
  readonly createShutdownClient?: (profilePath: string) => Pick<HostShutdownClient, 'shutdown'>
}

/**
 * Existing Desktop lifecycle compatibility over an independent Node Host.
 * Async stop is an explicit user lifecycle action; stopSync is ordinary app
 * teardown and therefore detaches without stopping a Host shared with TUI.
 */
export function createHostExternalLifecycleAdapter(
  options: HostExternalLifecycleAdapterOptions
): HostSupervisor {
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
        await createShutdownClient(options.profilePath).shutdown()
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
    get isRunning() {
      return running
    },
    get isStopped() {
      return stopped
    },
    get connectedClientCount() {
      return 0
    },
    healthProvider
  }
}
