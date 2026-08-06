/**
 * utilityProcess entry for item 6: performs `saveChat`'s durable write so the
 * blocking fsync happens off the Electron main thread.
 *
 * Long-lived, unlike the repo's other worker entries. `externalActivityWorker`
 * and friends are forked per scan and exit on completion; that lifecycle is
 * right for a multi-second walk and wrong here, because a fork per chat save
 * would cost far more than the fsync it is avoiding. This process is spawned
 * once and drains jobs until the host kills it.
 *
 * ORDERING IS BY CONSTRUCTION. `writeSerializedDurably` is synchronous, so each
 * message is handled to completion before the next one is delivered — there is
 * no interleaving window and no hand-rolled queue that could reorder. Combined
 * with the host posting exactly one in-flight job at a time, writes land in the
 * order `enqueueWrite` was called. Do not make this handler `async`: an `await`
 * anywhere below reintroduces the interleaving this design exists to prevent.
 *
 * The write itself is imported rather than reimplemented so the worker and the
 * main-process fallback cannot drift — `chats/<id>.json` must stay
 * byte-identical whichever process wrote it.
 */
import {
  writeSerializedDurably,
  type PersistenceWriteJobMessage,
  type PersistenceWriteWorkerMessage
} from '../store/PersistenceWriteWorker'

const parentPort = process.parentPort

function isWriteJob(value: unknown): value is PersistenceWriteJobMessage {
  if (!value || typeof value !== 'object') return false
  const message = value as Partial<PersistenceWriteJobMessage>
  return (
    message.type === 'write' &&
    typeof message.jobId === 'number' &&
    typeof message.filePath === 'string' &&
    typeof message.serialized === 'string'
  )
}

parentPort?.on('message', (event) => {
  const message = (event as { data?: unknown } | undefined)?.data
  if (!isWriteJob(message)) return

  let reply: PersistenceWriteWorkerMessage
  try {
    reply = {
      type: 'ack',
      jobId: message.jobId,
      timings: writeSerializedDurably(message.filePath, message.serialized)
    }
  } catch (error) {
    // Report and let the host fall back. The host rewrites this job
    // synchronously, so a failure here costs latency, never the record.
    reply = {
      type: 'error',
      jobId: message.jobId,
      message: error instanceof Error ? error.message : String(error)
    }
  }
  parentPort.postMessage(reply)
})
