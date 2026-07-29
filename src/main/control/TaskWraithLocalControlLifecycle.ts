import type { App } from 'electron'
import type { BridgeActionExecutor } from '../BridgeActionExecutor'
import type { LocalControlServer } from './LocalControlServer'
import { startTaskWraithLocalControl } from './TaskWraithControlFacade'

type TaskWraithLocalControlExecutor = Pick<
  BridgeActionExecutor,
  | 'executeComposerPrompt'
  | 'executeCancelRun'
  | 'executeEnsembleSteer'
  | 'executeEnsembleCancelRound'
  | 'executeEnsembleRosterUpdate'
>
type TaskWraithLocalControlExecutorFactory = () => TaskWraithLocalControlExecutor
type TaskWraithLocalControlApp = Pick<App, 'getPath' | 'getVersion' | 'once' | 'removeListener'>

/**
 * Owns the Electron lifecycle seam for the TUI host. Keeping this here leaves
 * main/index.ts as composition wiring while the local-control implementation,
 * shutdown guarantees, and action adaptation remain independently testable.
 *
 * The first BrowserWindow is also the startup-readiness boundary. Starting
 * before it exists publishes control discovery while Electron's large
 * `whenReady` bootstrap still owns the main event loop. A client can connect to
 * that socket but the host cannot consume even its first frame until bootstrap
 * finishes. Install the listeners synchronously, then start in a microtask
 * after `browser-window-created` so discovery describes a serviceable host.
 */
export function installTaskWraithLocalControl(
  app: TaskWraithLocalControlApp,
  executor: TaskWraithLocalControlExecutorFactory
): Promise<void> {
  let server: LocalControlServer | null = null
  let startPromise: Promise<LocalControlServer | null> | null = null
  let stopped = false

  const stopServer = (candidate: LocalControlServer) => {
    try {
      candidate.stopSync()
    } catch (error) {
      console.error('Failed to stop TaskWraith local-control sidecar host', error)
    }
  }

  const start = () => {
    if (stopped || startPromise) return
    startPromise = Promise.resolve()
      .then(() => {
        if (stopped) return null
        return startTaskWraithLocalControl({
          userDataPath: app.getPath('userData'),
          hostVersion: app.getVersion(),
          executeComposerPrompt: (action) => executor().executeComposerPrompt(action),
          executeCancelRun: (action) => executor().executeCancelRun(action),
          executeEnsembleSteer: (action) => executor().executeEnsembleSteer(action),
          executeEnsembleCancelRound: (action) => executor().executeEnsembleCancelRound(action),
          executeEnsembleRosterUpdate: (action) => executor().executeEnsembleRosterUpdate(action),
          log: (line) => console.log(line)
        })
      })
      .catch((error) => {
        console.error('Failed to start TaskWraith local-control sidecar host', error)
        return null
      })
      .then((startedServer) => {
        if (!startedServer) return null
        if (stopped) {
          stopServer(startedServer)
          return null
        }
        server = startedServer
        return startedServer
      })
  }

  const stop = () => {
    if (stopped) return
    stopped = true
    app.removeListener('browser-window-created', start)
    process.removeListener('exit', stop)
    const startedServer = server
    server = null
    if (startedServer) stopServer(startedServer)
    if (startPromise) {
      void startPromise.then((pendingServer) => {
        if (pendingServer && pendingServer !== startedServer) stopServer(pendingServer)
      })
    }
  }

  app.once('browser-window-created', start)
  app.once('will-quit', stop)
  process.once('exit', stop)
  return Promise.resolve()
}
