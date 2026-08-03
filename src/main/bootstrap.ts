// MUST stay first — configures the unpackaged/private userData path before the
// singleton lock is acquired or any other Electron module can resolve it.
import './devAppName'

import { app } from 'electron'
import type { Event } from 'electron'
import { isTaskWraithHelperProcess } from './HelperProcessPresentation'
import { bootstrapMainProcess, type SecondInstanceEventArguments } from './MainProcessBootstrap'

function subscribeSecondInstance(
  listener: (...args: SecondInstanceEventArguments) => void
): () => void {
  const handler = (
    event: Event,
    argv: string[],
    workingDirectory: string,
    additionalData: unknown
  ) => listener(event, argv, workingDirectory, additionalData)
  app.on('second-instance', handler)
  return () => app.removeListener('second-instance', handler)
}

void bootstrapMainProcess({
  isHelperProcess: isTaskWraithHelperProcess(process.argv, process.env),
  requestSingleInstanceLock: () => app.requestSingleInstanceLock(),
  quit: () => app.quit(),
  // index.ts retains its existing guard during this extraction. Electron's
  // requestSingleInstanceLock is idempotent for the process that owns it.
  loadMainProcess: () => import('./index'),
  subscribeSecondInstance,
  replaySecondInstance: ([event, argv, workingDirectory, additionalData]) => {
    app.emit('second-instance', event as Event, argv, workingDirectory, additionalData)
  },
  log: (message) => console.log(message)
}).catch((error) => {
  console.error('[main-bootstrap] failed to load the main process', error)
  app.exit(1)
})
