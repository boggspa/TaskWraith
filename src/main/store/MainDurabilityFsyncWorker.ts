import fs from 'node:fs'
import { parentPort } from 'node:worker_threads'

/** Portable Node 22 worker entry. Bundle as a standalone CJS file with node
 * builtins external. The integration must pass that emitted path explicitly.
 * Main owns descriptors; this worker never opens, writes or closes them.
 */
parentPort!.on(
  'message',
  (request: {
    fd: number
    dev: string
    ino: string
    generation: number
    shared: SharedArrayBuffer
  }) => {
    const words = new Int32Array(request.shared, 0, 4)
    if (
      Atomics.load(words, 1) !== request.generation ||
      Atomics.compareExchange(words, 0, 1, 2) !== 1
    ) {
      return
    }
    try {
      const identity = fs.fstatSync(request.fd, { bigint: true })
      if (String(identity.dev) !== request.dev || String(identity.ino) !== request.ino) {
        throw new Error('Fsync descriptor identity changed')
      }
      fs.fsyncSync(request.fd)
      Atomics.store(words, 0, 3)
    } catch (error) {
      const message = Buffer.from(error instanceof Error ? error.message : String(error))
      const bytes = new Uint8Array(request.shared, 16)
      const length = Math.min(message.length, bytes.length)
      bytes.set(message.subarray(0, length))
      Atomics.store(words, 2, length)
      Atomics.store(words, 0, 4)
    }
    Atomics.notify(words, 0)
    parentPort!.postMessage(request.generation)
  }
)
