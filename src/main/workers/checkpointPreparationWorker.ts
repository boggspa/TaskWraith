import { prepareCheckpoint } from '../store/CheckpointPreparationCore'
import type {
  CheckpointPreparationRequest,
  CheckpointPreparationReply
} from '../store/CheckpointPreparationProtocol'

function run(request: CheckpointPreparationRequest): CheckpointPreparationReply {
  try {
    return { ok: true, prepared: prepareCheckpoint(request) }
  } catch (error) {
    return {
      ok: false,
      error: (error instanceof Error ? error.message : String(error)).slice(0, 512)
    }
  }
}

// Each child owns one admitted job. Main retires it after the reply; a fatal
// allocation or parser failure cannot abort Electron's main process.
if (process.parentPort) {
  process.parentPort.once('message', (event) => process.parentPort?.postMessage(run(event.data)))
} else {
  process.once('message', (request) => process.send?.(run(request as CheckpointPreparationRequest)))
}
