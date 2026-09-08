import { utilityProcess } from 'electron'
import { join } from 'node:path'
import { ThreadCatalogueClient } from './store/ThreadCatalogueClient'

export function createDesktopThreadCatalogue(
  profilePath: string,
  writerId: string,
  defaultProvider?: string
): ThreadCatalogueClient {
  const createPort = () => {
    const worker = utilityProcess.fork(join(__dirname, 'threadCatalogueWorker.js'), [], {
      serviceName: 'Thread history',
      stdio: 'ignore'
    })
    let exited = false
    let termination: Promise<void> | null = null
    worker.once('exit', () => {
      exited = true
    })
    return {
      postMessage: (message: unknown) => worker.postMessage(message),
      on: (event: 'message' | 'exit' | 'error', listener: (...args: any[]) => void) =>
        (worker as unknown as NodeJS.EventEmitter).on(event, listener),
      terminate: (): Promise<void> => {
        if (exited) return Promise.resolve()
        if (!termination)
          termination = new Promise((resolve) => {
            worker.once('exit', () => resolve())
            worker.kill()
          })
        return termination
      }
    }
  }
  return new ThreadCatalogueClient(createPort(), {
    restart: createPort,
    reader: {
      profilePath,
      runtimeInstanceId: writerId,
      defaultProvider,
      segmented: process.env.TASKWRAITH_CHAT_STORE_V2 === '1'
    },
    decoderPath: join(__dirname, 'threadCatalogueDecoder.js'),
    owner: { writer: 'desktop', writerId }
  })
}
