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
>

/**
 * Owns the Electron lifecycle seam for the TUI host. Keeping this here leaves
 * main/index.ts as composition wiring while the local-control implementation,
 * shutdown guarantees, and action adaptation remain independently testable.
 */
export async function installTaskWraithLocalControl(
  app: Pick<App, 'getPath' | 'getVersion' | 'once'>,
  executor: TaskWraithLocalControlExecutor
): Promise<LocalControlServer | null> {
  const server = await startTaskWraithLocalControl({
    userDataPath: app.getPath('userData'),
    hostVersion: app.getVersion(),
    executeComposerPrompt: (action) => executor.executeComposerPrompt(action),
    executeCancelRun: (action) => executor.executeCancelRun(action),
    executeEnsembleSteer: (action) => executor.executeEnsembleSteer(action),
    executeEnsembleCancelRound: (action) => executor.executeEnsembleCancelRound(action),
    log: (line) => console.log(line)
  }).catch((error) => {
    console.error('Failed to start TaskWraith local-control sidecar host', error)
    return null
  })

  const stop = () => {
    try {
      server?.stopSync()
    } catch (error) {
      console.error('Failed to stop TaskWraith local-control sidecar host', error)
    }
  }
  app.once('will-quit', stop)
  process.once('exit', stop)
  return server
}
