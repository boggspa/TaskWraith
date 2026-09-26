/**
 * Private transfer workers for the public window seed (Independent Threads
 * M4, slice 13f1).
 *
 * The seed models every committed chat file once, at boot. The shared
 * transfer worker is one FIFO thread that live persists prepare and verify
 * through, so a seed queued there would stall them for its whole length.
 * The pool runs the same `model` request on its own workers instead, and is
 * closed at the switch.
 */
import { existsSync } from 'node:fs'

import {
  HostThreadRecordTransferWorker,
  hostThreadRecordTransferChannelFactory,
  hostThreadRecordTransferWorkerEntryPath,
  type HostThreadRecordTransferChannelFactory
} from './HostThreadRecordTransferWorker'
import type { HostThreadRecordFileModel, HostThreadRecordModelInput } from './HostThreadRecordModel'

/** Two workers: a seed's cost is the parse heap of the largest files, per worker. */
export const HOST_THREAD_RECORD_MODEL_POOL_SIZE = 2

export interface HostThreadRecordModelPool {
  readonly size: number
  model(input: HostThreadRecordModelInput): Promise<HostThreadRecordFileModel>
  close(): Promise<void>
}

export interface HostThreadRecordModelPoolOptions {
  readonly size?: number
  readonly entryPath?: string
  readonly channel?: HostThreadRecordTransferChannelFactory
}

/** The pool, or undefined when the compiled worker entry is absent. */
export function createHostThreadRecordModelPool(
  options: HostThreadRecordModelPoolOptions = {}
): HostThreadRecordModelPool | undefined {
  const entryPath = options.entryPath ?? hostThreadRecordTransferWorkerEntryPath()
  if (!existsSync(entryPath)) return undefined
  const size = Math.max(1, Math.floor(options.size ?? HOST_THREAD_RECORD_MODEL_POOL_SIZE))
  const channel = options.channel ?? hostThreadRecordTransferChannelFactory()
  const workers = Array.from(
    { length: size },
    () => new HostThreadRecordTransferWorker(entryPath, channel)
  )
  const pending = workers.map(() => 0)
  let closed: Promise<void> | null = null
  return {
    size,
    model: (input) => {
      if (closed) return Promise.reject(new Error('The thread-record model pool is closed.'))
      let chosen = 0
      for (let index = 1; index < workers.length; index += 1) {
        if (pending[index]! < pending[chosen]!) chosen = index
      }
      pending[chosen]! += 1
      return workers[chosen]!.model(input).finally(() => {
        pending[chosen]! -= 1
      })
    },
    close: () => {
      closed ??= Promise.all(workers.map((worker) => worker.close())).then(() => undefined)
      return closed
    }
  }
}
