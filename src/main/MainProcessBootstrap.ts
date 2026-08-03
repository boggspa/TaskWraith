export type SecondInstanceEventArguments = [
  event: unknown,
  argv: string[],
  workingDirectory: string,
  additionalData: unknown
]

export type MainProcessBootstrapOutcome = 'helper' | 'primary' | 'secondary'

export interface MainProcessBootstrapDependencies {
  isHelperProcess: boolean
  requestSingleInstanceLock: () => boolean
  quit: () => void
  loadMainProcess: () => Promise<unknown>
  subscribeSecondInstance: (listener: (...args: SecondInstanceEventArguments) => void) => () => void
  replaySecondInstance: (args: SecondInstanceEventArguments) => void
  log: (message: string) => void
}

/**
 * Acquire the normal app's singleton before evaluating the full main-process
 * graph. Several main modules import Node TLS, whose certificate preloader can
 * still be running when a duplicate Electron process takes the fast quit path.
 * Keeping that graph behind the lock means a losing process never starts the
 * native certificate worker in the first place.
 *
 * Helper processes deliberately bypass the singleton exactly as they did in
 * the old index.ts gate. A winning normal process temporarily buffers an early
 * `second-instance` notification while the main graph installs its canonical
 * focus/recreate handler, then replays it after the import completes.
 */
export async function bootstrapMainProcess(
  deps: MainProcessBootstrapDependencies
): Promise<MainProcessBootstrapOutcome> {
  if (deps.isHelperProcess) {
    await deps.loadMainProcess()
    return 'helper'
  }

  if (!deps.requestSingleInstanceLock()) {
    deps.log('[remote-bridge] another TaskWraith instance holds the lock — exiting')
    deps.quit()
    return 'secondary'
  }

  const pendingSecondInstances: SecondInstanceEventArguments[] = []
  const unsubscribe = deps.subscribeSecondInstance((...args) => {
    pendingSecondInstances.push(args)
  })

  try {
    await deps.loadMainProcess()
  } finally {
    unsubscribe()
  }

  for (const args of pendingSecondInstances) {
    deps.replaySecondInstance(args)
  }
  return 'primary'
}
