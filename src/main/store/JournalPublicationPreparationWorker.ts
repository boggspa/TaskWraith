import { parentPort, workerData } from 'node:worker_threads'
import { prepareJournalPublication } from './CheckpointPreparationCore'
import type { JournalPublicationRequest } from './CheckpointPreparationProtocol'

try {
  parentPort!.postMessage({
    ok: true,
    artifact: prepareJournalPublication(workerData as JournalPublicationRequest)
  })
} catch (error) {
  parentPort!.postMessage({
    ok: false,
    error: error instanceof Error ? error.message : 'Publication preparation failed'
  })
} finally {
  parentPort!.close()
}
