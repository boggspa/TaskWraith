/** Long-lived detailed Git snapshot utility-process entry. */
import { GitService } from '../services/GitService'

const parentPort = process.parentPort
const gitService = new GitService()
let tail = Promise.resolve()

parentPort?.on('message', (event) => {
  const message = event?.data as
    | { type?: string; requestId?: number; inputPath?: string }
    | undefined
  if (
    message?.type !== 'snapshot' ||
    !Number.isSafeInteger(message.requestId) ||
    typeof message.inputPath !== 'string' ||
    !message.inputPath
  ) {
    return
  }
  const requestId = message.requestId as number
  const inputPath = message.inputPath
  tail = tail.then(async () => {
    try {
      const result = await gitService.snapshot(inputPath)
      parentPort?.postMessage({ type: 'snapshot-complete', requestId, result })
    } catch (error) {
      parentPort?.postMessage({
        type: 'snapshot-error',
        requestId,
        message: error instanceof Error ? error.message : String(error)
      })
    }
  })
})
