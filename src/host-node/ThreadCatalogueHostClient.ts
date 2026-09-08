import { Worker } from 'node:worker_threads'
import { join } from 'node:path'
import { ThreadCatalogueClient } from '../host-shared/thread-catalogue/ThreadCatalogueClient'

export function createHostThreadCatalogue(
  profilePath: string,
  writerId: string
): ThreadCatalogueClient {
  const createPort = () => new Worker(join(__dirname, 'ThreadCatalogueWorkerEntry.js'))
  return new ThreadCatalogueClient(createPort(), {
    restart: createPort,
    reader: {
      profilePath,
      runtimeInstanceId: writerId,
      segmented: process.env.TASKWRAITH_CHAT_STORE_V2 === '1'
    },
    decoderPath: join(__dirname, 'ThreadCatalogueDecoderEntry.js'),
    owner: { writer: 'host', writerId }
  })
}
