import { parentPort } from 'node:worker_threads'

import { publishHostThreadRecordTransfer } from './HostThreadRecordTransfer'
import {
  readHostThreadRecordTransfer,
  type HostThreadRecordTransferWorkerReply,
  type HostThreadRecordTransferWorkerRequest
} from './HostThreadRecordTransferWorker'

if (!parentPort) throw new Error('Thread-record transfer entry requires a worker parent')
const port = parentPort

// Deliberately synchronous: jobs run in arrival order, and a success reply is
// sent only after the shared publisher has fsynced the file AND its directory.
port.on('message', (request: HostThreadRecordTransferWorkerRequest) => {
  let reply: HostThreadRecordTransferWorkerReply
  try {
    const value =
      request.kind === 'publish'
        ? publishHostThreadRecordTransfer(request.input)
        : readHostThreadRecordTransfer(request.input)
    reply = { id: request.id, ok: true, value }
  } catch (error) {
    reply = {
      id: request.id,
      ok: false,
      error: {
        name: error instanceof Error ? error.name : 'Error',
        message: error instanceof Error ? error.message : 'Thread-record transfer failed.'
      }
    }
  }
  port.postMessage(reply)
})
