import { parentPort } from 'node:worker_threads'

import {
  bindHostThreadRecordTransferPort,
  unwrapUtilityProcessMessage,
  utilityProcessParentPort,
  type HostThreadRecordTransferWorkerRequest
} from './HostThreadRecordTransferWorker'

// The same compiled entry serves both transports: a `worker_threads` parent
// (the standalone Host) delivers requests bare; an Electron utility process
// (Desktop main) delivers them as `{ data }` on `process.parentPort`.
if (parentPort) {
  bindHostThreadRecordTransferPort(
    parentPort,
    (message) => message as HostThreadRecordTransferWorkerRequest
  )
} else {
  const port = utilityProcessParentPort()
  if (!port) throw new Error('Thread-record transfer entry requires a worker parent')
  bindHostThreadRecordTransferPort(port, unwrapUtilityProcessMessage)
}
