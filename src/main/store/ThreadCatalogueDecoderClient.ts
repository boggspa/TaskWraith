import { Worker } from 'node:worker_threads'
import type {
  ThreadDecodeMessage,
  ThreadDecodeRequest,
  ThreadPrepareRequest
} from './ThreadCatalogueWorkerProtocol'
import { ThreadCatalogueRequestError } from '../../shared/threadCatalogueRequestError'

type SequencedDecodeMessage = Extract<ThreadDecodeMessage, { sequence: number }>
export type ThreadDecodeCompletion = Extract<
  ThreadDecodeMessage,
  { type: 'complete' | 'missing' | 'prepared' }
>

interface ActiveDecode {
  requestId: number
  sequence: number
  onMessage: (message: SequencedDecodeMessage) => void | Promise<void>
  resolve: (value: ThreadDecodeCompletion) => void
  reject: (error: Error) => void
  timeout: ReturnType<typeof setTimeout>
}

/** One decoder isolate, with one acknowledged batch in flight. SQLite stays in its parent. */
export class ThreadCatalogueDecoderClient {
  private worker: Worker | null = null
  private active: ActiveDecode | null = null
  private disposed = false
  private processing: Promise<void> = Promise.resolve()
  private readonly terminating = new Set<Promise<number>>()

  constructor(
    private readonly modulePath: string,
    private readonly timeoutMs = 120_000
  ) {}

  run(
    request: ThreadDecodeRequest | ThreadPrepareRequest,
    onMessage: ActiveDecode['onMessage']
  ): Promise<ThreadDecodeCompletion> {
    if (this.disposed) return Promise.reject(new Error('History decoder is shutting down'))
    if (this.active) return Promise.reject(new Error('History decoder is busy'))
    const worker = this.ensureWorker()
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(
        () => this.reset(new Error('History decoder timed out')),
        this.timeoutMs
      )
      timeout.unref?.()
      this.active = {
        requestId: request.requestId,
        sequence: 0,
        onMessage,
        resolve,
        reject,
        timeout
      }
      try {
        worker.postMessage(request)
      } catch (error) {
        this.reset(error instanceof Error ? error : new Error('History decoder submission failed'))
      }
    })
  }

  private ensureWorker(): Worker {
    if (this.worker) return this.worker
    const worker = new Worker(this.modulePath, { resourceLimits: { maxOldGenerationSizeMb: 1536 } })
    this.worker = worker
    worker.on('message', (message: ThreadDecodeMessage) => {
      if (this.worker !== worker) return
      this.processing = this.processing
        .then(() => this.handle(worker, message))
        .catch((error) => this.reset(error))
    })
    worker.on('error', (error) => {
      if (this.worker === worker) this.reset(error)
    })
    worker.on('exit', (code) => {
      if (this.worker === worker) this.reset(new Error(`History decoder exited (${code})`))
    })
    return worker
  }

  private async handle(worker: Worker, message: ThreadDecodeMessage): Promise<void> {
    const active = this.active
    if (!active || message?.requestId !== active.requestId) return
    if ('sequence' in message) {
      if (message.sequence !== active.sequence + 1)
        throw new Error('History decoder sequence changed')
      active.sequence = message.sequence
      await active.onMessage(message)
      if (this.active === active && this.worker === worker) {
        worker.postMessage({
          type: 'ack',
          requestId: active.requestId,
          sequence: message.sequence,
          ok: true
        })
      }
    } else if (
      message.type === 'complete' ||
      message.type === 'missing' ||
      message.type === 'prepared'
    ) {
      clearTimeout(active.timeout)
      this.active = null
      active.resolve(message)
    } else if (message.type === 'error') {
      clearTimeout(active.timeout)
      this.active = null
      active.reject(
        message.reason === 'changed'
          ? new ThreadCatalogueRequestError('source_changed')
          : new Error(message.message)
      )
    } else throw new Error('Invalid history decoder response')
  }

  private reset(error: Error): void {
    const worker = this.worker
    this.worker = null
    const active = this.active
    this.active = null
    if (active) {
      clearTimeout(active.timeout)
      active.reject(error)
    }
    if (worker) {
      const termination = worker.terminate()
      this.terminating.add(termination)
      void termination.finally(() => this.terminating.delete(termination))
    }
  }

  async dispose(): Promise<void> {
    this.disposed = true
    this.reset(new Error('History decoder shut down'))
    await this.processing
    await Promise.all([...this.terminating])
  }
}
