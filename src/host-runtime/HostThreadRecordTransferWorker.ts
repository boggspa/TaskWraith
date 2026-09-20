/**
 * One reusable Node worker per process for checkpoint artifact I/O. The worker
 * uses the same serializer, digest and fsync implementation as the sync path.
 * It never writes canonical chats: validation, CAS and adoption stay on Host.
 *
 * postMessage captures each JSON record immediately, including while the worker
 * starts. No live record reference is retained in a deferred publication queue.
 * Structured cloning still costs time on the caller; stringify/hash/fsync and
 * read/hash/parse run on the worker. Replies omit the redundant verified Buffer.
 */
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { types } from 'node:util'
import { Worker } from 'node:worker_threads'

import {
  decodeHostThreadRecordTransferBody,
  HostThreadRecordTransferError,
  HostThreadRecordTransferIntegrityError,
  HostThreadRecordTransferMissingError,
  publishHostThreadRecordTransfer,
  removeHostThreadRecordTransfer,
  verifyHostThreadRecordTransfer,
  type HostThreadRecordTransferConsumeOptions,
  type HostThreadRecordTransferDescriptor,
  type HostThreadRecordTransferIdentity,
  type HostThreadRecordTransferPublishOptions
} from './HostThreadRecordTransfer'

type PublishInput = Pick<
  HostThreadRecordTransferPublishOptions,
  'profilePath' | 'transferId' | 'record'
>
type ReadInput = Pick<HostThreadRecordTransferConsumeOptions, 'profilePath' | 'descriptor'>

export interface DecodedHostThreadRecordTransfer {
  readonly record: Record<string, unknown>
  readonly path: string
  readonly descriptor: HostThreadRecordTransferDescriptor
  readonly identity: HostThreadRecordTransferIdentity
}

export type HostThreadRecordTransferWorkerRequest = { readonly id: number } & (
  | { readonly kind: 'publish'; readonly input: PublishInput }
  | { readonly kind: 'read'; readonly input: ReadInput }
)

export type HostThreadRecordTransferWorkerReply =
  | {
      readonly id: number
      readonly ok: true
      readonly value: HostThreadRecordTransferDescriptor | DecodedHostThreadRecordTransfer
    }
  | {
      readonly id: number
      readonly ok: false
      readonly error: { readonly name: string; readonly message: string }
    }

/** Also used in source-only consumers where no compiled worker entry exists. */
export function readHostThreadRecordTransfer(input: ReadInput): DecodedHostThreadRecordTransfer {
  const verified = verifyHostThreadRecordTransfer(input)
  try {
    return {
      record: decodeHostThreadRecordTransferBody(verified.body),
      path: verified.path,
      descriptor: verified.descriptor,
      identity: verified.identity
    }
  } catch (error) {
    try {
      removeHostThreadRecordTransfer({
        profilePath: input.profilePath,
        transferId: input.descriptor.transferId,
        expectedIdentity: verified.identity
      })
    } catch {
      // Decoding is the reportable failure. Never delete a substituted inode.
    }
    throw error
  }
}

function decodeError(error: { name: string; message: string }): HostThreadRecordTransferError {
  if (error.name === 'HostThreadRecordTransferIntegrityError') {
    return new HostThreadRecordTransferIntegrityError(error.message)
  }
  if (error.name === 'HostThreadRecordTransferMissingError') {
    return new HostThreadRecordTransferMissingError(error.message)
  }
  return new HostThreadRecordTransferError(error.message)
}

const defaultEntryPath = join(__dirname, 'HostThreadRecordTransferWorkerEntry.js')
// Each pending publication owns an eagerly cloned record. Bound that memory;
// saturation retains the existing synchronous path rather than delaying capture.
const MAX_PENDING_JOBS = 4

/** Structured cloning must not change what the canonical JSON serializer sees. */
function canCloneRecord(record: unknown): boolean {
  const pending = [record]
  const seen = new Set<object>()
  while (pending.length > 0) {
    const value = pending.pop()
    if (value === null || value === undefined) continue
    if (typeof value !== 'object') {
      if (!['string', 'number', 'boolean'].includes(typeof value)) return false
      continue
    }
    if (seen.has(value)) continue
    seen.add(value)
    // Buffers become Uint8Arrays, custom prototypes lose toJSON, and getters
    // would run during cloning. Preserve the original serializer for these.
    if (types.isProxy(value)) return false
    const prototype = Object.getPrototypeOf(value)
    const array = Array.isArray(value)
    if (prototype !== (array ? Array.prototype : Object.prototype) && prototype !== null) {
      return false
    }
    if ('toJSON' in value) return false
    for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(value))) {
      if (array && key === 'length') continue
      if (!('value' in descriptor) || !descriptor.enumerable) return false
      pending.push(descriptor.value)
    }
  }
  return true
}

export class HostThreadRecordTransferWorker {
  private worker: Worker | undefined
  private nextId = 0
  private closed = false
  private readonly pending = new Map<
    number,
    { resolve(value: unknown): void; reject(error: Error): void }
  >()
  private readonly idle = new Set<() => void>()

  constructor(private readonly entryPath = defaultEntryPath) {}

  publish(input: PublishInput): Promise<HostThreadRecordTransferDescriptor> {
    if (!this.closed && (this.pending.size >= MAX_PENDING_JOBS || !canCloneRecord(input.record))) {
      // Capture exotic JSON values immediately too, with the same behavior as
      // the existing sync publisher instead of changing their serialized bytes.
      try {
        return Promise.resolve(publishHostThreadRecordTransfer(input))
      } catch (error) {
        return Promise.reject(error)
      }
    }
    return this.request({ kind: 'publish', input })
  }

  read(input: ReadInput): Promise<DecodedHostThreadRecordTransfer> {
    if (!this.closed && this.pending.size >= MAX_PENDING_JOBS) {
      try {
        return Promise.resolve(readHostThreadRecordTransfer(input))
      } catch (error) {
        return Promise.reject(error)
      }
    }
    return this.request({ kind: 'read', input })
  }

  /** Stop accepting jobs, finish every acknowledged durability barrier, then exit. */
  async close(): Promise<void> {
    this.closed = true
    if (this.pending.size > 0) await new Promise<void>((resolve) => this.idle.add(resolve))
    const worker = this.worker
    if (worker) await worker.terminate()
  }

  private settleIdle(): void {
    if (this.pending.size > 0) return
    this.worker?.unref()
    for (const resolve of this.idle) resolve()
    this.idle.clear()
  }

  private getWorker(): Worker {
    if (this.worker) return this.worker
    const worker = new Worker(this.entryPath)
    let failure: Error | undefined
    this.worker = worker
    worker.on('message', (reply: HostThreadRecordTransferWorkerReply) => {
      const pending = this.pending.get(reply.id)
      if (!pending) return
      this.pending.delete(reply.id)
      if (reply.ok) pending.resolve(reply.value)
      else pending.reject(decodeError(reply.error))
      this.settleIdle()
    })
    worker.on('error', (error: Error) => {
      failure = error
      // Reject only on exit: callers may remove failed artifacts, so the old
      // worker must have stopped writing before they can observe the failure.
    })
    worker.on('exit', (code) => {
      if (this.worker !== worker) return
      this.worker = undefined
      const error = new HostThreadRecordTransferError(
        'Thread-record transfer worker exited before completing its jobs.',
        {
          cause: failure ?? new Error(`Worker exit code ${code}`)
        }
      )
      for (const pending of this.pending.values()) pending.reject(error)
      this.pending.clear()
      this.settleIdle()
    })
    return worker
  }

  private request<T>(
    request:
      | Omit<Extract<HostThreadRecordTransferWorkerRequest, { kind: 'publish' }>, 'id'>
      | Omit<Extract<HostThreadRecordTransferWorkerRequest, { kind: 'read' }>, 'id'>
  ): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      if (this.closed) {
        reject(new HostThreadRecordTransferError('Thread-record transfer worker is closed.'))
        return
      }
      const id = ++this.nextId
      try {
        const worker = this.getWorker()
        this.pending.set(id, { resolve: (value) => resolve(value as T), reject })
        worker.ref()
        worker.postMessage({ ...request, id } satisfies HostThreadRecordTransferWorkerRequest)
      } catch (cause) {
        this.pending.delete(id)
        this.settleIdle()
        reject(
          new HostThreadRecordTransferError('Thread-record transfer job could not be dispatched.', {
            cause
          })
        )
      }
    })
  }
}

let sharedWorker: HostThreadRecordTransferWorker | undefined

function compiledWorker(): HostThreadRecordTransferWorker | undefined {
  // Standalone source tools/tests retain the exact synchronous implementation.
  // Both production builds emit this sibling entry; worker integration tests
  // exercise the compiled entry explicitly, rather than this compatibility path.
  if (!existsSync(defaultEntryPath)) return undefined
  return (sharedWorker ??= new HostThreadRecordTransferWorker())
}

export function publishHostThreadRecordTransferOffLoop(
  input: PublishInput
): HostThreadRecordTransferDescriptor | Promise<HostThreadRecordTransferDescriptor> {
  return compiledWorker()?.publish(input) ?? publishHostThreadRecordTransfer(input)
}

export function readHostThreadRecordTransferOffLoop(
  input: ReadInput
): DecodedHostThreadRecordTransfer | Promise<DecodedHostThreadRecordTransfer> {
  return compiledWorker()?.read(input) ?? readHostThreadRecordTransfer(input)
}
