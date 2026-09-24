/**
 * One reusable Node worker per process for checkpoint artifact I/O. The worker
 * uses the same serializer, digest and fsync implementation as the sync path.
 * It never writes canonical chats: validation, CAS and adoption stay on Host.
 *
 * postMessage captures each JSON record immediately, including while the worker
 * starts. No live record reference is retained in a deferred publication queue.
 * Structured cloning still costs time on the caller; stringify/hash/fsync and
 * read/hash/parse run on the worker. Replies omit the redundant verified Buffer.
 *
 * TRANSPORT. The embedding process chooses it: Desktop main installs an
 * Electron `utilityProcess` factory (`src/main/host/HostThreadRecordTransferTransport.ts`)
 * before its first persist; the standalone Host and tests keep the default
 * `worker_threads` Worker. This module never references Electron itself — the
 * standalone Host import audit forbids it. The split is crash containment, not
 * performance: a worker thread shares the app's process and its V8 pointer
 * cage, and a fatal V8 allocation failure while cloning or serializing a large
 * record aborts the whole app (release 1.9.8, 2026-09-22, thread
 * `WorkerThread`, `node::OOMErrorHandler`). Node's near-heap-limit escape
 * cannot contain a large single allocation, so a `resourceLimits` cap would
 * not have helped. A utility process ends alone and its pending jobs reject;
 * the next request starts a fresh one.
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

/**
 * One job, run where the entry lives. Deliberately synchronous: jobs run in
 * arrival order, and a success reply exists only after the shared publisher
 * has fsynced the file AND its directory.
 */
export function handleHostThreadRecordTransferRequest(
  request: HostThreadRecordTransferWorkerRequest
): HostThreadRecordTransferWorkerReply {
  try {
    const value =
      request.kind === 'publish'
        ? publishHostThreadRecordTransfer(request.input)
        : readHostThreadRecordTransfer(request.input)
    return { id: request.id, ok: true, value }
  } catch (error) {
    return {
      id: request.id,
      ok: false,
      error: {
        name: error instanceof Error ? error.name : 'Error',
        message: error instanceof Error ? error.message : 'Thread-record transfer failed.'
      }
    }
  }
}

/**
 * The parent-facing side of an entry. `worker_threads` delivers the request
 * itself; a utility process wraps it as `{ data }`, so the entry supplies the
 * unwrapping that matches its transport.
 */
export interface HostThreadRecordTransferEntryPort {
  on(event: 'message', listener: (message: unknown) => void): unknown
  postMessage(reply: HostThreadRecordTransferWorkerReply): void
}

export function bindHostThreadRecordTransferPort(
  port: HostThreadRecordTransferEntryPort,
  unwrap: (message: unknown) => HostThreadRecordTransferWorkerRequest
): void {
  port.on('message', (message) => {
    port.postMessage(handleHostThreadRecordTransferRequest(unwrap(message)))
  })
}

/** Electron's `process.parentPort`, present only inside a utility process. */
export function utilityProcessParentPort(
  env: { parentPort?: unknown } = process as { parentPort?: unknown }
): HostThreadRecordTransferEntryPort | undefined {
  const port = env.parentPort as Partial<HostThreadRecordTransferEntryPort> | undefined
  return typeof port?.on === 'function' && typeof port.postMessage === 'function'
    ? (port as HostThreadRecordTransferEntryPort)
    : undefined
}

/** A utility-process message event, as the child sees it. */
export function unwrapUtilityProcessMessage(
  message: unknown
): HostThreadRecordTransferWorkerRequest {
  return (message as { data: HostThreadRecordTransferWorkerRequest }).data
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

/**
 * What the worker class needs from a transport. Both implementations carry the
 * same request/reply messages; only failure delivery differs, and the class
 * treats every failure the same way: reject on exit, then start fresh.
 */
export interface HostThreadRecordTransferChannel {
  readonly kind: 'utility-process' | 'worker-thread'
  post(message: HostThreadRecordTransferWorkerRequest): void
  onMessage(listener: (reply: HostThreadRecordTransferWorkerReply) => void): void
  /** An uncaught error preceding the exit that follows it; utility processes only exit. */
  onError(listener: (error: Error) => void): void
  onExit(listener: (code: number) => void): void
  /** Keep the parent loop alive while jobs are pending; a no-op off `worker_threads`. */
  ref(): void
  unref(): void
  terminate(): Promise<void>
}

export type HostThreadRecordTransferChannelFactory = (
  entryPath: string
) => HostThreadRecordTransferChannel

/**
 * The slice of Electron's `utilityProcess` API this module uses, typed locally
 * because the standalone Host build has no Electron types.
 */
export interface UtilityProcessChildLike {
  postMessage(message: unknown): void
  on(event: 'message', listener: (message: unknown) => void): unknown
  on(event: 'exit', listener: (code: number) => void): unknown
  once(event: 'exit', listener: (code: number) => void): unknown
  kill(): boolean
}

export interface UtilityProcessLike {
  fork(
    modulePath: string,
    args?: string[],
    options?: { serviceName?: string }
  ): UtilityProcessChildLike
}

export const HOST_THREAD_RECORD_TRANSFER_SERVICE_NAME = 'taskwraith-thread-record-transfer'

export function createUtilityProcessTransferChannel(
  entryPath: string,
  utility: UtilityProcessLike
): HostThreadRecordTransferChannel {
  const child = utility.fork(entryPath, [], {
    serviceName: HOST_THREAD_RECORD_TRANSFER_SERVICE_NAME
  })
  let exited = false
  let termination: Promise<void> | null = null
  child.once('exit', () => {
    exited = true
  })
  return {
    kind: 'utility-process',
    post: (message) => child.postMessage(message),
    onMessage: (listener) => {
      child.on('message', (message) => listener(message as HostThreadRecordTransferWorkerReply))
    },
    onError: () => {},
    onExit: (listener) => {
      child.on('exit', listener)
    },
    ref: () => {},
    unref: () => {},
    terminate: () => {
      if (exited) return Promise.resolve()
      termination ??= new Promise((resolve) => {
        child.once('exit', () => resolve())
        child.kill()
      })
      return termination
    }
  }
}

export function createWorkerThreadTransferChannel(
  entryPath: string
): HostThreadRecordTransferChannel {
  const worker = new Worker(entryPath)
  return {
    kind: 'worker-thread',
    post: (message) => worker.postMessage(message),
    onMessage: (listener) => {
      worker.on('message', listener)
    },
    onError: (listener) => {
      worker.on('error', listener)
    },
    onExit: (listener) => {
      worker.on('exit', listener)
    },
    ref: () => worker.ref(),
    unref: () => worker.unref(),
    terminate: async () => {
      await worker.terminate()
    }
  }
}

/** A utility process when the embedder supplies one, `worker_threads` otherwise. */
export function createHostThreadRecordTransferChannel(
  entryPath: string,
  utility?: UtilityProcessLike
): HostThreadRecordTransferChannel {
  return utility
    ? createUtilityProcessTransferChannel(entryPath, utility)
    : createWorkerThreadTransferChannel(entryPath)
}

let sharedWorker: HostThreadRecordTransferWorker | undefined
let offLoopChannelFactory: HostThreadRecordTransferChannelFactory =
  createWorkerThreadTransferChannel

/**
 * Chooses the transport behind the process-wide off-loop worker. Desktop main
 * installs its utility-process factory at startup; installing the factory the
 * worker already uses is a no-op, and replacing it retires the current worker
 * so the next job starts on the new transport.
 */
export function configureHostThreadRecordTransferChannel(
  factory: HostThreadRecordTransferChannelFactory
): void {
  if (factory === offLoopChannelFactory) return
  offLoopChannelFactory = factory
  const previous = sharedWorker
  sharedWorker = undefined
  if (previous) void previous.close().catch(() => undefined)
}

/** The factory the next off-loop worker will be built with. */
export function hostThreadRecordTransferChannelFactory(): HostThreadRecordTransferChannelFactory {
  return offLoopChannelFactory
}

export class HostThreadRecordTransferWorker {
  private worker: HostThreadRecordTransferChannel | undefined
  private nextId = 0
  private closed = false
  private readonly pending = new Map<
    number,
    { resolve(value: unknown): void; reject(error: Error): void }
  >()
  private readonly idle = new Set<() => void>()

  constructor(
    private readonly entryPath = defaultEntryPath,
    private readonly channel: HostThreadRecordTransferChannelFactory = createWorkerThreadTransferChannel
  ) {}

  publish(input: PublishInput): Promise<HostThreadRecordTransferDescriptor> {
    if (this.closed) return this.request({ kind: 'publish', input })
    if (this.pending.size < MAX_PENDING_JOBS && canCloneRecord(input.record)) {
      // A transport that cannot accept the job (spawn failure, a message the
      // channel refuses) still has the unmutated record in hand right now.
      try {
        return this.request({ kind: 'publish', input })
      } catch {
        // Capture synchronously below, exactly as saturation does.
      }
    }
    // Capture exotic JSON values immediately too, with the same behavior as
    // the existing sync publisher instead of changing their serialized bytes.
    try {
      return Promise.resolve(publishHostThreadRecordTransfer(input))
    } catch (error) {
      return Promise.reject(error)
    }
  }

  read(input: ReadInput): Promise<DecodedHostThreadRecordTransfer> {
    if (this.closed) return this.request({ kind: 'read', input })
    if (this.pending.size < MAX_PENDING_JOBS) {
      try {
        return this.request({ kind: 'read', input })
      } catch {
        // Verify synchronously below, exactly as saturation does.
      }
    }
    try {
      return Promise.resolve(readHostThreadRecordTransfer(input))
    } catch (error) {
      return Promise.reject(error)
    }
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

  private getWorker(): HostThreadRecordTransferChannel {
    if (this.worker) return this.worker
    const worker = this.channel(this.entryPath)
    let failure: Error | undefined
    this.worker = worker
    worker.onMessage((reply) => {
      const pending = this.pending.get(reply.id)
      if (!pending) return
      this.pending.delete(reply.id)
      if (reply.ok) pending.resolve(reply.value)
      else pending.reject(decodeError(reply.error))
      this.settleIdle()
    })
    worker.onError((error) => {
      failure = error
      // Reject only on exit: callers may remove failed artifacts, so the old
      // worker must have stopped writing before they can observe the failure.
    })
    worker.onExit((code) => {
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

  /**
   * Dispatches one job. A closed worker rejects; a transport that fails to
   * accept the job throws synchronously so the caller can still capture the
   * record on the calling thread.
   */
  private request<T>(
    request:
      | Omit<Extract<HostThreadRecordTransferWorkerRequest, { kind: 'publish' }>, 'id'>
      | Omit<Extract<HostThreadRecordTransferWorkerRequest, { kind: 'read' }>, 'id'>
  ): Promise<T> {
    if (this.closed) {
      return Promise.reject(
        new HostThreadRecordTransferError('Thread-record transfer worker is closed.')
      )
    }
    const id = ++this.nextId
    // The executor runs synchronously, so `settle` is assigned before use.
    let settle: { resolve(value: unknown): void; reject(error: Error): void } = {
      resolve: () => undefined,
      reject: () => undefined
    }
    const result = new Promise<T>((resolve, reject) => {
      settle = { resolve: (value) => resolve(value as T), reject }
    })
    try {
      const worker = this.getWorker()
      this.pending.set(id, settle)
      worker.ref()
      worker.post({ ...request, id } satisfies HostThreadRecordTransferWorkerRequest)
    } catch (cause) {
      this.pending.delete(id)
      this.settleIdle()
      throw new HostThreadRecordTransferError(
        'Thread-record transfer job could not be dispatched.',
        { cause }
      )
    }
    return result
  }
}

/**
 * The process-wide worker behind the off-loop publish/read, built on the
 * configured transport once its compiled entry exists. Standalone source
 * tools/tests retain the exact synchronous implementation: both production
 * builds emit the sibling entry, and worker integration tests exercise a
 * compiled entry explicitly rather than this compatibility path.
 */
export function sharedHostThreadRecordTransferWorker(
  entryPath = defaultEntryPath
): HostThreadRecordTransferWorker | undefined {
  if (!existsSync(entryPath)) return undefined
  return (sharedWorker ??= new HostThreadRecordTransferWorker(entryPath, offLoopChannelFactory))
}

export function publishHostThreadRecordTransferOffLoop(
  input: PublishInput
): HostThreadRecordTransferDescriptor | Promise<HostThreadRecordTransferDescriptor> {
  return (
    sharedHostThreadRecordTransferWorker()?.publish(input) ?? publishHostThreadRecordTransfer(input)
  )
}

export function readHostThreadRecordTransferOffLoop(
  input: ReadInput
): DecodedHostThreadRecordTransfer | Promise<DecodedHostThreadRecordTransfer> {
  return sharedHostThreadRecordTransferWorker()?.read(input) ?? readHostThreadRecordTransfer(input)
}
